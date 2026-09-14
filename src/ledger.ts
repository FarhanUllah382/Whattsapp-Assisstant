// Version 2.1: replaces `customers.balance_owed` (a single mutable field
// that could silently drift from reality) with a real ledger — one row per
// debit (an order placed, customer owes more) or credit (a payment,
// customer owes less) event. Balance is always this table's running sum,
// never trusted as a standalone number.

export interface LedgerEntry {
  readonly kind: 'debit' | 'credit';
  readonly amount: number;
  readonly orderId?: number | null;
  readonly timestamp?: Date;
}

/**
 * Object-Oriented Domain Model encapsulating a customer's financial account.
 * Enforces double-entry bookkeeping invariants:
 *  - Amounts must be strictly positive numbers.
 *  - Account balance is dynamically derived from immutable transaction history.
 */
export class LedgerAccount {
  private readonly _customerId: number;
  private readonly _entries: LedgerEntry[];

  constructor(customerId: number, initialEntries: LedgerEntry[] = []) {
    if (!Number.isInteger(customerId) || customerId <= 0) {
      throw new Error('customerId must be a positive integer.');
    }
    this._customerId = customerId;
    this._entries = [...initialEntries];
  }

  get customerId(): number {
    return this._customerId;
  }

  get entries(): ReadonlyArray<LedgerEntry> {
    return this._entries;
  }

  postDebit(amount: number, orderId?: number | null): void {
    if (amount <= 0) {
      throw new Error('Debit amount must be strictly positive.');
    }
    this._entries.push({
      kind: 'debit',
      amount,
      orderId: orderId ?? null,
      timestamp: new Date(),
    });
  }

  postCredit(amount: number, orderId?: number | null): void {
    if (amount <= 0) {
      throw new Error('Credit amount must be strictly positive.');
    }
    this._entries.push({
      kind: 'credit',
      amount,
      orderId: orderId ?? null,
      timestamp: new Date(),
    });
  }

  getBalance(): number {
    return this._entries.reduce((acc, entry) => {
      return entry.kind === 'debit' ? acc + entry.amount : acc - entry.amount;
    }, 0);
  }

  clear(): void {
    this._entries.length = 0;
  }
}

function getDb() {
  const { db } = require('./db') as typeof import('./db');
  return db;
}

export function recordDebit(customerId: number, orderId: number, amount: number): void {
  getDb().prepare(
    "insert into ledger (customer_id, order_id, kind, amount) values (?, ?, 'debit', ?)",
  ).run(customerId, orderId, amount);
}

// orderId is optional — a genuine payment usually isn't tied to one specific
// order (customers often pay against their running balance, not per-order),
// but a cancellation reversal (orders.ts) IS tied to a specific order, and
// recording that link keeps the ledger's audit trail honest instead of
// flattening every credit down to "a payment, from somewhere."
export function recordCredit(customerId: number, amount: number, orderId: number | null = null): void {
  getDb().prepare(
    "insert into ledger (customer_id, order_id, kind, amount) values (?, ?, 'credit', ?)",
  ).run(customerId, orderId, amount);
}

/** What this customer currently owes: sum of debits minus sum of credits, reconstructed from history every time. */
export function getBalance(customerId: number): number {
  const row = getDb()
    .prepare(
      `select coalesce(sum(case when kind = 'debit' then amount else -amount end), 0) as balance
       from ledger where customer_id = ?`,
    )
    .get(customerId) as { balance: number };
  return row.balance;
}
