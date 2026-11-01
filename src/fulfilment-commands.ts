// Deterministic owner fulfilment commands (shipped / delivered).
//
// Same discipline as the payment-claim commands in payment-resolution.ts: no
// model in the loop for the state change. Ahmed sends an exact command
//   SHIP ORDER <ORD-ref>      or   DELIVER ORDER <ORD-ref>
// and receives a server-built summary plus the exact confirmation text. Only a
// LATER inbound message with exactly
//   CONFIRM SHIP ORDER <ORD-ref>   or   CONFIRM DELIVER ORDER <ORD-ref>
// performs the transition, once, through transitionOrderStatus (src/orders.ts)
// with the owner as actor and the provider message id as source event key.
//
// What the current FSM allows (and therefore what this module allows):
//   paid -> shipped, shipped -> delivered. A confirmed-but-unpaid order (the
//   normal cash-on-delivery situation) cannot be shipped; that is an owner
//   policy decision (HARD-09/HARD-10), not something this module changes.
// Cancellation is deliberately not offered here: cancelling a paid order
// creates a ledger credit (store credit / refund territory, HARD-11).
// No customer notification is sent: the owner turn has no customer sender and
// the guarded customer send path lives inside agent.ts.

import { randomUUID } from 'node:crypto';
import { db } from './db';
import { minorToRupees } from './money';
import { checkOrderStatusTransition, transitionOrderStatus, type OrderStatus } from './orders';
import { isOwnerPhone } from './owner';
import { maskPhoneForDisplay } from './privacy';

export type FulfilmentTarget = 'shipped' | 'delivered';

export interface FulfilmentCommandContext {
  ownerCustomerId: number;
  /** Stable provider message id (or a deterministic local key). */
  eventKey: string;
}

export interface FulfilmentCommandResult {
  response: string;
  mutation: 'none' | FulfilmentTarget;
}

interface IntentRow {
  id: string;
  owner_customer_id: number;
  order_id: number;
  target_status: FulfilmentTarget;
  from_status: OrderStatus;
  status: 'pending' | 'confirmed' | 'cancelled' | 'expired';
  source_event_key: string;
  confirm_event_key: string | null;
  status_event_id: number | null;
  expires_at: string;
}

interface OrderRow {
  id: number;
  public_ref: string;
  status: OrderStatus;
  total_minor: number;
  payment_method: string | null;
  items_json: string;
  customer_phone: string;
}

const REF = 'ORD-[0-9A-F]{20}';
const PREPARE_COMMAND = new RegExp(`^(SHIP|DELIVER)\\s+ORDER\\s+(${REF})$`, 'i');
const CONFIRM_COMMAND = new RegExp(`^CONFIRM\\s+(SHIP|DELIVER)\\s+ORDER\\s+(${REF})$`, 'i');
const CANCEL_ACTION_COMMAND = /^CANCEL\s+FULFIL{1,2}MENT\s+ACTION$/i;
// Anything that starts like a fulfilment command but is not the exact grammar.
const MALFORMED_COMMAND = /^(?:CONFIRM\s+)?(SHIP|DELIVER)\s+ORDER\b/i;
// Natural-language requests to change one specific order's fulfilment state.
const MUTATION_VERB = /\b(?:ship|shipped|dispatch|dispatched|deliver|delivered|bhej|bhejo|bhej\s+do)\b/i;
const SPECIFIC_ORDER = new RegExp(`(?:${REF.replace('{20}', '+')}|\\border\\s*#?\\d+)`, 'i');

const NOT_FOUND = 'No order matches that reference. Nothing was changed.';
const VERB: Record<FulfilmentTarget, 'SHIP' | 'DELIVER'> = { shipped: 'SHIP', delivered: 'DELIVER' };

function targetFromVerb(verb: string): FulfilmentTarget {
  return verb.toUpperCase() === 'SHIP' ? 'shipped' : 'delivered';
}

