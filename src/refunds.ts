import { randomBytes } from 'node:crypto';

import { db } from './db';
import { resolveOwnedOrderReference } from './order-access';
import { sanitizeMemoryText } from './privacy';
import {
  REFUND_APPROVED_PENDING_EXECUTION_MESSAGE,
  REFUND_REJECTED_MESSAGE,
  REFUND_REQUEST_PENDING_MESSAGE,
  refundStatusInstruction,
} from './sensitive-action-wording';
import type { ToolContext, ToolDef } from './types';

const REFUND_REFERENCE_PATTERN = /^RFD-[0-9A-F]{20}$/;
const RETURN_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
export const REFUND_ACCESS_DENIED =
  'No matching refund request is available for this WhatsApp account and reference.';

type RefundStatus = 'requested' | 'approved_pending_execution' | 'rejected';
type RefundEligibility = 'eligible' | 'manual_review';

interface RefundRequestRow {
  id: number;
  public_ref: string;
  customer_id: number;
  order_id: number;
  reason: string;
  eligibility: RefundEligibility;
  status: RefundStatus;
  event_key: string | null;
  resolved_by_customer_id: number | null;
  created_at: string;
  resolved_at: string | null;
}

type RefundAlertDelivery = (input: {
  customerId: number;
  reason: string;
  eventKey: string;
}) => Promise<{ ok: boolean; status?: string; alertId?: number; error?: string }>;

function newRefundReference(): string {
  return `RFD-${randomBytes(10).toString('hex').toUpperCase()}`;
}

function normalizeRefundReference(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toUpperCase();
  return REFUND_REFERENCE_PATTERN.test(normalized) ? normalized : null;
}

function parseSqlUtc(value: string): number {
  return new Date(`${value.replace(' ', 'T')}Z`).getTime();
}

function refundEligibility(orderId: number, now: Date): RefundEligibility | { error: string } {
  const order = db.prepare('select status from orders where id = ?').get(orderId) as
    | { status: string }
    | undefined;
  if (!order) return { error: 'The related order no longer exists.' };
  if (order.status !== 'delivered') {
    return {
      error:
        'Refund requests are available after delivery. For an order that has not shipped, request cancellation instead.',
    };
  }

  const delivered = db.prepare(`
    select created_at
    from order_status_events
    where order_id = ? and to_status = 'delivered'
    order by id desc
    limit 1
  `).get(orderId) as { created_at: string } | undefined;
  if (!delivered) return 'manual_review';
  const deliveredAt = parseSqlUtc(delivered.created_at);
  if (!Number.isFinite(deliveredAt)) return 'manual_review';
  if (now.getTime() - deliveredAt > RETURN_WINDOW_MS) {
    return { error: 'The documented 7-day return window has passed for this order.' };
  }
  return 'eligible';
}

export function createRefundRequest(input: {
  customerId: number;
  orderId: number;
  reason: string;
  eventKey?: string;
  now?: Date;
}): RefundRequestRow {
  return db.transaction(() => {
    const ownedOrder = db.prepare('select customer_id from orders where id = ?').get(input.orderId) as
      | { customer_id: number }
      | undefined;
    if (!ownedOrder || ownedOrder.customer_id !== input.customerId) {
      throw new Error('No matching delivered order is available for this WhatsApp account.');
    }

    if (input.eventKey) {
      const prior = db.prepare('select * from refund_requests where event_key = ?').get(input.eventKey) as
        | RefundRequestRow
        | undefined;
      if (prior) {
        if (prior.customer_id !== input.customerId || prior.order_id !== input.orderId) {
          throw new Error('The refund request event conflicts with an existing request.');
        }
        return prior;
      }
    }

    const existing = db.prepare(`
      select * from refund_requests
      where order_id = ? and status in ('requested', 'approved_pending_execution')
      order by id desc limit 1
    `).get(input.orderId) as RefundRequestRow | undefined;
    if (existing) return existing;

    const eligibility = refundEligibility(input.orderId, input.now ?? new Date());
    if (typeof eligibility !== 'string') throw new Error(eligibility.error);
    const reason = sanitizeMemoryText(input.reason).trim().slice(0, 500);
    if (reason.length < 5) throw new Error('Please briefly explain why a refund is requested.');

    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const result = db.prepare(`
          insert into refund_requests
            (public_ref, customer_id, order_id, reason, eligibility, event_key)
          values (?, ?, ?, ?, ?, ?)
        `).run(
          newRefundReference(),
          input.customerId,
          input.orderId,
          reason,
          eligibility,
          input.eventKey ?? null,
        );
        return db.prepare('select * from refund_requests where id = ?').get(result.lastInsertRowid) as RefundRequestRow;
      } catch (error) {
        if (attempt === 2 || !(error instanceof Error) || !/unique/i.test(error.message)) throw error;
      }
    }
    throw new Error('Could not create a unique refund reference.');
  }).immediate();
}

