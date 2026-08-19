import test from 'node:test';
import assert from 'node:assert/strict';

import { EmailService } from '../dist/services/email.service.js';

const limits = {
  defaultPageSize: 50,
  maxPageSize: 500,
  maxSearchResults: 1000,
  maxEmailBodySize: 65_536
};

function envelope(subject = 'Subject', address = 'sender@example.com') {
  return {
    subject,
    messageId: `<${subject}@example.com>`,
    date: new Date('2026-08-19T09:00:00Z'),
    from: [{ name: 'Sender', address }],
    to: [{ address: 'recipient@example.com' }]
  };
}

function message(uid, { seq = 1, subject = `Message ${uid}`, source } = {}) {
  return {
    uid,
    seq,
    envelope: envelope(subject),
    flags: new Set(),
    bodyStructure: { type: 'text/plain' },
    size: source?.length || 100,
    source
  };
}

function iterable(values) {
  return (async function* () {
    for (const value of values) yield value;
  })();
}

function fixture({ messages = [], searchResult = [] } = {}) {
  const calls = [];
  const client = {
    mailbox: { exists: messages.length },
    fetch(range, query, options) {
      calls.push({ method: 'fetch', range, query, options });
      return iterable(messages);
    },
    async search(criteria, options) {
      calls.push({ method: 'search', criteria, options });
      return searchResult;
    },
    async messageFlagsAdd(range, flags, options) {
      calls.push({ method: 'messageFlagsAdd', range, flags, options });
    },
    async messageFlagsRemove(range, flags, options) {
      calls.push({ method: 'messageFlagsRemove', range, flags, options });
    },
    async messageMove(range, folder, options) {
      calls.push({ method: 'messageMove', range, folder, options });
    },
    async messageDelete(range, options) {
      calls.push({ method: 'messageDelete', range, options });
    }
  };
  const pool = {
    async withMailbox(folder, operation, readOnly = true) {
      calls.push({ method: 'withMailbox', folder, readOnly });
      return operation(client, { release() {} });
    }
  };
  return {
    calls,
    client,
    service: new EmailService(pool, { sendMail() {} }, limits)
  };
}

test('listEmails fetches by sequence but always returns real UIDs', async () => {
  const { service, calls } = fixture({
    messages: [message(901, { seq: 2 }), message(777, { seq: 3 })]
  });

  const result = await service.listEmails('INBOX', 2, 0, 'desc');

  assert.deepEqual(result.map(item => item.uid), ['777', '901']);
  const fetch = calls.find(call => call.method === 'fetch');
  assert.equal(fetch.range, '1:2');
  assert.equal(fetch.query.uid, true);
  assert.equal(fetch.options, undefined);
});

test('listEmails handles ascending pages, caps limits, and skips invalid ranges', async () => {
  const { service, client, calls } = fixture({ messages: [message(10)] });
  client.mailbox.exists = 1000;
  await service.listEmails('Archive', 900, 10, 'asc');
  const fetch = calls.find(call => call.method === 'fetch');
  assert.equal(fetch.range, '11:510');

  const empty = fixture({ messages: [] });
  assert.deepEqual(await empty.service.listEmails('INBOX'), []);
  assert.equal(empty.calls.some(call => call.method === 'fetch'), false);

  const beyond = fixture({ messages: [message(1)] });
  assert.deepEqual(await beyond.service.listEmails('INBOX', 10, 50, 'asc'), []);
  assert.equal(beyond.calls.some(call => call.method === 'fetch'), false);
});

test('getEmailHeaders interprets the requested identifier as a UID', async () => {
  const { service, calls } = fixture({ messages: [message(9001, { seq: 4 })] });

  const result = await service.getEmailHeaders('INBOX', '9001');

  assert.equal(result.uid, '9001');
  const fetch = calls.find(call => call.method === 'fetch');
  assert.equal(fetch.range, '9001');
  assert.deepEqual(fetch.options, { uid: true });
});

test('getEmail fetches source by UID and parses the matching message', async () => {
  const source = Buffer.from(
    'From: sender@example.com\r\nTo: recipient@example.com\r\nSubject: Correct\r\n\r\nExpected body'
  );
  const { service, calls } = fixture({
    messages: [message(4321, { seq: 2, subject: 'Correct', source })]
  });

  const result = await service.getEmail('INBOX', '4321');

  assert.equal(result.uid, '4321');
  assert.match(result.body, /Expected body/);
  const fetch = calls.find(call => call.method === 'fetch');
  assert.deepEqual(fetch.options, { uid: true });
});

