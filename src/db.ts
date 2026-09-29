import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { multiplyMinor, rupeesToMinor } from './money';

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
  const existingColumns = db.pragma(`table_info(${table})`) as { name: string }[];
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
  const existingColumns = db.pragma(`table_info(${table})`) as { name: string }[];
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

function tableColumns(table: string): string[] {
  return (db.pragma(`table_info(${table})`) as { name: string }[]).map((column) => column.name);
}

// Production hardening: migrate every financial truth from SQLite REAL rupees
// to integer Pakistani paisas. All four tables and every order-item snapshot
// are validated before the first destructive statement. The transaction then
// replaces them together, so either the complete exact-money model commits or
// the legacy schema remains untouched.
function migrateExactMoney(): void {
  const specs = [
    ['products', 'price', 'price_minor'],
    ['orders', 'total', 'total_minor'],
    ['ledger', 'amount', 'amount_minor'],
    ['payment_claims', 'amount', 'amount_minor'],
  ] as const;
  const states = specs.map(([table, legacy, current]) => {
    const columns = tableColumns(table);
    return { table, legacy: columns.includes(legacy), current: columns.includes(current) };
  });
  if (states.every((state) => state.current && !state.legacy)) return;
  if (!states.every((state) => state.legacy && !state.current)) {
    throw new Error(`Exact-money migration found a mixed schema: ${JSON.stringify(states)}`);
  }

  const products = db.prepare('select * from products order by id').all() as Array<Record<string, unknown>>;
  const orders = db.prepare('select * from orders order by id').all() as Array<Record<string, unknown>>;
  const ledger = db.prepare('select * from ledger order by id').all() as Array<Record<string, unknown>>;
  const claims = db.prepare('select * from payment_claims order by id').all() as Array<Record<string, unknown>>;

  const migratedProducts = products.map((row) => ({ ...row, price_minor: rupeesToMinor(row.price as number, `product ${row.id} price`) })) as Array<Record<string, unknown> & { price_minor: number }>;
  const migratedOrders = orders.map((row) => {
    const parsed = JSON.parse(row.items_json as string) as unknown;
    if (!Array.isArray(parsed) || parsed.length === 0) throw new Error(`Order ${row.id} has invalid items_json.`);
    const items = parsed.map((item: any) => {
      if (!item || !Number.isInteger(item.product_id) || !Number.isInteger(item.qty) || item.qty <= 0) {
        throw new Error(`Order ${row.id} has an invalid item.`);
      }
      return { product_id: item.product_id, qty: item.qty, price_minor: rupeesToMinor(item.price, `order ${row.id} item price`) };
    });
    const totalMinor = rupeesToMinor(row.total as number, `order ${row.id} total`);
    const calculated = items.reduce((sum, item) => sum + multiplyMinor(item.price_minor, item.qty), 0);
    if (calculated !== totalMinor) throw new Error(`Order ${row.id} item snapshots do not equal its total.`);
    return { ...row, items_json: JSON.stringify(items), total_minor: totalMinor };
  }) as Array<Record<string, unknown> & { items_json: string; total_minor: number }>;
  const migratedLedger = ledger.map((row) => ({ ...row, amount_minor: rupeesToMinor(row.amount as number, `ledger ${row.id} amount`) })) as Array<Record<string, unknown> & { amount_minor: number }>;
  const migratedClaims = claims.map((row) => ({ ...row, amount_minor: rupeesToMinor(row.amount as number, `payment claim ${row.id} amount`) })) as Array<Record<string, unknown> & { amount_minor: number }>;

  // SQLite correctly prevents dropping a referenced parent table while
  // foreign-key enforcement is active. Temporarily suspend enforcement for
  // this single atomic table-replacement transaction, then run
  // `foreign_key_check` before commit and always restore the connection's
  // original setting. Any violation throws and rolls the whole migration back.
  const foreignKeysEnabled = db.pragma('foreign_keys', { simple: true }) === 1;
  if (foreignKeysEnabled) db.pragma('foreign_keys = OFF');
  try {
    db.transaction(() => {
      db.exec(`
      create table products_money_new (
        id integer primary key autoincrement,
        name text not null,
        size text,
        color text,
        price_minor integer not null
          check (typeof(price_minor) = 'integer' and price_minor >= 0),
        stock integer not null default 0
      );
      create table orders_money_new (
        id integer primary key autoincrement,
        customer_id integer not null references customers(id),
        items_json text not null,
        total_minor integer not null
          check (typeof(total_minor) = 'integer' and total_minor >= 0),
        status text not null default 'placed'
          check (status in ('placed', 'confirmed', 'paid', 'shipped', 'delivered', 'cancelled')),
        created_at text not null default (datetime('now'))
      );
      create table ledger_money_new (
        id integer primary key autoincrement,
        customer_id integer not null references customers(id),
        order_id integer references orders(id),
        kind text not null check (kind in ('debit', 'credit')),
        amount_minor integer not null
          check (typeof(amount_minor) = 'integer' and amount_minor >= 0),
        created_at text not null default (datetime('now'))
      );
      create table payment_claims_money_new (
        id integer primary key autoincrement,
        customer_id integer not null references customers(id),
        order_id integer references orders(id),
        amount_minor integer not null
          check (typeof(amount_minor) = 'integer' and amount_minor > 0),
        method text,
        reference text,
        status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
        event_key text unique,
        resolved_by_customer_id integer references customers(id),
        created_at text not null default (datetime('now')),
        resolved_at text
      );
    `);
      const insertProduct = db.prepare('insert into products_money_new (id, name, size, color, price_minor, stock) values (?, ?, ?, ?, ?, ?)');
      for (const row of migratedProducts) insertProduct.run(row['id'], row['name'], row['size'], row['color'], row.price_minor, row['stock']);
      const insertOrder = db.prepare('insert into orders_money_new (id, customer_id, items_json, total_minor, status, created_at) values (?, ?, ?, ?, ?, ?)');
      for (const row of migratedOrders) insertOrder.run(row['id'], row['customer_id'], row.items_json, row.total_minor, row['status'], row['created_at']);
      const insertLedger = db.prepare('insert into ledger_money_new (id, customer_id, order_id, kind, amount_minor, created_at) values (?, ?, ?, ?, ?, ?)');
      for (const row of migratedLedger) insertLedger.run(row['id'], row['customer_id'], row['order_id'], row['kind'], row.amount_minor, row['created_at']);
      const insertClaim = db.prepare(`insert into payment_claims_money_new
        (id, customer_id, order_id, amount_minor, method, reference, status, event_key, resolved_by_customer_id, created_at, resolved_at)
        values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      for (const row of migratedClaims) insertClaim.run(row['id'], row['customer_id'], row['order_id'], row.amount_minor, row['method'], row['reference'], row['status'], row['event_key'], row['resolved_by_customer_id'], row['created_at'], row['resolved_at']);
      db.exec(`
      drop table ledger;
      drop table payment_claims;
      drop table orders;
      drop table products;
      alter table products_money_new rename to products;
      alter table orders_money_new rename to orders;
      alter table ledger_money_new rename to ledger;
      alter table payment_claims_money_new rename to payment_claims;
      `);

      // Recreate indexes/triggers dropped with the legacy tables, then prove
      // every reference still resolves before allowing the transaction to commit.
      db.exec(schema);
      const violations = db.pragma('foreign_key_check') as unknown[];
      if (violations.length > 0) {
        throw new Error(`Exact-money migration would violate ${violations.length} foreign-key reference(s).`);
      }
    }).immediate();
  } finally {
    if (foreignKeysEnabled) db.pragma('foreign_keys = ON');
  }
}

migrateExactMoney();