function confirmText(target: FulfilmentTarget, ref: string): string {
  return `CONFIRM ${VERB[target]} ORDER ${ref}`;
}

function isAuthenticatedOwner(customerId: number): boolean {
  if (!Number.isInteger(customerId) || customerId <= 0) return false;
  const row = db.prepare('select phone from customers where id = ?').get(customerId) as { phone: string } | undefined;
  return Boolean(row && isOwnerPhone(row.phone));
}

function orderByReference(ref: string): OrderRow | undefined {
  return db.prepare(`
    select o.id, o.public_ref, o.status, o.total_minor, o.payment_method, o.items_json, c.phone as customer_phone
      from orders o join customers c on c.id = o.customer_id
     where o.public_ref = ? collate nocase
  `).get(ref.toUpperCase()) as OrderRow | undefined;
}

function orderById(orderId: number): OrderRow | undefined {
  return db.prepare(`
    select o.id, o.public_ref, o.status, o.total_minor, o.payment_method, o.items_json, c.phone as customer_phone
      from orders o join customers c on c.id = o.customer_id
     where o.id = ?
  `).get(orderId) as OrderRow | undefined;
}

function itemCount(itemsJson: string): number | null {
  try {
    const items = JSON.parse(itemsJson) as Array<{ qty?: unknown }>;
    if (!Array.isArray(items)) return null;
    return items.reduce((sum, item) => sum + (Number.isInteger(item?.qty) ? Number(item.qty) : 0), 0);
  } catch {
    return null;
  }
}

function displayOrder(order: OrderRow): string {
  const count = itemCount(order.items_json);
  return [
    order.public_ref.toUpperCase(),
    `status ${order.status}`,
    `Rs ${minorToRupees(order.total_minor, 'fulfilment summary total').toLocaleString('en-PK')}`,
    count === null ? 'items unknown' : `${count} item${count === 1 ? '' : 's'}`,
    order.payment_method ? `payment ${order.payment_method.toUpperCase()}` : 'payment method not recorded',
    `customer ${maskPhoneForDisplay(order.customer_phone)}`,
  ].join(' · ');
}

/** Teaching text when the current FSM does not allow `order.status -> target`. */
function refusal(order: OrderRow, target: FulfilmentTarget): string | null {
  if (checkOrderStatusTransition(order.status, target).ok) return null;
  const ref = order.public_ref.toUpperCase();
  if (order.status === target) {
    return `${ref} is already ${target}. Nothing was changed.`;
  }
  if (order.status === 'cancelled') {
    return `${ref} is cancelled and cannot be ${target}. Nothing was changed.`;
  }
  if (target === 'shipped') {
    if (order.status === 'delivered') return `${ref} is already delivered. Nothing was changed.`;
    const cod = order.payment_method === 'cod'
      ? ' Shipping a cash-on-delivery order before payment is not enabled; that is an owner policy decision, not a command.'
      : '';
    return `${ref} is ${order.status}, not paid yet. Current order rules only allow shipping a paid order. Nothing was changed.${cod}`;
  }
  return `${ref} is ${order.status}. An order must be shipped before it can be marked delivered. Nothing was changed.`;
}

function expireOldIntents(ownerCustomerId: number): void {
  db.prepare(`
    update order_fulfilment_intents set status = 'expired'
     where owner_customer_id = ? and status = 'pending'
       and julianday(expires_at) <= julianday('now')
  `).run(ownerCustomerId);
}

function pendingIntent(ownerCustomerId: number): IntentRow | undefined {
  expireOldIntents(ownerCustomerId);
  return db.prepare(`
    select * from order_fulfilment_intents
     where owner_customer_id = ? and status = 'pending'
     order by created_at desc limit 1
  `).get(ownerCustomerId) as IntentRow | undefined;
}

function evidenceText(intent: IntentRow, ref: string, confirmEventKey: string): string {
  return (
    `Owner exact two-step command ${VERB[intent.target_status]} ORDER ${ref}; ` +
    `prepared by event ${intent.source_event_key.slice(0, 160)}; ` +
    `confirmed by event ${confirmEventKey.slice(0, 160)}.`
  ).slice(0, 500);
}

