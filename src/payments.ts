import { db } from './db';
import { getBalance } from './ledger';
import { minorToRupees, positiveRupeesToMinor } from './money';
import { getOrderPublicReference, resolveOwnedOrderReference } from './order-access';
import { detectExplicitPaymentMethodSelection, parsePaymentMethod, type PaymentMethod } from './payment-instructions';
import { paymentClaimInstruction } from './sensitive-action-wording';
import { maskPhoneForDisplay } from './privacy';
import type { ToolContext, ToolDef } from './types';

export interface PaymentClaimRow {
  id: number;
  customer_id: number;
  order_id: number | null;
  amount: number;
  method: string | null;
  reference: string | null;
  status: 'pending' | 'approved' | 'rejected';
  event_key: string | null;
  resolved_by_customer_id: number | null;
  created_at: string;
  resolved_at: string | null;
}

interface StoredPaymentClaimRow extends Omit<PaymentClaimRow, 'amount'> {
  amount_minor: number;
}

function toPaymentClaimRow(row: StoredPaymentClaimRow): PaymentClaimRow {
  const { amount_minor, ...rest } = row;
  return { ...rest, amount: minorToRupees(amount_minor, 'payment claim amount') };
}

export const COD_CLAIM_NOT_NEEDED_MESSAGE =
  'COD is paid to the rider at delivery; no claim is needed. No payment claim was recorded. ' +
  'Tell the customer they pay the rider in cash when the order is delivered, and do not describe any payment as received.';

const CANCELLED_ORDER_CLAIM_MESSAGE =
  'This order is cancelled, so no payment claim was recorded. If the customer really sent money for it, ' +
  'use notify_owner so Ahmed can check; do not describe any payment as received.';

/** Thrown when a claim must not be recorded at all; the message is teaching text. */
export class PaymentClaimNotNeededError extends Error {}

const OPEN_CLAIM_WINDOW_SQL = "datetime('now', '-24 hours')";

export interface PaymentClaimOutcome {
  claim: PaymentClaimRow;
  /** false when an existing open claim (or event-key replay) was returned instead. */
  created: boolean;
  /** true when an earlier open claim for the same payment was reused. */
  duplicate: boolean;
}

function isCodMethod(method: string | undefined): boolean {
  if (!method) return false;
  return /^\s*(?:cod|cash(?:\s+on\s+delivery)?|cash[\s_-]+on[\s_-]+delivery)\s*$/i.test(method);
}

export type CanonicalPaymentMethod = PaymentMethod | 'unknown';

/**
 * Canonical payment method from free text ("JazzCash", "jazzcash se",
 * "Meezan bank", "cash on delivery"). Anything unrecognised — including no
 * method at all — is 'unknown'.
 */
export function canonicalPaymentMethod(method: string | null | undefined): CanonicalPaymentMethod {
  if (typeof method !== 'string' || method.trim() === '') return 'unknown';
  const exact = parsePaymentMethod(method);
  if (exact) return exact;
  if (isCodMethod(method)) return 'cod';
  const mentioned = detectExplicitPaymentMethodSelection(method);
  if (mentioned.status === 'selected') return mentioned.method;
  if (mentioned.status === 'ambiguous') return 'unknown';
  if (/\bbank\b|\bibft\b|\braast\b/i.test(method)) return 'bank_transfer';
  return 'unknown';
}

/**
 * True when the customer has live (not cancelled) orders and every one of
 * them is an undelivered COD order. A claim that names no order and no
 * method (the CLOSE safety net) can then only be about cash due at the door,
 * so it is not recorded — the same rule claim_payment applies to COD.
 */
export function onlyUndeliveredCodOrders(customerId: number): boolean {
  const row = db.prepare(`
    select
      count(*) as live,
      sum(case when payment_method = 'cod' and status <> 'delivered' then 1 else 0 end) as undelivered_cod
    from orders
    where customer_id = ? and status <> 'cancelled'
  `).get(customerId) as { live: number; undelivered_cod: number | null };
  return row.live > 0 && (row.undelivered_cod ?? 0) === row.live;
}

