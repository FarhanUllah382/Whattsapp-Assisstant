import assert from 'node:assert/strict';
import { test } from 'node:test';

import { runOwnerTurn } from '../src/agent';
import { ChannelSendError } from '../src/channel/types';
import { WahaAdapter } from '../src/channel/waha';
import { db } from '../src/db';
import { PACING_DEFAULTS } from '../src/guardrails/pacing/defaults';
import {
  beginOutboundAttempt,
  inspectOutboundAttempt,
  markOutboundFailure,
  markOutboundSent,
  outboundDeliveryIssuesTool,
} from '../src/outbound-delivery';

function insertCustomer(label: string): number {
  return Number(db.prepare('insert into customers (phone) values (?)').run(label).lastInsertRowid);
}

function attemptInput(id: string, customerId: number) {
  return {
    id,
    customerId,
    recipientKind: 'customer' as const,
    eventKey: `event:${id}`,
    bodyHash: `body:${id}`,
  };
}

test('sent attempts retain the provider id and cannot send twice', () => {
  db.exec('begin');
  try {
    const customerId = insertCustomer(`outbound-sent-${Date.now()}`);
    const input = attemptInput(`outbound-sent-${Date.now()}`, customerId);
    assert.equal(beginOutboundAttempt(input), 'send');
    markOutboundSent(input.id, 'provider-message-123');
    assert.equal(inspectOutboundAttempt(input.id), 'already_sent');
    assert.equal(beginOutboundAttempt(input), 'already_sent');
    const row = db.prepare(`
      select status, attempt_count, provider_message_id from send_ledger where id = ?
    `).get(input.id) as any;
    assert.deepEqual(row, {
      status: 'sent',
      attempt_count: 1,
      provider_message_id: 'provider-message-123',
    });
  } finally {
    db.exec('rollback');
  }
});

test('an interrupted pending attempt becomes uncertain and is never auto-retried', () => {
  db.exec('begin');
  try {
    const customerId = insertCustomer(`outbound-pending-${Date.now()}`);
    const input = attemptInput(`outbound-pending-${Date.now()}`, customerId);
    assert.equal(beginOutboundAttempt(input), 'send');

    // This is the state a restarted process sees after the prior process wrote
    // pending but died before it could persist the provider outcome.
    assert.equal(inspectOutboundAttempt(input.id), 'uncertain');
    assert.equal(beginOutboundAttempt(input), 'uncertain');
    const row = db.prepare(`
      select status, attempt_count, last_error_code from send_ledger where id = ?
    `).get(input.id) as any;
    assert.deepEqual(row, {
      status: 'uncertain',
      attempt_count: 1,
      last_error_code: 'interrupted_after_attempt_started',
    });
  } finally {
    db.exec('rollback');
  }
});

test('a rephrased body cannot create a second attempt for the same inbound event', () => {
  db.exec('begin');
  try {
    const customerId = insertCustomer(`outbound-rephrase-${Date.now()}`);
    const first = attemptInput(`outbound-first-${Date.now()}`, customerId);
    assert.equal(beginOutboundAttempt(first), 'send');
    const rephrased = {
      ...attemptInput(`outbound-second-${Date.now()}`, customerId),
      eventKey: first.eventKey,
    };
    assert.equal(beginOutboundAttempt(rephrased), 'uncertain');
    assert.equal((db.prepare('select count(*) count from send_ledger where event_key = ?')
      .get(first.eventKey) as any).count, 1);
  } finally {
    db.exec('rollback');
  }
});

test('definite provider rejection is retryable but an unknown outcome is not', () => {
  db.exec('begin');
  try {
    const customerId = insertCustomer(`outbound-failure-${Date.now()}`);
    const rejected = attemptInput(`outbound-rejected-${Date.now()}`, customerId);
    assert.equal(beginOutboundAttempt(rejected), 'send');
    assert.equal(markOutboundFailure(rejected.id, new ChannelSendError('HTTP 400', false)), 'failed');
    assert.equal(inspectOutboundAttempt(rejected.id), 'retryable');
    assert.equal(beginOutboundAttempt(rejected), 'send');
    assert.equal(
      (db.prepare('select attempt_count from send_ledger where id = ?').get(rejected.id) as any).attempt_count,
      2,
    );

    const unknown = attemptInput(`outbound-unknown-${Date.now()}`, customerId);
    assert.equal(beginOutboundAttempt(unknown), 'send');
    assert.equal(markOutboundFailure(unknown.id, new Error('socket reset')), 'uncertain');
    assert.equal(inspectOutboundAttempt(unknown.id), 'uncertain');
    assert.equal(beginOutboundAttempt(unknown), 'uncertain');
  } finally {
    db.exec('rollback');
  }
});

