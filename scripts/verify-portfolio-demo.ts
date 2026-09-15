import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

const root = path.resolve(__dirname, '..');
const demoDbPath = path.join(root, 'portfolio-demo', 'data', 'portfolio-demo.db');
const runtimeRoot = path.join(root, '.portfolio-runtime');
const realDbPath = path.join(root, 'ahmed.db');

assert.ok(fs.existsSync(realDbPath), 'The real database should remain present and separate.');
assert.ok(fs.existsSync(demoDbPath), 'The synthetic demo database should exist after the build.');
assert.notEqual(path.resolve(demoDbPath), path.resolve(realDbPath));

const demoDb = new Database(demoDbPath, { readonly: true, fileMustExist: true });
const phones = demoDb.prepare('select phone from customers order by id').pluck().all() as string[];
assert.deepEqual(phones, ['DEMO-CUSTOMER-001', 'DEMO-CUSTOMER-002', 'DEMO-CUSTOMER-003']);
assert.ok(phones.every((phone) => !/^\+?\d+$/.test(phone)), 'Demo identifiers must not be dialable phone numbers.');

const statuses = demoDb.prepare('select distinct status from orders order by status').pluck().all() as string[];
assert.deepEqual(statuses, ['cancelled', 'confirmed', 'delivered', 'paid', 'placed', 'shipped']);

const messageCount = demoDb.prepare('select count(*) from messages').pluck().get() as number;
assert.equal(messageCount, 12);
demoDb.close();

const runtimeDbModule = require(path.join(runtimeRoot, 'src', 'db')) as { db: Database.Database };
assert.equal(runtimeDbModule.db.pragma('query_only', { simple: true }), 1);
assert.throws(
  () => runtimeDbModule.db.prepare("insert into customers (phone, name) values ('NOPE', 'Nope')").run(),
  /readonly|read-only|attempt to write/i,
);

const analytics = require(path.join(runtimeRoot, 'src', 'analytics')) as typeof import('../src/analytics');
const followups = require(path.join(runtimeRoot, 'src', 'followups')) as typeof import('../src/followups');
assert.equal(analytics.getSalesToday(), 7200);
assert.deepEqual(analytics.getUnpaidCustomers().map((customer) => customer.balance_owed), [4400, 3200, 2800]);
assert.equal(analytics.getTopSellingProduct()?.name, 'Everyday Polo');
assert.equal(followups.getPendingFollowups().length, 2);
runtimeDbModule.db.close();

const runtimeFiles = fs
  .readdirSync(runtimeRoot, { recursive: true, withFileTypes: true })
  .filter((entry) => entry.isFile())
  .map((entry) => path.join(entry.parentPath, entry.name));
const sourceText = runtimeFiles
  .filter((file) => /\.(?:ts|js)$/i.test(file))
  .map((file) => fs.readFileSync(file, 'utf8'))
  .join('\n');
for (const forbidden of ['send_message', 'record_order', 'update_order_status', 'notify_owner', 'recordDebit', 'recordCredit']) {
  assert.ok(!sourceText.includes(forbidden), `Public runtime must not contain ${forbidden}.`);
}

process.stdout.write('Portfolio demo verification passed: synthetic data, all statuses, real readers, and read-only enforcement.\n');