export function createRequestRefundTool(deliverAlert?: RefundAlertDelivery): ToolDef {
  return {
    name: 'request_refund',
    description:
      'Create a refund-review case for this WhatsApp customer\'s own delivered order. ' +
      'This never approves, executes, or promises a refund.',
    input_schema: {
      type: 'object',
      properties: {
        order_reference: { type: 'string', description: 'the customer\'s ORD- public order reference' },
        reason: { type: 'string', description: 'why the customer is requesting a refund' },
      },
      required: ['order_reference', 'reason'],
    },
    execute: async (input, ctx) => {
      const { order_reference, reason } = input ?? {};
      if (Object.hasOwn(input ?? {}, 'order_id')) {
        return { ok: false, error: 'Use the public order_reference beginning with ORD-, not an internal numeric order id.' };
      }
      if (typeof reason !== 'string' || reason.trim().length < 5) {
        return { ok: false, error: 'Please briefly explain why a refund is requested.' };
      }
      const resolved = resolveOwnedOrderReference(ctx.customerId, order_reference);
      if (!resolved.ok) return { ok: false, error: resolved.error };

      try {
        const eventKey = ctx.idempotencyKey ? `${ctx.idempotencyKey}:refund_request` : undefined;
        const request = createRefundRequest({
          customerId: ctx.customerId,
          orderId: resolved.order.id,
          reason,
          eventKey,
        });
        let alertStatus: string | undefined;
        if (deliverAlert) {
          const delivery = await deliverAlert({
            customerId: ctx.customerId,
            reason:
              `Refund case ${request.public_ref} for order ${resolved.order.public_ref}. ` +
              `Eligibility: ${request.eligibility}. Reason: ${request.reason}. ` +
              'No refund has been approved or executed.',
            eventKey: `refund_request:${eventKey ?? request.public_ref}`,
          });
          alertStatus = delivery.status;
        }
        return {
          ok: true,
          refund_reference: request.public_ref,
          order_reference: resolved.order.public_ref.toUpperCase(),
          status: request.status,
          eligibility: request.eligibility,
          money_refunded: false,
          ...(alertStatus ? { alert_status: alertStatus } : {}),
          instruction: refundStatusInstruction(request.status),
        };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : 'Could not create the refund request.' };
      }
    },
  };
}

export const requestRefund = createRequestRefundTool();

export const getMyRefundStatus: ToolDef = {
  name: 'get_my_refund_status',
  description: 'Read the real status of this WhatsApp customer\'s refund case. Never reveals another customer\'s case.',
  input_schema: {
    type: 'object',
    properties: {
      refund_reference: { type: 'string', description: 'RFD- public refund reference; optional for latest own case' },
    },
  },
  execute: ({ refund_reference }, ctx) => {
    const normalized = refund_reference ? normalizeRefundReference(refund_reference) : null;
    const request = refund_reference
      ? normalized
        ? db.prepare('select * from refund_requests where public_ref = ? collate nocase and customer_id = ?')
            .get(normalized, ctx.customerId) as RefundRequestRow | undefined
        : undefined
      : db.prepare('select * from refund_requests where customer_id = ? order by id desc limit 1')
          .get(ctx.customerId) as RefundRequestRow | undefined;
    if (!request) return { ok: false, found: false, error: REFUND_ACCESS_DENIED };
    const order = db.prepare('select public_ref from orders where id = ?').get(request.order_id) as { public_ref: string };
    return {
      ok: true,
      found: true,
      refund_reference: request.public_ref,
      order_reference: order.public_ref.toUpperCase(),
      status: request.status,
      money_refunded: false,
      created_at: request.created_at,
      instruction: refundStatusInstruction(request.status),
    };
  },
};

