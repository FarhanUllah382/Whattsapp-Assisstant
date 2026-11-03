// Customer order tools: prepare_order (draft), confirm_order (explicit
// booking) and update_order_status (actor-limited FSM transition). Split out
// of tools.ts; shared validation lives in ./order-validation and draft
// helpers in ./order-drafts.

import { db } from '../db';
import { minorToRupees } from '../money';
import { getOrderPublicReference, resolveOwnedOrderReference } from '../order-access';
import { transitionOrderStatus, type OrderStatus } from '../orders';
import {
  detectExplicitPaymentMethodSelection,
  getAvailablePaymentMethods,
  parsePaymentMethod,
  paymentMethodLabel,
} from '../payment-instructions';
import type { ToolContext, ToolDef } from '../types';
import {
  draftResult,
  EXPIRED_ORDER_DRAFT_ERROR,
  getExpiredOrderDraft,
  getPendingOrderDraft,
  isExplicitOrderConfirmation,
  orderDraftExpiresAt,
  type OrderDraftRow,
} from './order-drafts';
import {
  aggregateDraftItems,
  checkDraftStock,
  insertValidatedOrder,
  validateFulfillment,
  validateOrderItems,
  type FulfillmentDetails,
} from './order-validation';

export const prepareOrder: ToolDef = {
  name: 'prepare_order',
  description:
    'Validate the complete delivery details, live stock, and server-controlled prices, then save a draft. ' +
    'This does NOT create or book an order. The payment method must exactly match the method explicitly named ' +
    'in the current customer message; never substitute another method. The application sends the deterministic ' +
    'server summary automatically; never compose or send one yourself.',
  // A getter: the payment_method enum is rebuilt from the configured methods
  // (COD always; others only with their PAYMENT_* settings) every time the
  // schema is sent to the model, like send_payment_instructions.
  get input_schema() {
    return prepareOrderInputSchema();
  },
  execute: (input, ctx) => prepareOrderExecute(input, ctx),
};

function prepareOrderInputSchema(): ToolDef['input_schema'] {
  return {
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
      payment_method: { type: 'string', enum: getAvailablePaymentMethods() },
    },
    required: ['items', 'recipient_name', 'contact_phone', 'delivery_address', 'city', 'payment_method'],
  };
}

function prepareOrderExecute(input: any, ctx: ToolContext): unknown {
  {
    try {
      // The model is not an authority for payment choice. On a real customer
      // turn, bind the draft to exactly what the customer typed. Requiring the
      // method in the current message gives the server unambiguous evidence
      // without trusting model memory or silently reusing an older order's
      // choice. Direct/internal callers without inboundText keep the existing
      // validation contract.
      if (ctx.inboundText !== undefined) {
        const selection = detectExplicitPaymentMethodSelection(ctx.inboundText);
        if (selection.status === 'ambiguous') {
          return {
            ok: false,
            error:
              'The customer mentioned more than one payment method. Ask them to choose exactly one method in a new message; do not choose for them.',
          };
        }
        if (selection.status === 'none') {
          return {
            ok: false,
            error:
              'The customer must explicitly name exactly one payment method in the current message before an order draft can be prepared.',
          };
        }
        const submittedMethod = parsePaymentMethod(input?.payment_method);
        if (submittedMethod && submittedMethod !== selection.method) {
          return {
            ok: false,
            error:
              `The customer selected ${paymentMethodLabel(selection.method)}, but the submitted draft used ` +
              `${paymentMethodLabel(submittedMethod)}. Payment methods may never be substituted. ` +
              'Use the customer-selected method, or explain that it is unavailable and ask the customer to choose another method in a new message.',
          };
        }
      }
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
  }
}

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
          return {
            ok: true,
            order_id: prior.order_id,
            order_reference: getOrderPublicReference(prior.order_id),
            draft_id: prior.id,
            status: 'confirmed',
            already_confirmed: true,
          };
        }
      }
      const draft = getPendingOrderDraft(ctx.customerId);
      if (!draft) {
        if (getExpiredOrderDraft(ctx.customerId)) return { ok: false, error: EXPIRED_ORDER_DRAFT_ERROR };
        return { ok: false, error: 'There is no prepared order waiting for this customer to confirm.' };
      }
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
        order_reference: getOrderPublicReference(orderId),
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
    'Confirm the current customer\'s existing prepared order. Call only on a later message where the customer explicitly mentions ' +
    'confirming, booking, or placing the order; a bare yes, okay, haan, ji, or done is not sufficient. ' +
    'The server verifies the exact inbound text, current catalog price, and stock before creating and reserving the order.',
  input_schema: { type: 'object', properties: {} },
  execute: (_input, ctx) => {
    const result = confirmPendingOrderDraft(ctx);
    if (result.ok !== true) return result;
    const { order_id: _internalOrderId, draft_id: _internalDraftId, ...customerSafe } = result;
    return customerSafe;
  },
};

