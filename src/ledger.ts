// Version 2.1: replaces `customers.balance_owed` (a single mutable field
// that could silently drift from reality) with a real ledger — one row per
// debit (an order placed, customer owes more) or credit (a payment,
// customer owes less) event. Balance is always this table's running sum,
// never trusted as a standalone number.

import { db } from './db';

export function recordDebit(customerId: number, orderId: number, amount: number): void {
  db.prepare(
    "insert into ledger (customer_id, order_id, kind, amount) values (?, ?, 'debit', ?)",
  ).run(customerId, orderId, amount);
}

export function recordCredit(customerId: number, amount: number): void {
  db.prepare(
    "insert into ledger (customer_id, order_id, kind, amount) values (?, null, 'credit', ?)",
  ).run(customerId, amount);
}

/** What this customer currently owes: sum of debits minus sum of credits, reconstructed from history every time. */
export function getBalance(customerId: number): number {
  const row = db
    .prepare(
      `select coalesce(sum(case when kind = 'debit' then amount else -amount end), 0) as balance
       from ledger where customer_id = ?`,
    )
    .get(customerId) as { balance: number };
  return row.balance;
}
