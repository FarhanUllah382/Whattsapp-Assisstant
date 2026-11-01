/**
 * HARD-01 / HARD-02 live-acceptance verifier. READ-ONLY by construction:
 *
 *   - the database is opened with { readonly: true, fileMustExist: true };
 *   - `PRAGMA query_only = ON` is set before any query runs;
 *   - this file never imports src/db.ts (which opens ahmed.db read-write and
 *     runs startup migrations).
 *
 * Output never contains a full phone number, delivery address, recipient
 * name, payment reference, or verified transaction reference. Phones are
 * masked with src/privacy.ts helpers, free text goes through
 * sanitizeMemoryText(), provider/event identifiers through
 * redactSensitiveText(), and a final pass replaces any stored contact value
 * that still appears verbatim.
 *
 * Usage (see docs/HARD-01_LIVE_CHECKLIST.md):
 *   npm run --silent live:verify -- snapshot [--db <path>] [--out <file.json>]
 *   npm run --silent live:verify -- diff <a.json> <b.json> [--preset <name>] [--expect key=+1] [--forbid key|prefix*] [--strict]
 *   npm run --silent live:verify -- customer <last-4-digits> [--db <path>] [--limit 20] [--no-bodies]
 *   npm run --silent live:verify -- since <ISO-8601 timestamp> [--db <path>] [--no-bodies]
 */
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

import { buildHandoffStatusMessage, checkHandoffClaimReply } from '../src/handoff-claims';
import { checkInventoryDisclosureReply } from '../src/inventory-visibility';
import { checkPaymentInstructionReply } from '../src/payment-instructions';
import { maskPhoneForDisplay, redactSensitiveText, sanitizeMemoryText } from '../src/privacy';

type Db = Database.Database;
type Row = Record<string, unknown>;

export const DEFAULT_DATABASE_PATH = path.resolve(__dirname, '..', 'ahmed.db');
const BODY_PREVIEW_CHARS = 400;

// ---------------------------------------------------------------------------
// Opening
// ---------------------------------------------------------------------------

export function openReadOnlyDatabase(databasePath: string): Db {
  const resolved = path.resolve(databasePath);
  const db = new Database(resolved, { readonly: true, fileMustExist: true });
  db.pragma('query_only = ON');
  const queryOnly = db.pragma('query_only', { simple: true });
  if (Number(queryOnly) !== 1) {
    db.close();
    throw new Error('Refusing to continue: PRAGMA query_only could not be enabled.');
  }
  return db;
}

// ---------------------------------------------------------------------------
// Redaction
// ---------------------------------------------------------------------------

/** Provider/event identifiers (WAHA ids embed the sender's phone number). */
export function redactIdentifier(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const text = redactSensitiveText(String(value));
  // Defence in depth: any long digit run that survived (e.g. a 16+ digit
  // privacy id) keeps only its last four digits.
  return text.replace(/\d{7,}/g, (digits) => `[digits ending ${digits.slice(-4)}]`);
}

export function redactFreeText(value: unknown, includeBody = true): string | null {
  if (value === null || value === undefined) return null;
  if (!includeBody) return `[omitted ${String(value).length} chars]`;
  const safe = sanitizeMemoryText(String(value));
  return safe.length > BODY_PREVIEW_CHARS ? `${safe.slice(0, BODY_PREVIEW_CHARS)}…` : safe;
}

function refTail(value: unknown): string | null {
  if (typeof value !== 'string' || value.length < 6) return value === null || value === undefined ? null : '[ref]';
  return `${value.slice(0, 4)}…${value.slice(-6)}`;
}

const PHONE_KEYS = /(?:^|_)phone$/i;
const IDENTIFIER_KEYS =
  /^(?:event_key|source_event_key|message_id|provider_message_id|prepared_event_key|confirmed_event_key|confirm_event_key|send_id|action_id)$/i;
const FREE_TEXT_KEYS = /^(?:body|reason|summary|headline|evidence|detail|last_error|latest_reason|last_error_code)$/i;
const PUBLIC_REF_KEYS = /^(?:public_ref|order_public_ref|refund_public_ref)$/i;
/** Columns that must never be printed even in redacted form. */
const FORBIDDEN_KEYS =
  /^(?:recipient_name|contact_phone_raw|delivery_address|postal_code|delivery_instructions|reference|verified_reference|reference_hash|sender_hash|body_hash|items_json|aliases_json|name)$/i;

