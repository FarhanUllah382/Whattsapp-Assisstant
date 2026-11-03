// Per-message traces: one `turn_traces` row per processed message plus an
// ordered list of `turn_trace_events` (job lifecycle, model calls, tool calls,
// guard blocks, sends, fallback, errors). See docs/OBSERVABILITY.md.
//
// Two rules this file must never break:
//  1. PRIVACY — no message bodies, phone numbers, names, addresses or payment
//     destinations are ever written. Callers pass only ids, tool names, stable
//     guard check ids and status codes; a reply body, when given, is reduced
//     here to its length and a short SHA-256 prefix.
//  2. NEVER BREAK A TURN — every database write is wrapped in try/catch; a
//     failure only increments `wa_trace_write_failures_total`.
//
// The current trace travels with the async call chain via AsyncLocalStorage,
// so instrumentation sites (llm.ts, send guards, outbound-delivery) do not
// need a trace id passed in. Outside a traced turn every helper still records
// its metric and simply skips the trace row.

import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';

import { db } from '../db';
import {
  recordFallbackMetric,
  recordGuardBlockMetric,
  recordJobEventMetric,
  recordModelCallMetric,
  recordSendMetric,
  recordToolCallMetric,
  recordTraceWriteFailure,
  recordTurnMetric,
  safeLabel,
} from './metrics';

export type TurnKind = 'customer' | 'owner' | 'unknown';
// `silenced` = intentional silence (the customer opted out with STOP). A reply
// held by pacing is dropped, not resent later, so that turn is `no_reply`. It is a metric outcome only: the
// turn_traces.outcome CHECK constraint predates it and existing tables are
// never rewritten, so the trace row stores `no_reply` plus a `send` event
// named `silenced`.
export type TurnOutcome = 'replied' | 'fallback' | 'no_reply' | 'silenced' | 'error' | 'deferred';
export type TraceEventKind = 'job' | 'model_call' | 'tool_call' | 'guard_block' | 'send' | 'fallback' | 'error';
export type JobLifecycle = 'completed' | 'deferred' | 'retry' | 'failed';

/** Outcomes stored in turn_traces (and accepted by the traces filter). */
export const TRACE_OUTCOMES: readonly TurnOutcome[] = ['replied', 'fallback', 'no_reply', 'error', 'deferred'];

interface TraceState {
  id: number | null;
  jobId: number | null;
  customerId: number | null;
  turnKind: TurnKind;
  startMs: number;
  seq: number;
  modelCalls: number;
  promptTokens: number;
  outputTokens: number;
  successfulSends: number;
  outcomeHint?: TurnOutcome;
  finished: boolean;
}

const storage = new AsyncLocalStorage<TraceState>();

function safeWrite<T>(write: () => T): T | undefined {
  try {
    return write();
  } catch {
    recordTraceWriteFailure();
    return undefined;
  }
}

function nowIso(): string {
  return new Date().toISOString();
}

function nonNegativeInteger(value: unknown): number {
  return Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : 0;
}

/** Length + short hash: enough to correlate, never enough to read. */
export function fingerprintText(text: string): { length: number; sha256_12: string } {
  return { length: text.length, sha256_12: createHash('sha256').update(text).digest('hex').slice(0, 12) };
}

function openTrace(input: { jobId?: number | null; customerId?: number | null; turnKind: TurnKind }): TraceState {
  const state: TraceState = {
    id: null,
    jobId: input.jobId ?? null,
    customerId: input.customerId ?? null,
    turnKind: input.turnKind,
    startMs: Date.now(),
    seq: 0,
    modelCalls: 0,
    promptTokens: 0,
    outputTokens: 0,
    successfulSends: 0,
    finished: false,
  };
  safeWrite(() => {
    const result = db.prepare(`
      insert into turn_traces (job_id, customer_id, turn_kind, started_at)
      values (?, ?, ?, ?)
    `).run(state.jobId, state.customerId, state.turnKind, new Date(state.startMs).toISOString());
    state.id = Number(result.lastInsertRowid);
  });
  return state;
}

