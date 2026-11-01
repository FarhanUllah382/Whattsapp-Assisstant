import assert from 'node:assert/strict';
import { Writable } from 'node:stream';
import { test } from 'node:test';

import { deliverOwnerAlert } from '../src/alerts';
import { db } from '../src/db';
import { createLogger } from '../src/obs/logger';
import { ORDER_ACCESS_DENIED, getMyOrderStatus, getOrderPublicReference } from '../src/order-access';
import { claimPayment } from '../src/payments';
import { sanitizeMemoryText } from '../src/privacy';
import { REFUND_ACCESS_DENIED, getMyRefundStatus, requestRefund } from '../src/refunds';
import { getCustomerNote, prepareOrder } from '../src/tools';

const PRIVATE = {
  phone: '+923001234567',
  phoneDigits: '923001234567',
  name: 'Ayesha Privacy Test',
  address: 'House 91, Street 7, F-10 Islamabad',
  email: 'ayesha.privacy@example.com',
  iban: 'PK36SCBL0000001123456702',
  paymentReference: 'PRIVATE-TXN-889912',
} as const;

const PRIVATE_VALUES = Object.values(PRIVATE);

function assertNoPrivateValues(value: unknown, label: string): void {
  const serialized = JSON.stringify(value);
  for (const secret of PRIVATE_VALUES) {
    assert.equal(serialized.includes(secret), false, `${label} exposed ${secret}`);
  }
}

function customer(label: string, name?: string): number {
  return Number(
    db.prepare('insert into customers (phone, name) values (?, ?)')
      .run(`pii-${label}-${Date.now()}-${Math.random()}`, name ?? null).lastInsertRowid,
  );
}

function order(
  customerId: number,
  status: 'confirmed' | 'delivered',
): { id: number; reference: string } {
  const id = Number(
    db.prepare(`
      insert into orders
        (customer_id, items_json, total_minor, recipient_name, contact_phone,
         delivery_address, city, postal_code, delivery_instructions, payment_method, status)
      values (?, '[]', 440000, ?, ?, ?, 'Islamabad', '44000', ?, 'cod', ?)
    `).run(
      customerId,
      PRIVATE.name,
      PRIVATE.phone,
      PRIVATE.address,
      `Email ${PRIVATE.email}`,
      status,
    ).lastInsertRowid,
  );
  return { id, reference: getOrderPublicReference(id) };
}

test('customer order-status output uses a strict public allowlist and foreign/missing orders are indistinguishable', async () => {
  db.exec('begin');
  try {
    const ownerId = customer('order-owner', PRIVATE.name);
    const attackerId = customer('order-attacker');
    const stored = order(ownerId, 'confirmed');

    const own = await getMyOrderStatus.execute(
      { order_reference: stored.reference },
      { customerId: ownerId },
    ) as Record<string, unknown>;
    assert.deepEqual(Object.keys(own).sort(), [
      'found',
      'ok',
      'order_reference',
      'placed_at',
      'status',
      'total',
    ]);
    assertNoPrivateValues(own, 'own order status');

    const foreign = await getMyOrderStatus.execute(
      { order_reference: stored.reference },
      { customerId: attackerId },
    );
    const missing = await getMyOrderStatus.execute(
      { order_reference: 'ORD-FFFFFFFFFFFFFFFFFFFF' },
      { customerId: attackerId },
    );
    assert.deepEqual(foreign, { ok: false, found: false, error: ORDER_ACCESS_DENIED });
    assert.deepEqual(missing, foreign);
    assertNoPrivateValues(foreign, 'foreign order status');
  } finally {
    db.exec('rollback');
  }
});

