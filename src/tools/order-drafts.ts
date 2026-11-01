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

export function getPendingOrderDraft(customerId: number): OrderDraftRow | undefined {
  return db.prepare(`
    select * from order_drafts
    where customer_id = ? and status = 'awaiting_confirmation'
    order by id desc limit 1
  `).get(customerId) as OrderDraftRow | undefined;
}

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
