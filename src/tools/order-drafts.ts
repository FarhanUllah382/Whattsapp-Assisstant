// Prepared-order drafts: the stored draft row shape, the deterministic
// server summary result, the pending-draft lookup, and the explicit
// confirmation-wording parser. Split out of tools.ts.

import { db } from '../db';
import { minorToRupees } from '../money';
import { buildDeterministicOrderSummary } from '../order-summary';
import type { PaymentMethod } from '../payment-instructions';
import { maskPhoneForDisplay } from '../privacy';
import type { ServerPricedOrderItem } from './order-validation';

export interface OrderDraftRow {
  id: number;
  customer_id: number;
  items_json: string;
  total_minor: number;
  shipping_minor: number;
  recipient_name: string;
  contact_phone: string;
  delivery_address: string;
  city: string;
  postal_code: string | null;
  delivery_instructions: string | null;
  payment_method: PaymentMethod;
  status: 'awaiting_confirmation' | 'confirmed' | 'superseded';
  prepared_event_key: string | null;
  confirmed_event_key: string | null;
  order_id: number | null;
  created_at: string;
}

export function draftResult(row: OrderDraftRow) {
  const items = JSON.parse(row.items_json) as ServerPricedOrderItem[];
  const productRows = db.prepare('select id, name, size, color from products where id = ?');
  const displayItems = items.map((item) => {
    const product = productRows.get(item.product_id) as
      | { id: number; name: string; size: string | null; color: string | null }
      | undefined;
    return {
      name: product?.name ?? `Product ${item.product_id}`,
      size: product?.size ?? null,
      color: product?.color ?? null,
      qty: item.qty,
      unitPriceMinor: item.price_minor,
    };
  });
  const serverSummary = buildDeterministicOrderSummary({
    items: displayItems,
    subtotalMinor: row.total_minor,
    deliveryMinor: row.shipping_minor,
    recipientName: row.recipient_name,
    maskedContactPhone: maskPhoneForDisplay(row.contact_phone),
    deliveryAddress: row.delivery_address,
    city: row.city,
    postalCode: row.postal_code,
    deliveryInstructions: row.delivery_instructions,
    paymentMethod: row.payment_method,
  });
  return {
    ok: true,
    draft_id: row.id,
    status: row.status,
    items: items.map((item) => ({
      ...item,
      price: minorToRupees(item.price_minor, 'draft item price'),
      product: productRows.get(item.product_id),
    })),
    subtotal: minorToRupees(row.total_minor, 'draft subtotal'),
    delivery_charge: minorToRupees(row.shipping_minor, 'draft shipping'),
    total: minorToRupees(row.total_minor + row.shipping_minor, 'draft total'),
    recipient_name: row.recipient_name,
    contact_phone_masked: maskPhoneForDisplay(row.contact_phone),
    delivery_address: row.delivery_address,
    city: row.city,
    postal_code: row.postal_code,
    delivery_instructions: row.delivery_instructions,
    payment_method: row.payment_method,
    server_summary: serverSummary,
    summary_generated_by: 'server',
    needs_explicit_confirmation: row.status === 'awaiting_confirmation',
    instruction: row.status === 'awaiting_confirmation'
      ? 'The application sends server_summary automatically. Do not copy, rewrite, calculate, translate, ' +
        'or send an additional order summary. Wait for a later explicit confirmation message.'
      : undefined,
  };
}

// Draft lifecycle (FIX2, live 2026-11-02): a prepared draft stays pending
// only for ORDER_DRAFT_TTL_HOURS after it was prepared. The order_drafts
// status column has a CHECK constraint ('awaiting_confirmation', 'confirmed',
// 'superseded') that cannot be widened without rebuilding the table, so expiry
// is COMPUTED, never written: an awaiting row older than the TTL is simply not
// pending (it no longer gates summaries, OPEN context or confirm_order). No
// row is rewritten or deleted; the next prepare_order marks it 'superseded'
// as it already does for any older awaiting draft.
export const DEFAULT_ORDER_DRAFT_TTL_HOURS = 6;
const MAX_ORDER_DRAFT_TTL_HOURS = 24 * 7;