/**
 * The single place that records a customer payment claim (claim_payment tool
 * and the turn-close safety net). Business rules, inside one transaction:
 *   - event-key replay returns the original claim;
 *   - an undelivered COD order needs no claim (payment happens at the door);
 *   - an open (pending) claim for the same payment within 24 h — same
 *     amount, same order (or either without one), same canonical method (or
 *     either unknown) — is reused instead of inserted.
 */
export function recordPaymentClaim(input: {
  customerId: number;
  amount: number;
  orderId?: number;
  method?: string;
  reference?: string;
  eventKey?: string;
  /**
   * The CLOSE safety net knows neither order nor method: apply the COD rule
   * to the customer's orders (all live orders undelivered COD ⇒ no claim).
   */
  inferMethodFromOrders?: boolean;
}): PaymentClaimOutcome {
  return db.transaction((): PaymentClaimOutcome => {
    if (input.eventKey) {
      const existing = db.prepare('select * from payment_claims where event_key = ?').get(input.eventKey) as
        | StoredPaymentClaimRow
        | undefined;
      if (existing) return { claim: toPaymentClaimRow(existing), created: false, duplicate: false };
    }

    const amountMinor = positiveRupeesToMinor(input.amount, 'Payment amount');
    if (input.orderId !== undefined) {
      if (!Number.isInteger(input.orderId) || input.orderId <= 0) {
        throw new Error('order_id must be a positive whole number.');
      }
      const order = db.prepare('select customer_id, payment_method, status from orders where id = ?').get(input.orderId) as
        | { customer_id: number; payment_method: string | null; status: string }
        | undefined;
      if (!order) throw new Error(`Order ${input.orderId} does not exist.`);
      if (order.customer_id !== input.customerId) {
        throw new Error(`Order ${input.orderId} does not belong to this customer.`);
      }
      if (order.status === 'cancelled') throw new PaymentClaimNotNeededError(CANCELLED_ORDER_CLAIM_MESSAGE);
      if (order.payment_method === 'cod' && order.status !== 'delivered') {
        throw new PaymentClaimNotNeededError(COD_CLAIM_NOT_NEEDED_MESSAGE);
      }
    } else if (input.method === undefined && input.inferMethodFromOrders && onlyUndeliveredCodOrders(input.customerId)) {
      throw new PaymentClaimNotNeededError(COD_CLAIM_NOT_NEEDED_MESSAGE);
    } else if (isCodMethod(input.method)) {
      // A COD claim with no order named: if every live COD order is still
      // undelivered, there is nothing the customer could have paid yet.
      const cod = db.prepare(`
        select
          sum(case when status = 'delivered' then 1 else 0 end) as delivered,
          sum(case when status in ('placed', 'confirmed', 'paid', 'shipped') then 1 else 0 end) as open
        from orders
        where customer_id = ? and payment_method = 'cod'
      `).get(input.customerId) as { delivered: number | null; open: number | null };
      if ((cod.open ?? 0) > 0 && (cod.delivered ?? 0) === 0) {
        throw new PaymentClaimNotNeededError(COD_CLAIM_NOT_NEEDED_MESSAGE);
      }
    }

    const method = input.method?.trim().slice(0, 80) || null;
    // A duplicate is the SAME payment told again (re-verifier finding, fix
    // round 2: one Rs 800 JazzCash payment became 4 claims via "JazzCash",
    // "jazzcash se", no method and the CLOSE safety net with no order).
    // Same customer, an OPEN (pending) claim, same amount, within 24 h, AND
    // (same order OR either has no order) AND (same canonical method OR
    // either method is unknown). A different amount on the same order (an
    // instalment) or a different known method is a new claim.
    const canonical = canonicalPaymentMethod(method);
    const candidates = db.prepare(`
      select * from payment_claims
      where customer_id = ? and amount_minor = ? and status = 'pending'
        and created_at >= ${OPEN_CLAIM_WINDOW_SQL}
      order by id
    `).all(input.customerId, amountMinor) as StoredPaymentClaimRow[];
    const openDuplicate = candidates.find((row) => {
      const orderMatches = row.order_id === null || input.orderId === undefined || row.order_id === input.orderId;
      if (!orderMatches) return false;
      const other = canonicalPaymentMethod(row.method);
      return other === 'unknown' || canonical === 'unknown' || other === canonical;
    });
    if (openDuplicate) return { claim: toPaymentClaimRow(openDuplicate), created: false, duplicate: true };

    const reference = input.reference?.trim().slice(0, 160) || null;
    const result = db.prepare(`
      insert into payment_claims
        (customer_id, order_id, amount_minor, method, reference, event_key)
      values (?, ?, ?, ?, ?, ?)
    `).run(
      input.customerId,
      input.orderId ?? null,
      amountMinor,
      method,
      reference,
      input.eventKey ?? null,
    );
    return {
      claim: toPaymentClaimRow(
        db.prepare('select * from payment_claims where id = ?').get(result.lastInsertRowid) as StoredPaymentClaimRow,
      ),
      created: true,
      duplicate: false,
    };
  }).immediate();
}

