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

/**
 * DB-backed version: reads the order's real current status, validates the
 * move via checkOrderStatusTransition, and only writes on success. Never
 * throws — a bad orderId or an invalid transition both come back as
 * {ok:false, error}, same teaching-text discipline as every tool in
 * tools.ts.
 */
export function transitionOrderStatus(orderId: number, next: OrderStatus): TransitionResult {
  if (!Number.isInteger(orderId) || orderId <= 0) {
    return { ok: false, error: 'orderId must be a positive whole number.' };
  }
  const row = db.prepare('select status from orders where id = ?').get(orderId) as
    | { status: OrderStatus }
    | undefined;
  if (!row) {
    return { ok: false, error: `Order ${orderId} does not exist.` };
  }

  const check = checkOrderStatusTransition(row.status, next);
  if (!check.ok) {
    return { ok: false, error: check.error! };
  }

  db.prepare('update orders set status = ? where id = ?').run(next, orderId);
  return { ok: true, order_id: orderId, from: row.status, to: next };
}