test('searchEmails paginates UID results and fetches the selected UIDs as UIDs', async () => {
  const { service, calls } = fixture({
    searchResult: [101, 205, 999],
    messages: [message(205, { seq: 1, subject: 'Wanted' })]
  });

  const result = await service.searchEmails({
    folder: 'INBOX',
    from: 'wanted@example.com',
    limit: 1,
    offset: 1
  });

  assert.deepEqual(result.map(item => item.uid), ['205']);
  const search = calls.find(call => call.method === 'search');
  assert.deepEqual(search.criteria, { from: 'wanted@example.com' });
  assert.deepEqual(search.options, { uid: true });
  const fetch = calls.find(call => call.method === 'fetch');
  assert.equal(fetch.range, '205');
  assert.deepEqual(fetch.options, { uid: true });
});

test('searchEmails builds combined criteria without silently dropping filters', async () => {
  const { service, calls } = fixture({ searchResult: [] });
  await service.searchEmails({
    query: 'needle',
    from: 'from@example.com',
    to: 'to@example.com',
    subject: 'subject',
    dateFrom: '2026-01-01T00:00:00Z',
    dateTo: '2026-02-01T00:00:00Z',
    isUnread: true
  });
  const criteria = calls.find(call => call.method === 'search').criteria;
  assert.deepEqual(criteria.or, [
    { subject: 'needle' },
    { body: 'needle' },
    { from: 'needle' },
    { to: 'needle' }
  ]);
  assert.equal(criteria.from, 'from@example.com');
  assert.equal(criteria.to, 'to@example.com');
  assert.equal(criteria.subject, 'subject');
  assert.equal(criteria.unseen, true);
  assert.equal(criteria.since.toISOString(), '2026-01-01T00:00:00.000Z');
  assert.equal(criteria.before.toISOString(), '2026-02-01T00:00:00.000Z');
});

test('empty and out-of-range search pages do not issue a fetch', async () => {
  for (const searchResult of [[], [10]]) {
    const { service, calls } = fixture({ searchResult });
    await service.searchEmails({ limit: 10, offset: 10 });
    assert.equal(calls.some(call => call.method === 'fetch'), false);
  }
});

test('missing UID responses fail closed instead of falling back to sequence numbers', async () => {
  const unsafe = message(undefined, { seq: 42 });
  const { service } = fixture({ messages: [unsafe] });
  await assert.rejects(
    service.getEmailHeaders('INBOX', '42'),
    /did not include a UID/
  );
});

test('direct UID reads reject a different message returned by the server', async () => {
  const { service } = fixture({ messages: [message(77, { seq: 42 })] });
  await assert.rejects(
    service.getEmailHeaders('INBOX', '42'),
    /UID integrity check failed/
  );
});

test('search rejects messages outside the UID set returned by SEARCH', async () => {
  const { service } = fixture({
    searchResult: [500],
    messages: [message(12, { seq: 500 })]
  });
  await assert.rejects(
    service.searchEmails({ from: 'wanted@example.com' }),
    /UID integrity check failed/
  );
});

test('missing messages return not-found rather than a different sequence message', async () => {
  const { service } = fixture({ messages: [] });
  await assert.rejects(service.getEmailHeaders('INBOX', '999'), /Email not found/);
});

test('search failures are wrapped as IMAP errors', async () => {
  const { service, client } = fixture();
  client.search = async () => { throw new Error('server rejected criteria'); };
  await assert.rejects(service.searchEmails({ query: 'x' }), /Search failed/);
});

test('UID mutations normalize identifiers and always use UID mode', async () => {
  const { service, calls } = fixture();
  await service.markAsRead('INBOX', ['1', '2', '2']);
  await service.markAsUnread('INBOX', ['3']);
  await service.moveEmails('INBOX', 'Archive', ['4']);
  await service.deleteEmails('Trash', ['5']);

  const add = calls.find(call => call.method === 'messageFlagsAdd');
  assert.deepEqual(add, {
    method: 'messageFlagsAdd', range: '1,2', flags: ['\\Seen'], options: { uid: true }
  });
  assert.deepEqual(calls.find(call => call.method === 'messageFlagsRemove').options, { uid: true });
  assert.deepEqual(calls.find(call => call.method === 'messageMove').options, { uid: true });
  assert.deepEqual(calls.find(call => call.method === 'messageDelete').options, { uid: true });
  assert.equal(calls.find(call => call.method === 'messageMove').readOnly, undefined);
  assert.equal(
    calls.filter(call => call.method === 'withMailbox' && call.readOnly === false).length,
    4
  );
});

test('invalid mutation UIDs fail before any IMAP mutation is issued', async () => {
  const { service, calls } = fixture();
  await assert.rejects(service.moveEmails('INBOX', 'Trash', ['1:*']), /Invalid UID/);
  assert.equal(calls.some(call => call.method === 'messageMove'), false);
});

test('oversized message sources are rejected before parsing', async () => {
  const { service } = fixture({
    messages: [message(1, { source: Buffer.alloc(limits.maxEmailBodySize + 1) })]
  });
  await assert.rejects(service.getEmail('INBOX', '1'), /exceeds the configured/);
});
