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
import { createLogger } from './obs/logger';
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
    const row = db
      .prepare('select balance_owed from customers where id = ?')
      .get(ctx.customerId) as { balance_owed: number } | undefined;
    return { balance_owed: row?.balance_owed ?? 0 };
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
      if (!Array.isArray(items) || items.length === 0) {
        return { ok: false, error: 'Please list at least one item to order.' };
      }
      for (const it of items) {
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

      const total = items.reduce((sum: number, it: any) => sum + it.qty * it.price, 0);
      const insertOrder = db.prepare(
        'insert into orders (customer_id, items_json, total, status) values (?, ?, ?, ?)',
      );
      const result = insertOrder.run(ctx.customerId, JSON.stringify(items), total, 'placed');
      db.prepare('update customers set balance_owed = balance_owed + ? where id = ?').run(
        total,
        ctx.customerId,
      );
      return { ok: true, order_id: result.lastInsertRowid, total };
    } catch {
      return { ok: false, error: 'Could not record the order — please try again.' };
    }
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
      db.prepare('update customers set balance_owed = balance_owed - ? where id = ?').run(
        amount,
        ctx.customerId,
      );
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
      db.prepare('insert into handoff_ledger (customer_id, reason) values (?, ?)').run(
        ctx.customerId,
        reason.trim(),
      );

      // The real WhatsApp connection (1.3) isn't live-verified yet — see
      // PROJECT-TRACKER-FINAL.md 1.3, currently blocked on a WhatsApp-side
      // session restriction. Until it's verified end-to-end, this log line
      // IS the handoff delivery mechanism: a distinct, greppable marker
      // Ahmed (or whoever's watching the logs) can act on directly.
      // TODO(after 1.3 is verified live): also send this as an actual
      // WhatsApp message to Ahmed's own number via the ChannelAdapter,
      // instead of only logging it.
      log.warn('NEEDS AHMED', { customerId: ctx.customerId, reason: reason.trim() });

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
  recordPayment,
  notifyOwner,
  searchCatalog,
];
