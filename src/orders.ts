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
// db and recordCredit are loaded lazily inside transitionOrderStatus so pure
// callers of checkOrderStatusTransition / ORDER_STATUSES don't eagerly trigger
// native SQLite bindings.

export const ORDER_STATUSES = ['placed', 'confirmed', 'paid', 'shipped', 'delivered', 'cancelled'] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

export const ORDER_STATUS_ACTOR_TYPES = ['customer', 'owner', 'payment_provider', 'courier', 'system'] as const;
export type OrderStatusActorType = (typeof ORDER_STATUS_ACTOR_TYPES)[number];

export interface OrderStatusAuditContext {
  actorType: OrderStatusActorType;
  actorCustomerId?: number;
  source: string;
  sourceEventKey?: string;
  evidence: string;
}

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

export interface TransitionLogEntry {
  readonly from: OrderStatus;
  readonly to: OrderStatus;
  readonly timestamp: Date;
}

/**
 * Object-Oriented Domain Entity encapsulating retail order state transitions,
 * transition validation, terminal state enforcement, and transition audit history.
 */
export class OrderStateMachine {
  private _status: OrderStatus;
  private readonly _orderId?: number;
  private readonly _history: TransitionLogEntry[] = [];

  constructor(initialStatus: OrderStatus = 'placed', orderId?: number) {
    if (!ORDER_STATUSES.includes(initialStatus)) {
      throw new Error(`Invalid initial order status: "${initialStatus}"`);
    }
    this._status = initialStatus;
    this._orderId = orderId;
  }

  get status(): OrderStatus {
    return this._status;
  }

  get orderId(): number | undefined {
    return this._orderId;
  }

  get history(): ReadonlyArray<TransitionLogEntry> {
    return this._history;
  }

  canTransitionTo(next: OrderStatus): StatusCheckResult {
    return checkOrderStatusTransition(this._status, next);
  }

  transition(next: OrderStatus): StatusCheckResult {
    const check = this.canTransitionTo(next);
    if (!check.ok) {
      return check;
    }
    const from = this._status;
    this._status = next;
    this._history.push({ from, to: next, timestamp: new Date() });
    return { ok: true };
  }

  isTerminal(): boolean {
    return ALLOWED_TRANSITIONS[this._status].length === 0;
  }

  getAllowedTransitions(): readonly OrderStatus[] {
    return ALLOWED_TRANSITIONS[this._status];
  }
}

export type TransitionResult =
  | { ok: true; order_id: number; from: OrderStatus; to: OrderStatus; event_id: number }
  | { ok: false; error: string };

interface OrderItem {
  product_id: number;
  qty: number;
  price: number;
}

class TransitionRejected extends Error {}

function validateAuditContext(audit: OrderStatusAuditContext): string | null {
  if (!audit || !ORDER_STATUS_ACTOR_TYPES.includes(audit.actorType)) {
    return 'A valid order-status actor is required.';
  }
  if ((audit.actorType === 'customer' || audit.actorType === 'owner') &&
      (!Number.isInteger(audit.actorCustomerId) || audit.actorCustomerId! <= 0)) {
    return `A valid actor customer id is required for ${audit.actorType} transitions.`;
  }
  if (typeof audit.source !== 'string' || audit.source.trim().length === 0 || audit.source.trim().length > 80) {
    return 'Order-status source must be 1-80 characters.';
  }
  if (audit.sourceEventKey !== undefined &&
      (typeof audit.sourceEventKey !== 'string' || audit.sourceEventKey.trim().length === 0 || audit.sourceEventKey.length > 200)) {
    return 'Order-status source event key must be 1-200 characters when supplied.';
  }
  if ((audit.actorType === 'payment_provider' || audit.actorType === 'courier') && !audit.sourceEventKey) {
    return `A stable source event key is required for ${audit.actorType} transitions.`;
  }
  if (typeof audit.evidence !== 'string' || audit.evidence.trim().length === 0 || audit.evidence.trim().length > 500) {
    return 'Order-status evidence must be 1-500 characters.';
  }
  return null;
}