export function createPaymentClaim(input: Parameters<typeof recordPaymentClaim>[0]): PaymentClaimRow {
  return recordPaymentClaim(input).claim;
}

type ClaimAlertDelivery = (input: {
  customerId: number;
  reason: string;
  eventKey: string;
}) => Promise<{ ok: boolean; status?: string; alertId?: number; error?: string }>;

export function createClaimPaymentTool(deliverAlert?: ClaimAlertDelivery): ToolDef {
  return {
    name: 'claim_payment',
    description:
      'Record that the customer says they paid. This creates a pending claim for owner review; ' +
      'it never credits the ledger or marks an order paid.',
    input_schema: {
      type: 'object',
      properties: {
        amount: { type: 'number', description: 'amount the customer says they paid' },
        order_reference: { type: 'string', description: 'related public order reference, if the customer identified one' },
        method: { type: 'string', description: 'payment method exactly as the customer described it' },
        reference: { type: 'string', description: 'transaction/reference text supplied by the customer' },
      },
      required: ['amount'],
    },
    execute: async (input, ctx) => {
      try {
        const { amount, order_reference, method, reference } = input ?? {};
        if (Object.hasOwn(input ?? {}, 'order_id')) {
          return { ok: false, error: 'Use the public order_reference beginning with ORD-, not an internal numeric order id.' };
        }
        if (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0) {
          return { ok: false, error: 'Please provide the claimed payment amount greater than 0.' };
        }
        if (method !== undefined && typeof method !== 'string') {
          return { ok: false, error: 'Payment method must be plain text.' };
        }
        if (reference !== undefined && typeof reference !== 'string') {
          return { ok: false, error: 'Payment reference must be plain text.' };
        }
        let ownedOrderId: number | undefined;
        let ownedOrderReference: string | undefined;
        if (order_reference !== undefined) {
          const resolved = resolveOwnedOrderReference(ctx.customerId, order_reference);
          if (!resolved.ok) return { ok: false, error: resolved.error };
          ownedOrderId = resolved.order.id;
          ownedOrderReference = resolved.order.public_ref.toUpperCase();
        }
        const eventKey = ctx.idempotencyKey ? `${ctx.idempotencyKey}:payment_claim` : undefined;
        let outcome: PaymentClaimOutcome;
        try {
          outcome = recordPaymentClaim({
            customerId: ctx.customerId,
            amount,
            orderId: ownedOrderId,
            method,
            reference,
            eventKey,
          });
        } catch (error) {
          if (error instanceof PaymentClaimNotNeededError) {
            return { ok: false, claim_created: false, error: error.message };
          }
          throw error;
        }
        const { claim } = outcome;
        if (outcome.duplicate) {
          // The earlier claim already alerted Ahmed; never insert or re-alert.
          return {
            ok: true,
            claim_id: claim.id,
            status: claim.status,
            order_reference:
              ownedOrderReference ?? (claim.order_id ? getOrderPublicReference(claim.order_id) : undefined),
            duplicate: true,
            new_claim_created: false,
            payment_verified: false,
            ledger_credited: false,
            order_status_changed: false,
            note: `An open claim #${claim.id} for this payment already exists; no new claim was recorded.`,
            instruction: paymentClaimInstruction(),
          };
        }
        if (!deliverAlert) {
          return {
            ok: true,
            claim_id: claim.id,
            status: claim.status,
            order_reference: ownedOrderReference,
            payment_verified: false,
            ledger_credited: false,
            order_status_changed: false,
            instruction: paymentClaimInstruction(),
          };
        }
        const detail = [
          `Payment claim #${claim.id}: amount ${claim.amount}`,
          claim.order_id ? `order ${ownedOrderReference ?? getOrderPublicReference(claim.order_id)}` : null,
          claim.method ? `method ${claim.method}` : null,
          claim.reference ? `reference ${claim.reference}` : null,
        ].filter(Boolean).join(', ');
        const delivery = await deliverAlert({
          customerId: ctx.customerId,
          reason: `${detail}. Approval is required before any ledger credit.`,
          eventKey: `payment_claim:${eventKey ?? `claim:${claim.id}`}`,
        });
        return {
          ok: true,
          claim_id: claim.id,
          status: claim.status,
          order_reference: ownedOrderReference,
          payment_verified: false,
          ledger_credited: false,
          order_status_changed: false,
          alert_status: delivery.status,
          ...(delivery.alertId ? { alert_id: delivery.alertId } : {}),
          instruction: paymentClaimInstruction(),
        };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : 'Could not record the payment claim.' };
      }
    },
  };
}