export function redactRow(row: Row, includeBodies = true): Row {
  const out: Row = {};
  for (const [key, value] of Object.entries(row)) {
    if (FORBIDDEN_KEYS.test(key)) {
      out[`has_${key}`] = value !== null && value !== undefined && String(value).trim() !== '';
    } else if (PHONE_KEYS.test(key)) {
      out[key] = value === null || value === undefined ? null : maskPhoneForDisplay(String(value));
    } else if (IDENTIFIER_KEYS.test(key)) {
      out[key] = redactIdentifier(value);
    } else if (FREE_TEXT_KEYS.test(key)) {
      out[key] = key === 'body' ? redactFreeText(value, includeBodies) : redactFreeText(value, true);
    } else if (PUBLIC_REF_KEYS.test(key)) {
      out[key] = refTail(value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

/** Every stored contact value that must never appear verbatim in output. */
function collectSecrets(db: Db): string[] {
  const secrets = new Set<string>();
  const add = (value: unknown, minLength: number) => {
    if (typeof value !== 'string') return;
    const trimmed = value.trim();
    if (trimmed.length >= minLength) secrets.add(trimmed);
    const digits = trimmed.replace(/\D/g, '');
    if (digits.length >= 7 && /^[+\d\s().-]+$/.test(trimmed)) secrets.add(digits);
  };
  const tryRows = (sql: string) => {
    try {
      return db.prepare(sql).all() as Row[];
    } catch {
      return [];
    }
  };
  for (const row of tryRows('select phone from customers')) add(row.phone, 7);
  for (const table of ['orders', 'order_drafts']) {
    for (const row of tryRows(`select contact_phone, delivery_address, recipient_name from ${table}`)) {
      add(row.contact_phone, 7);
      add(row.delivery_address, 6);
      add(row.recipient_name, 4);
    }
  }
  for (const row of tryRows('select reference from payment_claims where reference is not null')) add(row.reference, 6);
  for (const row of tryRows('select verified_reference from payment_claim_verifications')) add(row.verified_reference, 6);
  // Longest first so a phone is replaced before any shorter substring of it.
  return [...secrets].sort((a, b) => b.length - a.length);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Final safety net over the rendered output text. */
export function scrubOutput(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of secrets) {
    out = out.replace(new RegExp(escapeRegExp(secret), 'gi'), '[redacted]');
  }
  return out;
}

// ---------------------------------------------------------------------------
// Snapshot
// ---------------------------------------------------------------------------

export interface Snapshot {
  kind: 'live-verify-snapshot';
  version: 1;
  taken_at: string;
  database_file: string;
  integrity_check: string[];
  foreign_key_violations: number;
  foreign_key_sample: Row[];
  values: Record<string, number>;
  unavailable: string[];
}

function userTables(db: Db): string[] {
  return (db.prepare(
    "select name from sqlite_master where type = 'table' and name not like 'sqlite_%' order by name",
  ).all() as { name: string }[]).map((row) => row.name);
}

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

const GROUPED_COUNTS: ReadonlyArray<{ key: string; sql: string }> = [
  { key: 'orders.status', sql: 'select status as k, count(*) as n from orders group by status' },
  { key: 'order_drafts.status', sql: 'select status as k, count(*) as n from order_drafts group by status' },
  { key: 'payment_claims.status', sql: 'select status as k, count(*) as n from payment_claims group by status' },
  { key: 'refund_requests.status', sql: 'select status as k, count(*) as n from refund_requests group by status' },
  { key: 'send_ledger.status', sql: "select recipient_kind || ':' || status as k, count(*) as n from send_ledger group by recipient_kind, status" },
  { key: 'inbound_events.status', sql: 'select status as k, count(*) as n from inbound_events group by status' },
  { key: 'inbound_jobs.status', sql: "select turn_kind || ':' || status as k, count(*) as n from inbound_jobs group by turn_kind, status" },
  { key: 'consent_events', sql: "select action || ':' || confirmation_status as k, count(*) as n from customer_consent_events group by action, confirmation_status" },
  { key: 'owner_alerts.status', sql: 'select status as k, count(*) as n from owner_alerts group by status' },
  { key: 'ai_model_calls.status', sql: 'select status as k, count(*) as n from ai_model_calls group by status' },
  { key: 'inbound_abuse_events.decision', sql: "select actor_kind || ':' || decision as k, count(*) as n from inbound_abuse_events group by actor_kind, decision" },
  { key: 'messages.direction', sql: 'select direction as k, count(*) as n from messages group by direction' },
  { key: 'order_lookup_attempts.outcome', sql: 'select outcome as k, count(*) as n from order_lookup_attempts group by outcome' },
  { key: 'payment_claim_events.type', sql: 'select event_type as k, count(*) as n from payment_claim_events group by event_type' },
];

const SCALARS: ReadonlyArray<{ key: string; sql: string }> = [
  { key: 'customers.opted_out', sql: 'select count(*) as n from customers where automation_opted_out = 1' },
  { key: 'products.stock_total', sql: 'select coalesce(sum(stock), 0) as n from products' },
  { key: 'products.active', sql: 'select count(*) as n from products where active = 1' },
  { key: 'ledger.debit_count', sql: "select count(*) as n from ledger where kind = 'debit'" },
  { key: 'ledger.credit_count', sql: "select count(*) as n from ledger where kind = 'credit'" },
  { key: 'ledger.debit_minor', sql: "select coalesce(sum(amount_minor), 0) as n from ledger where kind = 'debit'" },
  { key: 'ledger.credit_minor', sql: "select coalesce(sum(amount_minor), 0) as n from ledger where kind = 'credit'" },
  { key: 'max_id.messages', sql: 'select coalesce(max(id), 0) as n from messages' },
  { key: 'max_id.orders', sql: 'select coalesce(max(id), 0) as n from orders' },
  { key: 'max_id.ledger', sql: 'select coalesce(max(id), 0) as n from ledger' },
  { key: 'max_id.order_drafts', sql: 'select coalesce(max(id), 0) as n from order_drafts' },
  // Reconciliation invariants. Legacy rows may make some non-zero; acceptance
  // checks look at the DELTA, which must stay 0.
  {
    key: 'invariant.orders_without_debit',
    sql: "select count(*) as n from orders o where not exists (select 1 from ledger l where l.order_id = o.id and l.kind = 'debit')",
  },
  {
    key: 'invariant.orders_without_status_event',
    sql: 'select count(*) as n from orders o where not exists (select 1 from order_status_events e where e.order_id = o.id)',
  },
  {
    key: 'invariant.drafts_confirmed_without_order',
    sql: "select count(*) as n from order_drafts where status = 'confirmed' and order_id is null",
  },
  {
    key: 'invariant.drafts_linked_to_missing_order',
    sql: 'select count(*) as n from order_drafts d where d.order_id is not null and not exists (select 1 from orders o where o.id = d.order_id)',
  },
  {
    key: 'invariant.orders_linked_to_multiple_drafts',
    sql: 'select count(*) as n from (select order_id from order_drafts where order_id is not null group by order_id having count(*) > 1)',
  },
  {
    key: 'invariant.inbound_events_with_multiple_jobs',
    sql: 'select count(*) as n from (select event_key from inbound_jobs group by event_key having count(*) > 1)',
  },
  {
    key: 'invariant.refund_requests_on_non_delivered_orders',
    sql: "select count(*) as n from refund_requests r join orders o on o.id = r.order_id where o.status <> 'delivered'",
  },
  {
    key: 'invariant.consent_events_pending',
    sql: "select count(*) as n from customer_consent_events where confirmation_status = 'pending'",
  },
  {
    key: 'invariant.send_ledger_uncertain',
    sql: "select count(*) as n from send_ledger where status = 'uncertain'",
  },
];

export function takeSnapshot(db: Db, databasePath: string, now: Date = new Date()): Snapshot {
  const values: Record<string, number> = {};
  const unavailable: string[] = [];
  for (const table of userTables(db)) {
    const row = db.prepare(`select count(*) as n from ${quoteIdent(table)}`).get() as { n: number };
    values[`rows.${table}`] = row.n;
  }
  for (const group of GROUPED_COUNTS) {
    try {
      for (const row of db.prepare(group.sql).all() as { k: string | null; n: number }[]) {
        values[`${group.key}.${row.k ?? 'null'}`] = row.n;
      }
    } catch {
      unavailable.push(group.key);
    }
  }
  for (const scalar of SCALARS) {
    try {
      values[scalar.key] = Number((db.prepare(scalar.sql).get() as { n: number }).n);
    } catch {
      unavailable.push(scalar.key);
    }
  }
  const integrity = (db.pragma('integrity_check') as { integrity_check: string }[]).map((row) => row.integrity_check);
  const fk = db.pragma('foreign_key_check') as Row[];
  return {
    kind: 'live-verify-snapshot',
    version: 1,
    taken_at: now.toISOString(),
    database_file: path.basename(databasePath),
    integrity_check: integrity,
    foreign_key_violations: fk.length,
    foreign_key_sample: fk.slice(0, 10).map((row) => ({ table: row.table, parent: row.parent, rowid: row.rowid })),
    values: Object.fromEntries(Object.entries(values).sort(([a], [b]) => a.localeCompare(b))),
    unavailable,
  };
}

// ---------------------------------------------------------------------------
// Diff with acceptance expectations
// ---------------------------------------------------------------------------

export type Expectation = { key: string; op: '=' | '<' | '>'; delta: number };

/** Keys whose change would be a business effect (money, stock, order state, cases). */
export const BUSINESS_KEYS: readonly string[] = [
  'rows.orders',
  'rows.order_drafts',
  'rows.order_status_events',
  'rows.ledger',
  'rows.payment_claims',
  'rows.payment_claim_action_intents',
  'rows.payment_claim_verifications',
  'rows.payment_claim_events',
  'rows.payment_claim_ledger_links',
  'rows.refund_requests',
  'rows.bookkeeping_receipts',
  'rows.products',
  'products.*',
  'orders.status.*',
  'order_drafts.status.*',
  'payment_claims.status.*',
  'refund_requests.status.*',
  'ledger.*',
  'invariant.*',
];

export interface DiffPreset {
  description: string;
  expect: Expectation[];
  forbid: string[];
  strict: boolean;
}

function exp(key: string, op: Expectation['op'], delta: number): Expectation {
  return { key, op, delta };
}

export const DIFF_PRESETS: Record<string, DiffPreset> = {
  'no-change': {
    description: 'Nothing at all may change (forged/invalid webhook, ignored traffic).',
    expect: [],
    forbid: [],
    strict: true,
  },
  'no-business-change': {
    description: 'Conversation rows may change; orders, drafts, ledger, stock, claims and refunds may not.',
    expect: [],
    forbid: [...BUSINESS_KEYS],
    strict: false,
  },
  'hard02-yes': {
    description:
      'Bare "Yes" against a prepared draft: no order, debit, audit event, stock reservation, claim or refund; ' +
      'a draft is still awaiting confirmation and none became confirmed (re-preparing a summary is allowed).',
    expect: [
      exp('order_drafts.status.awaiting_confirmation', '=', 0),
      exp('order_drafts.status.confirmed', '=', 0),
    ],
    forbid: BUSINESS_KEYS.filter((key) => key !== 'rows.order_drafts' && key !== 'order_drafts.status.*'),
    strict: false,
  },
  'hard02-confirm': {
    description: 'Explicit confirmation: exactly one order, one debit, two audit events, one draft link, stock reserved.',
    expect: [
      exp('rows.orders', '=', 1),
      exp('rows.ledger', '=', 1),
      exp('ledger.debit_count', '=', 1),
      exp('ledger.credit_count', '=', 0),
      exp('ledger.debit_minor', '>', 0),
      exp('rows.order_status_events', '=', 2),
      exp('orders.status.confirmed', '=', 1),
      exp('rows.order_drafts', '=', 0),
      exp('order_drafts.status.awaiting_confirmation', '=', -1),
      exp('order_drafts.status.confirmed', '=', 1),
      exp('products.stock_total', '<', 0),
      exp('rows.payment_claims', '=', 0),
      exp('rows.refund_requests', '=', 0),
      exp('rows.bookkeeping_receipts', '=', 0),
    ],
    forbid: ['invariant.*', 'payment_claims.status.*', 'refund_requests.status.*', 'rows.payment_claim_ledger_links'],
    strict: false,
  },
  'refund-request': {
    description: 'Delivered-order refund request: one review case, no money, ledger, stock, or order-state change.',
    expect: [exp('rows.refund_requests', '=', 1), exp('refund_requests.status.requested', '=', 1)],
    forbid: [
      'rows.orders',
      'rows.order_drafts',
      'rows.order_status_events',
      'rows.ledger',
      'ledger.*',
      'products.*',
      'orders.status.*',
      'rows.payment_claims',
      'payment_claims.status.*',
      'rows.payment_claim_ledger_links',
      'rows.bookkeeping_receipts',
      'invariant.*',
    ],
    strict: false,
  },
  'consent-command': {
    description: 'STOP/START: one consent event, no model call, no business change.',
    expect: [exp('rows.customer_consent_events', '=', 1), exp('rows.ai_model_calls', '=', 0), exp('rows.inbound_jobs', '=', 0)],
    forbid: [...BUSINESS_KEYS],
    strict: false,
  },
  'opted-out-message': {
    description: 'Message while opted out: event completed, no job, no model call, no outbound send.',
    expect: [
      exp('rows.inbound_jobs', '=', 0),
      exp('rows.ai_model_calls', '=', 0),
      exp('rows.send_ledger', '=', 0),
      exp('messages.direction.outbound', '=', 0),
      exp('rows.customer_consent_events', '=', 0),
    ],
    forbid: [...BUSINESS_KEYS],
    strict: false,
  },
};

export function parseExpectation(text: string): Expectation {
  const match = /^([A-Za-z0-9_.:*-]+)(=|<|>)([+-]?\d+)$/.exec(text.trim());
  if (!match) throw new Error(`Invalid --expect "${text}". Use key=+1, key=0, key<0 or key>0.`);
  return { key: match[1], op: match[2] as Expectation['op'], delta: Number(match[3]) };
}

function keyMatches(pattern: string, key: string): boolean {
  return pattern.endsWith('*') ? key.startsWith(pattern.slice(0, -1)) : key === pattern;
}

export interface DiffResult {
  kind: 'live-verify-diff';
  before_taken_at: string;
  after_taken_at: string;
  changes: Array<{ key: string; before: number; after: number; delta: number }>;
  checks: Array<{ check: string; pass: boolean; detail: string }>;
  verdict: 'PASS' | 'FAIL' | 'INFO';
}

export function readSnapshotFile(filePath: string): Snapshot {
  const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as Snapshot;
  if (parsed?.kind !== 'live-verify-snapshot' || typeof parsed.values !== 'object') {
    throw new Error(`${filePath} is not a live-verify snapshot.`);
  }
  return parsed;
}

export function diffSnapshots(
  before: Snapshot,
  after: Snapshot,
  options: { expect?: Expectation[]; forbid?: string[]; strict?: boolean } = {},
): DiffResult {
  const keys = [...new Set([...Object.keys(before.values), ...Object.keys(after.values)])].sort();
  const deltaOf = (key: string) => (after.values[key] ?? 0) - (before.values[key] ?? 0);
  const changes = keys
    .map((key) => ({ key, before: before.values[key] ?? 0, after: after.values[key] ?? 0, delta: deltaOf(key) }))
    .filter((change) => change.delta !== 0);

  const checks: DiffResult['checks'] = [];
  const integrityOk = after.integrity_check.length === 1 && after.integrity_check[0] === 'ok';
  checks.push({ check: 'after integrity_check = ok', pass: integrityOk, detail: after.integrity_check.slice(0, 3).join('; ') });
  checks.push({
    check: 'no new foreign_key_check violations',
    pass: after.foreign_key_violations <= before.foreign_key_violations,
    detail: `${before.foreign_key_violations} -> ${after.foreign_key_violations}`,
  });

  const expectations = options.expect ?? [];
  for (const expectation of expectations) {
    const delta = deltaOf(expectation.key);
    const pass =
      expectation.op === '=' ? delta === expectation.delta
        : expectation.op === '<' ? delta < expectation.delta
          : delta > expectation.delta;
    checks.push({
      check: `${expectation.key} delta ${expectation.op} ${expectation.delta}`,
      pass,
      detail: `actual delta ${delta >= 0 ? '+' : ''}${delta}`,
    });
  }
  const explicitlyExpected = (key: string) => expectations.some((expectation) => keyMatches(expectation.key, key));
  for (const pattern of options.forbid ?? []) {
    const offending = changes.filter((change) => keyMatches(pattern, change.key) && !explicitlyExpected(change.key));
    checks.push({
      check: `no change in ${pattern}`,
      pass: offending.length === 0,
      detail: offending.length === 0 ? 'unchanged' : offending.map((c) => `${c.key} ${c.delta >= 0 ? '+' : ''}${c.delta}`).join(', '),
    });
  }
  if (options.strict) {
    const unexpected = changes.filter((change) => !explicitlyExpected(change.key));
    checks.push({
      check: 'strict: no change other than expected keys',
      pass: unexpected.length === 0,
      detail: unexpected.length === 0 ? 'unchanged' : unexpected.map((c) => `${c.key} ${c.delta >= 0 ? '+' : ''}${c.delta}`).join(', '),
    });
  }
  const asserted = expectations.length > 0 || (options.forbid ?? []).length > 0 || options.strict === true;
  const allPass = checks.every((check) => check.pass);
  return {
    kind: 'live-verify-diff',
    before_taken_at: before.taken_at,
    after_taken_at: after.taken_at,
    changes,
    checks,
    verdict: !allPass ? 'FAIL' : asserted ? 'PASS' : 'INFO',
  };
}

// ---------------------------------------------------------------------------
// Outbound reply review flags (re-using the production backstops)
// ---------------------------------------------------------------------------

const HANDOFF_TEMPLATES: ReadonlyArray<{ status: string; body: string }> = (['sent', 'pending', 'none'] as const).map(
  (alertStatus) => ({ status: alertStatus, body: buildHandoffStatusMessage({ recorded: true, alertStatus }) ?? '' }),
);

const INTERNAL_ORDER_ID = /\border\s*(?:#|no\.?|number|id)\s*:?\s*#?\d{1,9}\b|#\d{1,9}\b/i;

export function reviewOutboundBody(body: string, privateValues: readonly string[]): Row {
  const flags: string[] = [];
  if (redactSensitiveText(body) !== body) flags.push('phone_or_email_like_text');
  const lower = body.toLowerCase();
  if (privateValues.some((value) => value.length >= 6 && lower.includes(value.toLowerCase()))) {
    flags.push('contains_stored_contact_or_address');
  }
  if (!checkInventoryDisclosureReply(body).ok) flags.push('exact_stock_count');
  if (!checkPaymentInstructionReply(body).ok) flags.push('payment_destination_or_placeholder');
  const template = HANDOFF_TEMPLATES.find((candidate) => candidate.body === body);
  if (!template && !checkHandoffClaimReply(body).ok) flags.push('handoff_or_human_action_wording');
  if (INTERNAL_ORDER_ID.test(body)) flags.push('possible_internal_order_id');
  return {
    review_flags: flags,
    handoff_status_template: template ? template.status : null,
  };
}

// ---------------------------------------------------------------------------
// customer <last-4>
// ---------------------------------------------------------------------------

function tableExists(db: Db, table: string): boolean {
  return Boolean(db.prepare("select 1 from sqlite_master where type = 'table' and name = ?").get(table));
}

function allRows(db: Db, sql: string, ...params: unknown[]): Row[] {
  return db.prepare(sql).all(...params) as Row[];
}

export function customerReport(
  db: Db,
  suffix: string,
  options: { limit?: number; includeBodies?: boolean } = {},
): Row {
  if (!/^\d{4}$/.test(suffix)) throw new Error('customer expects exactly the last 4 digits of the phone number.');
  const limit = Math.max(1, Math.min(200, Math.trunc(options.limit ?? 20)));
  const includeBodies = options.includeBodies ?? true;
  const customers = allRows(
    db,
    `select id, phone, disclosure_sent_at, automation_opted_out, opted_out_at, opted_in_at, created_at
       from customers
      where substr(replace(replace(replace(phone, '+', ''), ' ', ''), '-', ''), -4) = ?
      order by id`,
    suffix,
  );

  const reports = customers.map((customer) => {
    const id = customer.id as number;
    const privateValues: string[] = [String(customer.phone ?? '').replace(/\D/g, '')];
    for (const table of ['orders', 'order_drafts']) {
      for (const row of allRows(db, `select contact_phone, delivery_address, recipient_name from ${table} where customer_id = ?`, id)) {
        for (const value of [row.contact_phone, row.delivery_address, row.recipient_name]) {
          if (typeof value === 'string' && value.trim()) privateValues.push(value.trim());
          if (typeof value === 'string' && value.replace(/\D/g, '').length >= 7) privateValues.push(value.replace(/\D/g, ''));
        }
      }
    }

    const messages = allRows(
      db,
      `select m.id, m.direction, m.created_at, m.source_event_key, e.status as inbound_event_status, m.body
         from messages m left join inbound_events e on e.event_key = m.source_event_key
        where m.customer_id = ? order by m.id desc limit ?`,
      id,
      limit,
    ).map((row) => {
      const review = row.direction === 'outbound' ? reviewOutboundBody(String(row.body ?? ''), privateValues) : {};
      return { ...redactRow(row, includeBodies), ...review };
    });

    const report: Row = {
      customer: redactRow(customer),
      ledger_balance_minor:
        Number((db.prepare(
          "select coalesce(sum(case when kind = 'debit' then amount_minor else -amount_minor end), 0) as n from ledger where customer_id = ?",
        ).get(id) as { n: number }).n),
      consent_events: allRows(
        db,
        `select id, action, normalized_command, confirmation_status, created_at, confirmation_sent_at, event_key
           from customer_consent_events where customer_id = ? order by id desc limit ?`,
        id,
        limit,
      ).map((row) => redactRow(row)),
      messages,
      send_ledger: allRows(
        db,
        `select id as send_id, recipient_kind, status, attempt_count, provider_message_id, last_error_code, event_key, created_at, updated_at
           from send_ledger where customer_id = ? order by created_at desc limit ?`,
        id,
        limit,
      ).map((row) => redactRow(row)),
      inbound_jobs: allRows(
        db,
        `select id, turn_kind, status, attempt_count, event_key, created_at, completed_at, last_error
           from inbound_jobs where customer_id = ? order by id desc limit ?`,
        id,
        limit,
      ).map((row) => redactRow(row)),
      order_drafts: allRows(
        db,
        `select id, status, payment_method, total_minor, shipping_minor, order_id, prepared_event_key, confirmed_event_key,
                recipient_name, delivery_address, created_at, confirmed_at
           from order_drafts where customer_id = ? order by id desc limit ?`,
        id,
        limit,
      ).map((row) => redactRow(row)),
      orders: allRows(
        db,
        `select id, public_ref, status, payment_method, total_minor, shipping_minor, recipient_name, delivery_address, created_at
           from orders where customer_id = ? order by id desc limit ?`,
        id,
        limit,
      ).map((row) => redactRow(row)),
      order_status_events: allRows(
        db,
        `select e.id, e.order_id, e.from_status, e.to_status, e.actor_type, e.source, e.source_event_key, e.evidence, e.created_at
           from order_status_events e join orders o on o.id = e.order_id
          where o.customer_id = ? order by e.id desc limit ?`,
        id,
        limit,
      ).map((row) => redactRow(row)),
      ledger: allRows(
        db,
        'select id, order_id, kind, amount_minor, created_at from ledger where customer_id = ? order by id desc limit ?',
        id,
        limit,
      ),
      payment_claims: allRows(
        db,
        `select id, order_id, amount_minor, method, status, reference, event_key, created_at, resolved_at
           from payment_claims where customer_id = ? order by id desc limit ?`,
        id,
        limit,
      ).map((row) => redactRow(row)),
      refund_requests: allRows(
        db,
        `select id, public_ref, order_id, eligibility, status, reason, event_key, created_at, resolved_at
           from refund_requests where customer_id = ? order by id desc limit ?`,
        id,
        limit,
      ).map((row) => redactRow(row)),
      handoffs: allRows(
        db,
        'select id, reason, created_at from handoff_ledger where customer_id = ? order by id desc limit ?',
        id,
        limit,
      ).map((row) => redactRow(row)),
      owner_alerts: allRows(
        db,
        `select id, kind, status, occurrence_count, latest_reason, created_at, updated_at, sent_at
           from owner_alerts where first_customer_id = ? or latest_customer_id = ? order by id desc limit ?`,
        id,
        id,
        limit,
      ).map((row) => redactRow(row)),
      order_lookup_attempts: allRows(
        db,
        'select id, outcome, created_at from order_lookup_attempts where customer_id = ? order by id desc limit ?',
        id,
        limit,
      ),
      bookkeeping_receipts: allRows(
        db,
        'select effect, created_at from bookkeeping_receipts where customer_id = ? order by created_at desc limit ?',
        id,
        limit,
      ),
      memory: {
        checkpoint_updated_at:
          (db.prepare('select updated_at from checkpoints where customer_id = ?').get(id) as Row | undefined)?.updated_at ?? null,
        customer_notes: Number((db.prepare('select count(*) as n from customer_notes where customer_id = ?').get(id) as { n: number }).n),
      },
    };
    return report;
  });

  return {
    kind: 'live-verify-customer',
    phone_suffix: suffix,
    matched_customers: customers.length,
    note: customers.length > 1 ? 'More than one customer shares this suffix; compare masked phones.' : undefined,
    customers: reports,
  };
}

// ---------------------------------------------------------------------------
// since <ISO>
// ---------------------------------------------------------------------------

export function toSqliteUtc(iso: string): string {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/.test(iso.trim())) {
    throw new Error('since expects an ISO-8601 timestamp with Z or an offset, e.g. 2026-11-02T10:00:00+05:00');
  }
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) throw new Error(`Invalid timestamp: ${iso}`);
  return new Date(ms).toISOString().replace('T', ' ').replace(/\.\d+Z$/, '').replace('Z', '');
}

interface SinceSpec {
  table: string;
  sql: string; // must contain a single `{touched}` placeholder
  timeColumns: string[];
}

const SINCE_SPECS: readonly SinceSpec[] = [
  {
    table: 'customers',
    timeColumns: ['c.created_at', 'c.opted_out_at', 'c.opted_in_at', 'c.disclosure_sent_at'],
    sql: 'select c.id, c.phone, c.automation_opted_out, c.created_at, c.opted_out_at, c.opted_in_at from customers c where {touched} order by c.id',
  },
  {
    table: 'inbound_events',
    timeColumns: ['e.created_at', 'e.updated_at'],
    sql: 'select e.event_key, e.message_id, e.status, e.attempt_count, e.occurred_at, e.created_at, e.completed_at, e.last_error from inbound_events e where {touched} order by e.created_at',
  },
  {
    table: 'inbound_jobs',
    timeColumns: ['j.created_at', 'j.updated_at'],
    sql: 'select j.id, c.phone as customer_phone, j.turn_kind, j.status, j.attempt_count, j.event_key, j.created_at, j.completed_at, j.last_error from inbound_jobs j join customers c on c.id = j.customer_id where {touched} order by j.id',
  },
  {
    table: 'inbound_abuse_events',
    timeColumns: ['a.created_at'],
    sql: 'select a.event_key, a.actor_kind, a.decision, a.created_at from inbound_abuse_events a where {touched} order by a.created_at',
  },
  {
    table: 'messages',
    timeColumns: ['m.created_at'],
    sql: 'select m.id, c.phone as customer_phone, m.direction, m.source_event_key, m.created_at, m.body from messages m join customers c on c.id = m.customer_id where {touched} order by m.id',
  },
  {
    table: 'send_ledger',
    timeColumns: ['s.created_at', 's.updated_at'],
    sql: 'select s.id as send_id, c.phone as customer_phone, s.recipient_kind, s.status, s.attempt_count, s.provider_message_id, s.last_error_code, s.event_key, s.created_at, s.updated_at from send_ledger s join customers c on c.id = s.customer_id where {touched} order by s.created_at',
  },
  {
    table: 'customer_consent_events',
    timeColumns: ['ce.created_at', 'ce.confirmation_sent_at'],
    sql: 'select ce.id, c.phone as customer_phone, ce.action, ce.normalized_command, ce.confirmation_status, ce.created_at, ce.confirmation_sent_at from customer_consent_events ce join customers c on c.id = ce.customer_id where {touched} order by ce.id',
  },
  {
    table: 'order_drafts',
    timeColumns: ['d.created_at', 'd.updated_at', 'd.confirmed_at'],
    sql: 'select d.id, c.phone as customer_phone, d.status, d.payment_method, d.total_minor, d.order_id, d.prepared_event_key, d.confirmed_event_key, d.created_at, d.updated_at, d.confirmed_at from order_drafts d join customers c on c.id = d.customer_id where {touched} order by d.id',
  },
  {
    table: 'orders',
    timeColumns: ['o.created_at'],
    sql: 'select o.id, o.public_ref, c.phone as customer_phone, o.status, o.payment_method, o.total_minor, o.created_at from orders o join customers c on c.id = o.customer_id where {touched} order by o.id',
  },
  {
    table: 'order_status_events',
    timeColumns: ['ose.created_at'],
    sql: 'select ose.id, ose.order_id, ose.from_status, ose.to_status, ose.actor_type, ose.source, ose.source_event_key, ose.created_at from order_status_events ose where {touched} order by ose.id',
  },
  {
    table: 'ledger',
    timeColumns: ['l.created_at'],
    sql: 'select l.id, c.phone as customer_phone, l.order_id, l.kind, l.amount_minor, l.created_at from ledger l join customers c on c.id = l.customer_id where {touched} order by l.id',
  },
  {
    table: 'payment_claims',
    timeColumns: ['pc.created_at', 'pc.resolved_at', 'pc.approval_reversed_at'],
    sql: 'select pc.id, c.phone as customer_phone, pc.order_id, pc.amount_minor, pc.method, pc.status, pc.created_at, pc.resolved_at from payment_claims pc join customers c on c.id = pc.customer_id where {touched} order by pc.id',
  },
  {
    table: 'payment_claim_events',
    timeColumns: ['pce.created_at'],
    sql: 'select pce.id, pce.claim_id, pce.event_type, pce.amount_minor, pce.created_at from payment_claim_events pce where {touched} order by pce.id',
  },
  {
    table: 'refund_requests',
    timeColumns: ['r.created_at', 'r.resolved_at'],
    sql: 'select r.id, r.public_ref, c.phone as customer_phone, r.order_id, r.eligibility, r.status, r.created_at, r.resolved_at from refund_requests r join customers c on c.id = r.customer_id where {touched} order by r.id',
  },
  {
    table: 'handoff_ledger',
    timeColumns: ['h.created_at'],
    sql: 'select h.id, c.phone as customer_phone, h.reason, h.created_at from handoff_ledger h join customers c on c.id = h.customer_id where {touched} order by h.id',
  },
  {
    table: 'owner_alerts',
    timeColumns: ['oa.created_at', 'oa.updated_at', 'oa.sent_at'],
    sql: 'select oa.id, oa.kind, oa.status, oa.occurrence_count, oa.created_at, oa.updated_at, oa.sent_at from owner_alerts oa where {touched} order by oa.id',
  },
  {
    table: 'order_lookup_attempts',
    timeColumns: ['ola.created_at'],
    sql: 'select ola.id, c.phone as customer_phone, ola.outcome, ola.created_at from order_lookup_attempts ola join customers c on c.id = ola.customer_id where {touched} order by ola.id',
  },
  {
    table: 'bookkeeping_receipts',
    timeColumns: ['b.created_at'],
    sql: 'select c.phone as customer_phone, b.effect, b.created_at from bookkeeping_receipts b join customers c on c.id = b.customer_id where {touched} order by b.created_at',
  },
  {
    table: 'ai_model_calls',
    timeColumns: ['ai.started_at'],
    sql: 'select ai.model, ai.status, ai.prompt_tokens, ai.output_tokens, ai.total_tokens, ai.started_at, ai.finished_at from ai_model_calls ai where {touched} order by ai.started_at',
  },
];

export function sinceReport(db: Db, iso: string, options: { includeBodies?: boolean } = {}): Row {
  const cutoff = toSqliteUtc(iso);
  const tables: Row = {};
  const unavailable: string[] = [];
  for (const spec of SINCE_SPECS) {
    if (!tableExists(db, spec.table)) {
      unavailable.push(spec.table);
      continue;
    }
    const touched = spec.timeColumns.map((column) => `julianday(${column}) >= julianday(@cutoff)`).join(' or ');
    try {
      const rows = db.prepare(spec.sql.replace('{touched}', `(${touched})`)).all({ cutoff }) as Row[];
      tables[spec.table] = { count: rows.length, rows: rows.map((row) => redactRow(row, options.includeBodies ?? true)) };
    } catch (error) {
      unavailable.push(`${spec.table}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { kind: 'live-verify-since', since_utc: cutoff, tables, unavailable };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

interface ParsedArgs {
  positional: string[];
  db: string;
  out?: string;
  limit?: number;
  includeBodies: boolean;
  preset?: string;
  expect: Expectation[];
  forbid: string[];
  strict: boolean;
}

export function parseArgs(argv: readonly string[]): ParsedArgs {
  const parsed: ParsedArgs = { positional: [], db: DEFAULT_DATABASE_PATH, includeBodies: true, expect: [], forbid: [], strict: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      const value = argv[i + 1];
      if (value === undefined) throw new Error(`${arg} requires a value.`);
      i += 1;
      return value;
    };
    if (arg === '--db') parsed.db = next();
    else if (arg === '--out') parsed.out = next();
    else if (arg === '--limit') parsed.limit = Number(next());
    else if (arg === '--no-bodies') parsed.includeBodies = false;
    else if (arg === '--preset') parsed.preset = next();
    else if (arg === '--expect') parsed.expect.push(parseExpectation(next()));
    else if (arg === '--forbid') parsed.forbid.push(next());
    else if (arg === '--strict') parsed.strict = true;
    else if (arg.startsWith('--')) throw new Error(`Unknown option ${arg}`);
    else parsed.positional.push(arg);
  }
  return parsed;
}

const USAGE = `live-verify (read-only HARD-01 evidence helper)
  snapshot [--db ahmed.db] [--out before.json]
  diff <before.json> <after.json> [--preset ${Object.keys(DIFF_PRESETS).join('|')}] [--expect key=+1|key<0|key>0]... [--forbid key|prefix*]... [--strict]
  customer <last-4-digits> [--db ahmed.db] [--limit 20] [--no-bodies]
  since <ISO-8601 with Z or offset> [--db ahmed.db] [--no-bodies]
  presets`;

/** Runs one command and returns { output, exitCode }; never writes to the database. */
export function runCli(argv: readonly string[]): { output: string; exitCode: number } {
  const args = parseArgs(argv);
  const [command, ...rest] = args.positional;
  if (!command || command === 'help' || command === '--help') return { output: USAGE, exitCode: command ? 0 : 2 };

  if (command === 'presets') {
    return { output: JSON.stringify(DIFF_PRESETS, null, 2), exitCode: 0 };
  }

  if (command === 'diff') {
    if (rest.length !== 2) throw new Error('diff requires <before.json> <after.json>.');
    const preset = args.preset ? DIFF_PRESETS[args.preset] : undefined;
    if (args.preset && !preset) throw new Error(`Unknown preset ${args.preset}. Run \`presets\` to list them.`);
    const result = diffSnapshots(readSnapshotFile(rest[0]), readSnapshotFile(rest[1]), {
      expect: [...(preset?.expect ?? []), ...args.expect],
      forbid: [...(preset?.forbid ?? []), ...args.forbid],
      strict: args.strict || preset?.strict === true,
    });
    return {
      output: JSON.stringify({ preset: args.preset ?? null, ...result }, null, 2),
      exitCode: result.verdict === 'FAIL' ? 1 : 0,
    };
  }

  const db = openReadOnlyDatabase(args.db);
  try {
    let payload: unknown;
    if (command === 'snapshot') {
      payload = takeSnapshot(db, args.db);
    } else if (command === 'customer') {
      if (rest.length !== 1) throw new Error('customer requires the last 4 digits of the phone number.');
      payload = customerReport(db, rest[0], { limit: args.limit, includeBodies: args.includeBodies });
    } else if (command === 'since') {
      if (rest.length !== 1) throw new Error('since requires one ISO-8601 timestamp.');
      payload = sinceReport(db, rest[0], { includeBodies: args.includeBodies });
    } else {
      throw new Error(`Unknown command ${command}.\n${USAGE}`);
    }
    const output = scrubOutput(JSON.stringify(payload, null, 2), collectSecrets(db));
    if (args.out) {
      fs.writeFileSync(path.resolve(args.out), `${output}\n`, { flag: 'wx' });
      return { output: `wrote ${path.resolve(args.out)}`, exitCode: 0 };
    }
    return { output, exitCode: 0 };
  } finally {
    db.close();
  }
}

if (require.main === module) {
  try {
    const { output, exitCode } = runCli(process.argv.slice(2));
    process.stdout.write(`${output}\n`);
    process.exitCode = exitCode;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
  }
}
