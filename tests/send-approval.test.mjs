import test from 'node:test';
import assert from 'node:assert/strict';
import {
  fingerprintSend,
  requireSendApproval
} from '../dist/security/send-approval.js';

const payload = () => ({
  to: ['person@example.com'],
  subject: 'Test subject',
  body: 'Exact body'
});

function fakeServer(result, capabilities = { elicitation: { form: {} } }) {
  const calls = [];
  return {
    calls,
    getClientCapabilities: () => capabilities,
    elicitInput: async (params, options) => {
      calls.push({ params, options });
      return result;
    }
  };
}

test('accepts one explicitly confirmed frozen payload', async () => {
  const server = fakeServer({ action: 'accept', content: { confirm: true } });
  const message = payload();
  const fingerprint = await requireSendApproval(
    server,
    'new email',
    message,
    42,
    new AbortController().signal
  );

  assert.equal(fingerprint, fingerprintSend(message));
  assert.equal(Object.isFrozen(message), true);
  assert.equal(Object.isFrozen(message.to), true);
  assert.equal(server.calls[0].options.relatedRequestId, 42);
  assert.match(server.calls[0].params.message, new RegExp(fingerprint));
});

test('fails closed when the client lacks elicitation support', async () => {
  const server = fakeServer({ action: 'accept', content: { confirm: true } }, {});
  await assert.rejects(
    requireSendApproval(server, 'new email', payload(), 1, new AbortController().signal),
    /does not support approval elicitation/
  );
  assert.equal(server.calls.length, 0);
});

for (const result of [
  { action: 'decline' },
  { action: 'cancel' },
  { action: 'accept', content: { confirm: false } },
  { action: 'accept' }
]) {
  test(`fails closed for ${JSON.stringify(result)}`, async () => {
    const server = fakeServer(result);
    await assert.rejects(
      requireSendApproval(server, 'new email', payload(), 1, new AbortController().signal),
      /Send blocked/
    );
  });
}

test('fingerprint is stable across object key order and covers the body', () => {
  const first = fingerprintSend(payload());
  const reordered = fingerprintSend({ body: 'Exact body', subject: 'Test subject', to: ['person@example.com'] });
  const changed = fingerprintSend({ ...payload(), body: 'Changed body' });
  assert.equal(first, reordered);
  assert.notEqual(first, changed);
});
