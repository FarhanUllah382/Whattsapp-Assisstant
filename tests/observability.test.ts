import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';

// Observability (docs/OBSERVABILITY.md): /metrics format + fail-closed auth,
// per-message trace rows for stubbed turns, no PII in trace tables or metric
// labels, and tracing failures never break a turn.

process.env.GEMINI_API_KEY = 'TEST-GEMINI-KEY-observability';
delete process.env.GEMINI_PRICE_INPUT_PER_MTOK;
delete process.env.GEMINI_PRICE_OUTPUT_PER_MTOK;

import express from 'express';

import { runOwnerTurn, runTurn } from '../src/agent';
import { guardBlocked, makeSendMessageTool } from '../src/agent/send-guards';
import { db } from '../src/db';
import { PACING_DEFAULTS } from '../src/guardrails/pacing/defaults';
import {
  enqueueInboundJob,
  InboundJobDeferredError,
  InboundJobWorkerPool,
  readInboundJobConfig,
} from '../src/inbound-jobs';
import { installObservability, observabilityAccessAllowed } from '../src/obs/http';
import {
  incCounter,
  METRIC,
  readCounter,
  readModelPrices,
  renderPrometheus,
  setWhatsappSessionUp,
} from '../src/obs/metrics';
import { pruneTraces, readRecentTraces, readTraceRetentionDays, readTraceWithEvents } from '../src/obs/trace';

const OPS_KEY = 'obs-test-key-0123456789abcdef';

type Parts = unknown[];
type Script = (request: { tools?: unknown[] }, loopCall: number) => Parts;

