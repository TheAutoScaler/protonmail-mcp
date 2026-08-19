import test from 'node:test';
import assert from 'node:assert/strict';

import { validateConfig } from '../dist/config/config.js';
import { normalizeUids } from '../dist/utils/validation.js';

const baseConfig = {
  protonmail: {
    imap: { host: '127.0.0.1', port: 1143, secure: false, tls: { rejectUnauthorized: false } },
    smtp: { host: '127.0.0.1', port: 1025, secure: false, requireTLS: true, tls: { rejectUnauthorized: false } },
    auth: { user: 'test@example.com', pass: 'bridge-password' }
  },
  server: { authToken: 'a'.repeat(32) }
};

test('accepts safe loopback configuration', () => {
  const config = validateConfig(baseConfig);
  assert.equal(config.server.host, '127.0.0.1');
  assert.equal(config.server.authToken.length, 32);
});

test('rejects a missing or short bearer token', () => {
  assert.throws(() => validateConfig({ ...baseConfig, server: {} }), /bearer token/i);
  assert.throws(
    () => validateConfig({ ...baseConfig, server: { authToken: 'short' } }),
    /32\+ character/i
  );
});

test('rejects non-loopback HTTP binding', () => {
  assert.throws(
    () => validateConfig({ ...baseConfig, server: { authToken: 'a'.repeat(32), host: '0.0.0.0' } }),
    /loopback/i
  );
});

test('rejects disabled TLS verification for a remote Bridge host', () => {
  const config = structuredClone(baseConfig);
  config.protonmail.imap.host = 'bridge.example.com';
  assert.throws(() => validateConfig(config), /certificate verification/i);
});

test('normalizes and deduplicates decimal UIDs', () => {
  assert.deepEqual(normalizeUids(['1', '1', '2']), ['1', '2']);
});

test('rejects IMAP sequence sets and empty UID lists', () => {
  for (const uid of ['1:*', '*', '0', '-1', '1,2', 'abc']) {
    assert.throws(() => normalizeUids([uid]), /Invalid UID/);
  }
  assert.throws(() => normalizeUids([]), /between 1 and 500/);
});
