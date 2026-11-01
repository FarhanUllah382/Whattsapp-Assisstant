import assert from 'node:assert/strict';
import { test } from 'node:test';

import { db } from '../src/db';
import { getOrderPublicReference } from '../src/order-access';
import {
  checkRefundCompletionClaim,
  createRefundRequest,
  createRequestRefundTool,
  getMyRefundStatus,
  pendingRefundRequests,
  REFUND_ACCESS_DENIED,
  resolveRefundRequest,
} from '../src/refunds';
import { baseTools, ownerTools } from '../src/tools';

function customer(label: string): number {
  return Number(
    db.prepare('insert into customers (phone) values (?)').run(`${label}-${Date.now()}-${Math.random()}`).lastInsertRowid,
  );
}

function order(customerId: number, status: string): { id: number; reference: string } {
  const id = Number(
    db.prepare(`
      insert into orders (customer_id, items_json, total_minor, status)
      values (?, '[]', 80000, ?)
    `).run(customerId, status).lastInsertRowid,
  );
  return { id, reference: getOrderPublicReference(id) };
}

function deliveredEvent(orderId: number, customerId: number, createdAt: string): void {
  db.prepare(`
    insert into order_status_events
      (order_id, from_status, to_status, actor_type, actor_customer_id, source, evidence, created_at)
    values (?, 'shipped', 'delivered', 'system', ?, 'refund_test', 'Delivery verified for refund test.', ?)
  `).run(orderId, customerId, createdAt);
}

test('eligible delivered order creates a high-entropy refund case without moving money or order state', () => {
  db.exec('begin');
  try {
    const customerId = customer('refund-eligible');
    const originalOrder = order(customerId, 'delivered');
    deliveredEvent(originalOrder.id, customerId, '2026-10-01 12:00:00');
    const ledgerBefore = (db.prepare('select count(*) n from ledger').get() as { n: number }).n;

    const request = createRefundRequest({
      customerId,
      orderId: originalOrder.id,
      reason: 'Item arrived damaged. Contact: 03001234567',
      eventKey: 'refund-eligible-event',
      now: new Date('2026-10-03T12:00:00Z'),
    });
    assert.match(request.public_ref, /^RFD-[0-9A-F]{20}$/);
    assert.equal(request.status, 'requested');
    assert.equal(request.eligibility, 'eligible');
    assert.equal(request.reason.includes('03001234567'), false);
    assert.equal((db.prepare('select status from orders where id = ?').get(originalOrder.id) as { status: string }).status, 'delivered');
    assert.equal((db.prepare('select count(*) n from ledger').get() as { n: number }).n, ledgerBefore);

    const retry = createRefundRequest({
      customerId,
      orderId: originalOrder.id,
      reason: 'Different retry text',
      eventKey: 'refund-eligible-event',
      now: new Date('2026-10-03T12:00:00Z'),
    });
    assert.equal(retry.id, request.id);
    assert.equal((db.prepare('select count(*) n from refund_requests where order_id = ?').get(originalOrder.id) as { n: number }).n, 1);

    const anotherOrder = order(customerId, 'delivered');
    assert.throws(() => createRefundRequest({
      customerId,
      orderId: anotherOrder.id,
      reason: 'Must not reuse an event across orders',
      eventKey: 'refund-eligible-event',
    }), /event conflicts/i);
  } finally {
    db.exec('rollback');
  }
});

test('eligibility rejects undelivered and expired orders but flags legacy delivery for manual review', () => {
  db.exec('begin');
  try {
    const customerId = customer('refund-eligibility');
    const undelivered = order(customerId, 'confirmed');
    assert.throws(() => createRefundRequest({
      customerId,
      orderId: undelivered.id,
      reason: 'I want a refund please',
      now: new Date('2026-10-03T12:00:00Z'),
    }), /available after delivery/i);

    const expired = order(customerId, 'delivered');
    deliveredEvent(expired.id, customerId, '2026-09-20 12:00:00');
    assert.throws(() => createRefundRequest({
      customerId,
      orderId: expired.id,
      reason: 'The item was damaged',
      now: new Date('2026-10-03T12:00:00Z'),
    }), /7-day return window has passed/i);

    const legacy = order(customerId, 'delivered');
    const request = createRefundRequest({
      customerId,
      orderId: legacy.id,
      reason: 'Needs manual review',
      now: new Date('2026-10-03T12:00:00Z'),
    });
    assert.equal(request.eligibility, 'manual_review');
    assert.equal(request.status, 'requested');
  } finally {
    db.exec('rollback');
  }
});

