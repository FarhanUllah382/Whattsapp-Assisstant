// FIX6 — pause work while WhatsApp is down.
//
// Live evidence (2 Nov 06:36): the WAHA session was FAILED, queued jobs still
// ran Gemini and were marked completed, every send got HTTP 422 "Session
// status is not as expected", and owner-alert ledger rows ended 'uncertain'
// after 16–17 attempts. Every test here injects/stubs the session status and
// never touches the network.
import assert from 'node:assert/strict';
import test from 'node:test';

import { retryPendingOwnerAlerts, deliverOwnerAlert, OWNER_ALERT_RETRY_POLICY } from '../src/alerts';
import { reserveAiModelCall } from '../src/ai-budget';
import { ChannelSendError, type ChannelSessionStatus } from '../src/channel/types';
import { ChannelSessionMonitor } from '../src/channel/session-monitor';
import { WahaAdapter } from '../src/channel/waha';
import { db } from '../src/db';
import {
  enqueueInboundJob,
  InboundJobWorkerPool,
  readWhatsappDownDeferSeconds,
  type InboundJobConfig,
} from '../src/inbound-jobs';
import { beginOutboundAttempt, markOutboundFailure, markOutboundSent } from '../src/outbound-delivery';

const config: InboundJobConfig = {
  workerCount: 1,
  maxPendingJobs: 500,
  leaseSeconds: 60,
  maxAttempts: 3,
  retryBaseSeconds: 1,
};

function insertInboundEvent(eventKey: string): void {
  const now = new Date().toISOString();
  db.prepare(`
    insert into inbound_events
      (event_key, channel, message_id, occurred_at, status, processing_started_at, updated_at)
    values (?, 'test', ?, ?, 'processing', ?, ?)
  `).run(eventKey, eventKey, now, now, now);
}

