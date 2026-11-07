import { db } from './db';
import { minorToRupees } from './money';

// The production analytics readers need only this one balance operation.
// The demo runtime intentionally omits every ledger-writing operation.
// Mirrors src/ledger.ts's getBalance contract: rupees, derived from
// amount_minor (integer paisa).
export function getBalance(customerId: number): number {
  const row = db
    .prepare(
      `select coalesce(sum(case when kind = 'debit' then amount_minor else -amount_minor end), 0) as balance
       from ledger where customer_id = ?`,
    )
    .get(customerId) as { balance: number };
  return minorToRupees(row.balance, 'ledger balance');
}
