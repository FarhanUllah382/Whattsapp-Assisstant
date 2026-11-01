import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { multiplyMinor, rupeesToMinor } from './money';
import { sanitizeMemoryText } from './privacy';

// One file, one database. Swap for Postgres later if you outgrow SQLite —
// nothing else in this project needs to change, because every other file
// only ever imports `db` from here (same "one seam" idea as llm.ts).
//
// Automated tests must never share Ahmed's real database. The test runner
// supplies a fresh absolute path for every test file. A test started directly
// without that runner fails before opening any database, and the override is
// rejected outside NODE_ENV=test so it cannot become a hidden production
// database switch.
const productionDatabasePath = path.resolve(__dirname, '..', 'ahmed.db');
const requestedTestDatabasePath = process.env.AHMED_TEST_DATABASE_PATH?.trim();
const directTestEntryPoint = process.argv.some((argument) =>
  /(?:^|[\\/])tests[\\/][^\\/]+\.ts$/i.test(argument) ||
  /(?:^|[\\/])scripts[\\/]test-v2-flow\.ts$/i.test(argument),
);

if (directTestEntryPoint && !requestedTestDatabasePath) {
  throw new Error(
    'Refusing to run a test against ahmed.db. Use `npm test` so the isolated test runner supplies a temporary database.',
  );
}

if (requestedTestDatabasePath && (process.env.NODE_ENV !== 'test' || !directTestEntryPoint)) {
  throw new Error('AHMED_TEST_DATABASE_PATH is accepted only for an isolated test entry point.');
}

const resolvedTestDatabasePath = requestedTestDatabasePath
  ? path.resolve(requestedTestDatabasePath)
  : null;

if (resolvedTestDatabasePath === productionDatabasePath) {
  throw new Error('The isolated test database cannot be ahmed.db.');
}

