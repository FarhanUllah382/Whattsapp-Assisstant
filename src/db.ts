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