async function waitFor(predicate: () => boolean, label: string, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function aiCallCount(prefix: string): number {
  return (db.prepare('select count(*) as n from ai_model_calls where id like ?')
    .get(`${prefix}%`) as { n: number }).n;
}

test('WHATSAPP_DOWN_DEFER_SECONDS is configurable and stays finite', () => {
  assert.equal(readWhatsappDownDeferSeconds({}), 60);
  assert.equal(readWhatsappDownDeferSeconds({ WHATSAPP_DOWN_DEFER_SECONDS: '15' }), 15);
  assert.equal(readWhatsappDownDeferSeconds({ WHATSAPP_DOWN_DEFER_SECONDS: '0' }), 60);
  assert.equal(readWhatsappDownDeferSeconds({ WHATSAPP_DOWN_DEFER_SECONDS: 'forever' }), 60);
});

test('a job is deferred (not completed, no attempt, no AI call) while the session is down, then completes', async () => {
  db.exec('begin');
  let pool: InboundJobWorkerPool | undefined;
  try {
    const prefix = `fix6-gate-${Date.now()}`;
    let sessionStatus = 'FAILED';
    const monitor = new ChannelSessionMonitor({
      source: async (): Promise<ChannelSessionStatus> => ({
        status: sessionStatus,
        working: sessionStatus === 'WORKING',
        checkedAt: new Date(),
      }),
    });
    const keys = [`${prefix}:customer`, `${prefix}:owner`];
    for (const [index, eventKey] of keys.entries()) {
      insertInboundEvent(eventKey);
      enqueueInboundJob({
        eventKey,
        phone: `92300${Date.now() % 10_000_000}${index}`,
        body: `held message ${index}`,
        owner: index === 1,
        config,
      });
    }

    let modelTurns = 0;
    pool = new InboundJobWorkerPool(config, async (job) => {
      modelTurns += 1;
      // Stand-in for runTurn/runOwnerTurn: the first thing a real turn does
      // with the model is reserve an ai_model_calls row.
      reserveAiModelCall({ model: 'test-model', reservationId: `${prefix}:${job.id}` });
    }, {
      check: () => monitor.check(),
      deferMs: 60_000,
      onDeferred: (job) => monitor.recordHeld(job.id),
    });

    const before = Date.now();
    pool.kick();
    const rowsFor = () => db.prepare(`
      select status, attempt_count, available_at, last_error from inbound_jobs
      where event_key like ? order by id
    `).all(`${prefix}:%`) as Array<{
      status: string; attempt_count: number; available_at: string; last_error: string | null;
    }>;
    await waitFor(
      () => rowsFor().every((row) => row.status === 'pending' && row.last_error !== null),
      'both jobs deferred',
    );
    // Allow any stray re-claim to surface.
    await new Promise((resolve) => setTimeout(resolve, 30));

    const deferred = rowsFor();
    assert.equal(deferred.length, 2);
    for (const row of deferred) {
      assert.equal(row.status, 'pending', 'deferred, never completed');
      assert.equal(row.attempt_count, 0, 'a WhatsApp outage must not consume an attempt');
      assert.match(row.last_error ?? '', /deferred/);
      const availableAt = new Date(row.available_at.replace(' ', 'T') + 'Z').getTime();
      assert.ok(availableAt >= before + 59_000, 'deferred by about 60 seconds');
    }
    assert.equal(modelTurns, 0, 'no model turn while WhatsApp is down (customer and owner)');
    assert.equal(aiCallCount(prefix), 0, 'no ai_model_calls row while WhatsApp is down');
    assert.equal(monitor.snapshot().heldMessages, 2);
    assert.equal(monitor.snapshot().working, false);

    // Session returns: make the held jobs due again and let the pool drain.
    sessionStatus = 'WORKING';
    db.prepare("update inbound_jobs set available_at = '2000-01-01 00:00:00' where event_key like ?")
      .run(`${prefix}:%`);
    pool.kick();
    await waitFor(
      () => rowsFor().every((row) => row.status === 'completed'),
      'both jobs completed after recovery',
    );
    assert.equal(modelTurns, 2);
    assert.equal(aiCallCount(prefix), 2);
    assert.deepEqual(rowsFor().map((row) => row.attempt_count), [1, 1]);
  } finally {
    pool?.stop();
    db.exec('rollback');
  }
});

test('an erroring status check is treated as unknown and also defers', async () => {
  const monitor = new ChannelSessionMonitor({
    source: async () => { throw new Error('status endpoint unreachable'); },
  });
  const status = await monitor.check();
  assert.equal(status.working, false);
  assert.equal(status.status, 'UNKNOWN');
});

test('WAHA session status is cached for 10 s and timeout-guarded', async () => {
  const originalFetch = globalThis.fetch;
  let clock = 1_000_000;
  let calls = 0;
  try {
    globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
      calls += 1;
      assert.match(String(input), /\/api\/sessions\/test$/);
      assert.equal((init?.headers as Record<string, string>)['X-Api-Key'], 'k');
      return new Response(JSON.stringify({ status: 'FAILED' }), { status: 200 });
    };
    const adapter = new WahaAdapter({
      baseUrl: 'http://test.invalid', session: 'test', apiKey: 'k', now: () => clock,
    });
    assert.deepEqual(
      { ...(await adapter.getSessionStatus()), checkedAt: undefined },
      { status: 'FAILED', working: false, checkedAt: undefined },
    );
    clock += 9_000;
    await adapter.getSessionStatus();
    assert.equal(calls, 1, 'second check within 10 s served from cache');
    clock += 2_000;
    await adapter.getSessionStatus();
    assert.equal(calls, 2, 'refreshed after 10 s');

    globalThis.fetch = async () => { throw new DOMException('timed out', 'TimeoutError'); };
    clock += 11_000;
    const unknown = await adapter.getSessionStatus();
    assert.equal(unknown.working, false);
    assert.equal(unknown.status, 'UNKNOWN');
    assert.ok(unknown.error);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('WAHA 422 session error is channel_unavailable (retryable); a timeout stays uncertain', async () => {
  const originalFetch = globalThis.fetch;
  db.exec('begin');
  try {
    const adapter = new WahaAdapter({ baseUrl: 'http://test.invalid', session: 'test' });
    globalThis.fetch = async () => new Response(
      JSON.stringify({ statusCode: 422, message: 'Session status is not as expected', status: 'FAILED' }),
      { status: 422 },
    );
    let unavailable: unknown;
    try { await adapter.sendText('923001234567', 'hello'); } catch (error) { unavailable = error; }
    assert.ok(unavailable instanceof ChannelSendError);
    assert.equal(unavailable.code, 'channel_unavailable');
    assert.equal(unavailable.deliveryUncertain, false);

    globalThis.fetch = async () => { throw new DOMException('timed out', 'TimeoutError'); };
    let timeout: unknown;
    try { await adapter.sendText('923001234567', 'hello'); } catch (error) { timeout = error; }
    assert.ok(timeout instanceof ChannelSendError);
    assert.equal(timeout.deliveryUncertain, true);
    assert.notEqual(timeout.code, 'channel_unavailable');

    const customerId = Number(
      db.prepare('insert into customers (phone) values (?)').run(`fix6-${Date.now()}`).lastInsertRowid,
    );
    const base = { customerId, recipientKind: 'owner' as const, bodyHash: 'b' };
    const a = { ...base, id: `fix6-422-${Date.now()}`, eventKey: `fix6-422-ev-${Date.now()}` };
    assert.equal(beginOutboundAttempt(a), 'send');
    assert.equal(markOutboundFailure(a.id, unavailable), 'failed');
    const row = db.prepare('select status, last_error_code from send_ledger where id = ?').get(a.id);
    assert.deepEqual(row, { status: 'failed', last_error_code: 'channel_unavailable' });

    const t = { ...base, id: `fix6-timeout-${Date.now()}`, eventKey: `fix6-timeout-ev-${Date.now()}` };
    assert.equal(beginOutboundAttempt(t), 'send');
    assert.equal(markOutboundFailure(t.id, timeout), 'uncertain');
    assert.equal(beginOutboundAttempt(t), 'uncertain', 'a timed-out send is never resent');
  } finally {
    globalThis.fetch = originalFetch;
    db.exec('rollback');
  }
});

test('connection refused never reached WAHA, so it is channel_unavailable too', async () => {
  const originalFetch = globalThis.fetch;
  try {
    const adapter = new WahaAdapter({ baseUrl: 'http://test.invalid', session: 'test' });
    globalThis.fetch = async () => {
      throw Object.assign(new TypeError('fetch failed'), {
        cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }),
      });
    };
    await assert.rejects(
      adapter.sendText('923001234567', 'hello'),
      (error: unknown) => error instanceof ChannelSendError && error.code === 'channel_unavailable' &&
        error.deliveryUncertain === false,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('a rerun after channel_unavailable may send once for the same event, never twice', () => {
  db.exec('begin');
  try {
    const customerId = Number(
      db.prepare('insert into customers (phone) values (?)').run(`fix6-rerun-${Date.now()}`).lastInsertRowid,
    );
    const eventKey = `fix6-rerun-ev-${Date.now()}`;
    const first = { id: `fix6-rerun-a-${Date.now()}`, customerId, recipientKind: 'customer' as const, eventKey, bodyHash: 'a' };
    assert.equal(beginOutboundAttempt(first), 'send');
    markOutboundFailure(first.id, new ChannelSendError('422 session', false, 'channel_unavailable'));

    // Rerun of the deferred turn: the model may phrase the reply differently.
    const second = { ...first, id: `fix6-rerun-b-${Date.now()}`, bodyHash: 'b' };
    assert.equal(beginOutboundAttempt(second), 'send');
    markOutboundSent(second.id, 'provider-1');

    const third = { ...first, id: `fix6-rerun-c-${Date.now()}`, bodyHash: 'c' };
    assert.equal(beginOutboundAttempt(third), 'already_sent', 'one visible reply per inbound event');
    assert.deepEqual(
      db.prepare('select id, status, attempt_count from send_ledger where event_key = ?').all(eventKey),
      [{ id: second.id, status: 'sent', attempt_count: 2 }],
      'still exactly one ledger row for the event',
    );

    // A definitive non-session rejection keeps the old conservative rule.
    const otherEvent = `${eventKey}-other`;
    const rejected = { ...first, id: `fix6-rerun-d-${Date.now()}`, eventKey: otherEvent };
    assert.equal(beginOutboundAttempt(rejected), 'send');
    markOutboundFailure(rejected.id, new ChannelSendError('HTTP 400', false));
    assert.equal(beginOutboundAttempt({ ...rejected, id: `${rejected.id}-x` }), 'uncertain');
  } finally {
    db.exec('rollback');
  }
});

test('outage > 2 minutes logs once and produces one recovery summary with the held count', async () => {
  let clock = new Date('2030-01-01T01:00:00.000Z').getTime();
  let status = 'FAILED';
  const longOutages: Date[] = [];
  const recoveries: Array<{ heldMessages: number; message: string }> = [];
  const monitor = new ChannelSessionMonitor({
    source: async () => ({ status, working: status === 'WORKING', checkedAt: new Date(clock) }),
    now: () => new Date(clock),
    timezone: 'Asia/Karachi',
    onLongOutage: (since) => longOutages.push(since),
    onRecovered: (summary) => recoveries.push(summary),
  });
  await monitor.check();
  monitor.recordHeld(1);
  monitor.recordHeld(2);
  monitor.recordHeld(2);
  clock += 60_000;
  await monitor.check();
  assert.equal(longOutages.length, 0);
  clock += 90_000;
  await monitor.check();
  clock += 60_000;
  await monitor.check();
  assert.equal(longOutages.length, 1, 'logged once');
  const snap = monitor.snapshot();
  assert.equal(snap.working, false);
  assert.equal(snap.downSince, '2030-01-01T01:00:00.000Z');
  assert.equal(snap.reason, 'whatsapp_session_not_working');

  status = 'WORKING';
  clock += 30_000;
  await monitor.check();
  await monitor.check();
  assert.equal(recoveries.length, 1);
  assert.equal(recoveries[0].heldMessages, 2);
  assert.match(recoveries[0].message, /WhatsApp was disconnected from .*06:00.* to .*06:04/);
  assert.match(recoveries[0].message, /2 messages were held and are now being answered/);
  assert.equal(monitor.snapshot().working, true);
  assert.equal(monitor.snapshot().downSince, undefined);

  // A short blip produces no owner alert.
  status = 'STARTING';
  await monitor.check();
  clock += 30_000;
  status = 'WORKING';
  await monitor.check();
  assert.equal(recoveries.length, 1);
});

test('owner-alert retries back off and are capped instead of reaching 17 attempts', async () => {
  db.exec('begin');
  try {
    db.prepare("update owner_alerts set status = 'sent' where status = 'pending'").run();
    db.prepare("update owner_alerts set sent_at = '2000-01-01 00:00:00' where status = 'sent'").run();
    const customerId = Number(
      db.prepare('insert into customers (phone) values (?)').run(`fix6-alert-${Date.now()}`).lastInsertRowid,
    );
    let sendCalls = 0;
    const failing = async (): Promise<void> => {
      sendCalls += 1;
      throw new ChannelSendError('422 session', false, 'channel_unavailable');
    };
    const start = new Date('2030-01-01T00:00:00.000Z').getTime();
    await deliverOwnerAlert({
      kind: 'reply_failure', eventKey: `fix6-alert-${Date.now()}`, customerId,
      reason: 'test', send: failing, now: new Date(start),
    });
    assert.equal(sendCalls, 1);
    // The server's retry loop runs every 60 s; simulate 3 hours of it.
    for (let minute = 1; minute <= 180; minute += 1) {
      await retryPendingOwnerAlerts(failing, undefined, new Date(start + minute * 60_000));
    }
    assert.ok(
      sendCalls <= 1 + OWNER_ALERT_RETRY_POLICY.maxAutomaticRetries,
      `send attempts capped (got ${sendCalls})`,
    );
    assert.ok(sendCalls < 17);
    assert.ok(sendCalls >= 3, 'still retried a few times with backoff');
    const pending = db.prepare("select count(*) as n from owner_alerts where status = 'pending'").get() as { n: number };
    assert.equal(pending.n, 1, 'alert is kept (never deleted), just not hammered');

    // Delivery works again: a new occurrence of the same kind resets the backoff.
    let delivered = 0;
    const ok = async (): Promise<void> => { delivered += 1; };
    const result = await deliverOwnerAlert({
      kind: 'reply_failure', eventKey: `fix6-alert-next-${Date.now()}`, customerId,
      reason: 'test again', send: ok, now: new Date(start + 200 * 60_000),
    });
    assert.equal(result.status, 'sent');
    assert.equal(delivered, 1);
  } finally {
    db.exec('rollback');
  }
});
