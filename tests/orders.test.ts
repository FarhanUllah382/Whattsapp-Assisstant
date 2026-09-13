import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../src/db';
import { checkOrderStatusTransition, transitionOrderStatus } from '../src/orders';
import { getBalance } from '../src/ledger';

describe('Order State Machine (FSM)', () => {
  describe('checkOrderStatusTransition (Pure Function)', () => {
    it('allows valid forward transitions: placed -> confirmed -> paid -> shipped -> delivered', () => {
      assert.deepEqual(checkOrderStatusTransition('placed', 'confirmed'), { ok: true });
      assert.deepEqual(checkOrderStatusTransition('confirmed', 'paid'), { ok: true });
      assert.deepEqual(checkOrderStatusTransition('paid', 'shipped'), { ok: true });
      assert.deepEqual(checkOrderStatusTransition('shipped', 'delivered'), { ok: true });
    });

    it('allows cancellations before shipping', () => {
      assert.deepEqual(checkOrderStatusTransition('placed', 'cancelled'), { ok: true });
      assert.deepEqual(checkOrderStatusTransition('confirmed', 'cancelled'), { ok: true });
      assert.deepEqual(checkOrderStatusTransition('paid', 'cancelled'), { ok: true });
    });

    it('rejects cancellation after shipping or delivery', () => {
      const shipCancel = checkOrderStatusTransition('shipped', 'cancelled');
      assert.equal(shipCancel.ok, false);

      const delCancel = checkOrderStatusTransition('delivered', 'cancelled');
      assert.equal(delCancel.ok, false);
    });

    it('rejects backward transitions', () => {
      const backward1 = checkOrderStatusTransition('confirmed', 'placed');
      assert.equal(backward1.ok, false);

      const backward2 = checkOrderStatusTransition('paid', 'confirmed');
      assert.equal(backward2.ok, false);
    });

    it('rejects skipping states', () => {
      const skip = checkOrderStatusTransition('placed', 'shipped');
      assert.equal(skip.ok, false);
    });

    it('rejects transitions out of terminal states', () => {
      assert.equal(checkOrderStatusTransition('delivered', 'shipped').ok, false);
      assert.equal(checkOrderStatusTransition('cancelled', 'placed').ok, false);
    });
  });

  describe('transitionOrderStatus (DB Integrated & Stock Effects)', () => {
    let customerId: number;
    let productId: number;

    before(() => {
      const cust = db.prepare('insert into customers (phone, name) values (?, ?)').run(`test-fsm-${Date.now()}`, 'FSM Test');
      customerId = cust.lastInsertRowid as number;

      const prod = db.prepare('insert into products (name, size, color, price, stock) values (?, ?, ?, ?, ?)').run(
        'fsm-shirt',
        'medium',
        'black',
        2000,
        20,
      );
      productId = prod.lastInsertRowid as number;
    });

    after(() => {
      db.prepare('delete from ledger where customer_id = ?').run(customerId);
      db.prepare('delete from orders where customer_id = ?').run(customerId);
      db.prepare('delete from customers where id = ?').run(customerId);
      db.prepare('delete from products where id = ?').run(productId);
    });

    it('decrements stock when moving from placed to confirmed', () => {
      // Create order with 3 items
      const items = [{ product_id: productId, qty: 3, price: 2000 }];
      const orderRes = db
        .prepare('insert into orders (customer_id, items_json, total, status) values (?, ?, ?, ?)')
        .run(customerId, JSON.stringify(items), 6000, 'placed');
      const orderId = orderRes.lastInsertRowid as number;

      // Verify initial stock
      const initialStock: any = db.prepare('select stock from products where id = ?').get(productId);
      assert.equal(initialStock.stock, 20);

      // Confirm order
      const transResult = transitionOrderStatus(orderId, 'confirmed');
      assert.equal(transResult.ok, true);

      // Stock should have dropped to 17
      const updatedStock: any = db.prepare('select stock from products where id = ?').get(productId);
      assert.equal(updatedStock.stock, 17);
    });

    it('restores stock and reverses ledger debit when cancelling a confirmed order', () => {
      const items = [{ product_id: productId, qty: 2, price: 2000 }];
      const orderRes = db
        .prepare('insert into orders (customer_id, items_json, total, status) values (?, ?, ?, ?)')
        .run(customerId, JSON.stringify(items), 4000, 'placed');
      const orderId = orderRes.lastInsertRowid as number;

      // Record initial debit as recordOrder would
      db.prepare("insert into ledger (customer_id, order_id, kind, amount) values (?, ?, 'debit', ?)").run(
        customerId,
        orderId,
        4000,
      );

      // Confirm (stock 17 -> 15)
      transitionOrderStatus(orderId, 'confirmed');
      const confirmedStock: any = db.prepare('select stock from products where id = ?').get(productId);
      assert.equal(confirmedStock.stock, 15);

      // Cancel order
      const cancelResult = transitionOrderStatus(orderId, 'cancelled');
      assert.equal(cancelResult.ok, true);

      // Stock restored to 17
      const restoredStock: any = db.prepare('select stock from products where id = ?').get(productId);
      assert.equal(restoredStock.stock, 17);

      // Ledger debit is reversed by an equal credit
      const balance = getBalance(customerId);
      assert.equal(balance, 0);
    });
  });
});
