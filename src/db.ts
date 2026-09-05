import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

// One file, one database. Swap for Postgres later if you outgrow SQLite —
// nothing else in this project needs to change, because every other file
// only ever imports `db` from here (same "one seam" idea as llm.ts).
export const db = new Database(path.join(__dirname, '..', 'ahmed.db'));

const schema = fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf-8');
db.exec(schema);

// `create table if not exists` only bootstraps a table that doesn't exist yet —
// it won't retrofit a column added to schema.sql onto a table that was already
// created by an earlier version of this file. This adds any such column if
// it's missing, so an existing dev database doesn't break on startup.
function ensureColumn(table: string, column: string, columnDdl: string): void {
  const existingColumns = db.prepare(`pragma table_info(${table})`).all() as { name: string }[];
  if (!existingColumns.some((c) => c.name === column)) {
    db.exec(`alter table ${table} add column ${columnDdl}`);
  }
}

ensureColumn('customers', 'disclosure_sent_at', 'disclosure_sent_at text');

// Version 2.1: `customers.balance_owed` is replaced by the `ledger` table
// (schema.sql). `create table if not exists` never touches an already-
// existing table, so an existing dev database still has the old column —
// drop it if present. Safe to run every startup: `ensureColumn`'s sibling,
// same idempotency idea.
function dropColumnIfExists(table: string, column: string): void {
  const existingColumns = db.prepare(`pragma table_info(${table})`).all() as { name: string }[];
  if (existingColumns.some((c) => c.name === column)) {
    db.exec(`alter table ${table} drop column ${column}`);
  }
}

dropColumnIfExists('customers', 'balance_owed');

// Version 2.1: `orders.status` gained a CHECK constraint listing the full
// retail state machine. SQLite's ALTER TABLE can't add a CHECK constraint
// to an existing table, only the standard create-new/copy/drop-old/rename
// dance — done here, guarded so it only runs once (detected by checking
// the table's own stored CREATE TABLE text for the new constraint).
function migrateOrdersStatusConstraint(): void {
  const row = db
    .prepare(`select sql from sqlite_master where type = 'table' and name = 'orders'`)
    .get() as { sql: string } | undefined;
  if (!row || row.sql.includes("check (status in")) return; // already migrated, or table doesn't exist yet

  db.exec(`
    create table orders_new (
      id integer primary key autoincrement,
      customer_id integer not null references customers(id),
      items_json text not null,
      total real not null,
      status text not null default 'placed'
        check (status in ('placed', 'confirmed', 'paid', 'shipped', 'delivered', 'cancelled')),
      created_at text not null default (datetime('now'))
    );
    insert into orders_new (id, customer_id, items_json, total, status, created_at)
      select id, customer_id, items_json, total, status, created_at from orders;
    drop table orders;
    alter table orders_new rename to orders;
  `);
}

migrateOrdersStatusConstraint();