export const pendingRefundRequests: ToolDef = {
  name: 'pending_refund_requests',
  description: 'List refund cases that require Ahmed\'s decision. No case has moved money.',
  input_schema: { type: 'object', properties: {} },
  execute: () => ({
    refund_requests: db.prepare(`
      select rr.public_ref as refund_reference, o.public_ref as order_reference,
             rr.customer_id as customer_record, rr.reason, rr.eligibility, rr.status, rr.created_at
      from refund_requests rr
      join orders o on o.id = rr.order_id
      where rr.status = 'requested'
      order by rr.created_at, rr.id
    `).all(),
  }),
};

export const resolveRefundRequest: ToolDef = {
  name: 'resolve_refund_request',
  description:
    'Approve or reject a refund case after Ahmed reviews it. Approval authorizes later external execution only; ' +
    'this tool never moves money or changes the order/ledger.',
  input_schema: {
    type: 'object',
    properties: {
      refund_reference: { type: 'string' },
      decision: { type: 'string', enum: ['approve', 'reject'] },
    },
    required: ['refund_reference', 'decision'],
  },
  execute: ({ refund_reference, decision }, ctx: ToolContext) => {
    const normalized = normalizeRefundReference(refund_reference);
    if (!normalized) return { ok: false, error: 'refund_reference must be RFD- followed by 20 hexadecimal characters.' };
    if (decision !== 'approve' && decision !== 'reject') {
      return { ok: false, error: 'decision must be approve or reject.' };
    }
    return db.transaction(() => {
      const request = db.prepare('select * from refund_requests where public_ref = ? collate nocase')
        .get(normalized) as RefundRequestRow | undefined;
      if (!request) return { ok: false, error: 'Refund request does not exist.' };
      if (request.status !== 'requested') {
        return {
          ok: true,
          refund_reference: request.public_ref,
          status: request.status,
          already_resolved: true,
          money_refunded: false,
        };
      }
      const status: RefundStatus = decision === 'approve' ? 'approved_pending_execution' : 'rejected';
      db.prepare(`
        update refund_requests
        set status = ?, resolved_by_customer_id = ?, resolved_at = datetime('now')
        where id = ? and status = 'requested'
      `).run(status, ctx.customerId, request.id);
      return {
        ok: true,
        refund_reference: request.public_ref,
        status,
        money_refunded: false,
        order_status_changed: false,
        ledger_changed: false,
        instruction: status === 'approved_pending_execution'
          ? 'Approval is recorded, but money has not been refunded. Execute through the authorized payment process.'
          : 'The request was rejected; no money or order state changed.',
      };
    }).immediate();
  },
};

const REFUND_COMPLETION_CLAIM =
  /\brefund\b.{0,40}\b(?:processed|completed|sent|issued|transferred|credited|done|ho\s*gaya|kar\s*diya)\b/i;

export function checkRefundCompletionClaim(body: string): { ok: true } | { ok: false; error: string } {
  if (
    body === REFUND_REQUEST_PENDING_MESSAGE ||
    body === REFUND_APPROVED_PENDING_EXECUTION_MESSAGE ||
    body === REFUND_REJECTED_MESSAGE
  ) {
    return { ok: true };
  }
  if (!REFUND_COMPLETION_CLAIM.test(body)) return { ok: true };
  return {
    ok: false,
    error:
      'Do not claim a refund was processed, sent, or completed. This system can only record a request ' +
      'or owner approval pending external execution.',
  };
}
