import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import Database from 'better-sqlite3';

import {
  customerReport,
  DIFF_PRESETS,
  diffSnapshots,
  openReadOnlyDatabase,
  runCli,
  takeSnapshot,
  toSqliteUtc,
} from '../scripts/live-verify';

// This test never imports src/db.ts. It builds its own fixture database from
// db/schema.sql inside the isolated directory supplied by the test runner.
const isolatedPath = process.env.AHMED_TEST_DATABASE_PATH;
if (!isolatedPath) {
  throw new Error('Refusing to run outside the isolated test runner (AHMED_TEST_DATABASE_PATH missing).');
}
const workDir = path.join(path.dirname(path.resolve(isolatedPath)), 'live-verify');
fs.mkdirSync(workDir, { recursive: true });
const fixturePath = path.join(workDir, 'fixture.db');
const productionPath = path.resolve(__dirname, '..', 'ahmed.db');
assert.notEqual(path.resolve(fixturePath), productionPath);

const PHONE_A = '923001112222';
const PHONE_B = '923009998888';
const OWNER = '923331115555';
const CONTACT_A = '03001112222';
const ADDRESS_A = 'House 42, Street 7, Gulberg Lahore';
const RECIPIENT_A = 'Zainab Fixture';
const CLAIM_REFERENCE = 'TXN-ABC123456';
const PROVIDER_IN = `false_${PHONE_A}@c.us_3EB0AAA111`;
const PROVIDER_OUT = `true_${PHONE_A}@c.us_3EB0BBB222`;
const SECRETS = [PHONE_A, PHONE_B, OWNER, '3001112222', CONTACT_A, ADDRESS_A, 'House 42', RECIPIENT_A, CLAIM_REFERENCE];

const PENDING_HANDOFF_TEMPLATE =
  'Your request has been recorded for Ahmed, but the WhatsApp alert is still pending delivery. ' +
  'I cannot confirm that he has viewed it.';

