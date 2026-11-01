// Shared server-side order validation: server pricing, fulfilment-detail
// normalisation, draft item aggregation, live stock checks, and the single
// transactional order insert. Used by prepare_order / confirm_order
// (tools/orders.ts). Split out of tools.ts.

import { db } from '../db';
import { recordDebitMinor } from '../ledger';
import { minorToRupees, multiplyMinor } from '../money';
import { recordInitialOrderStatus, type OrderStatusAuditContext } from '../orders';
import {
  getAvailablePaymentMethods,
  getPaymentInstructions,
  parsePaymentMethod,
  type PaymentMethod,
} from '../payment-instructions';

export interface ServerPricedOrderItem {
  product_id: number;
  qty: number;
  /** Exact price snapshot in Pakistani paisas, loaded by the server. */
  price_minor: number;
}

export interface FulfillmentDetails {
  recipientName: string;
  contactPhone: string;
  deliveryAddress: string;
  city: string;
  postalCode: string | null;
  deliveryInstructions: string | null;
  paymentMethod: PaymentMethod;
  shippingMinor: 0;
}

export type ValidateOrderItemsResult =
  | { ok: true; items: ServerPricedOrderItem[]; totalMinor: number; total: number }
  | { ok: false; error: string };

// Shared by prepare_order (draft pricing) and confirm_order (re-validation
// at booking time) — one validation source of truth for server pricing.
export function validateOrderItems(items: unknown): ValidateOrderItemsResult {
  if (!Array.isArray(items) || items.length === 0) {
    return { ok: false, error: 'Please list at least one item to order.' };
  }
  const serverPricedItems: ServerPricedOrderItem[] = [];
  for (const it of items as any[]) {
    if (typeof it !== 'object' || it === null) {
      return { ok: false, error: 'Each order item must contain a product and quantity.' };
    }
    if (!Number.isInteger(it.product_id) || it.product_id <= 0) {
      return { ok: false, error: 'Each item needs a valid product.' };
    }
    if (!Number.isInteger(it.qty) || it.qty <= 0) {
      return { ok: false, error: 'Quantity must be a whole number greater than 0.' };
    }
    const product = db
      .prepare('select id, price_minor from products where id = ? and active = 1')
      .get(it.product_id) as { id: number; price_minor: number } | undefined;
    if (!product) {
      return { ok: false, error: `Product ${it.product_id} does not exist — check the product first.` };
    }
    if (!Number.isSafeInteger(product.price_minor) || product.price_minor < 0) {
      return { ok: false, error: `Product ${it.product_id} has an invalid catalog price — ask the owner to correct it.` };
    }
    serverPricedItems.push({ product_id: product.id, qty: it.qty, price_minor: product.price_minor });
  }
  let totalMinor: number;
  try {
    totalMinor = serverPricedItems.reduce((sum, it) => sum + multiplyMinor(it.price_minor, it.qty), 0);
  } catch {
    return { ok: false, error: 'The server could not calculate a valid order total.' };
  }
  if (!Number.isSafeInteger(totalMinor)) return { ok: false, error: 'The server could not calculate a valid order total.' };
  return { ok: true, items: serverPricedItems, totalMinor, total: minorToRupees(totalMinor, 'order total') };
}

