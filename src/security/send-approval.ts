import { createHash } from 'node:crypto';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type { RequestId } from '@modelcontextprotocol/sdk/types.js';
import type { SendEmailOptions } from '../types.js';

const APPROVAL_TIMEOUT_MS = 10 * 60 * 1000;

function canonicalize(value: unknown): unknown {
  if (Buffer.isBuffer(value)) {
    return { $bytes: value.toString('base64') };
  }
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalize(entry)])
    );
  }
  return value;
}

function freezePayload(value: unknown): void {
  if (!value || typeof value !== 'object' || ArrayBuffer.isView(value) || Object.isFrozen(value)) {
    return;
  }
  for (const entry of Object.values(value as Record<string, unknown>)) {
    freezePayload(entry);
  }
  Object.freeze(value);
}

export function fingerprintSend(payload: SendEmailOptions): string {
  return createHash('sha256')
    .update(JSON.stringify(canonicalize(payload)))
    .digest('hex');
}

function approvalMessage(action: string, payload: SendEmailOptions, fingerprint: string): string {
  const recipients = [
    ...payload.to,
    ...(payload.cc ?? []),
    ...(payload.bcc ?? [])
  ];
  const attachments = payload.attachments?.map(attachment => attachment.filename) ?? [];
  const lines = [
    `Approve ${action}?`,
    `Recipients (${recipients.length}): ${recipients.join(', ')}`,
    `Subject: ${payload.subject}`,
    `Attachments (${attachments.length}): ${attachments.length ? attachments.join(', ') : 'none'}`,
    `SHA-256: ${fingerprint}`
  ];
  return lines.join('\n').slice(0, 4000);
}

export async function requireSendApproval(
  server: Server,
  action: string,
  payload: SendEmailOptions,
  requestId: RequestId,
  signal: AbortSignal
): Promise<string> {
  freezePayload(payload);
  const fingerprint = fingerprintSend(payload);
  const capabilities = server.getClientCapabilities();
  if (!capabilities?.elicitation) {
    throw new Error('Send blocked: MCP client does not support approval elicitation');
  }

  const result = await server.elicitInput(
    {
      mode: 'form',
      message: approvalMessage(action, payload, fingerprint),
      requestedSchema: {
        type: 'object',
        properties: {
          confirm: {
            type: 'boolean',
            title: 'Allow once',
            description: 'Send exactly the message described above',
            default: false
          }
        },
        required: ['confirm']
      }
    },
    {
      relatedRequestId: requestId,
      signal,
      timeout: APPROVAL_TIMEOUT_MS,
      maxTotalTimeout: APPROVAL_TIMEOUT_MS
    }
  );

  if (result.action !== 'accept' || result.content?.confirm !== true) {
    throw new Error(`Send blocked: approval ${result.action}`);
  }
  if (fingerprintSend(payload) !== fingerprint) {
    throw new Error('Send blocked: payload changed after approval');
  }
  return fingerprint;
}
