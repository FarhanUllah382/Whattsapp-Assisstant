// Owner-only read-only report tools (inventory, sales, unpaid customers,
// top seller, follow-ups). See the Version 3.2 note above ownerTools in
// tools.ts for why this is a small fixed set. Split out of tools.ts.

import { getSalesToday, getTopSellingProduct, getUnpaidCustomers } from '../analytics';
import { db } from '../db';
import { getPendingFollowups } from '../followups';
import { minorToRupees } from '../money';
import type { ToolDef } from '../types';

export const inventoryOverviewTool: ToolDef = {
  name: 'inventory_overview',
  description:
    'Owner-only read-only inventory report. Use when Ahmed asks what is in stock, stock levels, products, sizes, colors, or prices.',
  input_schema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'optional product or category text filter' },
    },
  },
  execute: ({ query }) => {
    if (query !== undefined && typeof query !== 'string') {
      return { ok: false, error: 'Inventory query must be plain text.' };
    }
    const normalized = query?.trim().toLowerCase() ?? '';
    const escaped = normalized.replace(/[\\%_]/g, '\\$&');
    const like = `%${escaped}%`;
    const rows = db.prepare(`
      select sku, name, category, size, color, price_minor, stock
        from products
       where active = 1
         and (? = '' or lower(name) like ? escape '\\' or lower(coalesce(category, '')) like ? escape '\\')
       order by category, name, color, size, sku
    `).all(normalized, like, like) as Array<{
      sku: string;
      name: string;
      category: string | null;
      size: string | null;
      color: string | null;
      price_minor: number;
      stock: number;
    }>;
    return {
      ok: true,
      active_sku_count: rows.length,
      products: rows.map(({ price_minor, ...row }) => ({
        ...row,
        price: minorToRupees(price_minor, 'owner inventory price'),
      })),
    };
  },
};

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
