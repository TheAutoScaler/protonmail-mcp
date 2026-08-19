import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { z } from 'zod';
import type { ProtonMailConfig } from '../types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Zod schema for configuration validation
const TLSConfigSchema = z.object({
  rejectUnauthorized: z.boolean().default(true),
  minVersion: z.string().default('TLSv1.2')
});

const IMAPConfigSchema = z.object({
  host: z.string().default('127.0.0.1'),
  port: z.number().default(1143),
  secure: z.boolean().default(false),
  tls: TLSConfigSchema.default({})
});

const SMTPConfigSchema = z.object({
  host: z.string().default('127.0.0.1'),
  port: z.number().default(1025),
  secure: z.boolean().default(false),
  requireTLS: z.boolean().default(true),
  tls: TLSConfigSchema.default({})
});

const AuthConfigSchema = z.object({
  user: z.string().min(1, 'Email address is required'),
  pass: z.string().min(1, 'Bridge password is required')
});

const ServerConfigSchema = z.object({
  transport: z.enum(['stdio', 'http']).default('stdio'),
  httpPort: z.number().int().min(1).max(65535).default(3000),
  httpPath: z.string().regex(/^\/[A-Za-z0-9/_-]*$/).default('/mcp'),
  host: z.string().default('127.0.0.1'),
  authToken: z.string({
    required_error: 'A 32+ character MCP bearer token is required'
  }).min(32, 'A 32+ character MCP bearer token is required'),
  allowedHosts: z.array(z.string()).default(['localhost', '127.0.0.1', '[::1]']),
  allowedOrigins: z.array(z.string().url()).default([]),
  rateLimitWindowMs: z.number().int().positive().default(60_000),
  rateLimitMaxRequests: z.number().int().positive().default(120),
  maxConcurrentRequests: z.number().int().positive().max(100).default(10)
});

const ConnectionConfigSchema = z.object({
  poolSize: z.number().min(1).max(10).default(3),
  idleTimeout: z.number().int().positive().default(300000),
  connectionTimeout: z.number().int().positive().default(30000),
  maxRetries: z.number().int().min(0).max(10).default(3),
  retryDelay: z.number().int().positive().default(1000)
});

const CacheConfigSchema = z.object({
  enabled: z.boolean().default(true),
  ttl: z.number().default(60),
  maxSize: z.number().default(1000)
});

const LimitsConfigSchema = z.object({
  defaultPageSize: z.number().int().min(1).max(500).default(50),
  maxPageSize: z.number().int().min(1).max(500).default(500),
  maxSearchResults: z.number().int().min(1).max(5000).default(1000),
  maxEmailBodySize: z.number().int().min(65_536).max(25_000_000).default(1_048_576)
});

const ProtonMailConfigSchema = z.object({
  protonmail: z.object({
    imap: IMAPConfigSchema.default({}),
    smtp: SMTPConfigSchema.default({}),
    auth: AuthConfigSchema
  }),
  server: ServerConfigSchema,
  connection: ConnectionConfigSchema.default({}),
  cache: CacheConfigSchema.default({}),
  limits: LimitsConfigSchema.default({})
}).superRefine((config, ctx) => {
  const loopbackHosts = new Set(['127.0.0.1', '::1', 'localhost']);
  if (!loopbackHosts.has(config.server.host)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['server', 'host'],
      message: 'The MCP server must bind to a loopback address; use an authenticated TLS reverse proxy for remote access'
    });
  }

  for (const [name, endpoint] of [
    ['imap', config.protonmail.imap],
    ['smtp', config.protonmail.smtp]
  ] as const) {
    if (!loopbackHosts.has(endpoint.host) && !endpoint.tls.rejectUnauthorized) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['protonmail', name, 'tls', 'rejectUnauthorized'],
        message: 'TLS certificate verification may only be disabled for a loopback Bridge endpoint'
      });
    }
  }
});

function findConfigFile(): string | null {
  const possiblePaths = [
    process.env.PROTONMAIL_CONFIG,
    join(process.cwd(), 'config', 'protonmail.config.json'),
    join(process.cwd(), 'protonmail.config.json'),
    join(__dirname, '..', '..', 'config', 'protonmail.config.json')
  ].filter(Boolean) as string[];

  for (const configPath of possiblePaths) {
    if (existsSync(configPath)) {
      return configPath;
    }
  }

  return null;
}

export function loadConfig(): ProtonMailConfig {
  const configPath = findConfigFile();

  if (!configPath) {
    // Check for environment variables as fallback
    if (process.env.PROTONMAIL_USER && process.env.PROTONMAIL_PASS) {
      const envConfig = {
        protonmail: {
          imap: {
            host: process.env.PROTONMAIL_IMAP_HOST || '127.0.0.1',
            port: parseInt(process.env.PROTONMAIL_IMAP_PORT || '1143', 10),
            secure: process.env.PROTONMAIL_IMAP_SECURE === 'true',
            tls: {
              rejectUnauthorized: process.env.PROTONMAIL_TLS_REJECT_UNAUTHORIZED !== 'false',
              minVersion: 'TLSv1.2'
            }
          },
          smtp: {
            host: process.env.PROTONMAIL_SMTP_HOST || '127.0.0.1',
            port: parseInt(process.env.PROTONMAIL_SMTP_PORT || '1025', 10),
            secure: process.env.PROTONMAIL_SMTP_SECURE === 'true',
            requireTLS: true,
            tls: {
              rejectUnauthorized: process.env.PROTONMAIL_TLS_REJECT_UNAUTHORIZED !== 'false',
              minVersion: 'TLSv1.2'
            }
          },
          auth: {
            user: process.env.PROTONMAIL_USER,
            pass: process.env.PROTONMAIL_PASS
          }
        },
        server: {
          host: process.env.MCP_HOST || '127.0.0.1',
          httpPort: parseInt(process.env.PORT || '3000', 10),
          authToken: process.env.MCP_AUTH_TOKEN,
          allowedHosts: process.env.MCP_ALLOWED_HOSTS?.split(',').map(v => v.trim()).filter(Boolean),
          allowedOrigins: process.env.MCP_ALLOWED_ORIGINS?.split(',').map(v => v.trim()).filter(Boolean)
        },
        connection: {},
        cache: {},
        limits: {}
      };

      const result = ProtonMailConfigSchema.safeParse(envConfig);
      if (!result.success) {
        throw new Error(`Invalid configuration from environment: ${result.error.message}`);
      }
      return result.data;
    }

    throw new Error(
      'Configuration file not found. Please create config/protonmail.config.json or set PROTONMAIL_USER and PROTONMAIL_PASS environment variables.'
    );
  }

  try {
    const configContent = readFileSync(configPath, 'utf-8');
    const rawConfig = JSON.parse(configContent);

    const result = ProtonMailConfigSchema.safeParse(rawConfig);
    if (!result.success) {
      throw new Error(`Invalid configuration: ${result.error.message}`);
    }

    return result.data;
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(`Invalid JSON in configuration file: ${configPath}`);
    }
    throw error;
  }
}

export function validateConfig(config: unknown): ProtonMailConfig {
  const result = ProtonMailConfigSchema.safeParse(config);
  if (!result.success) {
    throw new Error(`Configuration validation failed: ${result.error.message}`);
  }
  return result.data;
}