function prepare(target: FulfilmentTarget, ref: string, ctx: FulfilmentCommandContext): FulfilmentCommandResult {
  return db.transaction((): FulfilmentCommandResult => {
    const retried = db.prepare('select * from order_fulfilment_intents where source_event_key = ?')
      .get(ctx.eventKey) as IntentRow | undefined;
    if (retried) {
      const retriedOrder = orderById(retried.order_id);
      return {
        mutation: 'none',
        response: retriedOrder && retried.status === 'pending'
          ? `Fulfilment action already prepared — nothing changed. Reply exactly: ${confirmText(retried.target_status, retriedOrder.public_ref.toUpperCase())}`
          : 'This command was already processed. Nothing was changed.',
      };
    }
    const order = orderByReference(ref);
    if (!order) return { mutation: 'none', response: NOT_FOUND };
    const refused = refusal(order, target);
    if (refused) return { mutation: 'none', response: refused };

    const old = pendingIntent(ctx.ownerCustomerId);
    if (old) {
      db.prepare("update order_fulfilment_intents set status = 'cancelled' where id = ? and status = 'pending'")
        .run(old.id);
    }
    db.prepare(`
      insert into order_fulfilment_intents
        (id, owner_customer_id, order_id, target_status, from_status, source_event_key, expires_at)
      values (?, ?, ?, ?, ?, ?, datetime('now', '+10 minutes'))
    `).run(randomUUID(), ctx.ownerCustomerId, order.id, target, order.status, ctx.eventKey);

    const publicRef = order.public_ref.toUpperCase();
    return {
      mutation: 'none',
      response: [
        'FULFILMENT ACTION PREPARED — nothing has changed yet.',
        `${VERB[target]}: ${displayOrder(order)}.`,
        `This will move the order from ${order.status} to ${target}. Stock and the ledger are not changed by this step.`,
        `Reply exactly within 10 minutes: ${confirmText(target, publicRef)}`,
        'Or reply exactly: CANCEL FULFILMENT ACTION',
      ].join('\n'),
    };
  }).immediate();
}

function confirm(target: FulfilmentTarget, ref: string, ctx: FulfilmentCommandContext): FulfilmentCommandResult {
  return db.transaction((): FulfilmentCommandResult => {
    // Provider retry of the exact same confirmation message.
    const replay = db.prepare('select * from order_fulfilment_intents where confirm_event_key = ?')
      .get(ctx.eventKey) as IntentRow | undefined;
    if (replay) {
      return {
        mutation: 'none',
        response: replay.status === 'confirmed'
          ? 'This exact confirmation was already applied; no duplicate change was made.'
          : 'This confirmation was already processed. Nothing was changed.',
      };
    }

    const order = orderByReference(ref);
    const intent = pendingIntent(ctx.ownerCustomerId);
    if (!intent || !order || intent.order_id !== order.id || intent.target_status !== target) {
      if (order && order.status === target) {
        return { mutation: 'none', response: `${order.public_ref.toUpperCase()} is already ${target}. No duplicate change was made.` };
      }
      const start = `${VERB[target]} ORDER ${order ? order.public_ref.toUpperCase() : '<ORD-reference>'}`;
      return {
        mutation: 'none',
        response: `No matching prepared fulfilment action exists. Nothing was changed. Start with “${start}”.`,
      };
    }
    if (intent.source_event_key === ctx.eventKey) {
      return { mutation: 'none', response: 'Confirmation must arrive in a later message. Nothing was changed.' };
    }

    const publicRef = order.public_ref.toUpperCase();
    if (order.status !== intent.from_status) {
      db.prepare("update order_fulfilment_intents set status = 'cancelled', confirm_event_key = ? where id = ?")
        .run(ctx.eventKey, intent.id);
      return {
        mutation: 'none',
        response: `${publicRef} changed to ${order.status} after this action was prepared. Nothing was changed; prepare it again if still needed.`,
      };
    }

    const result = transitionOrderStatus(order.id, target, {
      actorType: 'owner',
      actorCustomerId: ctx.ownerCustomerId,
      source: 'owner_fulfilment_command',
      sourceEventKey: ctx.eventKey.slice(0, 200),
      evidence: evidenceText(intent, publicRef, ctx.eventKey),
    });
    if (!result.ok) {
      db.prepare("update order_fulfilment_intents set status = 'cancelled', confirm_event_key = ? where id = ?")
        .run(ctx.eventKey, intent.id);
      return { mutation: 'none', response: `${publicRef} was not changed: ${result.error}` };
    }
    db.prepare(`
      update order_fulfilment_intents
         set status = 'confirmed', confirm_event_key = ?, status_event_id = ?, confirmed_at = datetime('now')
       where id = ? and status = 'pending'
    `).run(ctx.eventKey, result.event_id, intent.id);
    const updated = orderById(order.id)!;
    return {
      mutation: target,
      response: `${target.toUpperCase()}: ${displayOrder(updated)}. One order status event was recorded; stock and the ledger were not changed. The customer was not messaged automatically.`,
    };
  }).immediate();
}

