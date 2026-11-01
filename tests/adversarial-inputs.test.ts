import assert from 'node:assert/strict';
import { test } from 'node:test';

import { db } from '../src/db';
import { ORDER_ACCESS_DENIED, getMyOrderStatus, getOrderPublicReference } from '../src/order-access';
import { checkStock, getCustomerNote, prepareOrder } from '../src/tools';

const SQL_LIKE_PAYLOADS = [
  `' OR 1=1 --`,
  `"; DROP TABLE orders; --`,
  `%_UNION_SELECT_customer_id_FROM_orders`,
  `x'); UPDATE products SET price_minor = 1; --`,
  `Robert'); DROP TABLE customers;--`,
  `admin'/**/OR/**/'1'='1`,
] as const;

const BUSINESS_TABLES = [
  'customers',
  'products',
  'orders',
  'order_drafts',
  'ledger',
  'payment_claims',
  'refund_requests',
  'handoff_ledger',
  'customer_notes',
] as const;

function count(table: typeof BUSINESS_TABLES[number]): number {
  return (db.prepare(`select count(*) as count from ${table}`).get() as { count: number }).count;
}

function snapshot(): Record<string, number> {
  return Object.fromEntries(BUSINESS_TABLES.map((table) => [table, count(table)]));
}

function customer(label: string): number {
  return Number(
    db.prepare('insert into customers (phone) values (?)')
      .run(`adversarial-input-${label}-${Date.now()}-${Math.random()}`).lastInsertRowid,
  );
}

function product(): number {
  return Number(
    db.prepare(`
      insert into products (sku, name, category, size, color, price_minor, stock)
      values (?, 'Adversarial Safety Kurta', 'kurta', 'medium', 'navy', 375000, 20)
    `).run(`ADV-${Date.now()}-${Math.random()}`).lastInsertRowid,
  );
}

test('SQL-like product queries remain literal data and cannot turn wildcards into catalog access', () => {
  db.exec('begin');
  try {
    const productId = product();
    const before = snapshot();

    for (const payload of SQL_LIKE_PAYLOADS) {
      const result = checkStock.execute({ name: payload }, { customerId: 1 }) as Record<string, unknown>;
      assert.equal(result.ok, true, payload);
      assert.equal(result.found, false, payload);
      assert.equal(JSON.stringify(result).includes('Adversarial Safety Kurta'), false, payload);
    }

    assert.equal(
      (db.prepare('select price_minor from products where id = ?').get(productId) as { price_minor: number }).price_minor,
      375_000,
    );
    assert.deepEqual(snapshot(), before);
  } finally {
    db.exec('rollback');
  }
});

test('SQL-like order references never bypass sender ownership or reveal whether an order exists', async () => {
  db.exec('begin');
  try {
    const victimId = customer('victim');
    const orderId = Number(
      db.prepare(`
        insert into orders (customer_id, items_json, total_minor, status)
        values (?, '[]', 440000, 'confirmed')
      `).run(victimId).lastInsertRowid,
    );
    const victimReference = getOrderPublicReference(orderId);

    for (const [index, payload] of SQL_LIKE_PAYLOADS.entries()) {
      const attackerId = customer(`attacker-${index}`);
      const injected = await getMyOrderStatus.execute({ order_reference: payload }, { customerId: attackerId });
      const missing = await getMyOrderStatus.execute(
        { order_reference: 'ORD-FFFFFFFFFFFFFFFFFFFF' },
        { customerId: attackerId },
      );
      const foreign = await getMyOrderStatus.execute(
        { order_reference: victimReference },
        { customerId: attackerId },
      );
      assert.deepEqual(injected, { ok: false, found: false, error: ORDER_ACCESS_DENIED });
      assert.deepEqual(missing, injected);
      assert.deepEqual(foreign, injected);
    }

    assert.equal(
      (db.prepare('select status from orders where id = ?').get(orderId) as { status: string }).status,
      'confirmed',
    );
  } finally {
    db.exec('rollback');
  }
});

