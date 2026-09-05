// Forward-only order-status state machine (Version 2.1). Same discipline as
// DeskcommCRM's lead-state.ts pattern — server-validated, forward-only
// transitions, a teaching-text error on an invalid one — but retail
// vocabulary throughout. Never the B2B funnel vocabulary
// (new/contacted/qualifying/qualified/negotiating/won/lost) — that's a
// permanent exclusion (CLAUDE.md §6), not a stylistic choice.
//
// lead-state.ts itself didn't qualify for extraction (DB-coupled, see
// EXTRACTED-FOR-AHMED/MANIFEST.md's rejected list) — this is a from-scratch
// reimplementation of the pattern, not a port.

import { db } from './db';

export const ORDER_STATUSES = ['placed', 'confirmed', 'paid', 'shipped', 'delivered', 'cancelled'] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

// Forward chain: placed -> confirmed -> paid -> shipped -> delivered.
// Cancellation is only meaningful before the order has actually shipped —
// once it's shipped or delivered, "cancelled" would misrepresent what
// really happened (that's a return/refund, a different flow, not built
// yet). `delivered` and `cancelled` are terminal: nothing moves out of them.
const ALLOWED_TRANSITIONS: Record<OrderStatus, readonly OrderStatus[]> = {
  placed: ['confirmed', 'cancelled'],
  confirmed: ['paid', 'cancelled'],
  paid: ['shipped', 'cancelled'],
  shipped: ['delivered'],
  delivered: [],
  cancelled: [],
};

export interface StatusCheckResult {
  ok: boolean;
  error?: string;
}

/** Pure function: is `current -> next` an allowed order-status move? No DB access. */
export function checkOrderStatusTransition(current: OrderStatus, next: OrderStatus): StatusCheckResult {
  if (!ORDER_STATUSES.includes(next)) {
    return { ok: false, error: `"${next}" isn't a real order status.` };
  }
  if (!ALLOWED_TRANSITIONS[current].includes(next)) {
    return {
      ok: false,
      error:
        `An order can't move from "${current}" to "${next}". Orders only move forward ` +
        `(placed → confirmed → paid → shipped → delivered), or to "cancelled" before shipping.`,
    };
  }
  return { ok: true };
}

export type TransitionResult =
  | { ok: true; order_id: number; from: OrderStatus; to: OrderStatus }
  | { ok: false; error: string };

interface OrderItem {
  product_id: number;
  qty: number;
  price: number;
}

/**
 * DB-backed version: reads the order's real current status, validates the
 * move via checkOrderStatusTransition, and only writes on success. Never
 * throws — a bad orderId or an invalid transition both come back as
 * {ok:false, error}, same teaching-text discipline as every tool in
 * tools.ts.
 *
 * Version 2.4 stock side effects, live here (not in the tool that calls
 * this) so they hold for any future caller of the state machine, not just
 * today's one: confirming an order reserves stock by decrementing it;
 * cancelling an order that had already reserved stock (cancelled from
 * "confirmed" or "paid", not from "placed" — nothing was reserved yet at
 * "placed") restores it. Relies on the state machine's own forward-only +
 * terminal-state guarantees to rule out double-adjusting, rather than a
 * separate "already adjusted" flag: "confirmed" is reachable via exactly
 * one edge per order (placed -> confirmed — no other state lists it as a
 * valid target, so a second "confirm" attempt is rejected before this code
 * ever runs), and "cancelled" is terminal (nothing transitions out of it),
 * so each order can decrement at most once and restore at most once.
 */
export function transitionOrderStatus(orderId: number, next: OrderStatus): TransitionResult {
  if (!Number.isInteger(orderId) || orderId <= 0) {
    return { ok: false, error: 'orderId must be a positive whole number.' };
  }
  const row = db.prepare('select status, items_json from orders where id = ?').get(orderId) as
    | { status: OrderStatus; items_json: string }
    | undefined;
  if (!row) {
    return { ok: false, error: `Order ${orderId} does not exist.` };
  }

  const check = checkOrderStatusTransition(row.status, next);
  if (!check.ok) {
    return { ok: false, error: check.error! };
  }

  db.prepare('update orders set status = ? where id = ?').run(next, orderId);

  if (next === 'confirmed' || (next === 'cancelled' && row.status !== 'placed')) {
    const items = JSON.parse(row.items_json) as OrderItem[];
    const sign = next === 'confirmed' ? -1 : 1; // decrement on confirm, restore on cancel-after-reserving
    const adjustStock = db.prepare('update products set stock = stock + ? where id = ?');
    for (const item of items) {
      adjustStock.run(sign * item.qty, item.product_id);
    }
  }

  return { ok: true, order_id: orderId, from: row.status, to: next };
}