function addEvent(
  state: TraceState | undefined,
  event: {
    kind: TraceEventKind;
    name?: string;
    durationMs?: number;
    promptTokens?: number;
    outputTokens?: number;
    ok?: boolean;
    code?: string;
    detail?: Record<string, string | number | boolean | null>;
  },
): void {
  if (!state || state.id === null || state.finished) return;
  state.seq += 1;
  const seq = state.seq;
  safeWrite(() => {
    db.prepare(`
      insert into turn_trace_events
        (trace_id, seq, at, kind, name, duration_ms, prompt_tokens, output_tokens, ok, code, detail_json)
      values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      state.id,
      seq,
      nowIso(),
      event.kind,
      event.name === undefined ? null : safeLabel(event.name),
      event.durationMs === undefined ? null : Math.max(0, Math.round(event.durationMs)),
      event.promptTokens ?? null,
      event.outputTokens ?? null,
      event.ok === undefined ? null : event.ok ? 1 : 0,
      event.code === undefined ? null : safeLabel(event.code),
      event.detail ? JSON.stringify(event.detail) : null,
    );
  });
}

function classifyError(error: unknown): TurnOutcome {
  const name = error instanceof Error ? error.name : '';
  return name === 'AiBudgetExceededError' || name === 'InboundJobDeferredError' ? 'deferred' : 'error';
}

function finishTrace(state: TraceState, outcome: TurnOutcome): void {
  if (state.finished) return;
  const totalMs = Date.now() - state.startMs;
  if (outcome === 'silenced') addEvent(state, { kind: 'send', name: 'silenced', ok: false });
  const storedOutcome: TurnOutcome = outcome === 'silenced' ? 'no_reply' : outcome;
  if (state.id !== null) {
    safeWrite(() => {
      db.prepare(`
        update turn_traces
           set finished_at = ?, outcome = ?, model_calls = ?, prompt_tokens = ?, output_tokens = ?,
               total_ms = ?, customer_id = coalesce(customer_id, ?)
         where id = ?
      `).run(
        nowIso(),
        storedOutcome,
        state.modelCalls,
        state.promptTokens,
        state.outputTokens,
        totalMs,
        state.customerId,
        state.id,
      );
    });
  }
  state.finished = true;
  recordTurnMetric({
    turnKind: state.turnKind,
    outcome,
    durationMs: totalMs,
    modelCalls: state.modelCalls,
    promptTokens: state.promptTokens,
  });
}

function completedOutcome(state: TraceState): TurnOutcome {
  return state.outcomeHint ?? (state.successfulSends > 0 ? 'replied' : 'no_reply');
}

// ── Job and turn scopes ──────────────────────────────────────────────────────

export interface JobTraceHandle {
  run<T>(operation: () => Promise<T>): Promise<T>;
  finish(lifecycle: JobLifecycle, error?: unknown): void;
}

/** Opens the trace for one durable inbound job attempt (inbound-jobs.ts). */
export function openJobTrace(job: { id: number; turnKind: string; customerId?: number }): JobTraceHandle {
  let state: TraceState | undefined;
  try {
    state = openTrace({
      jobId: job.id,
      customerId: job.customerId ?? null,
      turnKind: job.turnKind === 'owner' ? 'owner' : job.turnKind === 'customer' ? 'customer' : 'unknown',
    });
    recordJobEventMetric('started');
    addEvent(state, { kind: 'job', name: 'started' });
  } catch {
    recordTraceWriteFailure();
  }
  return {
    run: (operation) => (state ? storage.run(state, operation) : operation()),
    finish: (lifecycle, error) => {
      try {
        recordJobEventMetric(lifecycle);
        if (!state) return;
        if (error !== undefined && lifecycle !== 'deferred') {
          addEvent(state, { kind: 'error', code: error instanceof Error ? error.name : 'error', ok: false });
        }
        addEvent(state, { kind: 'job', name: lifecycle, ok: lifecycle === 'completed' });
        finishTrace(state, lifecycle === 'completed' ? completedOutcome(state) : lifecycle === 'deferred' ? 'deferred' : 'error');
      } catch {
        recordTraceWriteFailure();
      }
    },
  };
}

/**
 * Runs one turn inside a trace. Inside a job trace it only attaches the
 * customer id; called directly (tests, scripts) it opens and finishes its own.
 */
export async function withTurnTrace<T>(
  input: { turnKind: TurnKind; customerId?: number },
  operation: () => Promise<T>,
): Promise<T> {
  const existing = storage.getStore();
  if (existing && !existing.finished) {
    if (input.customerId !== undefined) traceCustomer(input.customerId);
    return operation();
  }
  let state: TraceState;
  try {
    state = openTrace({ customerId: input.customerId ?? null, turnKind: input.turnKind });
  } catch {
    recordTraceWriteFailure();
    return operation();
  }
  return storage.run(state, async () => {
    try {
      const result = await operation();
      try { finishTrace(state, completedOutcome(state)); } catch { recordTraceWriteFailure(); }
      return result;
    } catch (error) {
      try {
        addEvent(state, { kind: 'error', code: error instanceof Error ? error.name : 'error', ok: false });
        finishTrace(state, classifyError(error));
      } catch {
        recordTraceWriteFailure();
      }
      throw error;
    }
  });
}

// ── Instrumentation helpers ─────────────────────────────────────────────────

/** Attaches the internal customer id (never the phone) to the current trace. */
export function traceCustomer(customerId: number): void {
  const state = storage.getStore();
  if (!state || state.finished || state.customerId !== null) return;
  state.customerId = customerId;
  safeWrite(() => {
    db.prepare('update turn_traces set customer_id = coalesce(customer_id, ?) where id = ?')
      .run(customerId, state.id);
  });
}

/** Turn code states what the customer actually got (replied/fallback/no_reply). */
export function traceTurnOutcome(outcome: 'replied' | 'fallback' | 'no_reply' | 'silenced'): void {
  const state = storage.getStore();
  if (state) state.outcomeHint = outcome;
}

export function traceModelCall(input: {
  ok: boolean;
  status: string;
  durationMs: number;
  promptTokens?: unknown;
  outputTokens?: unknown;
  providerCall: boolean;
}): void {
  try {
    const promptTokens = nonNegativeInteger(input.promptTokens);
    const outputTokens = nonNegativeInteger(input.outputTokens);
    recordModelCallMetric({ ...input, promptTokens, outputTokens });
    const state = storage.getStore();
    if (!state) return;
    if (input.providerCall) {
      state.modelCalls += 1;
      state.promptTokens += promptTokens;
      state.outputTokens += outputTokens;
    }
    addEvent(state, {
      kind: 'model_call',
      name: 'gemini',
      durationMs: input.durationMs,
      promptTokens,
      outputTokens,
      ok: input.ok,
      code: input.status,
    });
  } catch {
    recordTraceWriteFailure();
  }
}

/** Times one tool execution; never changes its result or error. */
export async function traceToolCall<T>(name: string, operation: () => Promise<T> | T): Promise<T> {
  const started = Date.now();
  const output = await operation();
  try {
    const record = output as { ok?: unknown; error?: unknown } | null | undefined;
    const ok = !(record && typeof record === 'object' && (record.ok === false || (record.error !== undefined && record.ok !== true)));
    recordToolCallMetric(name, ok);
    addEvent(storage.getStore(), { kind: 'tool_call', name, durationMs: Date.now() - started, ok });
  } catch {
    recordTraceWriteFailure();
  }
  return output;
}

export function traceGuardBlock(check: string, body?: unknown): void {
  try {
    recordGuardBlockMetric(check);
    addEvent(storage.getStore(), {
      kind: 'guard_block',
      name: check,
      ok: false,
      code: check,
      detail: typeof body === 'string' ? { body_length: fingerprintText(body).length, body_sha256_12: fingerprintText(body).sha256_12 } : undefined,
    });
  } catch {
    recordTraceWriteFailure();
  }
}

export function traceFallback(ok: boolean, code?: string): void {
  try {
    recordFallbackMetric();
    addEvent(storage.getStore(), { kind: 'fallback', name: 'fallback_reply', ok, code });
  } catch {
    recordTraceWriteFailure();
  }
}

const inFlightSends = new Map<string, { recipientKind: string; startedMs: number }>();

/** outbound-delivery.ts: a send_ledger attempt is about to reach the provider. */
export function traceSendStarted(sendId: string, recipientKind: string): void {
  try {
    if (inFlightSends.size > 1_000) inFlightSends.clear();
    inFlightSends.set(sendId, { recipientKind, startedMs: Date.now() });
  } catch {
    recordTraceWriteFailure();
  }
}

/** outbound-delivery.ts: the ledger row reached its post-attempt status. */
export function traceSendFinished(sendId: string, ledgerStatus: string): void {
  try {
    const started = inFlightSends.get(sendId);
    inFlightSends.delete(sendId);
    const recipientKind = started?.recipientKind ?? 'unknown';
    const durationMs = started ? Date.now() - started.startedMs : undefined;
    recordSendMetric(recipientKind, ledgerStatus, durationMs);
    const state = storage.getStore();
    if (state && ledgerStatus === 'sent') state.successfulSends += 1;
    addEvent(state, {
      kind: 'send',
      name: recipientKind,
      durationMs,
      ok: ledgerStatus === 'sent',
      code: ledgerStatus,
      detail: { ledger_status: ledgerStatus, send_ref: sendId.slice(0, 12) },
    });
  } catch {
    recordTraceWriteFailure();
  }
}

// ── Retention and read API ───────────────────────────────────────────────────

export function readTraceRetentionDays(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.TRACE_RETENTION_DAYS?.trim() ?? '';
  const parsed = /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
  return Number.isSafeInteger(parsed) && parsed >= 1 && parsed <= 365 ? parsed : 14;
}

export function pruneTraces(retentionDays = readTraceRetentionDays(), now = new Date()): number {
  const cutoff = new Date(now.getTime() - retentionDays * 86_400_000).toISOString();
  return safeWrite(() => db.transaction(() => {
    db.prepare(`
      delete from turn_trace_events
       where trace_id in (select id from turn_traces where started_at < ?)
    `).run(cutoff);
    return db.prepare('delete from turn_traces where started_at < ?').run(cutoff).changes;
  })()) ?? 0;
}

export interface TraceRow {
  id: number;
  job_id: number | null;
  customer_id: number | null;
  turn_kind: string;
  started_at: string;
  finished_at: string | null;
  outcome: string | null;
  model_calls: number;
  prompt_tokens: number;
  output_tokens: number;
  total_ms: number | null;
}

export function readRecentTraces(input: { limit?: unknown; outcome?: unknown } = {}): TraceRow[] {
  const rawLimit = Number(input.limit);
  const limit = Number.isSafeInteger(rawLimit) && rawLimit >= 1 ? Math.min(rawLimit, 500) : 50;
  const outcome = typeof input.outcome === 'string' && (TRACE_OUTCOMES as readonly string[]).includes(input.outcome)
    ? input.outcome
    : null;
  return db.prepare(`
    select id, job_id, customer_id, turn_kind, started_at, finished_at, outcome,
           model_calls, prompt_tokens, output_tokens, total_ms
      from turn_traces
     where (? is null or outcome = ?)
     order by id desc
     limit ?
  `).all(outcome, outcome, limit) as TraceRow[];
}

export function readTraceWithEvents(id: unknown): { trace: TraceRow; events: unknown[] } | null {
  const traceId = Number(id);
  if (!Number.isSafeInteger(traceId) || traceId < 1) return null;
  const trace = db.prepare(`
    select id, job_id, customer_id, turn_kind, started_at, finished_at, outcome,
           model_calls, prompt_tokens, output_tokens, total_ms
      from turn_traces where id = ?
  `).get(traceId) as TraceRow | undefined;
  if (!trace) return null;
  const events = (db.prepare(`
    select seq, at, kind, name, duration_ms, prompt_tokens, output_tokens, ok, code, detail_json
      from turn_trace_events where trace_id = ? order by seq
  `).all(traceId) as Array<Record<string, unknown>>).map(({ detail_json, ...rest }) => ({
    ...rest,
    detail: typeof detail_json === 'string' ? JSON.parse(detail_json) : null,
  }));
  return { trace, events };
}
