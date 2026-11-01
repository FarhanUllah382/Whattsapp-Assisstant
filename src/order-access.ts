import { createHash } from 'node:crypto';
import { db } from './db';
import { minorToRupees } from './money';
import type { ToolDef } from './types';

const ORDER_REFERENCE_PATTERN = /^ORD-[0-9A-F]{20}$/;
const FAILED_LOOKUP_LIMIT = 10;
const FAILED_LOOKUP_WINDOW = '-15 minutes';

export const ORDER_ACCESS_DENIED =
  'No matching order is available for this WhatsApp account and reference.';

export interface OwnedOrderReference {
  id: number;
  public_ref: string;
  customer_id: number;
  status: string;
  total_minor: number;
  created_at: string;
}

function normalizeOrderReference(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toUpperCase();
  return ORDER_REFERENCE_PATTERN.test(normalized) ? normalized : null;
}

function referenceHash(value: unknown): string {
  const normalized = typeof value === 'string' ? value.trim().toUpperCase() : '<invalid>';
  return createHash('sha256').update(normalized).digest('hex');
}

function recordLookup(customerId: number, suppliedReference: unknown, outcome: 'success' | 'not_found' | 'rate_limited'): void {
  db.prepare(`
    insert into order_lookup_attempts (customer_id, reference_hash, outcome)
    values (?, ?, ?)
  `).run(customerId, referenceHash(suppliedReference), outcome);
}

function tooManyFailedLookups(customerId: number): boolean {
  const row = db.prepare(`
    select count(*) as count
    from order_lookup_attempts
    where customer_id = ?
      and outcome = 'not_found'
      and created_at >= datetime('now', ?)
  `).get(customerId, FAILED_LOOKUP_WINDOW) as { count: number };
  return row.count >= FAILED_LOOKUP_LIMIT;
}

export type OwnedOrderResolution =
  | { ok: true; order: OwnedOrderReference }
  | { ok: false; error: string; rateLimited?: boolean };

/**
 * Resolve a public order reference and the authenticated WhatsApp customer in
 * one query. A reference belonging to somebody else is indistinguishable from
 * a nonexistent reference to the caller.
 */
export function resolveOwnedOrderReference(customerId: number, suppliedReference: unknown): OwnedOrderResolution {
  if (tooManyFailedLookups(customerId)) {
    recordLookup(customerId, suppliedReference, 'rate_limited');
    return {
      ok: false,
      rateLimited: true,
      error: 'Too many unsuccessful order lookups. Please wait 15 minutes before trying again.',
    };
  }

  const reference = normalizeOrderReference(suppliedReference);
  const order = reference
    ? db.prepare(`
        select id, public_ref, customer_id, status, total_minor, created_at
        from orders
        where public_ref = ? collate nocase and customer_id = ?
      `).get(reference, customerId) as OwnedOrderReference | undefined
    : undefined;

  if (!order) {
    recordLookup(customerId, suppliedReference, 'not_found');
    return { ok: false, error: ORDER_ACCESS_DENIED };
  }
  recordLookup(customerId, reference, 'success');
  return { ok: true, order };
}

export function getOrderPublicReference(orderId: number): string {
  const row = db.prepare('select public_ref from orders where id = ?').get(orderId) as
    | { public_ref: string }
    | undefined;
  if (!row?.public_ref || !ORDER_REFERENCE_PATTERN.test(row.public_ref.toUpperCase())) {
    throw new Error('Order does not have a valid public reference.');
  }
  return row.public_ref.toUpperCase();
}

export const getMyOrderStatus: ToolDef = {
  name: 'get_my_order_status',
  description:
    "Read an order's real status for the current WhatsApp sender. Use the public order reference when provided. " +
    'Never use a supplied name or phone number as authorization. If no reference is provided, return only this sender\'s latest order.',
  input_schema: {
    type: 'object',
    properties: {
      order_reference: {
        type: 'string',
        description: 'public reference in the form ORD- plus 20 hexadecimal characters; optional for the sender\'s latest order',
      },
    },
  },
  execute: ({ order_reference }, ctx) => {
    let order: OwnedOrderReference | undefined;
    if (order_reference === undefined || order_reference === null || order_reference === '') {
      order = db.prepare(`
        select id, public_ref, customer_id, status, total_minor, created_at
        from orders
        where customer_id = ?
        order by id desc
        limit 1
      `).get(ctx.customerId) as OwnedOrderReference | undefined;
      if (!order) {
        recordLookup(ctx.customerId, '<latest>', 'not_found');
        return { ok: false, found: false, error: ORDER_ACCESS_DENIED };
      }
      recordLookup(ctx.customerId, '<latest>', 'success');
    } else {
      const resolved = resolveOwnedOrderReference(ctx.customerId, order_reference);
      if (!resolved.ok) return { ok: false, found: false, error: resolved.error };
      order = resolved.order;
    }

    return {
      ok: true,
      found: true,
      order_reference: order.public_ref.toUpperCase(),
      status: order.status,
      total: minorToRupees(order.total_minor, 'order total'),
      placed_at: order.created_at,
    };
  },
};
