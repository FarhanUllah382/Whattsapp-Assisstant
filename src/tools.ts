// ═══════════════════════════════════════════════════════════════════════════
// The AI's menu of actions. Compare to `AGENT_TOOL_DEFS` in the big reference
// file (11 tools, MCP catalog, per-turn conditional wiring). We start with 5.
//
// Rule borrowed from the big system, worth keeping forever: the AI's raw text
// is NEVER what reaches the customer. The only way it can speak is by calling
// `send_message`. This one rule is what makes "log everything, guard every
// message" possible later — there's exactly one choke point.
// ═══════════════════════════════════════════════════════════════════════════

import { getSalesToday, getTopSellingProduct, getUnpaidCustomers } from './analytics';
import { findBestMatch, loadCatalogSections } from './catalog';
import { db } from './db';
import { getPendingFollowups } from './followups';
import { normalizeSize } from './inventory';
import { getBalance, recordCredit, recordDebitMinor } from './ledger';
import { minorToRupees, multiplyMinor } from './money';
import { createLogger } from './obs/logger';
import { recordInitialOrderStatus, transitionOrderStatus, type OrderStatus, type OrderStatusAuditContext } from './orders';
import { claimPayment, pendingPaymentClaims, resolvePaymentClaim } from './payments';
import type { ToolContext, ToolDef } from './types';

const log = createLogger();

export const checkStock: ToolDef = {
  name: 'check_stock',
  description: 'Look up whether a product is in stock, and how many are available.',
  input_schema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'product name, e.g. "shirt"' },
      size: { type: 'string', description: 'e.g. "medium" (optional)' },
      color: { type: 'string', description: 'e.g. "black" (optional)' },
    },
    required: ['name'],
  },
  execute: ({ name, size, color }) => {
    if (typeof name !== 'string' || name.trim() === '') {
      return { ok: false, error: 'Please say which product you mean.' };
    }
    if (size !== undefined && typeof size !== 'string') {
      return { ok: false, error: 'Size must be plain text, like "medium".' };
    }
    if (color !== undefined && typeof color !== 'string') {
      return { ok: false, error: 'Color must be plain text, like "black".' };
    }

    const escapeLike = (value: string) => value.toLowerCase().replace(/[\\%_]/g, '\\$&');
    const namePattern = `%${escapeLike(name.trim())}%`;
    let sql = `select id, sku, name, category, size, color, price_minor, stock
      from products
      where active = 1 and (
        lower(name) like ? escape '\\'
        or exists (
          select 1 from json_each(products.aliases_json)
          where lower(cast(json_each.value as text)) like ? escape '\\'
        )
      )`;
    const params: unknown[] = [namePattern, namePattern];
    if (size) {
      sql += ' and lower(size) = ?';
      params.push(normalizeSize(size));
    }
    if (color) {
      sql += ' and lower(color) = ?';
      params.push(color.trim().toLowerCase());
    }
    const rows = db.prepare(sql).all(...params) as Array<Record<string, unknown> & { price_minor: number }>;
    return rows.length > 0
      ? rows.map(({ price_minor, ...row }) => ({ ...row, price: minorToRupees(price_minor, 'product price') }))
      : { found: false, message: 'no matching product' };
  },
};

export const getCustomerBalance: ToolDef = {
  name: 'get_customer_balance',
  description: "Check how much this customer currently owes (unpaid orders).",
  input_schema: { type: 'object', properties: {} },
  execute: (_input, ctx) => {
    return { balance_owed: getBalance(ctx.customerId) };
  },
};

export const getCustomerNote: ToolDef = {
  name: 'get_customer_note',
  description:
    "Fetch the full detail behind one of this customer's known-facts headlines " +
    '(shown in the opening context as "[note #N] headline"), by its id.',
  input_schema: {
    type: 'object',
    properties: {
      note_id: { type: 'number', description: 'the N from "[note #N]" in the headline list' },
    },
    required: ['note_id'],
  },
  execute: ({ note_id }, ctx) => {
    if (!Number.isInteger(note_id) || note_id <= 0) {
      return { ok: false, error: 'note_id must be a positive whole number.' };
    }
    const row = db
      .prepare('select id, headline, body, created_at from customer_notes where id = ? and customer_id = ?')
      .get(note_id, ctx.customerId);
    if (!row) {
      return { ok: false, error: 'No note found with that id for this customer.' };
    }
    return { ok: true, note: row };
  },
};

