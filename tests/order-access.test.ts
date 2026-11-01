import assert from 'node:assert/strict';
import { test } from 'node:test';
import { db } from '../src/db';
import { ORDER_ACCESS_DENIED, getMyOrderStatus, getOrderPublicReference, resolveOwnedOrderReference } from '../src/order-access';
import { createClaimPaymentTool } from '../src/payments';
import { updateOrderStatus } from '../src/tools';

function createCustomer(label: string): number {
  return Number(
    db.prepare('insert into customers (phone) values (?)').run(`${label}-${Date.now()}-${Math.random()}`).lastInsertRowid,
  );
}

function createOrder(customerId: number, status = 'placed'): { id: number; reference: string } {
  const id = Number(
    db.prepare(`
      insert into orders (customer_id, items_json, total_minor, status)
      values (?, '[]', 250000, ?)
    `).run(customerId, status).lastInsertRowid,
  );
  return { id, reference: getOrderPublicReference(id) };
}

test('every order receives a high-entropy public reference unrelated to its internal id', () => {
  db.exec('begin');
  try {
    const customerId = createCustomer('public-ref');
    const first = createOrder(customerId);
    const second = createOrder(customerId);
    assert.match(first.reference, /^ORD-[0-9A-F]{20}$/);
    assert.match(second.reference, /^ORD-[0-9A-F]{20}$/);
    assert.notEqual(first.reference, second.reference);
    assert.notEqual(first.reference, `ORD-${first.id.toString(16).toUpperCase().padStart(20, '0')}`);
  } finally {
    db.exec('rollback');
  }
});

test('order status is bound to the current WhatsApp customer and returns no PII or internal id', () => {
  db.exec('begin');
  try {
    const ownerId = createCustomer('order-owner');
    const attackerId = createCustomer('order-attacker');
    const order = createOrder(ownerId, 'confirmed');

    const own = getMyOrderStatus.execute(
      { order_reference: order.reference.toLowerCase() },
      { customerId: ownerId },
    ) as Record<string, unknown>;
    assert.equal(own.ok, true);
    assert.equal(own.order_reference, order.reference);
    assert.equal(own.status, 'confirmed');
    assert.equal(own.total, 2500);
    assert.equal(typeof own.placed_at, 'string');
    for (const privateField of ['id', 'order_id', 'customer_id', 'phone', 'contact_phone', 'delivery_address']) {
      assert.equal(Object.hasOwn(own, privateField), false);
    }

    const crossNumber = getMyOrderStatus.execute(
      { order_reference: order.reference },
      { customerId: attackerId },
    );
    const nonexistent = getMyOrderStatus.execute(
      { order_reference: 'ORD-FFFFFFFFFFFFFFFFFFFF' },
      { customerId: attackerId },
    );
    assert.deepEqual(crossNumber, { ok: false, found: false, error: ORDER_ACCESS_DENIED });
    assert.deepEqual(nonexistent, crossNumber);

    const latestOwn = getMyOrderStatus.execute({}, { customerId: ownerId }) as { order_reference: string };
    assert.equal(latestOwn.order_reference, order.reference);
    assert.equal(
      (getMyOrderStatus.execute({}, { customerId: attackerId }) as { error: string }).error,
      ORDER_ACCESS_DENIED,
    );
  } finally {
    db.exec('rollback');
  }
});

test('customer mutations and payment claims accept only an owned public reference', async () => {
  db.exec('begin');
  try {
    const ownerId = createCustomer('mutation-owner');
    const attackerId = createCustomer('mutation-attacker');
    const order = createOrder(ownerId);

    const wrongCancellation = updateOrderStatus.execute(
      { order_reference: order.reference, status: 'cancelled' },
      { customerId: attackerId },
    );
    assert.deepEqual(wrongCancellation, { ok: false, error: ORDER_ACCESS_DENIED });

    const claimTool = createClaimPaymentTool();
    const internalIdClaim = await claimTool.execute(
      { amount: 2500, order_id: order.id },
      { customerId: ownerId, idempotencyKey: 'internal-id-payment-claim' },
    ) as { ok: boolean; error?: string };
    assert.equal(internalIdClaim.ok, false);
    assert.match(internalIdClaim.error ?? '', /public order_reference/i);
    const wrongClaim = await claimTool.execute(
      { amount: 2500, order_reference: order.reference },
      { customerId: attackerId, idempotencyKey: 'cross-number-payment-claim' },
    );
    assert.deepEqual(wrongClaim, { ok: false, error: ORDER_ACCESS_DENIED });
    assert.equal(
      (db.prepare('select count(*) n from payment_claims where customer_id = ?').get(attackerId) as { n: number }).n,
      0,
    );

    const ownCancellation = updateOrderStatus.execute(
      { order_reference: order.reference, status: 'cancelled' },
      { customerId: ownerId },
    );
    assert.deepEqual(ownCancellation, {
      ok: true,
      order_reference: order.reference,
      from: 'placed',
      to: 'cancelled',
    });
  } finally {
    db.exec('rollback');
  }
});

test('repeated failed guesses are rate-limited per WhatsApp customer', () => {
  db.exec('begin');
  try {
    const customerId = createCustomer('lookup-limit');
    for (let i = 0; i < 10; i++) {
      const suffix = i.toString(16).toUpperCase().padStart(20, '0');
      assert.deepEqual(resolveOwnedOrderReference(customerId, `ORD-${suffix}`), {
        ok: false,
        error: ORDER_ACCESS_DENIED,
      });
    }
    const limited = resolveOwnedOrderReference(customerId, 'ORD-AAAAAAAAAAAAAAAAAAAA');
    assert.equal(limited.ok, false);
    if (limited.ok) return;
    assert.equal(limited.rateLimited, true);
    assert.match(limited.error, /wait 15 minutes/i);
  } finally {
    db.exec('rollback');
  }
});
