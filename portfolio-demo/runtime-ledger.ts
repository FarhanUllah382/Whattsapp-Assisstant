import { db } from './db';

// The production analytics readers need only this one balance operation.
// The demo runtime intentionally omits every ledger-writing operation.
export function getBalance(customerId: number): number {
  const row = db
    .prepare(
      `select coalesce(sum(case when kind = 'debit' then amount else -amount end), 0) as balance
       from ledger where customer_id = ?`,
    )
    .get(customerId) as { balance: number };
  return row.balance;
}