export const claimPayment = createClaimPaymentTool();

export const pendingPaymentClaims: ToolDef = {
  name: 'pending_payment_claims',
  description:
    'List unverified customer payment claims. This is read-only. Format each item only as CLAIM #<claim_id>; ' +
    'never add separate list-position numbers. Natural-language replies cannot resolve a claim.',
  input_schema: { type: 'object', properties: {} },
  execute: () => ({
    claims: (db.prepare(`
      select pc.id, pc.customer_id, pc.amount_minor, pc.method, pc.reference, pc.created_at,
             c.name as customer_name, c.phone as customer_phone,
             o.public_ref as order_reference,
             (select count(*) from payment_claims possible
               where possible.customer_id = pc.customer_id
                 and possible.amount_minor = pc.amount_minor
                 and possible.id <> pc.id
                 and possible.status in ('pending', 'approved')
                 and possible.approval_reversed_at is null) as similar_claims
      from payment_claims pc
      join customers c on c.id = pc.customer_id
      left join orders o on o.id = pc.order_id
      where pc.status = 'pending'
      order by pc.created_at, pc.id
    `).all() as Array<Record<string, unknown> & {
      id: number;
      customer_id: number;
      amount_minor: number;
      customer_phone: string;
      similar_claims: number;
    }>).map(({ id, customer_id, amount_minor, customer_phone, similar_claims, ...claim }) => ({
      claim_id: id,
      ...claim,
      amount: minorToRupees(amount_minor, 'pending payment claim amount'),
      customer_phone_masked: maskPhoneForDisplay(customer_phone),
      outstanding_balance: getBalance(customer_id),
      verification_status: 'unverified',
      possible_duplicate: similar_claims > 0,
      reference_requirement: 'For approval, independently verify the transaction in the business payment account.',
      instruction: `Nothing changes from natural language. To approve, use APPROVE CLAIM ${id} REF <VERIFIED_TRANSACTION_REFERENCE>. To reject, use REJECT CLAIM ${id}.`,
    })),
  }),
};

export const resolvePaymentClaim: ToolDef = {
  name: 'resolve_payment_claim',
  description:
    'Disabled legacy interface. Payment decisions are handled only by the deterministic exact-command, two-step owner path.',
  input_schema: {
    type: 'object',
    properties: {
      claim_id: { type: 'number' },
      decision: { type: 'string', enum: ['approve', 'reject'] },
    },
    required: ['claim_id', 'decision'],
  },
  execute: () => ({
    ok: false,
    error:
      'Direct model-controlled payment resolution is disabled. After independently checking the business payment account, use APPROVE CLAIM <id> REF <verified-reference>, or use REJECT CLAIM <id>, followed by the exact confirmation.',
  }),
};
