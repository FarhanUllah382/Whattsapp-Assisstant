import assert from 'node:assert/strict';
import { test } from 'node:test';

import { db } from '../src/db';
import {
  checkInventoryDisclosureReply,
  publicInventoryFields,
  publicStockStatus,
} from '../src/inventory-visibility';
import { checkStock, prepareOrder } from '../src/tools';

test('public stock policy maps exact counts to deliberate availability states', () => {
  assert.equal(publicStockStatus(0), 'out_of_stock');
  assert.equal(publicStockStatus(1), 'low_stock');
  assert.equal(publicStockStatus(5), 'low_stock');
  assert.equal(publicStockStatus(6), 'in_stock');
  assert.throws(() => publicStockStatus(-1), /non-negative whole number/i);
  assert.throws(() => publicStockStatus(1.5), /non-negative whole number/i);
});

test('requested quantity produces only a yes/no fulfillment decision', () => {
  assert.deepEqual(publicInventoryFields(3, 2), {
    availability: 'low_stock',
    can_fulfill_requested_qty: true,
  });
  assert.deepEqual(publicInventoryFields(3, 4), {
    availability: 'low_stock',
    can_fulfill_requested_qty: false,
  });
  assert.deepEqual(publicInventoryFields(3), { availability: 'low_stock' });
});

test('customer stock tool exposes an allowlisted public schema without exact quantity', () => {
  db.exec('begin');
  try {
    const marker = `visibility-${Date.now()}`;
    db.prepare(`
      insert into products
        (sku, name, category, size, color, price_minor, stock, active, aliases_json)
      values (?, ?, 'hoodie', 'medium', 'black', 80000, 4, 1, '[]')
    `).run(`VIS-${Date.now()}`, marker);

    const result = checkStock.execute(
      { name: marker, size: 'medium', color: 'black', requested_qty: 5 },
      { customerId: 1 },
    ) as { ok: boolean; found: boolean; scope: string; products: Array<Record<string, unknown>> };
    assert.equal(result.ok, true);
    assert.equal(result.found, true);
    assert.equal(result.scope, 'current_active_catalog');
    assert.equal(result.products.length, 1);
    assert.deepEqual(Object.keys(result.products[0]).sort(), [
      'availability',
      'can_fulfill_requested_qty',
      'category',
      'color',
      'name',
      'price',
      'product_id',
      'size',
    ]);
    assert.equal(result.products[0].availability, 'low_stock');
    assert.equal(result.products[0].can_fulfill_requested_qty, false);
    assert.equal(Object.hasOwn(result.products[0], 'stock'), false);
    assert.equal(JSON.stringify(result).includes('"stock"'), false);
  } finally {
    db.exec('rollback');
  }
});

test('customer stock tool validates requested quantity and fails closed', () => {
  for (const requested_qty of [0, -1, 1.5, '2', Number.NaN]) {
    assert.deepEqual(checkStock.execute(
      { name: 'hoodie', requested_qty },
      { customerId: 1 },
    ), { ok: false, error: 'requested_qty must be a positive whole number.' });
  }
});

test('order stock failures do not reveal the remaining internal count', () => {
  db.exec('begin');
  try {
    const customerId = Number(
      db.prepare('insert into customers (phone) values (?)').run(`visibility-customer-${Date.now()}`).lastInsertRowid,
    );
    const productId = Number(
      db.prepare(`
        insert into products (sku, name, category, size, color, price_minor, stock, active, aliases_json)
        values (?, 'Privacy Hoodie', 'hoodie', 'medium', 'black', 80000, 4, 1, '[]')
      `).run(`VIS-ORDER-${Date.now()}`).lastInsertRowid,
    );
    const result = prepareOrder.execute(
      {
        items: [{ product_id: productId, qty: 5 }],
        recipient_name: 'Test Customer',
        contact_phone: '03001234567',
        delivery_address: 'House 1, Test Street, Islamabad',
        city: 'Islamabad',
        payment_method: 'cod',
      },
      { customerId, idempotencyKey: `visibility-order-${Date.now()}` },
    ) as { ok: boolean; error?: string };
    assert.equal(result.ok, false);
    assert.match(result.error ?? '', /requested quantity/i);
    assert.doesNotMatch(result.error ?? '', /available\s+4|stock\s*(?:is|:)?\s*4/i);
  } finally {
    db.exec('rollback');
  }
});

test('outbound guard blocks exact inventory claims in English and Roman Urdu', () => {
  for (const body of [
    'We have 17 pieces available.',
    'We have 17 medium black hoodies available hain.',
    'There are 17 medium black hoodies.',
    '17 medium black hoodies hain.',
    'Stock: 17',
    'Only 4 units left.',
    '4 pieces stock mein hain.',
  ]) {
    const result = checkInventoryDisclosureReply(body);
    assert.equal(result.ok, false, body);
  }
  for (const body of [
    'This hoodie is in stock.',
    'Stock is low.',
    'Your requested quantity can be fulfilled.',
    'Your requested quantity is not currently available.',
  ]) {
    assert.deepEqual(checkInventoryDisclosureReply(body), { ok: true });
  }
});
