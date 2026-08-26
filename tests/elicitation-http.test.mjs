import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const token = 'test-token-that-is-at-least-32-characters-long';

async function within(promise, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out`)), 5000);
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function waitForHealth(url, child) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`server exited with ${child.exitCode}`);
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // Startup race.
    }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('server did not become healthy');
}

test('HTTP send call elicits approval and a decline fails closed before SMTP', async t => {
  const port = 31_000 + (process.pid % 1000);
  const childEnv = { ...process.env };
  delete childEnv.NODE_TEST_CONTEXT;
  const child = spawn(process.execPath, ['dist/server.js'], {
    cwd: process.cwd(),
    env: {
      ...childEnv,
      PROTONMAIL_USER: 'bridge-user',
      PROTONMAIL_PASS: 'bridge-password',
      MCP_AUTH_TOKEN: token,
      MCP_ALLOWED_HOSTS: '127.0.0.1',
      PORT: String(port)
    },
    stdio: ['ignore', 'ignore', 'pipe']
  });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', chunk => { stderr += chunk; });
  t.after(() => { child.kill('SIGKILL'); });

  await waitForHealth(`http://127.0.0.1:${port}/health`, child);
  const client = new Client(
    { name: 'approval-test', version: '1.0.0' },
    { capabilities: { elicitation: { form: {} } } }
  );
  client.setRequestHandler(ElicitRequestSchema, async request => {
    assert.match(request.params.message, /person@example\.com/);
    assert.match(request.params.message, /SHA-256:/);
    return { action: 'decline' };
  });
  const transport = new StreamableHTTPClientTransport(
    new URL(`http://127.0.0.1:${port}/mcp`),
    { requestInit: { headers: { Authorization: `Bearer ${token}` } } }
  );
  t.after(() => { void client.close(); });

  await within(client.connect(transport), `connect: ${stderr}`);
  const result = await within(client.callTool({
    name: 'send_email',
    arguments: {
      to: ['person@example.com'],
      subject: 'Must not send',
      body: 'Approval was declined'
    }
  }), `callTool: ${stderr}`);

  assert.equal(result.isError, true, stderr);
  assert.match(result.content[0].text, /approval decline/);
});