test('delivery issue tool is read-only and exposes no message body or phone', () => {
  db.exec('begin');
  try {
    const customerId = insertCustomer(`outbound-issue-${Date.now()}`);
    const input = attemptInput(`outbound-issue-${Date.now()}`, customerId);
    assert.equal(beginOutboundAttempt(input), 'send');
    markOutboundFailure(input.id, new Error('timeout'));
    const before = (db.prepare('select count(*) count from send_ledger').get() as any).count;
    const result = outboundDeliveryIssuesTool.execute({}, { customerId }) as any;
    const after = (db.prepare('select count(*) count from send_ledger').get() as any).count;
    assert.equal(result.ok, true);
    assert.equal(before, after);
    assert.equal(result.issues.some((issue: any) => issue.attempt_reference === input.id.slice(0, 12)), true);
    assert.equal(JSON.stringify(result).includes('outbound-issue-'), false);
    assert.equal(JSON.stringify(result).includes('body:'), false);
  } finally {
    db.exec('rollback');
  }
});

test('WAHA captures a provider message id and classifies response certainty', async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response(JSON.stringify({ key: { id: 'WAHA-ID-1' } }), { status: 200 });
    const adapter = new WahaAdapter({ baseUrl: 'http://test.invalid', session: 'test' });
    assert.deepEqual(await adapter.sendText('923001234567', 'hello'), { providerMessageId: 'WAHA-ID-1' });

    globalThis.fetch = async () => new Response('bad request', { status: 400 });
    await assert.rejects(
      adapter.sendText('923001234567', 'hello'),
      (error: unknown) => error instanceof ChannelSendError && error.deliveryUncertain === false,
    );

    globalThis.fetch = async () => { throw new Error('network reset'); };
    await assert.rejects(
      adapter.sendText('923001234567', 'hello'),
      (error: unknown) => error instanceof ChannelSendError && error.deliveryUncertain === true,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('owner conversational retry uses the same durable attempt and sends once', async () => {
  db.exec('begin');
  const originalWindow = {
    start: PACING_DEFAULTS.windowStartHour,
    end: PACING_DEFAULTS.windowEndHour,
  };
  try {
    // This test verifies idempotency, not shop hours, and must remain
    // deterministic regardless of the local time at which the suite runs.
    PACING_DEFAULTS.windowStartHour = 0;
    PACING_DEFAULTS.windowEndHour = 24;
    const suffix = Date.now();
    // Use a realistic normalized WhatsApp number. The outbound boundary now
    // rejects synthetic non-phone identifiers before any provider call.
    const phone = `9231${String(suffix).slice(-8)}`;
    const eventKey = `owner-event-${suffix}`;
    let sends = 0;
    const modelCaller = async (_system: string, messages: any[]) => {
      const alreadyHasToolResult = messages.some((message) =>
        Array.isArray(message.content) && message.content.some((block: any) => block.type === 'tool_result'));
      return alreadyHasToolResult
        ? { content: [{ type: 'text', text: '' }], stop_reason: 'end_turn' }
        : {
            content: [{
              type: 'tool_use',
              id: `send-${suffix}`,
              name: 'send_message',
              input: { body: 'The report is ready.' },
            }],
            stop_reason: 'tool_use',
          };
    };
    const send = async () => {
      sends += 1;
      return { providerMessageId: `owner-provider-${suffix}` };
    };

    await runOwnerTurn(phone, 'Show my report', send, modelCaller as any, eventKey);
    await runOwnerTurn(phone, 'Show my report', send, modelCaller as any, eventKey);
    assert.equal(sends, 1);
    const ownerId = (db.prepare('select id from customers where phone = ?').get(phone) as any).id;
    const row = db.prepare(`
      select recipient_kind, status, attempt_count, provider_message_id
        from send_ledger where customer_id = ? and recipient_kind = 'owner'
        order by created_at desc limit 1
    `).get(ownerId) as any;
    assert.deepEqual(row, {
      recipient_kind: 'owner',
      status: 'sent',
      attempt_count: 1,
      provider_message_id: `owner-provider-${suffix}`,
    });
  } finally {
    PACING_DEFAULTS.windowStartHour = originalWindow.start;
    PACING_DEFAULTS.windowEndHour = originalWindow.end;
    db.exec('rollback');
  }
});