/** Fail-safe parse: anything missing, non-numeric, <= 0 or above a week means the default. */
export function orderDraftTtlHours(raw: string | undefined = process.env.ORDER_DRAFT_TTL_HOURS): number {
  const trimmed = raw?.trim() ?? '';
  if (!/^\d+(?:\.\d+)?$/.test(trimmed)) return DEFAULT_ORDER_DRAFT_TTL_HOURS;
  const value = Number(trimmed);
  if (!Number.isFinite(value) || value <= 0 || value > MAX_ORDER_DRAFT_TTL_HOURS) {
    return DEFAULT_ORDER_DRAFT_TTL_HOURS;
  }
  return value;
}

/** SQLite datetime modifier for the TTL, in whole minutes (at least one). */
function ttlModifier(): string {
  return `+${Math.max(1, Math.round(orderDraftTtlHours() * 60))} minutes`;
}

export function getPendingOrderDraft(customerId: number): OrderDraftRow | undefined {
  return db.prepare(`
    select * from order_drafts
    where customer_id = ? and status = 'awaiting_confirmation'
      and datetime(created_at, ?) > datetime('now')
    order by id desc limit 1
  `).get(customerId, ttlModifier()) as OrderDraftRow | undefined;
}

/** The latest draft that is still stored as awaiting but has passed its TTL. */
export function getExpiredOrderDraft(customerId: number): OrderDraftRow | undefined {
  return db.prepare(`
    select * from order_drafts
    where customer_id = ? and status = 'awaiting_confirmation'
      and datetime(created_at, ?) <= datetime('now')
    order by id desc limit 1
  `).get(customerId, ttlModifier()) as OrderDraftRow | undefined;
}

/** UTC expiry time of a draft, as an ISO-8601 string (for OPEN context). */
export function orderDraftExpiresAt(row: Pick<OrderDraftRow, 'id'>): string | null {
  const found = db.prepare('select datetime(created_at, ?) as expires_at from order_drafts where id = ?')
    .get(ttlModifier(), row.id) as { expires_at: string | null } | undefined;
  return found?.expires_at ? `${found.expires_at.replace(' ', 'T')}Z` : null;
}

export const EXPIRED_ORDER_DRAFT_ERROR =
  'The earlier order summary expired and can no longer be confirmed. Nothing was booked. ' +
  'Ask the customer to re-check the items, delivery details and payment method, then call prepare_order for a fresh summary.';

export function isExplicitOrderConfirmation(text: unknown): boolean {
  if (typeof text !== 'string') return false;
  const normalized = text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+/g, ' ');
  if (!normalized || /\b(no|nope|not|dont|don t|nahi|nahin|mat|cancel|change|wait|ruk|stop)\b/.test(normalized)) return false;
  // Generic affirmations are not transaction-specific. The preceding model
  // reply may contain another question, so "yes"/"okay"/"haan"/"done" must
  // never create an order by themselves. Require language that explicitly
  // names confirmation, booking, placement, or the order itself.
  const exact = new Set(['confirm', 'confirmed', 'confirm order', 'order confirm', 'book order']);
  if (exact.has(normalized)) return true;
  return (
    /^(?:yes |haan |han |ha |ji )?confirm(?: order)?(?: bhai| bro| please| pls| ji)*$/.test(normalized) ||
    /\b(confirm|place|book)\b.{0,30}\b(order|it|this)\b/.test(normalized) ||
    /\b(order|it|this)\b.{0,30}\b(confirm|place|book)\b/.test(normalized) ||
    /\border\b.{0,25}\bkar\b.{0,10}\b(do|dein|dain|den)\b/.test(normalized) ||
    /\bbook\b.{0,20}\bkar\b.{0,10}\b(do|dein|dain|den)\b/.test(normalized)
  );
}