/** Assumes `items`/`total` already passed validateOrderItems — no re-validation here. */
export function insertValidatedOrder(
  customerId: number,
  items: unknown[],
  totalMinor: number,
  audit: OrderStatusAuditContext,
  fulfillment?: FulfillmentDetails,
): number {
  return db.transaction(() => {
    const result = fulfillment
      ? db.prepare(`
          insert into orders
            (customer_id, items_json, total_minor, shipping_minor, recipient_name,
             contact_phone, delivery_address, city, postal_code,
             delivery_instructions, payment_method, status)
          values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          customerId,
          JSON.stringify(items),
          totalMinor,
          fulfillment.shippingMinor,
          fulfillment.recipientName,
          fulfillment.contactPhone,
          fulfillment.deliveryAddress,
          fulfillment.city,
          fulfillment.postalCode,
          fulfillment.deliveryInstructions,
          fulfillment.paymentMethod,
          'placed',
        )
      : db
          .prepare('insert into orders (customer_id, items_json, total_minor, status) values (?, ?, ?, ?)')
          .run(customerId, JSON.stringify(items), totalMinor, 'placed');
    const orderId = result.lastInsertRowid as number;
    recordDebitMinor(customerId, orderId, totalMinor);
    recordInitialOrderStatus(orderId, customerId, audit);
    return orderId;
  })();
}

function cleanRequiredText(value: unknown, label: string, min: number, max: number): string | { error: string } {
  if (typeof value !== 'string') return { error: `${label} must be plain text.` };
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(value)) {
    return { error: `${label} contains unsupported control characters.` };
  }
  const clean = value.trim().replace(/\s+/g, ' ');
  if (clean.length < min || clean.length > max) {
    return { error: `${label} must contain ${min}-${max} characters.` };
  }
  return clean;
}

function cleanOptionalText(value: unknown, label: string, max: number): string | null | { error: string } {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') return { error: `${label} must be plain text.` };
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(value)) {
    return { error: `${label} contains unsupported control characters.` };
  }
  const clean = value.trim().replace(/\s+/g, ' ');
  if (clean.length > max) return { error: `${label} must be ${max} characters or fewer.` };
  return clean || null;
}

function normalizeContactPhone(value: unknown): string | { error: string } {
  if (typeof value !== 'string') return { error: 'Contact number must be plain text.' };
  const trimmed = value.trim();
  const digits = trimmed.replace(/\D/g, '');
  if (!/^03\d{9}$/.test(digits) && !/^923\d{9}$/.test(digits)) {
    return {
      error:
        'Contact number must be a valid Pakistani mobile number: 03XXXXXXXXX or +923XXXXXXXXX.',
    };
  }
  return trimmed.startsWith('+') ? `+${digits}` : digits;
}

function normalizePaymentMethod(value: unknown): PaymentMethod | { error: string } {
  const method = parsePaymentMethod(value);
  if (!method) return { error: 'Payment method must be COD, bank transfer, Easypaisa, or JazzCash.' };
  if (!getPaymentInstructions(method).ok) {
    return {
      error:
        `${method} is not currently available because owner-approved payment details are not configured. ` +
        `Available methods: ${getAvailablePaymentMethods().join(', ')}.`,
    };
  }
  return method;
}

export function validateFulfillment(input: any): FulfillmentDetails | { error: string } {
  const recipientName = cleanRequiredText(input?.recipient_name, 'Recipient name', 2, 100);
  if (typeof recipientName !== 'string') return recipientName;
  const contactPhone = normalizeContactPhone(input?.contact_phone);
  if (typeof contactPhone !== 'string') return contactPhone;
  const deliveryAddress = cleanRequiredText(input?.delivery_address, 'Complete delivery address', 10, 300);
  if (typeof deliveryAddress !== 'string') return deliveryAddress;
  const city = cleanRequiredText(input?.city, 'City', 2, 80);
  if (typeof city !== 'string') return city;
  const postalCode = cleanOptionalText(input?.postal_code, 'Postal code', 12);
  if (postalCode && typeof postalCode !== 'string') return postalCode;
  if (typeof postalCode === 'string' && !/^[a-zA-Z0-9 -]{3,12}$/.test(postalCode)) {
    return { error: 'Postal code may contain only letters, numbers, spaces, and hyphens.' };
  }
  const deliveryInstructions = cleanOptionalText(input?.delivery_instructions, 'Delivery instructions', 300);
  if (deliveryInstructions && typeof deliveryInstructions !== 'string') return deliveryInstructions;
  const paymentMethod = normalizePaymentMethod(input?.payment_method);
  if (typeof paymentMethod !== 'string') return paymentMethod;
  return {
    recipientName,
    contactPhone,
    deliveryAddress,
    city,
    postalCode,
    deliveryInstructions,
    paymentMethod,
    shippingMinor: 0,
  };
}

export function aggregateDraftItems(items: unknown): unknown[] | { error: string } {
  if (!Array.isArray(items) || items.length === 0) return { error: 'Please list at least one item to order.' };
  const quantities = new Map<number, number>();
  for (const item of items as any[]) {
    if (!item || !Number.isInteger(item.product_id) || item.product_id <= 0) {
      return { error: 'Each item needs a valid product.' };
    }
    if (!Number.isInteger(item.qty) || item.qty <= 0) {
      return { error: 'Quantity must be a whole number greater than 0.' };
    }
    const next = (quantities.get(item.product_id) ?? 0) + item.qty;
    if (!Number.isSafeInteger(next)) return { error: 'The requested quantity is too large.' };
    quantities.set(item.product_id, next);
  }
  return [...quantities].map(([product_id, qty]) => ({ product_id, qty }));
}

export function checkDraftStock(items: ServerPricedOrderItem[]): string | null {
  const read = db.prepare('select name, size, color, stock from products where id = ? and active = 1');
  for (const item of items) {
    const product = read.get(item.product_id) as
      | { name: string; size: string | null; color: string | null; stock: number }
      | undefined;
    if (!product) return `Product ${item.product_id} is no longer available.`;
    if (product.stock < item.qty) {
      const variant = [product.color, product.size, product.name].filter(Boolean).join(' ');
      return `The requested quantity (${item.qty}) cannot currently be fulfilled for ${variant}.`;
    }
  }
  return null;
}
