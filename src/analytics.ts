// Version 3.2: owner analytics — a small, fixed set of safe report
// functions, never a freely-written SQL query from the model (that's the
// whole point of naming each one explicitly rather than giving the model a
// generic "run_query" tool). Each one is a pure read over data Version 2
// already built (the ledger, orders, products) — no new state, same
// "derived, not stored" discipline as followups.ts's getPendingFollowups
// (2.5), which this file reuses directly for the 4th tool rather than
// duplicating it.

import { db } from './db';
import { dayStartInTz } from './guardrails/pacing/engine';
import { PACING_DEFAULTS } from './guardrails/pacing/defaults';
import { getBalance } from './ledger';

/**
 * Total value of orders placed today (Ahmed's shop timezone), excluding
 * cancelled ones — a cancelled order isn't a completed sale. `now` is
 * injectable, same discipline as followups.ts's getPendingFollowups, so
 * tests don't depend on the wall clock.
 */
export function getSalesToday(now: Date = new Date()): number {
  const todayStart = dayStartInTz(now, PACING_DEFAULTS.timezone);
  const todayStartSql = todayStart.toISOString().slice(0, 19).replace('T', ' ');
  const row = db
    .prepare(`select coalesce(sum(total), 0) as total from orders where status != 'cancelled' and created_at >= ?`)
    .get(todayStartSql) as { total: number };
  return row.total;
}

export interface UnpaidCustomer {
  customer_id: number;
  phone: string;
  name: string | null;
  balance_owed: number;
}

/**
 * Every customer whose real ledger balance (getBalance — the single source
 * of truth from 2.1, never recomputed differently here) is currently
 * positive. Reuses getBalance() per candidate rather than re-deriving the
 * debit/credit math a second time, so this can never drift from what
 * get_customer_balance itself reports.
 */
export function getUnpaidCustomers(): UnpaidCustomer[] {
  const candidates = db
    .prepare(
      `select distinct c.id as customer_id, c.phone, c.name
       from customers c join ledger l on l.customer_id = c.id`,
    )
    .all() as { customer_id: number; phone: string; name: string | null }[];

  return candidates
    .map((c) => ({ ...c, balance_owed: getBalance(c.customer_id) }))
    .filter((c) => c.balance_owed > 0)
    .sort((a, b) => b.balance_owed - a.balance_owed);
}

export interface TopSellingProduct {
  product_id: number;
  name: string;
  total_qty_sold: number;
  total_revenue: number;
}

interface OrderItem {
  product_id: number;
  qty: number;
  price: number;
}

/**
 * The single product with the most units sold across all non-cancelled
 * orders, all time (no time window — "our best seller" isn't naturally a
 * single-day question the way sales_today is). Ties broken by lowest
 * product_id, for determinism. null if nothing has ever been ordered.
 */
export function getTopSellingProduct(): TopSellingProduct | null {
  const rows = db.prepare(`select items_json from orders where status != 'cancelled'`).all() as { items_json: string }[];

  const tally = new Map<number, { qty: number; revenue: number }>();
  for (const row of rows) {
    const items = JSON.parse(row.items_json) as OrderItem[];
    for (const item of items) {
      const entry = tally.get(item.product_id) ?? { qty: 0, revenue: 0 };
      entry.qty += item.qty;
      entry.revenue += item.qty * item.price;
      tally.set(item.product_id, entry);
    }
  }

  let bestId: number | null = null;
  let best = { qty: -1, revenue: 0 };
  for (const [id, v] of tally) {
    if (v.qty > best.qty || (v.qty === best.qty && bestId !== null && id < bestId)) {
      bestId = id;
      best = v;
    }
  }
  if (bestId === null) return null;

  const product = db.prepare('select name from products where id = ?').get(bestId) as { name: string } | undefined;
  return {
    product_id: bestId,
    name: product?.name ?? `Product ${bestId}`, // the product itself may since have been deleted
    total_qty_sold: best.qty,
    total_revenue: best.revenue,
  };
}