test('SQL-like names and addresses are stored only as draft data and create no order or ledger effect', () => {
  db.exec('begin');
  try {
    const customerId = customer('fulfillment');
    const productId = product();
    const ordersBefore = count('orders');
    const ledgerBefore = count('ledger');

    for (const [index, payload] of SQL_LIKE_PAYLOADS.entries()) {
      const recipient = `Customer ${index} ${payload}`;
      const address = `House ${index + 1}, Safety Street, ${payload}`;
      const result = prepareOrder.execute(
        {
          items: [{ product_id: productId, qty: 1 }],
          recipient_name: recipient,
          contact_phone: '03001234567',
          delivery_address: address,
          city: `City ${index} ${payload}`,
          delivery_instructions: `Leave safely; ${payload}`,
          payment_method: 'cod',
        },
        { customerId, idempotencyKey: `adversarial-draft-${index}` },
      ) as Record<string, unknown>;
      assert.equal(result.ok, true, payload);

      const stored = db.prepare(`
        select recipient_name, delivery_address, delivery_instructions
        from order_drafts where prepared_event_key = ?
      `).get(`adversarial-draft-${index}:prepare_order`) as {
        recipient_name: string;
        delivery_address: string;
        delivery_instructions: string;
      };
      assert.equal(stored.recipient_name, recipient);
      assert.equal(stored.delivery_address, address);
      assert.equal(stored.delivery_instructions, `Leave safely; ${payload}`);
    }

    assert.equal(count('orders'), ordersBefore);
    assert.equal(count('ledger'), ledgerBefore);
    assert.equal(count('payment_claims'), 0);
    assert.equal(count('refund_requests'), 0);
  } finally {
    db.exec('rollback');
  }
});

test('unsupported control characters fail before any fulfilment draft is stored', () => {
  db.exec('begin');
  try {
    const customerId = customer('control-character');
    const productId = product();
    const before = count('order_drafts');
    const result = prepareOrder.execute(
      {
        items: [{ product_id: productId, qty: 1 }],
        recipient_name: 'Ali\u0000Khan',
        contact_phone: '03001234567',
        delivery_address: 'House 1, Safety Street',
        city: 'Islamabad',
        payment_method: 'cod',
      },
      { customerId, idempotencyKey: 'control-character-draft' },
    ) as Record<string, unknown>;
    assert.equal(result.ok, false);
    assert.match(String(result.error), /unsupported control characters/i);
    assert.equal(count('order_drafts'), before);
  } finally {
    db.exec('rollback');
  }
});

test('SQL-like note content stays customer-bound data and note-id injection is rejected', async () => {
  db.exec('begin');
  try {
    const ownerId = customer('note-owner');
    const attackerId = customer('note-attacker');
    const payload = SQL_LIKE_PAYLOADS.join(' | ');
    const noteId = Number(
      db.prepare('insert into customer_notes (customer_id, headline, body) values (?, ?, ?)')
        .run(ownerId, 'Literal customer preference', payload).lastInsertRowid,
    );

    const own = await getCustomerNote.execute({ note_id: noteId }, { customerId: ownerId }) as {
      ok: boolean;
      note: { body: string };
    };
    assert.equal(own.ok, true);
    assert.equal(own.note.body, payload);

    const foreign = await getCustomerNote.execute({ note_id: noteId }, { customerId: attackerId });
    const injected = await getCustomerNote.execute({ note_id: '1 OR 1=1' }, { customerId: attackerId });
    assert.deepEqual(foreign, { ok: false, error: 'No note found with that id for this customer.' });
    assert.deepEqual(injected, { ok: false, error: 'note_id must be a positive whole number.' });
    assert.equal(count('orders'), 0);
    assert.equal(count('ledger'), 0);
  } finally {
    db.exec('rollback');
  }
});

test('the adversarial corpus leaves every critical table and schema intact', () => {
  const tables = db.prepare(`
    select name from sqlite_master where type = 'table'
  `).all() as Array<{ name: string }>;
  const names = new Set(tables.map((row) => row.name));
  for (const table of BUSINESS_TABLES) assert.equal(names.has(table), true, table);
  assert.equal(db.pragma('integrity_check', { simple: true }), 'ok');
  assert.deepEqual(db.pragma('foreign_key_check'), []);
});
