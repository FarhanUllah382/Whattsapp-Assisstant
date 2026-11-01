// Customer account/memory read tools: derived ledger balance and the full
// body behind a durable customer-note headline. Split out of tools.ts.

import { db } from '../db';
import { getBalance } from '../ledger';
import type { ToolDef } from '../types';

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