test('payment and refund customer outputs never echo supplied evidence or fulfilment PII', async () => {
  db.exec('begin');
  try {
    const customerId = customer('financial-owner', PRIVATE.name);
    const attackerId = customer('financial-attacker');
    const delivered = order(customerId, 'delivered');
    db.prepare(`
      insert into order_status_events
        (order_id, from_status, to_status, actor_type, actor_customer_id, source, evidence)
      values (?, 'shipped', 'delivered', 'courier', ?, 'pii_test', 'Verified test delivery.')
    `).run(delivered.id, customerId);

    const payment = await claimPayment.execute(
      {
        amount: 4400,
        order_reference: delivered.reference,
        method: `bank transfer ${PRIVATE.iban}`,
        reference: PRIVATE.paymentReference,
      },
      { customerId, idempotencyKey: 'pii-payment-claim' },
    ) as Record<string, unknown>;
    assert.equal(payment.ok, true);
    assertNoPrivateValues(payment, 'payment claim output');
    for (const field of ['method', 'reference', 'customer_id', 'order_id']) {
      assert.equal(Object.hasOwn(payment, field), false, field);
    }

    const refund = await requestRefund.execute(
      {
        order_reference: delivered.reference,
        reason: `Damaged item. Contact ${PRIVATE.phone}; email ${PRIVATE.email}`,
      },
      { customerId, idempotencyKey: 'pii-refund-request' },
    ) as Record<string, unknown>;
    assert.equal(refund.ok, true);
    assertNoPrivateValues(refund, 'refund request output');
    assert.equal(Object.hasOwn(refund, 'reason'), false);

    const refundStatus = await getMyRefundStatus.execute(
      { refund_reference: refund.refund_reference },
      { customerId },
    );
    assertNoPrivateValues(refundStatus, 'refund status output');

    const foreign = await getMyRefundStatus.execute(
      { refund_reference: refund.refund_reference },
      { customerId: attackerId },
    );
    const missing = await getMyRefundStatus.execute(
      { refund_reference: 'RFD-FFFFFFFFFFFFFFFFFFFF' },
      { customerId: attackerId },
    );
    assert.deepEqual(foreign, { ok: false, found: false, error: REFUND_ACCESS_DENIED });
    assert.deepEqual(missing, foreign);
    assertNoPrivateValues(foreign, 'foreign refund status');
  } finally {
    db.exec('rollback');
  }
});

test('derived model memory keeps business meaning while removing reusable PII and remains customer-bound', async () => {
  db.exec('begin');
  try {
    const ownerId = customer('memory-owner');
    const attackerId = customer('memory-attacker');
    const raw =
      `Prefers navy kurtas. Name: ${PRIVATE.name}. Contact: ${PRIVATE.phone}. ` +
      `Address: ${PRIVATE.address}. Email: ${PRIVATE.email}. IBAN: ${PRIVATE.iban}. ` +
      `Payment reference: ${PRIVATE.paymentReference}. Usually orders two items.`;
    const safe = sanitizeMemoryText(raw);
    const noteId = Number(
      db.prepare('insert into customer_notes (customer_id, headline, body) values (?, ?, ?)')
        .run(ownerId, 'Shopping preference', safe).lastInsertRowid,
    );
    db.prepare('insert into checkpoints (customer_id, summary) values (?, ?)').run(ownerId, safe);

    assert.match(safe, /prefers navy kurtas/i);
    assert.match(safe, /usually orders two items/i);
    assertNoPrivateValues(safe, 'sanitized memory');

    const own = await getCustomerNote.execute({ note_id: noteId }, { customerId: ownerId });
    assertNoPrivateValues(own, 'own model-facing note');
    const foreign = await getCustomerNote.execute({ note_id: noteId }, { customerId: attackerId });
    assert.deepEqual(foreign, { ok: false, error: 'No note found with that id for this customer.' });
    assertNoPrivateValues(foreign, 'foreign note response');
  } finally {
    db.exec('rollback');
  }
});