function buildFixture(): void {
  fs.rmSync(fixturePath, { force: true });
  const db = new Database(fixturePath);
  db.exec(fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8'));
  db.pragma('foreign_keys = ON');
  const insertCustomer = db.prepare('insert into customers (phone) values (?)');
  const a = Number(insertCustomer.run(PHONE_A).lastInsertRowid);
  insertCustomer.run(PHONE_B);
  const owner = Number(insertCustomer.run(OWNER).lastInsertRowid);
  db.prepare("insert into products (name, size, color, price_minor, stock) values ('hoodie', 'M', 'black', 250000, 10)").run();

  // A delivered order with its debit and audit chain.
  const orderId = Number(db.prepare(`
    insert into orders (public_ref, customer_id, items_json, total_minor, recipient_name, contact_phone,
                        delivery_address, city, payment_method, status)
    values ('ORD-0123456789ABCDEF0123', ?, '[{"product_id":1,"qty":1,"price_minor":250000}]', 250000, ?, ?, ?, 'Lahore', 'cod', 'delivered')
  `).run(a, RECIPIENT_A, CONTACT_A, ADDRESS_A).lastInsertRowid);
  db.prepare("insert into ledger (customer_id, order_id, kind, amount_minor) values (?, ?, 'debit', 250000)").run(a, orderId);
  db.prepare(`
    insert into order_status_events (order_id, from_status, to_status, actor_type, actor_customer_id, source, evidence)
    values (?, null, 'placed', 'customer', ?, 'fixture', 'fixture order placed')
  `).run(orderId, a);

  // A prepared draft that is waiting for explicit confirmation.
  db.prepare(`
    insert into order_drafts (customer_id, items_json, total_minor, recipient_name, contact_phone, delivery_address,
                              city, payment_method, prepared_event_key)
    values (?, '[{"product_id":1,"qty":1,"price_minor":250000}]', 250000, ?, ?, ?, 'Lahore', 'cod', ?)
  `).run(a, RECIPIENT_A, CONTACT_A, ADDRESS_A, `waha:${PROVIDER_IN}:prepare_order`);

  db.prepare(`
    insert into inbound_events (event_key, channel, message_id, occurred_at, status)
    values (?, 'waha', ?, '2026-11-01T10:00:00.000Z', 'completed')
  `).run(`waha:${PROVIDER_IN}`, PROVIDER_IN);
  db.prepare("insert into messages (customer_id, direction, body, source_event_key) values (?, 'inbound', ?, ?)")
    .run(a, `My number is ${CONTACT_A} and address: ${ADDRESS_A}`, `waha:${PROVIDER_IN}`);
  db.prepare("insert into messages (customer_id, direction, body) values (?, 'outbound', ?)")
    .run(a, `We have 7 pieces left. Delivering to ${ADDRESS_A}, contact ${CONTACT_A}.`);
  db.prepare("insert into messages (customer_id, direction, body) values (?, 'outbound', ?)")
    .run(a, PENDING_HANDOFF_TEMPLATE);
  db.prepare(`
    insert into send_ledger (id, customer_id, event_key, body_hash, status, provider_message_id)
    values (?, ?, ?, 'hash', 'sent', ?)
  `).run(`waha:${PROVIDER_IN}:send:1`, a, `waha:${PROVIDER_IN}`, PROVIDER_OUT);
  db.prepare(`
    insert into payment_claims (customer_id, order_id, amount_minor, method, reference, status, event_key)
    values (?, ?, 250000, 'easypaisa', ?, 'pending', ?)
  `).run(a, orderId, CLAIM_REFERENCE, `waha:${PROVIDER_IN}:claim`);
  db.prepare(`
    insert into refund_requests (public_ref, customer_id, order_id, reason, eligibility)
    values ('RFD-0123456789ABCDEF0123', ?, ?, ?, 'eligible')
  `).run(a, orderId, `Wrong size, call me on ${CONTACT_A}`);
  db.prepare('insert into handoff_ledger (customer_id, reason) values (?, ?)').run(a, 'Customer asked about fabric GSM');
  db.prepare(`
    insert into customer_consent_events (customer_id, event_key, action, normalized_command, confirmation_status)
    values (?, ?, 'opt_out', 'stop', 'sent')
  `).run(a, `waha:false_${PHONE_A}@c.us_STOP1`);
  db.prepare(`
    insert into owner_alerts (kind, first_customer_id, latest_customer_id, latest_reason)
    values ('handoff', ?, ?, ?)
  `).run(a, a, `Customer ${PHONE_A} needs help`);
  void owner;
  db.close();
}

function fileSha256(filePath: string): string {
  return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function assertNoSecrets(output: string, label: string): void {
  for (const secret of SECRETS) {
    assert.equal(output.toLowerCase().includes(secret.toLowerCase()), false, `${label} leaked "${secret}"`);
  }
}

buildFixture();

test('the verifier refuses every write and leaves the database bytes unchanged', () => {
  const before = fileSha256(fixturePath);
  const db = openReadOnlyDatabase(fixturePath);
  try {
    assert.equal(db.readonly, true);
    assert.equal(Number(db.pragma('query_only', { simple: true })), 1);
    assert.throws(() => db.prepare("insert into customers (phone) values ('920000000001')").run());
    assert.throws(() => db.prepare('update products set stock = 0').run());
    assert.throws(() => db.prepare('delete from messages').run());
    assert.throws(() => db.exec('create table should_not_exist (id integer)'));
    // Even if query_only were switched off, the connection itself is read-only.
    db.pragma('query_only = OFF');
    assert.throws(() => db.prepare("insert into customers (phone) values ('920000000002')").run());
  } finally {
    db.close();
  }

  for (const argv of [
    ['snapshot', '--db', fixturePath],
    ['customer', '2222', '--db', fixturePath],
    ['since', '2000-01-01T00:00:00Z', '--db', fixturePath],
  ]) {
    assert.equal(runCli(argv).exitCode, 0);
  }
  assert.equal(fileSha256(fixturePath), before, 'read-only commands changed the database file');
  assert.throws(() => openReadOnlyDatabase(path.join(workDir, 'missing.db')), /unable to open|does not exist|SQLITE_CANTOPEN/i);
  assert.equal(fs.existsSync(path.join(workDir, 'missing.db')), false, 'fileMustExist must not create a database');
});

test('snapshot counts every schema table and reports integrity and foreign keys', () => {
  const db = openReadOnlyDatabase(fixturePath);
  try {
    const snapshot = takeSnapshot(db, fixturePath, new Date('2026-11-01T00:00:00Z'));
    assert.deepEqual(snapshot.integrity_check, ['ok']);
    assert.equal(snapshot.foreign_key_violations, 0);
    const schemaTables = [...fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8')
      .matchAll(/create table if not exists (\w+)/g)].map((match) => match[1]);
    assert.equal(schemaTables.length, 31); // 29 + turn_traces, turn_trace_events (observability)
    for (const table of schemaTables) assert.ok(`rows.${table}` in snapshot.values, `missing rows.${table}`);
    assert.equal(snapshot.values['rows.customers'], 3);
    assert.equal(snapshot.values['orders.status.delivered'], 1);
    assert.equal(snapshot.values['order_drafts.status.awaiting_confirmation'], 1);
    assert.equal(snapshot.values['products.stock_total'], 10);
    assert.equal(snapshot.values['invariant.orders_without_debit'], 0);
    assert.deepEqual(snapshot.unavailable, []);
    assertNoSecrets(JSON.stringify(snapshot), 'snapshot');
  } finally {
    db.close();
  }
});

test('diff presets prove HARD-02: bare Yes changes nothing, explicit confirm books exactly one order', () => {
  const s1 = path.join(workDir, 's1.json');
  const s2 = path.join(workDir, 's2.json');
  const s3 = path.join(workDir, 's3.json');
  for (const file of [s1, s2, s3]) fs.rmSync(file, { force: true });

  assert.equal(runCli(['snapshot', '--db', fixturePath, '--out', s1]).exitCode, 0);
  assert.throws(() => runCli(['snapshot', '--db', fixturePath, '--out', s1]), /EEXIST/, 'snapshots must never be overwritten');

  // "Yes": only conversation rows change.
  const writer = new Database(fixturePath);
  writer.prepare("insert into messages (customer_id, direction, body) values (1, 'inbound', 'Yes')").run();
  writer.prepare("insert into messages (customer_id, direction, body) values (1, 'outbound', 'Please reply confirm order to book it.')").run();
  writer.close();
  assert.equal(runCli(['snapshot', '--db', fixturePath, '--out', s2]).exitCode, 0);

  const yes = runCli(['diff', s1, s2, '--preset', 'hard02-yes']);
  assert.equal(yes.exitCode, 0, yes.output);
  assert.equal(JSON.parse(yes.output).verdict, 'PASS');
  assert.equal(JSON.parse(runCli(['diff', s1, s2, '--preset', 'no-change']).output).verdict, 'FAIL');
  assert.equal(runCli(['diff', s1, s1, '--preset', 'no-change']).exitCode, 0);

  // Explicit confirmation: the same effects confirm_order commits atomically.
  const confirm = new Database(fixturePath);
  confirm.pragma('foreign_keys = ON');
  confirm.transaction(() => {
    const orderId = Number(confirm.prepare(`
      insert into orders (public_ref, customer_id, items_json, total_minor, payment_method, status)
      values ('ORD-FFFFFFFFFFFFFFFFFFFF', 1, '[]', 250000, 'cod', 'confirmed')
    `).run().lastInsertRowid);
    confirm.prepare("insert into ledger (customer_id, order_id, kind, amount_minor) values (1, ?, 'debit', 250000)").run(orderId);
    confirm.prepare(`
      insert into order_status_events (order_id, from_status, to_status, actor_type, source, evidence)
      values (?, null, 'placed', 'customer', 'fixture', 'placed'), (?, 'placed', 'confirmed', 'customer', 'fixture', 'confirmed')
    `).run(orderId, orderId);
    confirm.prepare("update order_drafts set status = 'confirmed', order_id = ?, confirmed_at = datetime('now') where status = 'awaiting_confirmation'").run(orderId);
    confirm.prepare('update products set stock = stock - 1').run();
  })();
  confirm.close();
  assert.equal(runCli(['snapshot', '--db', fixturePath, '--out', s3]).exitCode, 0);

  const booked = runCli(['diff', s2, s3, '--preset', 'hard02-confirm']);
  assert.equal(booked.exitCode, 0, booked.output);
  assert.equal(JSON.parse(booked.output).verdict, 'PASS');
  const wronglyBookedOnYes = runCli(['diff', s2, s3, '--preset', 'hard02-yes']);
  assert.equal(wronglyBookedOnYes.exitCode, 1);
  assert.equal(JSON.parse(wronglyBookedOnYes.output).verdict, 'FAIL');

  // Direct API: a double booking fails the exact-one expectations.
  const before = JSON.parse(fs.readFileSync(s2, 'utf8'));
  const doubled = JSON.parse(fs.readFileSync(s3, 'utf8'));
  doubled.values['rows.orders'] += 1;
  doubled.values['ledger.debit_count'] += 1;
  const preset = DIFF_PRESETS['hard02-confirm'];
  assert.equal(diffSnapshots(before, doubled, preset).verdict, 'FAIL');
  assert.equal(JSON.parse(runCli(['diff', s2, s3, '--expect', 'rows.orders=+2']).output).verdict, 'FAIL');
});

test('customer report finds by last four digits, flags unsafe replies, and never prints PII', () => {
  const db = openReadOnlyDatabase(fixturePath);
  try {
    const report = customerReport(db, '2222') as { matched_customers: number; customers: any[] };
    assert.equal(report.matched_customers, 1);
    const customer = report.customers[0];
    assert.match(customer.customer.phone, /^\*+2222$/);
    const outbound = customer.messages.filter((message: any) => message.direction === 'outbound');
    const leaky = outbound.find((message: any) => message.review_flags.includes('exact_stock_count'));
    assert.ok(leaky, 'exact stock disclosure must be flagged');
    assert.ok(leaky.review_flags.includes('contains_stored_contact_or_address'));
    assert.ok(leaky.review_flags.includes('phone_or_email_like_text'));
    const handoff = outbound.find((message: any) => message.handoff_status_template === 'pending');
    assert.ok(handoff, 'the exact pending handoff template must be recognized');
    assert.deepEqual(handoff.review_flags, []);
    assert.equal(customer.payment_claims[0].has_reference, true);
    assert.equal('reference' in customer.payment_claims[0], false);
    assert.equal(customer.orders.some((order: any) => order.has_delivery_address === true), true);
    assert.equal(customer.consent_events[0].action, 'opt_out');

    assert.equal((customerReport(db, '0000') as { matched_customers: number }).matched_customers, 0);
    assert.throws(() => customerReport(db, '22'), /last 4 digits/);
    assert.throws(() => customerReport(db, PHONE_A), /last 4 digits/);
  } finally {
    db.close();
  }

  const cli = runCli(['customer', '2222', '--db', fixturePath]);
  assert.equal(cli.exitCode, 0);
  assertNoSecrets(cli.output, 'customer output');
  assert.match(cli.output, /\*+2222/);
  assertNoSecrets(runCli(['customer', '8888', '--db', fixturePath]).output, 'customer B output');
  assert.match(runCli(['customer', '2222', '--db', fixturePath, '--no-bodies']).output, /\[omitted \d+ chars\]/);
});

test('since lists rows touched after a timestamp across key tables without PII', () => {
  const all = runCli(['since', '2000-01-01T00:00:00+05:00', '--db', fixturePath]);
  assert.equal(all.exitCode, 0);
  const parsed = JSON.parse(all.output);
  assert.equal(parsed.since_utc, '1999-12-31 19:00:00');
  assert.deepEqual(parsed.unavailable, []);
  for (const table of ['customers', 'messages', 'orders', 'ledger', 'order_drafts', 'send_ledger', 'inbound_events',
    'payment_claims', 'refund_requests', 'handoff_ledger', 'customer_consent_events', 'owner_alerts']) {
    assert.ok(parsed.tables[table].count > 0, `${table} should have rows`);
  }
  assert.match(parsed.tables.inbound_events.rows[0].message_id, /\[phone ending 2222\]/);
  assertNoSecrets(all.output, 'since output');

  const future = JSON.parse(runCli(['since', '2999-01-01T00:00:00Z', '--db', fixturePath]).output);
  for (const table of Object.values(future.tables) as Array<{ count: number }>) assert.equal(table.count, 0);

  assert.equal(toSqliteUtc('2026-11-02T15:30:00+05:00'), '2026-11-02 10:30:00');
  assert.throws(() => toSqliteUtc('yesterday'), /ISO-8601/);
  assert.throws(() => toSqliteUtc('2026-11-02 10:00:00'), /ISO-8601/);
});
