// Shared turn/send plumbing used by both the customer and the owner turn:
// the global send lock, millisecond timestamps, inbound recording, the shared
// pacing state, and customer-row lookup. Split out of agent.ts; the send lock
// is a single module-level promise chain and must stay defined only here.

import type { ChannelImageMessage, ChannelSendReceipt } from '../channel/types';
import { db } from '../db';
import {
  dayStartInTz,
  parseActivationDateInTz,
  type PacingState,
} from '../guardrails/pacing/engine';
import type { Customer } from '../types';

export const MAX_TOOL_STEPS = 6; // hard ceiling so a confused AI can't loop forever

// How long a "sent" ledger entry blocks a repeat send. Long enough to cover
// a crash-and-retry (a provider redelivering a webhook happens in seconds),
// short enough that a customer genuinely repeating themselves next week
// still gets a reply instead of being silently swallowed forever.
export const SEND_RETRY_WINDOW_MS = 5 * 60 * 1000;
export type SendTextOperation = (text: string) => Promise<ChannelSendReceipt | void>;
export type SendImageOperation = (image: ChannelImageMessage) => Promise<ChannelSendReceipt | void>;

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Serializes every guarded send (pacing/spinning decision through the actual
// send + write) so concurrent turns can't each read the same stale "last
// sent"/"recent outbound" state before any of them commits. Found live
// 2026-09-05 (PROJECT-TRACKER-FINAL.md 1.3): server.ts awaits runTurn() per
// request with no lock, and Node yields at every await (the real LLM call,
// the pacing sleep below), so a burst of concurrent messages really did blow
// through the configured throttle instead of visibly spacing out — 5
// concurrent sends landed within ~230ms of each other against a 1200ms
// throttle, both in a direct test and live against the real number. A
// single in-process promise chain is the right scope here: one process, one
// WhatsApp number, no external queue needed for that.
let sendQueueTail: Promise<unknown> = Promise.resolve();

export function withSendLock<T>(fn: () => Promise<T>): Promise<T> {
  const result = sendQueueTail.then(fn, fn);
  sendQueueTail = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

// SQLite's `datetime('now')` (the schema's default for messages.created_at)
// only stores whole-second precision. getPacingState() below reads that value
// back as `lastSentAt` — with truncated seconds, the real enforced gap
// between sends can land up to ~999ms under the configured `throttleMs`,
// weakening the anti-ban throttle in practice. Found via live burst testing
// against the real pacing engine (2026-09-04), not the pure-function tests
// (which used precise injected clocks and never hit this). Same
// "YYYY-MM-DD HH:MM:SS[.mmm]" shape the existing parse code
// (`.replace(' ', 'T') + 'Z'`) already expects — just with milliseconds kept.
export function nowSql(): string {
  return new Date().toISOString().slice(0, 23).replace('T', ' ');
}

export function recordInboundMessageOnce(
  customerId: number,
  body: string,
  sourceEventKey?: string,
): void {
  if (sourceEventKey) {
    db.prepare(`
      insert into messages (customer_id, direction, body, source_event_key, created_at)
      values (?, 'inbound', ?, ?, ?)
      on conflict do nothing
    `).run(customerId, body, sourceEventKey, nowSql());
    return;
  }
  db.prepare(
    'insert into messages (customer_id, direction, body, created_at) values (?, ?, ?, ?)',
  ).run(customerId, 'inbound', body, nowSql());
}

// Pacing and spinning are both about protecting Ahmed's ONE sending number in
// aggregate, not any single customer's thread — so both look at sends across
// ALL customers, not just the one this turn is talking to.

export function getPacingState(timezone: string, now: Date = new Date()): PacingState {
  const last = db
    .prepare("select created_at from messages where direction = 'outbound' order by id desc limit 1")
    .get() as { created_at: string } | undefined;
  const lastSentAt = last ? new Date(last.created_at.replace(' ', 'T') + 'Z') : null;

  const todayStart = dayStartInTz(now, timezone);
  const todayStartSql = todayStart.toISOString().slice(0, 19).replace('T', ' ');
  const sentToday = (
    db
      .prepare("select count(*) as c from messages where direction = 'outbound' and created_at >= ?")
      .get(todayStartSql) as { c: number }
  ).c;

  const numberActivatedAt = parseActivationDateInTz(
    process.env.PACING_NUMBER_ACTIVATED_ON,
    timezone,
  );
  return { lastSentAt, sentToday, numberActivatedAt };
}

export function getOrCreateCustomer(phone: string): Customer {
  const existing = db.prepare('select * from customers where phone = ?').get(phone) as
    | Customer
    | undefined;
  if (existing) return existing;
  const result = db.prepare('insert into customers (phone) values (?)').run(phone);
  return db
    .prepare('select * from customers where id = ?')
    .get(result.lastInsertRowid) as Customer;
}
