#!/usr/bin/env node
import express from 'express';
import { timingSafeEqual } from 'crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { loadConfig } from './config/config.js';
import { ImapConnectionPool } from './connection/imap-pool.js';
import { SMTPClient } from './connection/smtp-client.js';
import { createServices } from './services/index.js';
import { setupTools } from './tools/index.js';
import { setupResources } from './resources/index.js';

const SERVER_NAME = 'protonmail-mcp';
const SERVER_VERSION = '1.0.0';

async function main() {
  // Load configuration
  let config;
  try {
    config = loadConfig();
    console.error(`[${SERVER_NAME}] Configuration loaded successfully`);
  } catch (error) {
    console.error(`[${SERVER_NAME}] Failed to load configuration:`, (error as Error).message);
    process.exit(1);
  }

  // Initialize IMAP connection pool
  const imapPool = new ImapConnectionPool(
    config.protonmail.imap,
    config.protonmail.auth,
    config.connection
  );

  // Initialize SMTP client
  const smtpClient = new SMTPClient(
    config.protonmail.smtp,
    config.protonmail.auth
  );

  // Create services
  const services = createServices(imapPool, smtpClient, config);

  // Create MCP server
  const server = new Server(
    {
      name: SERVER_NAME,
      version: SERVER_VERSION
    },
    {
      capabilities: {
        tools: {},
        resources: {}
      }
    }
  );

  // Setup handlers
  setupTools(server, services);
  setupResources(server, services);

  // Handle server errors
  server.onerror = (error) => {
    console.error(`[${SERVER_NAME}] Server error:`, error);
  };

  // Handle graceful shutdown
  const shutdown = async () => {
    console.error(`[${SERVER_NAME}] Shutting down...`);
    try {
      await imapPool.close();
      await smtpClient.close();
    } catch {
      // Ignore cleanup errors
    }
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  const { server: serverConfig } = config;
  const requestCounts = new Map<string, { count: number; resetAt: number }>();
  let activeRequests = 0;

  // Express app — matches obsidian-http-mcp architecture
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '1mb', strict: true }));

  app.use((req, res, next) => {
    if (!serverConfig.allowedHosts.includes(req.hostname)) {
      res.status(403).json({ error: 'Forbidden host' });
      return;
    }

    const origin = req.get('origin');
    if (origin && !serverConfig.allowedOrigins.includes(origin)) {
      res.status(403).json({ error: 'Forbidden origin' });
      return;
    }

    next();
  });

  // Health check
  app.get('/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  // REST endpoint for n8n digest workflow
  const protectedRequest: express.RequestHandler = (req, res, next) => {
    const authorization = req.get('authorization');
    const suppliedToken = authorization?.startsWith('Bearer ')
      ? authorization.slice('Bearer '.length)
      : '';
    const expected = Buffer.from(serverConfig.authToken);
    const supplied = Buffer.from(suppliedToken);
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
      res.set('WWW-Authenticate', 'Bearer');
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const now = Date.now();
    const key = req.ip || req.socket.remoteAddress || 'unknown';
    const entry = requestCounts.get(key);
    if (!entry || entry.resetAt <= now) {
      requestCounts.set(key, { count: 1, resetAt: now + serverConfig.rateLimitWindowMs });
    } else if (entry.count >= serverConfig.rateLimitMaxRequests) {
      res.status(429).json({ error: 'Too many requests' });
      return;
    } else {
      entry.count += 1;
    }

    if (activeRequests >= serverConfig.maxConcurrentRequests) {
      res.status(503).json({ error: 'Server busy' });
      return;
    }
    activeRequests += 1;
    let released = false;
    const release = () => {
      if (!released) {
        released = true;
        activeRequests -= 1;
      }
    };
    res.once('finish', release);
    res.once('close', release);
    next();
  };

  app.get('/emails', protectedRequest, async (req, res) => {
    try {
      const limit = parseInt((req.query.limit as string) ?? '50', 10);
      const since = req.query.since as string | undefined;
      if (!Number.isInteger(limit) || limit < 1 || limit > config.limits.maxSearchResults) {
        res.status(400).json({ success: false, error: 'limit is out of range' });
        return;
      }
      if (since && Number.isNaN(Date.parse(since))) {
        res.status(400).json({ success: false, error: 'since must be an ISO date' });
        return;
      }
      const emails = await services.email.searchEmails({
        folder: 'INBOX',
        isUnread: true,
        dateFrom: since || new Date(Date.now() - 86400000).toISOString(),
        limit
      });
      res.json({ success: true, emails, count: emails.length });
    } catch (error) {
      console.error(`[${SERVER_NAME}] Email request failed:`, error);
      res.status(500).json({ success: false, error: 'Internal error' });
    }
  });

  // MCP endpoint — Streamable HTTP, stateless, plain JSON responses
  app.post(serverConfig.httpPath, protectedRequest, async (req, res) => {
    try {
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      res.on('close', () => {
        transport.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      console.error(`[${SERVER_NAME}] MCP request error:`, error);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0',
          error: {
            code: -32603,
            message: 'Internal error',
          },
          id: null,
        });
      }
    }
  });

  app.use((error: unknown, req: express.Request, res: express.Response, next: express.NextFunction) => {
    console.error(`[${SERVER_NAME}] HTTP request rejected:`, error);
    if (!res.headersSent) {
      res.status(400).json({ error: 'Invalid request' });
    } else {
      next(error);
    }
  });

  app.listen(serverConfig.httpPort, serverConfig.host, () => {
    console.error(
      `[${SERVER_NAME}] Server started on http://${serverConfig.host}:${serverConfig.httpPort}${serverConfig.httpPath}`
    );
    console.error(`[${SERVER_NAME}] Connected to ProtonMail Bridge at ${config.protonmail.imap.host}`);
  });
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