/** Sends one exact server-generated summary text; supplied by the agent's guarded send path. */
export type SendServerOrderSummary = (
  body: string,
  draftId: number,
  ctx: ToolContext,
) => Promise<{ ok?: boolean; error?: string; status?: string }>;

/**
 * show_pending_order (FIX2, live 2026-11-01 loop): re-sends the EXACT stored
 * server summary of the customer's pending draft through the authorized
 * order-summary send path, so the model never has to retype it. It takes no
 * input: the draft is always the current sender's own latest pending one.
 */
export function createShowPendingOrderTool(sendSummary: SendServerOrderSummary): ToolDef {
  return {
    name: 'show_pending_order',
    description:
      'Re-send the exact server-generated summary of this customer\'s prepared (not yet booked) order. ' +
      'Use it when the customer asks to see, check or repeat their pending order. It sends the message itself; ' +
      'never type, copy or rewrite an order summary in send_message. It does not confirm or book anything.',
    input_schema: { type: 'object', properties: {} },
    execute: async (_input, ctx) => {
      try {
        const draft = getPendingOrderDraft(ctx.customerId);
        if (!draft) {
          return getExpiredOrderDraft(ctx.customerId)
            ? { ok: false, error: EXPIRED_ORDER_DRAFT_ERROR }
            : {
                ok: false,
                error:
                  'There is no prepared order waiting for confirmation. Collect the missing order details and call prepare_order.',
              };
        }
        const summary = draftResult(draft);
        const sent = await sendSummary(summary.server_summary, draft.id, ctx);
        if (!sent.ok) {
          return { ok: false, error: sent.error ?? 'The order summary could not be sent right now.' };
        }
        return {
          ok: true,
          sent: true,
          status: 'awaiting_confirmation',
          booked: false,
          item_count: summary.items.length,
          expires_at: orderDraftExpiresAt(draft),
          note:
            'The exact server summary was sent. Do not send another summary. The order is NOT booked until a later ' +
            'customer message explicitly confirms it and confirm_order succeeds.',
        };
      } catch {
        return { ok: false, error: 'Could not load the prepared order safely — please try again.' };
      }
    },
  };
}

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
    'Allow a customer to confirm or cancel an order belonging to their current WhatsApp identity, using its public reference. ' +
    'Customers cannot mark an order paid, shipped, or delivered.',
  input_schema: {
    type: 'object',
    properties: {
      order_reference: { type: 'string', description: 'the public order reference, beginning ORD-' },
      status: {
        type: 'string',
        enum: ['confirmed', 'cancelled'],
        description: 'the new status',
      },
    },
    required: ['order_reference', 'status'],
  },
  execute: ({ order_reference, status }, ctx) => {
    if (status !== 'confirmed' && status !== 'cancelled') {
      return {
        ok: false,
        error: 'Customers may only confirm or cancel their own order. Paid, shipped, and delivered require trusted verification.',
      };
    }

    const resolved = resolveOwnedOrderReference(ctx.customerId, order_reference);
    if (!resolved.ok) return { ok: false, error: resolved.error };
    const orderId = resolved.order.id;

    const result = transitionOrderStatus(orderId, status as OrderStatus, {
      actorType: 'customer',
      actorCustomerId: ctx.customerId,
      source: ctx.idempotencyKey ? 'whatsapp_customer_tool' : 'direct_customer_tool',
      sourceEventKey: ctx.idempotencyKey,
      evidence: `Customer requested order status ${status}.`,
    });
    if (!result.ok) {
      return { ok: false, error: result.error };
    }
    return {
      ok: true,
      order_reference: resolved.order.public_ref.toUpperCase(),
      from: result.from,
      to: result.to,
    };
  },
};