function stubGemini(script: Script): () => void {
  const originalFetch = globalThis.fetch;
  let loopCalls = 0;
  globalThis.fetch = (async (_url: unknown, init?: { body?: string }) => {
    const request = JSON.parse(String(init?.body ?? '{}'));
    const hasTools = Array.isArray(request.tools) && request.tools.length > 0;
    if (hasTools) loopCalls += 1;
    const parts = hasTools ? script(request, loopCalls) : [{ text: '{}' }];
    return new Response(JSON.stringify({
      candidates: [{ content: { parts } }],
      usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 7, totalTokenCount: 107 },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return () => {
    globalThis.fetch = originalFetch;
  };
}

function openPacingWindow(): () => void {
  const original = { start: PACING_DEFAULTS.windowStartHour, end: PACING_DEFAULTS.windowEndHour };
  PACING_DEFAULTS.windowStartHour = 0;
  PACING_DEFAULTS.windowEndHour = 24;
  return () => {
    PACING_DEFAULTS.windowStartHour = original.start;
    PACING_DEFAULTS.windowEndHour = original.end;
  };
}

let phoneCounter = 0;
function uniquePhone(): string {
  phoneCounter += 1;
  return `9233${String(Date.now()).slice(-6)}${String(phoneCounter).padStart(2, '0')}`;
}

function latestTraceFor(customerPhone: string) {
  const customer = db.prepare('select id from customers where phone = ?').get(customerPhone) as { id: number };
  const trace = db.prepare('select * from turn_traces where customer_id = ? order by id desc limit 1')
    .get(customer.id) as Record<string, any>;
  const events = db.prepare('select * from turn_trace_events where trace_id = ? order by seq')
    .all(trace.id) as Array<Record<string, any>>;
  return { customerId: customer.id, trace, events };
}

function insertInboundEvent(eventKey: string): void {
  const now = new Date().toISOString();
  db.prepare(`
    insert into inbound_events
      (event_key, channel, message_id, occurred_at, status, processing_started_at, updated_at)
    values (?, 'test', ?, ?, 'processing', ?, ?)
  `).run(eventKey, eventKey, now, now, now);
}

async function withServer<T>(operation: (baseUrl: string) => Promise<T>): Promise<T> {
  const app = express();
  const stop = installObservability(app, { sessionProbe: async () => ({ ok: true }) });
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  const { port } = server.address() as AddressInfo;
  try {
    return await operation(`http://127.0.0.1:${port}`);
  } finally {
    stop();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test('metrics auth fails closed: no key configured, short key, missing or wrong bearer', async () => {
  assert.equal(observabilityAccessAllowed(`Bearer ${OPS_KEY}`, undefined), false);
  assert.equal(observabilityAccessAllowed('Bearer short', 'short'), false);
  assert.equal(observabilityAccessAllowed(undefined, OPS_KEY), false);
  assert.equal(observabilityAccessAllowed(OPS_KEY, OPS_KEY), false, 'bare key without Bearer scheme');
  assert.equal(observabilityAccessAllowed(`Bearer ${OPS_KEY}x`, OPS_KEY), false);
  assert.equal(observabilityAccessAllowed(`Bearer ${OPS_KEY}`, OPS_KEY), true);

  const originalKey = process.env.OPERATIONS_API_KEY;
  try {
    await withServer(async (baseUrl) => {
      delete process.env.OPERATIONS_API_KEY;
      for (const path of ['/metrics', '/operations/traces', '/operations/traces/1']) {
        const response = await fetch(`${baseUrl}${path}`, { headers: { authorization: `Bearer ${OPS_KEY}` } });
        assert.equal(response.status, 401, `${path} must fail closed without a configured key`);
      }
      process.env.OPERATIONS_API_KEY = 'too-short-key';
      assert.equal((await fetch(`${baseUrl}/metrics`, { headers: { authorization: 'Bearer too-short-key' } })).status, 401);

      process.env.OPERATIONS_API_KEY = OPS_KEY;
      assert.equal((await fetch(`${baseUrl}/metrics`)).status, 401);
      assert.equal((await fetch(`${baseUrl}/operations/traces`)).status, 401);
      assert.equal((await fetch(`${baseUrl}/metrics`, { headers: { 'x-operations-key': OPS_KEY } })).status, 401);
      const ok = await fetch(`${baseUrl}/metrics`, { headers: { authorization: `Bearer ${OPS_KEY}` } });
      assert.equal(ok.status, 200);
      assert.match(ok.headers.get('content-type') ?? '', /^text\/plain;.*version=0\.0\.4/);
      const text = await ok.text();
      assert.match(text, /^wa_whatsapp_session_up 1$/m);
      assert.match(text, /^wa_queue_jobs\{status="pending"\} \d+$/m);
      assert.match(text, /^wa_ai_budget_used_ratio [\d.e-]+$/m);
      assert.match(text, /^wa_owner_alerts_pending \d+$/m);
      assert.match(text, /^wa_trace_write_failures_total \d+$/m);
    });
  } finally {
    if (originalKey === undefined) delete process.env.OPERATIONS_API_KEY;
    else process.env.OPERATIONS_API_KEY = originalKey;
  }
});

test('metrics output is valid Prometheus text format with histograms and bounded labels', () => {
  incCounter(METRIC.guardBlocks, { check: 'Some Weird Check +923001234567 text!' });
  setWhatsappSessionUp(false);
  const text = renderPrometheus();
  const sample = /^[a-zA-Z_:][a-zA-Z0-9_:]*(\{[a-zA-Z_][a-zA-Z0-9_]*="[a-z0-9_.+Inf]*"(,[a-zA-Z_][a-zA-Z0-9_]*="[a-z0-9_.+Inf]*")*\})? -?[0-9.e+-]+$/;
  for (const line of text.trim().split('\n')) {
    if (line.startsWith('# HELP ') || line.startsWith('# TYPE ')) continue;
    assert.match(line, sample, `invalid exposition line: ${line}`);
  }
  assert.match(text, /^# TYPE wa_turn_duration_seconds histogram$/m);
  assert.match(text, /^# TYPE wa_turns_total counter$/m);
  assert.match(text, /^wa_whatsapp_session_up 0$/m);
  // Free text in a label is clamped to a short safe token; digits survive but no
  // '+', spaces or case — and real call sites only pass fixed ids.
  assert.doesNotMatch(text, /\+923001234567|Weird Check/);
  // Cost is hidden unless both prices are configured.
  assert.equal(readModelPrices(), null);
  assert.doesNotMatch(text, /wa_estimated_cost_usd_total/);
});

test('guard vetoes carry a stable check id and keep the teaching text unchanged', async () => {
  const blocked = guardBlocked('spinning', { ok: false as const, error: 'Vary the wording.' });
  assert.deepEqual(blocked, { ok: false, error: 'Vary the wording.', check: 'spinning' });
  const tool = makeSendMessageTool(async () => ({}), 'guard-check-test');
  const empty = await tool.execute({ body: '   ' }, { customerId: 1 }) as { ok: boolean; error: string; check: string };
  assert.equal(empty.check, 'empty_body');
  assert.equal(empty.error, 'Message text must be a non-empty string.');
});

test('a stubbed customer turn writes one trace with ordered model, tool and send events', async () => {
  const restoreWindow = openPacingWindow();
  const restoreFetch = stubGemini(() => [
    { functionCall: { name: 'send_message', args: { body: 'Black hoodie is available in M and L. Price Rs 800.' } } },
  ]);
  const phone = uniquePhone();
  const before = readCounter(METRIC.turns, { turn_kind: 'customer', outcome: 'replied' });
  try {
    await runTurn(phone, 'Black hoodie available hai?', async () => ({ providerMessageId: 'obs-1' }), `obs-replied-${phone}`);
  } finally {
    restoreFetch();
    restoreWindow();
  }
  const { trace, events } = latestTraceFor(phone);
  assert.equal(trace.turn_kind, 'customer');
  assert.equal(trace.outcome, 'replied');
  assert.ok(trace.finished_at);
  assert.ok(trace.model_calls >= 2, 'loop call(s) + closing summary call');
  assert.equal(trace.prompt_tokens, trace.model_calls * 100);
  assert.equal(trace.output_tokens, trace.model_calls * 7);
  assert.ok(Number.isInteger(trace.total_ms));
  assert.deepEqual(events.map((event) => event.seq), events.map((_event, index) => index + 1));
  const kinds = events.map((event) => event.kind);
  assert.equal(kinds[0], 'model_call');
  const toolEvent = events.find((event) => event.kind === 'tool_call');
  assert.equal(toolEvent?.name, 'send_message');
  assert.equal(toolEvent?.ok, 1);
  const sendEvent = events.find((event) => event.kind === 'send');
  assert.equal(sendEvent?.name, 'customer');
  assert.equal(sendEvent?.code, 'sent');
  assert.ok(kinds.indexOf('tool_call') < kinds.indexOf('send') || kinds.indexOf('send') > 0);
  assert.equal(readCounter(METRIC.turns, { turn_kind: 'customer', outcome: 'replied' }), before + 1);
  assert.ok(readCounter(METRIC.sends, { recipient_kind: 'customer', status: 'sent' }) >= 1);

  const listed = readRecentTraces({ limit: 5 });
  assert.equal(listed[0].id, trace.id);
  const detail = readTraceWithEvents(trace.id);
  assert.equal(detail?.events.length, events.length);
});

test('a blocked turn records each guard block by check id and a fallback outcome', async () => {
  const restoreWindow = openPacingWindow();
  const restoreFetch = stubGemini(() => [
    { functionCall: { name: 'send_message', args: { body: 'We have 7 pieces left in that size.' } } },
  ]);
  const phone = uniquePhone();
  const blocksBefore = readCounter(METRIC.guardBlocks, { check: 'inventory_disclosure' });
  try {
    await runTurn(phone, 'How many running shoes of size 43?', async () => ({ providerMessageId: 'obs-2' }), `obs-fallback-${phone}`);
  } finally {
    restoreFetch();
    restoreWindow();
  }
  const { trace, events } = latestTraceFor(phone);
  assert.equal(trace.outcome, 'fallback');
  const guardEvents = events.filter((event) => event.kind === 'guard_block');
  assert.ok(guardEvents.length >= 1);
  assert.ok(guardEvents.every((event) => event.code === 'inventory_disclosure'));
  const detail = JSON.parse(guardEvents[0].detail_json);
  assert.deepEqual(Object.keys(detail).sort(), ['body_length', 'body_sha256_12']);
  assert.equal(events.filter((event) => event.kind === 'fallback').length, 1);
  assert.equal(events.find((event) => event.kind === 'fallback')?.ok, 1);
  assert.ok(readCounter(METRIC.guardBlocks, { check: 'inventory_disclosure' }) > blocksBefore);
  assert.ok(readCounter(METRIC.fallbackReplies) >= 1);
});

test('an owner turn is traced with turn_kind owner', async () => {
  const restoreWindow = openPacingWindow();
  const phone = uniquePhone();
  try {
    await runOwnerTurn(
      phone,
      'sales today?',
      async () => ({ providerMessageId: 'obs-owner' }),
      async () => ({ content: [{ type: 'text', text: 'Sales today: none yet.' }], stop_reason: 'end_turn' }),
      `obs-owner-${phone}`,
    );
  } finally {
    restoreWindow();
  }
  const { trace, events } = latestTraceFor(phone);
  assert.equal(trace.turn_kind, 'owner');
  assert.equal(trace.outcome, 'replied');
  assert.equal(events.find((event) => event.kind === 'send')?.name, 'owner');
});

test('durable jobs are traced with job id and lifecycle; deferred jobs get outcome deferred', async () => {
  const restoreWindow = openPacingWindow();
  const restoreFetch = stubGemini(() => [
    { functionCall: { name: 'send_message', args: { body: 'Jeans are available in sizes 30, 32 and 34.' } } },
  ]);
  const config = { ...readInboundJobConfig(), workerCount: 1 };
  const phone = uniquePhone();
  const deferPhone = uniquePhone();
  try {
    insertInboundEvent(`obs-job-${phone}`);
    insertInboundEvent(`obs-defer-${deferPhone}`);
    const queued = enqueueInboundJob({ eventKey: `obs-job-${phone}`, phone, body: 'jeans sizes?', owner: false, config });
    assert.equal(queued.queued, true);
    const deferred = enqueueInboundJob({ eventKey: `obs-defer-${deferPhone}`, phone: deferPhone, body: 'hello', owner: false, config });
    assert.equal(deferred.queued, true);
    let done = 0;
    await new Promise<void>((resolve, reject) => {
      const pool = new InboundJobWorkerPool(config, async (job) => {
        try {
          if (job.phone === deferPhone) throw new InboundJobDeferredError('WhatsApp session is not WORKING', 60_000);
          await runTurn(job.phone, job.body, async () => ({ providerMessageId: 'obs-job' }), job.eventKey);
        } finally {
          done += 1;
          if (done === 2) setTimeout(() => { pool.stop(); resolve(); }, 50);
        }
      });
      pool.kick();
      setTimeout(() => reject(new Error('pool did not finish')), 10_000).unref();
    });
    const jobTrace = latestTraceFor(phone);
    assert.equal(jobTrace.trace.job_id, (queued as { jobId: number }).jobId);
    assert.equal(jobTrace.trace.outcome, 'replied');
    const jobEvents = jobTrace.events.filter((event) => event.kind === 'job').map((event) => event.name);
    assert.deepEqual(jobEvents, ['started', 'completed']);
    assert.equal(db.prepare('select count(*) n from turn_traces where job_id = ?').get(jobTrace.trace.job_id).n, 1);

    const deferredTrace = latestTraceFor(deferPhone);
    assert.equal(deferredTrace.trace.outcome, 'deferred');
    assert.equal(deferredTrace.trace.model_calls, 0);
    assert.deepEqual(deferredTrace.events.map((event) => event.name), ['started', 'deferred']);
    assert.ok(readCounter(METRIC.jobEvents, { event: 'queued' }) >= 2);
    assert.ok(readCounter(METRIC.inboundMessages, { turn_kind: 'customer' }) >= 2);
  } finally {
    restoreFetch();
    restoreWindow();
  }
});

test('trace tables and metrics never contain message bodies or phone numbers', () => {
  const phones = (db.prepare('select phone from customers').all() as Array<{ phone: string }>).map((row) => row.phone);
  const bodies = (db.prepare('select body from messages').all() as Array<{ body: string }>)
    .map((row) => row.body)
    .filter((body) => body.length >= 8);
  assert.ok(phones.length >= 4 && bodies.length >= 4, 'previous tests created traced conversations');
  const traceText = JSON.stringify([
    db.prepare('select * from turn_traces').all(),
    db.prepare('select * from turn_trace_events').all(),
  ]);
  const metricsText = renderPrometheus();
  for (const phone of phones) {
    assert.equal(traceText.includes(phone), false, 'phone found in trace tables');
    assert.equal(traceText.includes(phone.slice(-7)), false, 'phone fragment found in trace tables');
    assert.equal(metricsText.includes(phone), false, 'phone found in metrics');
  }
  for (const body of bodies) {
    assert.equal(traceText.includes(body), false, `message body found in trace tables: ${body.slice(0, 20)}`);
    assert.equal(metricsText.includes(body), false, 'message body found in metrics');
  }
  const columns = [
    ...(db.pragma('table_info(turn_traces)') as Array<{ name: string }>),
    ...(db.pragma('table_info(turn_trace_events)') as Array<{ name: string }>),
  ].map((column) => column.name);
  for (const forbidden of ['body', 'phone', 'text', 'name_text', 'address']) {
    assert.equal(columns.includes(forbidden), false, `trace column ${forbidden} must not exist`);
  }
});

test('estimated cost appears only when both prices are configured', () => {
  try {
    process.env.GEMINI_PRICE_INPUT_PER_MTOK = '0.10';
    assert.equal(readModelPrices(), null);
    process.env.GEMINI_PRICE_OUTPUT_PER_MTOK = '0.40';
    assert.deepEqual(readModelPrices(), { input: 0.1, output: 0.4 });
    assert.match(renderPrometheus(), /^wa_estimated_cost_usd_total [\d.e-]+$/m);
    process.env.GEMINI_PRICE_OUTPUT_PER_MTOK = 'free';
    assert.equal(readModelPrices(), null);
  } finally {
    delete process.env.GEMINI_PRICE_INPUT_PER_MTOK;
    delete process.env.GEMINI_PRICE_OUTPUT_PER_MTOK;
  }
});

test('trace retention deletes only traces older than TRACE_RETENTION_DAYS', () => {
  assert.equal(readTraceRetentionDays({}), 14);
  assert.equal(readTraceRetentionDays({ TRACE_RETENTION_DAYS: '3' }), 3);
  assert.equal(readTraceRetentionDays({ TRACE_RETENTION_DAYS: '-1' }), 14);
  assert.equal(readTraceRetentionDays({ TRACE_RETENTION_DAYS: 'abc' }), 14);
  const old = Number(db.prepare(`
    insert into turn_traces (turn_kind, started_at, outcome) values ('customer', '2020-01-01T00:00:00.000Z', 'replied')
  `).run().lastInsertRowid);
  db.prepare(`insert into turn_trace_events (trace_id, seq, at, kind) values (?, 1, '2020-01-01T00:00:00.000Z', 'job')`).run(old);
  const recentCount = (db.prepare('select count(*) n from turn_traces where id <> ?').get(old) as { n: number }).n;
  assert.ok(pruneTraces(14) >= 1);
  assert.equal(db.prepare('select count(*) n from turn_traces where id = ?').get(old).n, 0);
  assert.equal(db.prepare('select count(*) n from turn_trace_events where trace_id = ?').get(old).n, 0);
  assert.equal((db.prepare('select count(*) n from turn_traces').get() as { n: number }).n, recentCount);
});

// Must stay last: it drops the trace tables for this test database.
test('a tracing failure never breaks the turn; it is counted in a metric', async () => {
  db.exec('drop table turn_trace_events; drop table turn_traces;');
  const failuresBefore = readCounter(METRIC.traceWriteFailures);
  const restoreWindow = openPacingWindow();
  const restoreFetch = stubGemini(() => [
    { functionCall: { name: 'send_message', args: { body: 'White sneakers are available in size 42.' } } },
  ]);
  const phone = uniquePhone();
  const sends: string[] = [];
  try {
    await runTurn(phone, 'white sneakers 42?', async (body) => { sends.push(body); return { providerMessageId: 'obs-x' }; }, `obs-broken-${phone}`);
  } finally {
    restoreFetch();
    restoreWindow();
  }
  assert.equal(sends.length, 1);
  assert.match(sends[0], /White sneakers are available in size 42/);
  assert.ok(readCounter(METRIC.traceWriteFailures) > failuresBefore);
  assert.match(renderPrometheus(), /^wa_trace_write_failures_total [1-9]\d*$/m);
});