test('customer refund creation is bound to the current WhatsApp identity and exposes no internal ids', async () => {
  db.exec('begin');
  try {
    const ownerId = customer('refund-owner');
    const attackerId = customer('refund-attacker');
    const delivered = order(ownerId, 'delivered');
    deliveredEvent(delivered.id, ownerId, new Date().toISOString().slice(0, 19).replace('T', ' '));
    const tool = createRequestRefundTool();

    assert.throws(() => createRefundRequest({
      customerId: attackerId,
      orderId: delivered.id,
      reason: 'Trying the lower-level function directly',
    }), /No matching delivered order is available/i);

    const denied = await tool.execute(
      { order_reference: delivered.reference, reason: 'Trying another customer order' },
      { customerId: attackerId, idempotencyKey: 'cross-refund' },
    );
    assert.deepEqual(denied, {
      ok: false,
      error: 'No matching order is available for this WhatsApp account and reference.',
    });

    const created = await tool.execute(
      { order_reference: delivered.reference, reason: 'The delivered item is damaged' },
      { customerId: ownerId, idempotencyKey: 'own-refund' },
    ) as Record<string, unknown>;
    assert.equal(created.ok, true);
    assert.match(String(created.refund_reference), /^RFD-[0-9A-F]{20}$/);
    assert.equal(created.money_refunded, false);
    assert.equal(Object.hasOwn(created, 'id'), false);
    assert.equal(Object.hasOwn(created, 'order_id'), false);
    assert.equal(Object.hasOwn(created, 'customer_id'), false);
  } finally {
    db.exec('rollback');
  }
});

test('refund status is sender-bound and foreign/nonexistent references are indistinguishable', () => {
  db.exec('begin');
  try {
    const customerId = customer('refund-status-owner');
    const attackerId = customer('refund-status-attacker');
    const delivered = order(customerId, 'delivered');
    const request = createRefundRequest({ customerId, orderId: delivered.id, reason: 'Manual legacy review' });

    const own = getMyRefundStatus.execute(
      { refund_reference: request.public_ref.toLowerCase() },
      { customerId },
    ) as Record<string, unknown>;
    assert.equal(own.ok, true);
    assert.equal(own.refund_reference, request.public_ref);
    assert.equal(own.money_refunded, false);
    assert.equal(Object.hasOwn(own, 'reason'), false);
    assert.equal(Object.hasOwn(own, 'customer_id'), false);

    const foreign = getMyRefundStatus.execute({ refund_reference: request.public_ref }, { customerId: attackerId });
    const missing = getMyRefundStatus.execute(
      { refund_reference: 'RFD-FFFFFFFFFFFFFFFFFFFF' },
      { customerId: attackerId },
    );
    assert.deepEqual(foreign, { ok: false, found: false, error: REFUND_ACCESS_DENIED });
    assert.deepEqual(missing, foreign);
  } finally {
    db.exec('rollback');
  }
});

test('only owner toolset can resolve a case and approval never moves money or order state', () => {
  db.exec('begin');
  try {
    assert.equal(baseTools.some((tool) => tool.name === 'resolve_refund_request'), false);
    assert.equal(ownerTools.some((tool) => tool.name === 'resolve_refund_request'), true);
    assert.equal(ownerTools.some((tool) => tool.name === 'pending_refund_requests'), true);
    const customerId = customer('refund-resolution');
    const ownerId = customer('refund-resolution-owner');
    const delivered = order(customerId, 'delivered');
    const request = createRefundRequest({ customerId, orderId: delivered.id, reason: 'Manual legacy review' });
    const ledgerBefore = (db.prepare('select count(*) n from ledger').get() as { n: number }).n;

    const pending = pendingRefundRequests.execute({}, { customerId: ownerId }) as { refund_requests: any[] };
    assert.equal(pending.refund_requests.some((row) => row.refund_reference === request.public_ref), true);
    const approved = resolveRefundRequest.execute(
      { refund_reference: request.public_ref, decision: 'approve' },
      { customerId: ownerId },
    ) as Record<string, unknown>;
    assert.equal(approved.status, 'approved_pending_execution');
    assert.equal(approved.money_refunded, false);
    assert.equal(approved.ledger_changed, false);
    assert.equal(approved.order_status_changed, false);
    assert.equal((db.prepare('select count(*) n from ledger').get() as { n: number }).n, ledgerBefore);
    assert.equal((db.prepare('select status from orders where id = ?').get(delivered.id) as { status: string }).status, 'delivered');

    const retry = resolveRefundRequest.execute(
      { refund_reference: request.public_ref, decision: 'approve' },
      { customerId: ownerId },
    ) as Record<string, unknown>;
    assert.equal(retry.already_resolved, true);
    assert.equal(retry.money_refunded, false);
  } finally {
    db.exec('rollback');
  }
});

test('outbound refund guard blocks false completion claims but permits truthful case states', () => {
  for (const body of [
    'Your refund has been processed.',
    'Refund completed successfully.',
    'Aap ka refund ho gaya.',
    'Refund transfer kar diya.',
  ]) {
    assert.equal(checkRefundCompletionClaim(body).ok, false, body);
  }
  for (const body of [
    'Your refund request was recorded for review.',
    'Your refund request is pending.',
    'Ahmed approved the request, but no money has been refunded yet.',
    'The refund request was rejected.',
  ]) {
    assert.deepEqual(checkRefundCompletionClaim(body), { ok: true });
  }
});
