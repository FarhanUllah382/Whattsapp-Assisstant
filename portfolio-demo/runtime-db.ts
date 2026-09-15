import Database from 'better-sqlite3';
import path from 'node:path';

// Demo-only adapter. The generated public runtime contains no write-capable
// business modules and SQLite itself rejects every write on this connection.
export const db = new Database(path.join(__dirname, '..', 'portfolio-demo.db'), {
  readonly: true,
  fileMustExist: true,
});
db.pragma('query_only = ON');