export const databasePath = resolvedTestDatabasePath ?? productionDatabasePath;
export const db = new Database(databasePath);

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
ensureColumn(
  'customers',
  'automation_opted_out',
  'automation_opted_out integer not null default 0 check (automation_opted_out in (0, 1))',
);
ensureColumn('customers', 'opted_out_at', 'opted_out_at text');
ensureColumn('customers', 'opted_in_at', 'opted_in_at text');
ensureColumn('products', 'image_filename', 'image_filename text');
ensureColumn('payment_claims', 'approval_reversed_at', 'approval_reversed_at text');
ensureColumn(
  'payment_claims',
  'approval_reversed_by_customer_id',
  'approval_reversed_by_customer_id integer references customers(id)',
);
ensureColumn('payment_claim_action_intents', 'verified_reference', 'verified_reference text');
ensureColumn(
  'messages',
  'source_event_key',
  "source_event_key text check (source_event_key is null or direction = 'inbound')",
);
ensureColumn(
  'send_ledger',
  'recipient_kind',
  "recipient_kind text not null default 'customer' check (recipient_kind in ('customer', 'owner'))",
);
ensureColumn('send_ledger', 'event_key', 'event_key text');
ensureColumn('send_ledger', 'body_hash', 'body_hash text');
ensureColumn(
  'send_ledger',
  'attempt_count',
  'attempt_count integer not null default 1 check (attempt_count >= 1)',
);
ensureColumn('send_ledger', 'provider_message_id', 'provider_message_id text');
ensureColumn('send_ledger', 'last_error_code', 'last_error_code text');
ensureColumn('send_ledger', 'updated_at', "updated_at text not null default '1970-01-01 00:00:00'");
db.exec(`
  create unique index if not exists messages_source_event_key_unique_idx
    on messages(source_event_key) where source_event_key is not null;
  update send_ledger set body_hash = id where body_hash is null;
  update send_ledger set updated_at = created_at where updated_at = '1970-01-01 00:00:00';
  update send_ledger
     set status = 'uncertain', last_error_code = 'legacy_pending_outcome_unknown'
   where status = 'pending';
  create index if not exists send_ledger_status_updated_idx
    on send_ledger(status, updated_at);
  create unique index if not exists send_ledger_recipient_event_unique_idx
    on send_ledger(recipient_kind, event_key) where event_key is not null;
`);

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
        sku text collate nocase
          check (sku is null or length(trim(sku)) between 2 and 64),
        name text not null,
        category text,
        size text,
        color text,
        price_minor integer not null
          check (typeof(price_minor) = 'integer' and price_minor >= 0),
        stock integer not null default 0,
        active integer not null default 1 check (active in (0, 1)),
        aliases_json text not null default '[]'
          check (json_valid(aliases_json) and json_type(aliases_json) = 'array'),
        created_at text not null default (datetime('now')),
        updated_at text not null default (datetime('now'))
      );
      create table orders_money_new (
        id integer primary key autoincrement,
        customer_id integer not null references customers(id),
        items_json text not null,
        total_minor integer not null
          check (typeof(total_minor) = 'integer' and total_minor >= 0),
        shipping_minor integer not null default 0
          check (typeof(shipping_minor) = 'integer' and shipping_minor >= 0),
        recipient_name text,
        contact_phone text,
        delivery_address text,
        city text,
        postal_code text,
        delivery_instructions text,
        payment_method text
          check (payment_method is null or payment_method in ('cod', 'bank_transfer', 'easypaisa', 'jazzcash')),
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

// Fulfillment details are nullable on historical orders because inventing
// recipient/address data for old rows would corrupt the audit trail. Every
// order created through the new two-step fulfillment flow supplies all
// required delivery fields and a server-controlled zero shipping charge.
ensureColumn(
  'orders',
  'shipping_minor',
  "shipping_minor integer not null default 0 check (typeof(shipping_minor) = 'integer' and shipping_minor >= 0)",
);
ensureColumn('orders', 'recipient_name', 'recipient_name text');
ensureColumn('orders', 'contact_phone', 'contact_phone text');
ensureColumn('orders', 'delivery_address', 'delivery_address text');
ensureColumn('orders', 'city', 'city text');
ensureColumn('orders', 'postal_code', 'postal_code text');
ensureColumn('orders', 'delivery_instructions', 'delivery_instructions text');
ensureColumn(
  'orders',
  'payment_method',
  "payment_method text check (payment_method is null or payment_method in ('cod', 'bank_transfer', 'easypaisa', 'jazzcash'))",
);

// Customer-facing order references are deliberately unrelated to the
// sequential internal primary key. Existing rows are backfilled once; every
// later insert (including a direct administrative insert) receives 80 random
// bits from SQLite before it can be exposed to a customer. A unique index is
// the collision backstop. Internal ids remain the foreign-key mechanism only.
ensureColumn(
  'orders',
  'public_ref',
  "public_ref text collate nocase check (public_ref is null or (length(public_ref) = 24 and upper(substr(public_ref, 1, 4)) = 'ORD-' and upper(substr(public_ref, 5)) not glob '*[^0-9A-F]*'))",
);
db.exec(`
  update orders
     set public_ref = 'ORD-' || upper(hex(randomblob(10)))
   where public_ref is null;
  create unique index if not exists orders_public_ref_unique_idx on orders(public_ref);
  create trigger if not exists orders_public_ref_assign_after_insert
  after insert on orders
  when new.public_ref is null
  begin
    update orders
       set public_ref = 'ORD-' || upper(hex(randomblob(10)))
     where id = new.id;
  end;
  create trigger if not exists orders_public_ref_validate_insert
  before insert on orders
  when new.public_ref is not null and (
    length(new.public_ref) != 24 or upper(substr(new.public_ref, 1, 4)) != 'ORD-' or
    upper(substr(new.public_ref, 5)) glob '*[^0-9A-F]*'
  )
  begin
    select raise(abort, 'invalid public order reference');
  end;
  create trigger if not exists orders_public_ref_validate_update
  before update of public_ref on orders
  when new.public_ref is null or (
    length(new.public_ref) != 24 or upper(substr(new.public_ref, 1, 4)) != 'ORD-' or
    upper(substr(new.public_ref, 5)) glob '*[^0-9A-F]*'
  )
  begin
    select raise(abort, 'invalid public order reference');
  end;
`);

// Correction #5: derived AI memory must retain business meaning without
// becoming a second permanent copy of contact, address, or payment details.
// The raw transcript and authoritative fulfilment records are intentionally
// untouched. The migration marker makes this historical cleanup exactly once.
const MEMORY_PII_MIGRATION = '2026-10-03-derived-memory-pii-minimization-v1';

function minimizeHistoricalDerivedMemory(): void {
  const applied = db
    .prepare('select 1 from privacy_migrations where migration_key = ?')
    .get(MEMORY_PII_MIGRATION);
  if (applied) return;

  db.transaction(() => {
    let checkpointRowsRedacted = 0;
    let noteRowsRedacted = 0;

    const checkpoints = db.prepare('select customer_id, summary from checkpoints').all() as Array<{
      customer_id: number;
      summary: string;
    }>;
    const updateCheckpoint = db.prepare(
      "update checkpoints set summary = ?, updated_at = datetime('now') where customer_id = ?",
    );
    for (const row of checkpoints) {
      const sanitized = sanitizeMemoryText(row.summary);
      if (sanitized !== row.summary) {
        updateCheckpoint.run(sanitized, row.customer_id);
        checkpointRowsRedacted += 1;
      }
    }

    const notes = db.prepare('select id, headline, body from customer_notes').all() as Array<{
      id: number;
      headline: string;
      body: string;
    }>;
    const updateNote = db.prepare('update customer_notes set headline = ?, body = ? where id = ?');
    for (const row of notes) {
      const headline = sanitizeMemoryText(row.headline);
      const body = sanitizeMemoryText(row.body);
      if (headline !== row.headline || body !== row.body) {
        updateNote.run(headline, body, row.id);
        noteRowsRedacted += 1;
      }
    }

    db.prepare(`
      insert into privacy_migrations
        (migration_key, checkpoint_rows_redacted, note_rows_redacted)
      values (?, ?, ?)
    `).run(MEMORY_PII_MIGRATION, checkpointRowsRedacted, noteRowsRedacted);
  }).immediate();
}

minimizeHistoricalDerivedMemory();

// Real-inventory onboarding metadata. These additions are deliberately
// nullable/defaulted so existing order-linked products keep their ids and
// history. CSV-imported variants require a stable SKU in application code.
ensureColumn(
  'products',
  'sku',
  "sku text collate nocase check (sku is null or length(trim(sku)) between 2 and 64)",
);
ensureColumn('products', 'category', 'category text');
ensureColumn('products', 'active', 'active integer not null default 1 check (active in (0, 1))');
ensureColumn(
  'products',
  'aliases_json',
  "aliases_json text not null default '[]' check (json_valid(aliases_json) and json_type(aliases_json) = 'array')",
);
ensureColumn('products', 'created_at', 'created_at text');
ensureColumn('products', 'updated_at', 'updated_at text');
db.exec(`
  update products set created_at = coalesce(created_at, datetime('now'));
  update products set updated_at = coalesce(updated_at, datetime('now'));
  create unique index if not exists products_sku_unique_idx on products(sku);
  create trigger if not exists products_sku_valid_insert
  before insert on products
  when new.sku is not null and length(trim(new.sku)) not between 2 and 64
  begin
    select raise(abort, 'product sku must contain 2-64 characters');
  end;
  create trigger if not exists products_sku_valid_update
  before update of sku on products
  when new.sku is not null and length(trim(new.sku)) not between 2 and 64
  begin
    select raise(abort, 'product sku must contain 2-64 characters');
  end;
`);
