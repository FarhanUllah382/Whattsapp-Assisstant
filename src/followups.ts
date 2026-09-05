// Version 2.5: follow-up tracking tied to unpaid orders.
//
// Deliberately NOT a stored `follow_ups` table populated by some background
// job — there's no real job queue yet (see CLAUDE.md's carried-forward
// Version 1 gaps), and a derived, computed-at-query-time answer can never
// drift out of sync with real order/ledger state or silently stop firing.
// An order counts as needing a follow-up purely because its status hasn't
// reached 'paid' yet — the forward-only state machine in orders.ts is
// already the single source of truth for that, so this file adds no new
// state, just a read over what already exists.
//
// This is the query/read side only. There is no tool here that fires a
// reminder or pushes anything to Ahmed on its own — that distinction
// ("owner-initiated query, not the bot auto-firing") is the whole point of
// 2.5 per PROJECT-TRACKER-FINAL.md. Wiring this into something Ahmed can
// actually ask over WhatsApp needs a sender-identity check to tell him apart
// from a customer, which is Version 3.1's job, not this one's — see
// CLAUDE.md §3/§6. This file only ships the underlying capability.

import { db } from './db';
import { getBalance } from './ledger';
import type { OrderStatus } from './orders';

// How long an order can sit short of 'paid' before it's worth a nudge —
// enough time to let a customer arrange payment without nagging same-day.
export const FOLLOWUP_WINDOW_MS = 2 * 24 * 60 * 60 * 1000; // 2 days

// Beyond this, a pending follow-up is flagged overdue so Ahmed can
// prioritize it over one that just crossed the window.
export const OVERDUE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export interface PendingFollowup {
  order_id: number;
  customer_id: number;
  phone: string;
  name: string | null;
  status: OrderStatus;
  total: number;
  /** This customer's overall ledger balance — not order-scoped (the ledger never was, see ledger.ts) — shown for context alongside this specific unpaid order. */
  balance_owed: number;
  placed_at: string;
  days_since_placed: number;
  overdue: boolean;
}

interface UnpaidOrderRow {
  order_id: number;
  customer_id: number;
  phone: string;
  name: string | null;
  status: OrderStatus;
  total: number;
  created_at: string;
}

function parseSqlDatetime(value: string): number {
  return new Date(value.replace(' ', 'T') + 'Z').getTime();
}

/**
 * Every real order still short of 'paid' — status 'placed' or 'confirmed',
 * the only two states the forward-only machine allows before 'paid' — that's
 * old enough to need a follow-up. `now` is injectable so callers (and tests)
 * don't depend on the wall clock. Ordered most-overdue first.
 */
export function getPendingFollowups(now: Date = new Date()): PendingFollowup[] {
  const rows = db
    .prepare(
      `select o.id as order_id, o.customer_id, c.phone, c.name, o.status, o.total, o.created_at
       from orders o
       join customers c on c.id = o.customer_id
       where o.status in ('placed', 'confirmed')
       order by o.created_at asc`,
    )
    .all() as UnpaidOrderRow[];

  const nowMs = now.getTime();

  return rows
    .map((row) => {
      const placedAtMs = parseSqlDatetime(row.created_at);
      const daysSincePlaced = (nowMs - placedAtMs) / (24 * 60 * 60 * 1000);
      return {
        order_id: row.order_id,
        customer_id: row.customer_id,
        phone: row.phone,
        name: row.name,
        status: row.status,
        total: row.total,
        balance_owed: getBalance(row.customer_id),
        placed_at: row.created_at,
        days_since_placed: daysSincePlaced,
        overdue: nowMs - placedAtMs >= OVERDUE_WINDOW_MS,
      };
    })
    .filter((f) => nowMs - parseSqlDatetime(f.placed_at) >= FOLLOWUP_WINDOW_MS)
    .sort((a, b) => b.days_since_placed - a.days_since_placed);
}
