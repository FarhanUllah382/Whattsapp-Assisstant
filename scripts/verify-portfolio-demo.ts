import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

const root = path.resolve(__dirname, '..');
const demoDbPath = path.join(root, 'portfolio-demo', 'data', 'portfolio-demo.db');
const runtimeRoot = path.join(root, '.portfolio-runtime');
const realDbPath = path.join(root, 'ahmed.db');
const realDatabaseFiles = [realDbPath, `${realDbPath}-wal`, `${realDbPath}-shm`];

// ahmed.db is gitignored and legitimately absent in a clean checkout (e.g.
// CI). This step must never create it — it only proves that if one is
// present on disk, this script leaves it untouched and distinct from the
// synthetic demo database.
type FileFingerprint = { exists: boolean; sha256?: string; size?: number };

function fingerprint(filePath: string): FileFingerprint {
  if (!fs.existsSync(filePath)) return { exists: false };
  const bytes = fs.readFileSync(filePath);
  return { exists: true, sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length };
}

function snapshotRealDatabase(): Record<string, FileFingerprint> {
  return Object.fromEntries(realDatabaseFiles.map((filePath) => [path.basename(filePath), fingerprint(filePath)]));
}

const realDbBefore = snapshotRealDatabase();
assert.notEqual(path.resolve(demoDbPath), path.resolve(realDbPath));

assert.ok(fs.existsSync(demoDbPath), 'The synthetic demo database should exist after the build.');

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

const realDbAfter = snapshotRealDatabase();
assert.deepEqual(realDbAfter, realDbBefore, 'ahmed.db must remain untouched by the portfolio demo build/verify.');

process.stdout.write(
  realDbBefore['ahmed.db'].exists
    ? 'Portfolio demo verification passed: synthetic data, all statuses, real readers, read-only enforcement, and ahmed.db left unchanged.\n'
    : 'Portfolio demo verification passed: synthetic data, all statuses, real readers, and read-only enforcement (ahmed.db absent, as expected in a clean checkout).\n',
);