test('fulfilment keeps necessary authoritative details but masks contact and never books before confirmation', () => {
  db.exec('begin');
  try {
    const customerId = customer('fulfillment-owner');
    const productId = Number(
      db.prepare(`
        insert into products (name, category, size, color, price_minor, stock)
        values ('Privacy Test Kurta', 'kurta', 'medium', 'navy', 440000, 3)
      `).run().lastInsertRowid,
    );
    const result = prepareOrder.execute(
      {
        items: [{ product_id: productId, qty: 1 }],
        recipient_name: PRIVATE.name,
        contact_phone: PRIVATE.phone,
        delivery_address: PRIVATE.address,
        city: 'Islamabad',
        postal_code: '44000',
        delivery_instructions: 'Call on arrival',
        payment_method: 'cod',
      },
      { customerId, idempotencyKey: 'pii-fulfilment-draft' },
    ) as Record<string, unknown>;

    assert.equal(result.ok, true);
    assert.equal(Object.hasOwn(result, 'contact_phone'), false);
    assert.equal(String(result.contact_phone_masked).endsWith('4567'), true);
    assert.equal(JSON.stringify(result).includes(PRIVATE.phoneDigits), false);
    assert.equal((db.prepare('select count(*) as count from orders').get() as { count: number }).count, 0);
    assert.equal((db.prepare('select count(*) as count from ledger').get() as { count: number }).count, 0);

    const stored = db.prepare(`
      select recipient_name, contact_phone, delivery_address
      from order_drafts where customer_id = ?
    `).get(customerId) as {
      recipient_name: string;
      contact_phone: string;
      delivery_address: string;
    };
    assert.equal(stored.recipient_name, PRIVATE.name);
    assert.equal(stored.contact_phone, PRIVATE.phone);
    assert.equal(stored.delivery_address, PRIVATE.address);
  } finally {
    db.exec('rollback');
  }
});

test('owner alerts and nested structured logs redact customer PII at their final output boundaries', async () => {
  db.exec('begin');
  try {
    const customerId = customer('alert-owner');
    let alertBody = '';
    const alert = await deliverOwnerAlert({
      kind: 'customer_handoff',
      eventKey: 'pii-owner-alert',
      customerId,
      reason:
        `Customer name: ${PRIVATE.name}. Contact: ${PRIVATE.phone}. Address: ${PRIVATE.address}. ` +
        `Email: ${PRIVATE.email}. Payment reference: ${PRIVATE.paymentReference}. Needs size confirmation.`,
      send: async (body) => {
        alertBody = body;
      },
    });
    assert.equal(alert.ok, true);
    assert.match(alertBody, /needs size confirmation/i);
    assertNoPrivateValues(alertBody, 'owner alert');

    let logged = '';
    const stream = new Writable({
      write(chunk, _encoding, callback) {
        logged += chunk.toString();
        callback();
      },
    });
    createLogger(stream).error(`Failure for ${PRIVATE.phone}`, {
      customer_name: PRIVATE.name,
      contact_phone: PRIVATE.phone,
      delivery_address: PRIVATE.address,
      payment_reference: PRIVATE.paymentReference,
      nested: [{ email: PRIVATE.email }, new Error(`IBAN: ${PRIVATE.iban}`)],
    });
    assertNoPrivateValues(logged, 'structured log');
    assert.doesNotThrow(() => JSON.parse(logged));
  } finally {
    db.exec('rollback');
  }
});

test('validation and ownership errors never echo hostile PII-bearing inputs', async () => {
  db.exec('begin');
  try {
    const customerId = customer('error-path');
    const productId = Number(
      db.prepare(`
        insert into products (name, category, size, color, price_minor, stock)
        values ('Error Test Kurta', 'kurta', 'medium', 'navy', 440000, 2)
      `).run().lastInsertRowid,
    );
    const malformed = `${PRIVATE.paymentReference}-${PRIVATE.phone}`;

    const orderError = await getMyOrderStatus.execute(
      { order_reference: malformed },
      { customerId },
    );
    const refundError = await getMyRefundStatus.execute(
      { refund_reference: malformed },
      { customerId },
    );
    const noteError = await getCustomerNote.execute({ note_id: malformed }, { customerId });
    const fulfilmentError = await prepareOrder.execute(
      {
        items: [{ product_id: productId, qty: 1 }],
        recipient_name: PRIVATE.name,
        contact_phone: `${PRIVATE.phone}99999`,
        delivery_address: PRIVATE.address,
        city: 'Islamabad',
        payment_method: 'cod',
      },
      { customerId, idempotencyKey: 'pii-invalid-fulfilment' },
    );

    for (const [label, output] of [
      ['order error', orderError],
      ['refund error', refundError],
      ['note error', noteError],
      ['fulfilment error', fulfilmentError],
    ] as const) {
      assertNoPrivateValues(output, label);
    }
    assert.equal((db.prepare('select count(*) as count from order_drafts').get() as { count: number }).count, 0);
  } finally {
    db.exec('rollback');
  }
});
