// ═══════════════════════════════════════════════════════════════════════════
// The AI's menu of actions. Compare to `AGENT_TOOL_DEFS` in the big reference
// file (11 tools, MCP catalog, per-turn conditional wiring). We start with 5.
//
// Rule borrowed from the big system, worth keeping forever: the AI's raw text
// is NEVER what reaches the customer. The only way it can speak is by calling
// `send_message`. This one rule is what makes "log everything, guard every
// message" possible later — there's exactly one choke point.
// ═══════════════════════════════════════════════════════════════════════════

import { findBestMatch, loadCatalogSections } from './catalog';
import { db } from './db';
import { getBalance, recordCredit, recordDebit } from './ledger';
import { createLogger } from './obs/logger';
import { ORDER_STATUSES, transitionOrderStatus, type OrderStatus } from './orders';
import type { ToolDef } from './types';

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

    let sql = 'select * from products where name like ?';
    const params: unknown[] = [`%${name}%`];
    if (size) {
      sql += ' and size = ?';
      params.push(size);
    }
    if (color) {
      sql += ' and color = ?';
      params.push(color);
    }
    const rows = db.prepare(sql).all(...params);
    return rows.length > 0 ? rows : { found: false, message: 'no matching product' };
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

export interface ValidateOrderItemsResult {
  ok: boolean;
  error?: string;
  total?: number;
}

// Shared between record_order's own execute() and the Version 2.3 safety
// net in agent.ts's CLOSE step (a possible order the model confirmed in
// conversation but never called record_order for) — one validation source
// of truth, so the safety net can never be looser than the real tool.
export function validateOrderItems(items: unknown): ValidateOrderItemsResult {
  if (!Array.isArray(items) || items.length === 0) {
    return { ok: false, error: 'Please list at least one item to order.' };
  }
  for (const it of items as any[]) {
    if (typeof it !== 'object' || it === null) {
      return { ok: false, error: 'Each order item must be a product, quantity, and price.' };
    }
    if (!Number.isInteger(it.product_id) || it.product_id <= 0) {
      return { ok: false, error: 'Each item needs a valid product.' };
    }
    if (!Number.isInteger(it.qty) || it.qty <= 0) {
      return { ok: false, error: 'Quantity must be a whole number greater than 0.' };
    }
    if (typeof it.price !== 'number' || !Number.isFinite(it.price) || it.price < 0) {
      return { ok: false, error: 'Price must be a number 0 or greater.' };
    }
    const product = db.prepare('select id from products where id = ?').get(it.product_id);
    if (!product) {
      return { ok: false, error: `Product ${it.product_id} does not exist — check the product first.` };
    }
  }
  const total = (items as any[]).reduce((sum, it) => sum + it.qty * it.price, 0);
  return { ok: true, total };
}

/** Assumes `items`/`total` already passed validateOrderItems — no re-validation here. */
export function insertValidatedOrder(customerId: number, items: unknown[], total: number): number {
  const result = db
    .prepare('insert into orders (customer_id, items_json, total, status) values (?, ?, ?, ?)')
    .run(customerId, JSON.stringify(items), total, 'placed');
  const orderId = result.lastInsertRowid as number;
  recordDebit(customerId, orderId, total);
  return orderId;
}

export const recordOrder: ToolDef = {
  name: 'record_order',
  description:
    'Record a new order for this customer. Only call this once the customer has ' +
    'clearly confirmed what they want (product, size, color, quantity).',
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
            price: { type: 'number' },
          },
          required: ['product_id', 'qty', 'price'],
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
      const orderId = insertValidatedOrder(ctx.customerId, items, check.total!);
      return { ok: true, order_id: orderId, total: check.total };
    } catch {
      return { ok: false, error: 'Could not record the order — please try again.' };
    }
  },
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
    "Move a real order forward through its lifecycle (confirmed -> paid -> shipped -> delivered), " +
    'or cancel it (only before it has shipped). Orders only move forward — you cannot skip a step ' +
    'or go backward. Call this once the conversation makes clear a status actually changed (e.g. ' +
    "the customer confirms the order, says they've paid, or asks to cancel) — never guess.",
  input_schema: {
    type: 'object',
    properties: {
      order_id: { type: 'number', description: 'the order id' },
      status: {
        type: 'string',
        enum: ['confirmed', 'paid', 'shipped', 'delivered', 'cancelled'],
        description: 'the new status',
      },
    },
    required: ['order_id', 'status'],
  },
  execute: ({ order_id, status }, ctx) => {
    if (!Number.isInteger(order_id) || order_id <= 0) {
      return { ok: false, error: 'order_id must be a positive whole number.' };
    }
    if (typeof status !== 'string' || !ORDER_STATUSES.includes(status as OrderStatus)) {
      return {
        ok: false,
        error: `"${status}" isn't a real order status. Use one of: confirmed, paid, shipped, delivered, cancelled.`,
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

    const result = transitionOrderStatus(order_id, status as OrderStatus);
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
      recordCredit(ctx.customerId, amount);
      return { ok: true };
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
// net in agent.ts's CLOSE step (flagging a possible order/payment the
// model wasn't confident enough to auto-log). Real WhatsApp delivery to
// Ahmed's own number still isn't built (1.3 itself has been live-verified
// since 2026-09-04 — that's not what's blocking this, the upgrade itself
// just hasn't been done yet, see PROJECT-TRACKER-FINAL.md's Version 1
// final-status note). Until then, this log line + ledger row IS the
// handoff delivery mechanism: a distinct, greppable marker Ahmed (or
// whoever's watching the logs) can act on directly.
export function recordHandoff(customerId: number, reason: string): void {
  db.prepare('insert into handoff_ledger (customer_id, reason) values (?, ?)').run(customerId, reason);
  log.warn('NEEDS AHMED', { customerId, reason });
}

export const notifyOwner: ToolDef = {
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
  execute: ({ reason }, ctx) => {
    if (typeof reason !== 'string' || reason.trim() === '') {
      return { ok: false, error: 'Please describe what Ahmed needs to look at.' };
    }
    try {
      recordHandoff(ctx.customerId, reason.trim());
      return { ok: true };
    } catch {
      return { ok: false, error: 'Could not record the handoff — please try again.' };
    }
  },
};

// `send_message` is deliberately NOT here — it's wired up in agent.ts
// because it needs access to the actual WhatsApp-sending function, which
// server.ts owns. Everything else is a pure database tool; this one has a
// side effect that leaves the system, so it's treated specially — same
// distinction the big file draws with `READ_ONLY_TOOLS`.

export const baseTools: ToolDef[] = [
  checkStock,
  getCustomerBalance,
  getCustomerNote,
  recordOrder,
  updateOrderStatus,
  recordPayment,
  notifyOwner,
  searchCatalog,
];