function insertStatusEvent(
  orderId: number,
  from: OrderStatus | null,
  to: OrderStatus,
  audit: OrderStatusAuditContext,
): number {
  const { db } = require('./db') as typeof import('./db');
  const result = db.prepare(`
    insert into order_status_events
      (order_id, from_status, to_status, actor_type, actor_customer_id, source, source_event_key, evidence)
    values (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    orderId,
    from,
    to,
    audit.actorType,
    audit.actorCustomerId ?? null,
    audit.source.trim(),
    audit.sourceEventKey?.trim() ?? null,
    audit.evidence.trim(),
  );
  return result.lastInsertRowid as number;
}

/** Record the initial placed state inside the caller's order-creation transaction. */
export function recordInitialOrderStatus(orderId: number, customerId: number, audit: OrderStatusAuditContext): number {
  const validationError = validateAuditContext(audit);
  if (validationError) throw new Error(validationError);
  if (audit.actorType !== 'customer' || audit.actorCustomerId !== customerId) {
    throw new Error('Order creation must be attributed to the same customer who owns the order.');
  }
  return insertStatusEvent(orderId, null, 'placed', audit);
}

function checkTransitionAuthority(
  orderCustomerId: number,
  next: OrderStatus,
  audit: OrderStatusAuditContext,
): string | null {
  switch (audit.actorType) {
    case 'customer':
      if (audit.actorCustomerId !== orderCustomerId) return 'A customer cannot change another customer\'s order.';
      if (next !== 'confirmed' && next !== 'cancelled') {
        return 'Customers may only confirm or cancel their own order.';
      }
      return null;
    case 'owner':
      return null;
    case 'payment_provider':
      return next === 'paid' ? null : 'A payment provider may only verify the paid transition.';
    case 'courier':
      return next === 'shipped' || next === 'delivered'
        ? null
        : 'A courier may only verify shipped or delivered transitions.';
    case 'system':
      return 'System actors may record initial order creation but cannot advance order status.';
  }
}

function parseAndAggregateItems(itemsJson: string): Map<number, number> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(itemsJson);
  } catch {
    throw new TransitionRejected('This order has invalid item data and cannot change status safely.');
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new TransitionRejected('This order has no valid items and cannot change status safely.');
  }

  const quantities = new Map<number, number>();
  for (const item of parsed as OrderItem[]) {
    if (
      typeof item !== 'object' ||
      item === null ||
      !Number.isInteger(item.product_id) ||
      item.product_id <= 0 ||
      !Number.isInteger(item.qty) ||
      item.qty <= 0
    ) {
      throw new TransitionRejected('This order contains an invalid product or quantity.');
    }
    quantities.set(item.product_id, (quantities.get(item.product_id) ?? 0) + item.qty);
  }
  return quantities;
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
 *
 * Correction found and fixed 2026-09-05, while building 3.2's
 * unpaid_customers report: record_order writes its ledger debit
 * immediately at creation (status 'placed'), before any confirm/pay step —
 * unlike stock, which only reserves at 'confirmed'. That debit was never
 * being reversed on cancellation, so a cancelled order silently kept
 * counting as money owed forever (get_customer_balance and
 * unpaid_customers would both have been wrong for any customer with a
 * cancelled order). Fixed the same way as stock, just unconditional on
 * `next === 'cancelled'` rather than gated on the prior status, since the
 * debit — unlike the stock reservation — always exists by the time an
 * order can be cancelled at all.
 */
export function transitionOrderStatus(
  orderId: number,
  next: OrderStatus,
  audit: OrderStatusAuditContext,
): TransitionResult {
  if (!Number.isInteger(orderId) || orderId <= 0) {
    return { ok: false, error: 'orderId must be a positive whole number.' };
  }
  const auditError = validateAuditContext(audit);
  if (auditError) return { ok: false, error: auditError };
  const { db } = require('./db') as typeof import('./db');
  const { recordCredit } = require('./ledger') as typeof import('./ledger');

  const transition = db.transaction((): TransitionResult => {
    const row = db.prepare('select status, items_json, customer_id, total from orders where id = ?').get(orderId) as
      | { status: OrderStatus; items_json: string; customer_id: number; total: number }
      | undefined;
    if (!row) {
      throw new TransitionRejected(`Order ${orderId} does not exist.`);
    }

    const check = checkOrderStatusTransition(row.status, next);
    if (!check.ok) {
      throw new TransitionRejected(check.error!);
    }
    const authorityError = checkTransitionAuthority(row.customer_id, next, audit);
    if (authorityError) throw new TransitionRejected(authorityError);

    if (next === 'confirmed' || (next === 'cancelled' && row.status !== 'placed')) {
      const quantities = parseAndAggregateItems(row.items_json);
      if (next === 'confirmed') {
        const reserve = db.prepare(
          'update products set stock = stock - ? where id = ? and stock >= ?',
        );
        const readProduct = db.prepare('select name, size, color, stock from products where id = ?');
        for (const [productId, qty] of quantities) {
          const result = reserve.run(qty, productId, qty);
          if (result.changes !== 1) {
            const product = readProduct.get(productId) as
              | { name: string; size: string | null; color: string | null; stock: number }
              | undefined;
            if (!product) {
              throw new TransitionRejected(`Product ${productId} no longer exists; the order was not confirmed.`);
            }
            const variant = [product.color, product.size, product.name].filter(Boolean).join(' ');
            throw new TransitionRejected(
              `Not enough stock for ${variant}: requested ${qty}, available ${product.stock}. ` +
              'The order remains placed and no stock was reserved.',
            );
          }
        }
      } else {
        const restore = db.prepare('update products set stock = stock + ? where id = ?');
        for (const [productId, qty] of quantities) {
          if (restore.run(qty, productId).changes !== 1) {
            throw new TransitionRejected(
              `Product ${productId} no longer exists; cancellation was not applied partially.`,
            );
          }
        }
      }
    }

    if (next === 'cancelled') {
      // Unconditional (unlike the stock branch above): the debit was recorded
      // the instant this order was placed, so it needs reversing no matter
      // which status it's cancelled from. This insert is in the same
      // transaction as status and stock, so all three commit or all roll back.
      recordCredit(row.customer_id, row.total, orderId);
    }

    db.prepare('update orders set status = ? where id = ?').run(next, orderId);
    const eventId = insertStatusEvent(orderId, row.status, next, audit);
    return { ok: true, order_id: orderId, from: row.status, to: next, event_id: eventId };
  });

  try {
    // IMMEDIATE obtains SQLite's write reservation before the status read.
    // Separate processes therefore cannot both confirm against the same final
    // stock snapshot; the second transaction re-reads after the first commits.
    return transition.immediate();
  } catch (error) {
    if (error instanceof TransitionRejected) {
      return { ok: false, error: error.message };
    }
    return { ok: false, error: 'Could not update the order safely; no partial change was committed.' };
  }
}
