import { db } from './db';
import { getBalance } from './ledger';
import { minorToRupees, positiveRupeesToMinor } from './money';
import { getOrderPublicReference, resolveOwnedOrderReference } from './order-access';
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

export function createPaymentClaim(input: {
  customerId: number;
  amount: number;
  orderId?: number;
  method?: string;
  reference?: string;
  eventKey?: string;
}): PaymentClaimRow {
  return db.transaction(() => {
    if (input.eventKey) {
      const existing = db.prepare('select * from payment_claims where event_key = ?').get(input.eventKey) as
        | StoredPaymentClaimRow
        | undefined;
      if (existing) return toPaymentClaimRow(existing);
    }

    const amountMinor = positiveRupeesToMinor(input.amount, 'Payment amount');
    if (input.orderId !== undefined) {
      if (!Number.isInteger(input.orderId) || input.orderId <= 0) {
        throw new Error('order_id must be a positive whole number.');
      }
      const order = db.prepare('select customer_id from orders where id = ?').get(input.orderId) as
        | { customer_id: number }
        | undefined;
      if (!order) throw new Error(`Order ${input.orderId} does not exist.`);
      if (order.customer_id !== input.customerId) {
        throw new Error(`Order ${input.orderId} does not belong to this customer.`);
      }
    }

    const method = input.method?.trim().slice(0, 80) || null;
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
    return toPaymentClaimRow(
      db.prepare('select * from payment_claims where id = ?').get(result.lastInsertRowid) as StoredPaymentClaimRow,
    );
  })();
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
        method: { type: 'string', description: 'claimed method, e.g. bank transfer, Easypaisa, JazzCash, COD' },
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
        const claim = createPaymentClaim({
          customerId: ctx.customerId,
          amount,
          orderId: ownedOrderId,
          method,
          reference,
          eventKey,
        });
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