export interface ServerPricedOrderItem {
  product_id: number;
  qty: number;
  /** Exact price snapshot in Pakistani paisas, loaded by the server. */
  price_minor: number;
}

export const PAYMENT_METHODS = ['cod', 'bank_transfer', 'easypaisa', 'jazzcash'] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

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

interface OrderDraftRow {
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

export type ValidateOrderItemsResult =
  | { ok: true; items: ServerPricedOrderItem[]; totalMinor: number; total: number }
  | { ok: false; error: string };

// Shared between record_order's own execute() and the Version 2.3 safety
// net in agent.ts's CLOSE step (a possible order the model confirmed in
// conversation but never called record_order for) — one validation source
// of truth, so the safety net can never be looser than the real tool.
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

/**
 * Runs one bookkeeping effect atomically for a provider event. The receipt
 * and the order/payment write commit in the same SQLite transaction, so a
 * crash can leave either both or neither—never an unreceipted committed write.
 */
export function runBookkeepingOnce<T>(
  ctx: ToolContext,
  effect: 'record_order' | 'record_payment',
  operation: () => T,
): T {
  if (!ctx.idempotencyKey) return operation();

  const receiptId = `${ctx.idempotencyKey}:${effect}`;
  return db.transaction(() => {
    const existing = db
      .prepare('select result_json from bookkeeping_receipts where id = ?')
      .get(receiptId) as { result_json: string } | undefined;
    if (existing) return JSON.parse(existing.result_json) as T;

    const result = operation();
    db.prepare(
      'insert into bookkeeping_receipts (id, customer_id, effect, result_json) values (?, ?, ?, ?)',
    ).run(receiptId, ctx.customerId, effect, JSON.stringify(result));
    return result;
  })();
}

export const recordOrder: ToolDef = {
  name: 'record_order',
  description:
    'Record a new order for this customer. Only call this once the customer has ' +
    'clearly confirmed what they want (product, size, color, quantity). Send only the ' +
    'product_id and quantity; the server always loads the authoritative catalog price.',
  input_schema: {
    type: 'object',
    properties: {
      items: {
        type: 'array',
        description: 'list of items ordered',
        items: {
          type: 'object',
          properties: {
            product_id: { type: 'number' },
            qty: { type: 'number' },
          },
          required: ['product_id', 'qty'],
        },
      },
    },
    required: ['items'],
  },
  execute: ({ items }, ctx) => {
    try {
      const check = validateOrderItems(items);
      if (!check.ok) {
        return { ok: false, error: check.error };
      }
      return runBookkeepingOnce(ctx, 'record_order', () => {
        const orderId = insertValidatedOrder(ctx.customerId, check.items, check.totalMinor, {
          actorType: 'customer',
          actorCustomerId: ctx.customerId,
          source: ctx.idempotencyKey ? 'whatsapp_customer_tool' : 'direct_customer_tool',
          sourceEventKey: ctx.idempotencyKey,
          evidence: 'Customer confirmed the order contents before placement.',
        });
        return { ok: true, order_id: orderId, total: check.total };
      });
    } catch {
      return { ok: false, error: 'Could not record the order — please try again.' };
    }
  },
};

function cleanRequiredText(value: unknown, label: string, min: number, max: number): string | { error: string } {
  if (typeof value !== 'string') return { error: `${label} must be plain text.` };
  const clean = value.trim().replace(/\s+/g, ' ');
  if (clean.length < min || clean.length > max) {
    return { error: `${label} must contain ${min}-${max} characters.` };
  }
  return clean;
}

function cleanOptionalText(value: unknown, label: string, max: number): string | null | { error: string } {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') return { error: `${label} must be plain text.` };
  const clean = value.trim().replace(/\s+/g, ' ');
  if (clean.length > max) return { error: `${label} must be ${max} characters or fewer.` };
  return clean || null;
}

function normalizeContactPhone(value: unknown): string | { error: string } {
  if (typeof value !== 'string') return { error: 'Contact number must be plain text.' };
  const trimmed = value.trim();
  const digits = trimmed.replace(/\D/g, '');
  if (digits.length < 10 || digits.length > 15) {
    return { error: 'Contact number must contain 10-15 digits.' };
  }
  return trimmed.startsWith('+') ? `+${digits}` : digits;
}

function normalizePaymentMethod(value: unknown): PaymentMethod | { error: string } {
  if (typeof value !== 'string') {
    return { error: 'Payment method must be COD, bank transfer, Easypaisa, or JazzCash.' };
  }
  const normalized = value.trim().toLowerCase().replace(/[\s-]+/g, '_');
  const aliases: Record<string, PaymentMethod> = {
    cod: 'cod',
    cash_on_delivery: 'cod',
    cash: 'cod',
    bank: 'bank_transfer',
    bank_transfer: 'bank_transfer',
    easypaisa: 'easypaisa',
    easy_paisa: 'easypaisa',
    jazzcash: 'jazzcash',
    jazz_cash: 'jazzcash',
  };
  return aliases[normalized] ?? { error: 'Payment method must be COD, bank transfer, Easypaisa, or JazzCash.' };
}

function validateFulfillment(input: any): FulfillmentDetails | { error: string } {
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

function aggregateDraftItems(items: unknown): unknown[] | { error: string } {
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

function checkDraftStock(items: ServerPricedOrderItem[]): string | null {
  const read = db.prepare('select name, size, color, stock from products where id = ? and active = 1');
  for (const item of items) {
    const product = read.get(item.product_id) as
      | { name: string; size: string | null; color: string | null; stock: number }
      | undefined;
    if (!product) return `Product ${item.product_id} is no longer available.`;
    if (product.stock < item.qty) {
      const variant = [product.color, product.size, product.name].filter(Boolean).join(' ');
      return `Not enough stock for ${variant}: requested ${item.qty}, available ${product.stock}.`;
    }
  }
  return null;
}

function draftResult(row: OrderDraftRow) {
  const items = JSON.parse(row.items_json) as ServerPricedOrderItem[];
  const productRows = db.prepare('select id, name, size, color from products where id = ?');
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
    contact_phone: row.contact_phone,
    delivery_address: row.delivery_address,
    city: row.city,
    postal_code: row.postal_code,
    delivery_instructions: row.delivery_instructions,
    payment_method: row.payment_method,
    needs_explicit_confirmation: row.status === 'awaiting_confirmation',
    instruction: row.status === 'awaiting_confirmation'
      ? 'Show this complete summary and ask the customer to confirm. Do not say the order is booked yet.'
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
  const exact = new Set(['yes', 'y', 'haan', 'han', 'ha', 'ji', 'ok', 'okay', 'confirm', 'confirmed', 'done']);
  if (exact.has(normalized)) return true;
  return (
    /\b(confirm|place|book)\b.{0,30}\b(order|it|this)\b/.test(normalized) ||
    /\b(order|it|this)\b.{0,30}\b(confirm|place|book)\b/.test(normalized) ||
    /\border\b.{0,25}\bkar\b.{0,10}\b(do|dein|dain|den)\b/.test(normalized) ||
    /\bbook\b.{0,20}\bkar\b.{0,10}\b(do|dein|dain|den)\b/.test(normalized)
  );
}

export const prepareOrder: ToolDef = {
  name: 'prepare_order',
  description:
    'Validate the complete delivery details, live stock, and server-controlled prices, then save a draft. ' +
    'This does NOT create or book an order. Show the returned summary and wait for a later customer message.',
  input_schema: {
    type: 'object',
    properties: {
      items: {
        type: 'array',
        items: {
          type: 'object',
          properties: { product_id: { type: 'number' }, qty: { type: 'number' } },
          required: ['product_id', 'qty'],
        },
      },
      recipient_name: { type: 'string' },
      contact_phone: { type: 'string' },
      delivery_address: { type: 'string' },
      city: { type: 'string' },
      postal_code: { type: 'string', description: 'optional' },
      delivery_instructions: { type: 'string', description: 'optional landmark or instructions' },
      payment_method: { type: 'string', enum: PAYMENT_METHODS },
    },
    required: ['items', 'recipient_name', 'contact_phone', 'delivery_address', 'city', 'payment_method'],
  },
  execute: (input, ctx) => {
    try {
      const fulfillment = validateFulfillment(input);
      if ('error' in fulfillment) return { ok: false, error: fulfillment.error };
      const aggregated = aggregateDraftItems(input?.items);
      if (!Array.isArray(aggregated)) return { ok: false, error: aggregated.error };
      const priced = validateOrderItems(aggregated);
      if (!priced.ok) return { ok: false, error: priced.error };
      const stockError = checkDraftStock(priced.items);
      if (stockError) return { ok: false, error: stockError };

      const eventKey = ctx.idempotencyKey ? `${ctx.idempotencyKey}:prepare_order` : null;
      const draft = db.transaction(() => {
        if (eventKey) {
          const existing = db.prepare('select * from order_drafts where prepared_event_key = ?').get(eventKey) as OrderDraftRow | undefined;
          if (existing) return existing;
        }
        db.prepare(`
          update order_drafts set status = 'superseded', updated_at = datetime('now')
          where customer_id = ? and status = 'awaiting_confirmation'
        `).run(ctx.customerId);
        const inserted = db.prepare(`
          insert into order_drafts
            (customer_id, items_json, total_minor, shipping_minor, recipient_name,
             contact_phone, delivery_address, city, postal_code,
             delivery_instructions, payment_method, prepared_event_key)
          values (?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          ctx.customerId,
          JSON.stringify(priced.items),
          priced.totalMinor,
          fulfillment.recipientName,
          fulfillment.contactPhone,
          fulfillment.deliveryAddress,
          fulfillment.city,
          fulfillment.postalCode,
          fulfillment.deliveryInstructions,
          fulfillment.paymentMethod,
          eventKey,
        );
        return db.prepare('select * from order_drafts where id = ?').get(inserted.lastInsertRowid) as OrderDraftRow;
      }).immediate();
      return draftResult(draft);
    } catch {
      return { ok: false, error: 'Could not prepare the order safely — please try again.' };
    }
  },
};

export function confirmPendingOrderDraft(ctx: ToolContext): Record<string, unknown> {
  if (!ctx.idempotencyKey) {
    return {
      ok: false,
      error: 'A stable inbound message identity is required before an order can be confirmed.',
    };
  }
  if (!isExplicitOrderConfirmation(ctx.inboundText)) {
    return {
      ok: false,
      error: 'The customer must explicitly confirm the prepared summary in their current message.',
    };
  }
  const confirmedEventKey = `${ctx.idempotencyKey}:confirm_order`;
  try {
    return db.transaction(() => {
      if (confirmedEventKey) {
        const prior = db.prepare('select * from order_drafts where confirmed_event_key = ?').get(confirmedEventKey) as OrderDraftRow | undefined;
        if (prior?.order_id) {
          return { ok: true, order_id: prior.order_id, draft_id: prior.id, status: 'confirmed', already_confirmed: true };
        }
      }
      const draft = getPendingOrderDraft(ctx.customerId);
      if (!draft) return { ok: false, error: 'There is no prepared order waiting for this customer to confirm.' };
      if (draft.prepared_event_key === `${ctx.idempotencyKey}:prepare_order`) {
        return {
          ok: false,
          error: 'Show the prepared summary first, then wait for a new customer message before confirming it.',
        };
      }
      const parsedItems = JSON.parse(draft.items_json) as unknown;
      const current = validateOrderItems(parsedItems);
      if (!current.ok) return { ok: false, error: `${current.error} Please prepare a fresh summary.` };
      if (current.totalMinor !== draft.total_minor || JSON.stringify(current.items) !== draft.items_json) {
        return { ok: false, error: 'A catalog price changed. Please prepare and confirm a fresh order summary.' };
      }
      const stockError = checkDraftStock(current.items);
      if (stockError) return { ok: false, error: `${stockError} Please prepare a fresh order summary.` };
      const fulfillment: FulfillmentDetails = {
        recipientName: draft.recipient_name,
        contactPhone: draft.contact_phone,
        deliveryAddress: draft.delivery_address,
        city: draft.city,
        postalCode: draft.postal_code,
        deliveryInstructions: draft.delivery_instructions,
        paymentMethod: draft.payment_method,
        shippingMinor: 0,
      };
      const auditSource = ctx.idempotencyKey ? 'whatsapp_fulfillment_confirmation' : 'direct_fulfillment_confirmation';
      const orderId = insertValidatedOrder(ctx.customerId, current.items, current.totalMinor, {
        actorType: 'customer',
        actorCustomerId: ctx.customerId,
        source: auditSource,
        sourceEventKey: ctx.idempotencyKey,
        evidence: 'Customer explicitly confirmed the complete server-priced delivery summary.',
      }, fulfillment);
      const reservation = transitionOrderStatus(orderId, 'confirmed', {
        actorType: 'customer',
        actorCustomerId: ctx.customerId,
        source: auditSource,
        sourceEventKey: ctx.idempotencyKey,
        evidence: 'Explicit final confirmation booked the order and reserved stock.',
      });
      if (!reservation.ok) throw new Error(reservation.error);
      const updated = db.prepare(`
        update order_drafts
        set status = 'confirmed', confirmed_event_key = ?, order_id = ?,
            confirmed_at = datetime('now'), updated_at = datetime('now')
        where id = ? and status = 'awaiting_confirmation'
      `).run(confirmedEventKey, orderId, draft.id);
      if (updated.changes !== 1) throw new Error('Draft confirmation lost its atomic state check.');
      return {
        ok: true,
        draft_id: draft.id,
        order_id: orderId,
        status: 'confirmed',
        total: minorToRupees(current.totalMinor, 'confirmed order total'),
        stock_reserved: true,
      };
    }).immediate();
  } catch {
    return { ok: false, error: 'Could not confirm the order safely; no partial order was created.' };
  }
}

export const confirmOrder: ToolDef = {
  name: 'confirm_order',
  description:
    'Confirm the current customer\'s existing prepared order. Call only on a later message where the customer explicitly confirms. ' +
    'The server verifies the exact inbound text, current catalog price, and stock before creating and reserving the order.',
  input_schema: { type: 'object', properties: {} },
  execute: (_input, ctx) => confirmPendingOrderDraft(ctx),
};

// Wide schema for the model (status is just `string` — the JSON-schema
// `enum` below is a hint, not the gate), strict validation server-side via
// the real state machine in orders.ts, same discipline as every other tool
// in this file. `orders.ts` doesn't qualify `next` against `'placed'` in
// any ALLOWED_TRANSITIONS list, so a model attempting to set that status
// back is already rejected by the state machine itself — no special case
// needed here.
export const updateOrderStatus: ToolDef = {
  name: 'update_order_status',
  description:
    'Allow a customer to confirm their own placed order or cancel it before shipping. ' +
    'Customers cannot mark an order paid, shipped, or delivered.',
  input_schema: {
    type: 'object',
    properties: {
      order_id: { type: 'number', description: 'the order id' },
      status: {
        type: 'string',
        enum: ['confirmed', 'cancelled'],
        description: 'the new status',
      },
    },
    required: ['order_id', 'status'],
  },
  execute: ({ order_id, status }, ctx) => {
    if (!Number.isInteger(order_id) || order_id <= 0) {
      return { ok: false, error: 'order_id must be a positive whole number.' };
    }
    if (status !== 'confirmed' && status !== 'cancelled') {
      return {
        ok: false,
        error: 'Customers may only confirm or cancel their own order. Paid, shipped, and delivered require trusted verification.',
      };
    }

    const order = db.prepare('select customer_id from orders where id = ?').get(order_id) as
      | { customer_id: number }
      | undefined;
    if (!order) {
      return { ok: false, error: `Order ${order_id} does not exist.` };
    }
    if (order.customer_id !== ctx.customerId) {
      return { ok: false, error: `Order ${order_id} does not belong to this customer.` };
    }

    const result = transitionOrderStatus(order_id, status as OrderStatus, {
      actorType: 'customer',
      actorCustomerId: ctx.customerId,
      source: ctx.idempotencyKey ? 'whatsapp_customer_tool' : 'direct_customer_tool',
      sourceEventKey: ctx.idempotencyKey,
      evidence: `Customer requested order status ${status}.`,
    });
    if (!result.ok) {
      return { ok: false, error: result.error };
    }
    return { ok: true, order_id: result.order_id, from: result.from, to: result.to };
  },
};

export const recordPayment: ToolDef = {
  name: 'record_payment',
  description: 'Record that this customer paid some amount, reducing what they owe.',
  input_schema: {
    type: 'object',
    properties: { amount: { type: 'number' } },
    required: ['amount'],
  },
  execute: ({ amount }, ctx) => {
    try {
      if (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0) {
        return { ok: false, error: 'Payment amount must be a number greater than 0.' };
      }
      return runBookkeepingOnce(ctx, 'record_payment', () => {
        recordCredit(ctx.customerId, amount);
        return { ok: true };
      });
    } catch {
      return { ok: false, error: 'Could not record the payment — please try again.' };
    }
  },
};

export const searchCatalog: ToolDef = {
  name: 'search_catalog',
  description:
    "Search Ahmed's catalog/FAQ document for general questions — what he sells, return policy, " +
    'delivery info, etc. This does NOT check live stock or exact prices — use check_stock for ' +
    "that. If this returns found:false, do NOT guess an answer — tell the customer you'll " +
    'confirm and get back to them.',
  input_schema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'what the customer is asking about' },
    },
    required: ['query'],
  },
  execute: ({ query }) => {
    if (typeof query !== 'string' || query.trim() === '') {
      return { ok: false, error: 'Please say what you want to look up in the catalog.' };
    }
    const sections = loadCatalogSections();
    const match = findBestMatch(sections, query);
    if (!match) {
      return {
        found: false,
        instruction:
          "Nothing in the catalog answers this — do not guess. Tell the customer you'll " +
          'confirm and get back to them.',
      };
    }
    return { found: true, title: match.title, content: match.body };
  },
};

// Shared between notify_owner's own execute() and the Version 2.3 safety
// net in agent.ts's CLOSE step (flagging a possible order/payment the model
// wasn't confident enough to auto-log). This remains the durable handoff
// audit row and visible log marker. Version 3.3 adds WhatsApp delivery on top
// through createNotifyOwnerTool's injected callback; it does not replace or
// weaken this original record.
export function recordHandoff(customerId: number, reason: string): number {
  const result = db.prepare('insert into handoff_ledger (customer_id, reason) values (?, ?)').run(customerId, reason);
  log.warn('NEEDS AHMED', { customerId, reason });
  return Number(result.lastInsertRowid);
}

type HandoffAlertDelivery = (input: {
  customerId: number;
  reason: string;
  eventKey: string;
}) => Promise<{ ok: boolean; status?: string; alertId?: number; error?: string }>;

export function createNotifyOwnerTool(deliverAlert?: HandoffAlertDelivery): ToolDef {
  return {
    name: 'notify_owner',
    description:
      "Hand this conversation off to Ahmed directly — use when you genuinely can't resolve " +
      'something yourself (a question outside what you know, a customer asking for a bigger ' +
      'discount than you can approve, anything needing his judgment). Always call this BEFORE ' +
      "telling the customer someone will follow up with them — that promise isn't allowed to " +
      'send otherwise.',
    input_schema: {
      type: 'object',
      properties: {
        reason: { type: 'string', description: "what Ahmed needs to look at, and why" },
      },
      required: ['reason'],
    },
    execute: async ({ reason }, ctx) => {
      if (typeof reason !== 'string' || reason.trim() === '') {
        return { ok: false, error: 'Please describe what Ahmed needs to look at.' };
      }
      try {
        const cleanReason = reason.trim();
        const handoffId = recordHandoff(ctx.customerId, cleanReason);
        if (!deliverAlert) return { ok: true, handoff_id: handoffId };

        const delivery = await deliverAlert({
          customerId: ctx.customerId,
          reason: cleanReason,
          eventKey: `customer_handoff:${ctx.idempotencyKey ?? `handoff:${handoffId}`}`,
        });
        return delivery.ok
          ? { ok: true, handoff_id: handoffId, alert_status: delivery.status, alert_id: delivery.alertId }
          : { ok: false, handoff_id: handoffId, error: delivery.error };
      } catch {
        return { ok: false, error: 'Could not record the handoff — please try again.' };
      }
    },
  };
}

// The default remains useful for direct tool execution and fail-closed local
// environments. runTurn() replaces it with the delivery-enabled instance when
// a configured owner WhatsApp sender is available.
export const notifyOwner: ToolDef = createNotifyOwnerTool();

// `send_message` is deliberately NOT here — it's wired up in agent.ts
// because it needs access to the actual WhatsApp-sending function, which
// server.ts owns. Everything else is a pure database tool; this one has a
// side effect that leaves the system, so it's treated specially — same
// distinction the big file draws with `READ_ONLY_TOOLS`.

export const baseTools: ToolDef[] = [
  checkStock,
  getCustomerBalance,
  getCustomerNote,
  prepareOrder,
  confirmOrder,
  updateOrderStatus,
  claimPayment,
  notifyOwner,
  searchCatalog,
];

// ═══════════════════════════════════════════════════════════════════════════
// Version 3.2 — Ahmed's own analytics tools. Only reachable from
// runOwnerTurn() (agent.ts), never baseTools — a customer can never see
// these regardless of what they ask, because routing to this tool list at
// all requires isOwnerPhone() to have already said yes (owner.ts).
// Deliberately a small, FIXED, explicitly-named set of safe report
// functions — never a freely-written SQL query handed to the model, which
// is exactly the risk naming each one avoids.
// ═══════════════════════════════════════════════════════════════════════════

export const salesToday: ToolDef = {
  name: 'sales_today',
  description: "Total value of orders placed today (excluding cancelled ones), in Ahmed's shop timezone.",
  input_schema: { type: 'object', properties: {} },
  execute: () => ({ total_sales: getSalesToday() }),
};

export const unpaidCustomersTool: ToolDef = {
  name: 'unpaid_customers',
  description: 'Every customer who currently owes money, with how much, highest balance first.',
  input_schema: { type: 'object', properties: {} },
  execute: () => ({ unpaid_customers: getUnpaidCustomers() }),
};

export const topSellingProductTool: ToolDef = {
  name: 'top_selling_product',
  description: 'The single best-selling product by units sold, across all non-cancelled orders, all time.',
  input_schema: { type: 'object', properties: {} },
  execute: () => {
    const top = getTopSellingProduct();
    return top ? { found: true, ...top } : { found: false, message: 'No orders recorded yet.' };
  },
};

export const pendingFollowupsTool: ToolDef = {
  name: 'pending_followups',
  description:
    'Every unpaid order that has been sitting for a while, most overdue first. Report account_position exactly: store_credit means Ahmed owes/holds credit for the customer, not that the customer owes money.',
  input_schema: { type: 'object', properties: {} },
  execute: () => ({
    pending_followups: getPendingFollowups().map(({ balance_owed, ...followup }) => ({
      ...followup,
      account_position:
        balance_owed > 0
          ? { kind: 'amount_owed', amount: balance_owed }
          : balance_owed < 0
            ? { kind: 'store_credit', amount: Math.abs(balance_owed) }
            : { kind: 'settled', amount: 0 },
    })),
  }),
};

export const ownerTools: ToolDef[] = [
  salesToday,
  unpaidCustomersTool,
  topSellingProductTool,
  pendingFollowupsTool,
  pendingPaymentClaims,
  resolvePaymentClaim,
];
