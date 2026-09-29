import { db } from './db';
import { recordCreditMinor } from './ledger';
import { minorToRupees, positiveRupeesToMinor } from './money';
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
        order_id: { type: 'number', description: 'related order id, if the customer identified one' },
        method: { type: 'string', description: 'claimed method, e.g. bank transfer, Easypaisa, JazzCash, COD' },
        reference: { type: 'string', description: 'transaction/reference text supplied by the customer' },
      },
      required: ['amount'],
    },
    execute: async ({ amount, order_id, method, reference }, ctx) => {
      try {
        if (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0) {
          return { ok: false, error: 'Please provide the claimed payment amount greater than 0.' };
        }
        if (method !== undefined && typeof method !== 'string') {
          return { ok: false, error: 'Payment method must be plain text.' };
        }
        if (reference !== undefined && typeof reference !== 'string') {
          return { ok: false, error: 'Payment reference must be plain text.' };
        }
        const eventKey = ctx.idempotencyKey ? `${ctx.idempotencyKey}:payment_claim` : undefined;
        const claim = createPaymentClaim({
          customerId: ctx.customerId,
          amount,
          orderId: order_id,
          method,
          reference,
          eventKey,
        });
        if (!deliverAlert) {
          return { ok: true, claim_id: claim.id, status: claim.status };
        }
        const detail = [
          `Payment claim #${claim.id}: amount ${claim.amount}`,
          claim.order_id ? `order #${claim.order_id}` : null,
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
          alert_status: delivery.status,
          ...(delivery.alertId ? { alert_id: delivery.alertId } : {}),
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
  description: 'List customer payment claims that still require Ahmed to approve or reject them.',
  input_schema: { type: 'object', properties: {} },
  execute: () => ({
    claims: (db.prepare(`
      select pc.id, pc.order_id, pc.amount_minor, pc.method, pc.reference, pc.created_at,
             c.name as customer_name, c.phone as customer_phone
      from payment_claims pc
      join customers c on c.id = pc.customer_id
      where pc.status = 'pending'
      order by pc.created_at, pc.id
    `).all() as Array<Record<string, unknown> & { amount_minor: number }>).map(({ amount_minor, ...claim }) => ({
      ...claim,
      amount: minorToRupees(amount_minor, 'pending payment claim amount'),
    })),
  }),
};

export const resolvePaymentClaim: ToolDef = {
  name: 'resolve_payment_claim',
  description:
    'Approve or reject one pending payment claim after Ahmed personally verifies it. ' +
    'Approval creates one ledger credit; it does not change order status.',
  input_schema: {
    type: 'object',
    properties: {
      claim_id: { type: 'number' },
      decision: { type: 'string', enum: ['approve', 'reject'] },
    },
    required: ['claim_id', 'decision'],
  },
  execute: ({ claim_id, decision }, ctx: ToolContext) => {
    if (!Number.isInteger(claim_id) || claim_id <= 0) {
      return { ok: false, error: 'claim_id must be a positive whole number.' };
    }
    if (decision !== 'approve' && decision !== 'reject') {
      return { ok: false, error: 'decision must be approve or reject.' };
    }

    try {
      return db.transaction(() => {
        const claim = db.prepare('select * from payment_claims where id = ?').get(claim_id) as
          | StoredPaymentClaimRow
          | undefined;
        if (!claim) return { ok: false, error: `Payment claim ${claim_id} does not exist.` };
        if (claim.status !== 'pending') {
          return {
            ok: true,
            claim_id: claim.id,
            status: claim.status,
            already_resolved: true,
            ledger_credit_created: claim.status === 'approved',
          };
        }

        const nextStatus = decision === 'approve' ? 'approved' : 'rejected';
        if (nextStatus === 'approved') {
          recordCreditMinor(claim.customer_id, claim.amount_minor, claim.order_id);
        }
        db.prepare(`
          update payment_claims
             set status = ?, resolved_by_customer_id = ?, resolved_at = datetime('now')
           where id = ? and status = 'pending'
        `).run(nextStatus, ctx.customerId, claim.id);
        return {
          ok: true,
          claim_id: claim.id,
          status: nextStatus,
          ledger_credit_created: nextStatus === 'approved',
          order_status_changed: false,
        };
      }).immediate();
    } catch {
      return { ok: false, error: 'Could not resolve the payment claim safely; no credit was committed.' };
    }
  },
};