function cancelPending(ctx: FulfilmentCommandContext): FulfilmentCommandResult {
  return db.transaction((): FulfilmentCommandResult => {
    const intent = pendingIntent(ctx.ownerCustomerId);
    if (!intent) return { mutation: 'none', response: 'No fulfilment action is waiting for confirmation.' };
    db.prepare("update order_fulfilment_intents set status = 'cancelled', confirm_event_key = ? where id = ? and status = 'pending'")
      .run(ctx.eventKey, intent.id);
    return { mutation: 'none', response: 'The pending fulfilment action was cancelled. Nothing was changed.' };
  }).immediate();
}

/**
 * Owner-only fulfilment command entry point. Returns null when the text is not
 * a fulfilment command (the caller continues with its normal handling), or
 * when the sender is not the authenticated owner (defence in depth; server.ts
 * already routes only the owner phone to runOwnerTurn).
 */
export async function handleOwnerFulfilmentCommand(
  rawText: string,
  ctx: FulfilmentCommandContext,
): Promise<FulfilmentCommandResult | null> {
  if (typeof rawText !== 'string' || typeof ctx?.eventKey !== 'string' || ctx.eventKey.trim() === '') return null;
  if (!isAuthenticatedOwner(ctx.ownerCustomerId)) return null;
  const text = rawText.trim().replace(/\s+/g, ' ');

  const confirmMatch = CONFIRM_COMMAND.exec(text);
  if (confirmMatch) return confirm(targetFromVerb(confirmMatch[1]), confirmMatch[2], ctx);

  const prepareMatch = PREPARE_COMMAND.exec(text);
  if (prepareMatch) return prepare(targetFromVerb(prepareMatch[1]), prepareMatch[2], ctx);

  if (CANCEL_ACTION_COMMAND.test(text)) return cancelPending(ctx);

  const malformed = MALFORMED_COMMAND.exec(text);
  if (malformed) {
    const verb = malformed[1].toUpperCase();
    return {
      mutation: 'none',
      response: `Not an exact fulfilment command. Nothing was changed. Use exactly: ${verb} ORDER ORD-<20 characters>, then in a later message CONFIRM ${verb} ORDER ORD-<20 characters>.`,
    };
  }

  if (MUTATION_VERB.test(text) && SPECIFIC_ORDER.test(text)) {
    return {
      mutation: 'none',
      response: 'Natural-language requests never change an order’s status. Nothing was changed. To mark an order shipped use SHIP ORDER <ORD-reference>; to mark it delivered use DELIVER ORDER <ORD-reference>; then send the exact CONFIRM command the server replies with.',
    };
  }
  return null;
}
