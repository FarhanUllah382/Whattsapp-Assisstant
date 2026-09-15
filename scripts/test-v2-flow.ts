import { db } from '../src/db';
import { checkStock, recordOrder, updateOrderStatus, recordPayment } from '../src/tools';
import { getBalance } from '../src/ledger';
import { getPendingFollowups } from '../src/followups';
import { insertValidatedOrder, validateOrderItems } from '../src/tools';

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`FAIL: ${message}`);
  }
  console.log(`  ✓ PASS: ${message}`);
}

async function runV2Verification(): Promise<void> {
  console.log('=== Starting Comprehensive Version 2 Verification ===\n');

  // Clean test setup
  const testRunId = Date.now();
  const testPhone = `test-v2-${testRunId}`;
  const testProductName = `test-shirt-${testRunId}`;
  const customerResult = db.prepare('insert into customers (phone, name) values (?, ?)').run(testPhone, 'Test Customer');
  const customerId = customerResult.lastInsertRowid as number;

  const productResult = db.prepare(
    'insert into products (name, size, color, price, stock) values (?, ?, ?, ?, ?)'
  ).run(testProductName, 'medium', 'black', 2500, 10);
  const productId = productResult.lastInsertRowid as number;

  const ctx = { customerId };

  try {
    // 1. Stock Check
    console.log('Test 1: Stock checking via check_stock');
    const stockCheck: any = checkStock.execute({ name: testProductName, size: 'medium', color: 'black' }, ctx);
    assert(Array.isArray(stockCheck) && stockCheck.length === 1, 'Found product by name, size, color');
    assert(stockCheck[0].stock === 10, 'Initial stock is 10');

    // 2. Order Placement (status: placed)
    console.log('\nTest 2: Order placement & initial ledger debit');
    const orderResult: any = recordOrder.execute({
      items: [{ product_id: productId, qty: 2, price: 2500 }],
    }, ctx);
    assert(orderResult.ok === true, 'record_order succeeded');
    const orderId = orderResult.order_id;
    assert(typeof orderId === 'number', 'Generated orderId');

    const orderRow: any = db.prepare('select * from orders where id = ?').get(orderId);
    assert(orderRow.status === 'placed', 'Initial status is "placed"');
    assert(orderRow.total === 5000, 'Order total is 5000');

    const balanceAfterOrder = getBalance(customerId);
    assert(balanceAfterOrder === 5000, 'Ledger balance owed is 5000 (debit recorded)');

    const stockAfterPlaced: any = db.prepare('select stock from products where id = ?').get(productId);
    assert(stockAfterPlaced.stock === 10, 'Stock remains unchanged at "placed" status');

    // 3. Order Confirmation (status: confirmed) -> Stock Decrements
    console.log('\nTest 3: Confirming order decrements live stock');
    const confirmResult: any = updateOrderStatus.execute({ order_id: orderId, status: 'confirmed' }, ctx);
    assert(confirmResult.ok === true, 'updateOrderStatus to confirmed succeeded');

    const stockAfterConfirm: any = db.prepare('select stock from products where id = ?').get(productId);
    assert(stockAfterConfirm.stock === 8, 'Stock decremented from 10 to 8');

    // 4. State Machine Guards (invalid backward / skip transitions)
    console.log('\nTest 4: Rejecting invalid state transitions');
    const backwardAttempt: any = updateOrderStatus.execute({ order_id: orderId, status: 'placed' }, ctx);
    assert(backwardAttempt.ok === false, 'Cannot move backward to "placed"');

    const skipAttempt: any = updateOrderStatus.execute({ order_id: orderId, status: 'delivered' }, ctx);
    assert(skipAttempt.ok === false, 'Cannot skip from confirmed directly to delivered');

    // 5. Payment Recording (ledger credit)
    console.log('\nTest 5: Recording payment and reducing balance');
    const paymentResult: any = recordPayment.execute({ amount: 3000 }, ctx);
    assert(paymentResult.ok === true, 'record_payment of 3000 succeeded');

    const balanceAfterPayment = getBalance(customerId);
    assert(balanceAfterPayment === 2000, 'Customer balance owed reduced from 5000 to 2000');

    // 6. Safety Net Validation
    console.log('\nTest 6: Safety net validation logic');
    const validCheck = validateOrderItems([{ product_id: productId, qty: 1, price: 2500 }]);
    assert(validCheck.ok === true && validCheck.total === 2500, 'Valid order payload passes');

    const invalidCheck = validateOrderItems([{ product_id: 999999, qty: 1, price: 2500 }]);
    assert(invalidCheck.ok === false, 'Invalid product_id rejected by safety net');

    // 7. Cancellation before shipping -> Stock Restores & Ledger Reverses
    console.log('\nTest 7: Cancelling confirmed order restores stock and reverses debit');
    const cancelResult: any = updateOrderStatus.execute({ order_id: orderId, status: 'cancelled' }, ctx);
    assert(cancelResult.ok === true, 'updateOrderStatus to cancelled succeeded');

    const stockAfterCancel: any = db.prepare('select stock from products where id = ?').get(productId);
    assert(stockAfterCancel.stock === 10, 'Stock restored back to 10');

    const balanceAfterCancel = getBalance(customerId);
    assert(balanceAfterCancel === -3000, 'Balance is -3000 (payment remains credited, order debit reversed)');

    // 8. Follow-up Tracking (injectable time)
    console.log('\nTest 8: Follow-up tracking for unpaid orders');
    // Create an unpaid order backdated 3 days
    const oldOrderResult = db.prepare(
      "insert into orders (customer_id, items_json, total, status, created_at) values (?, ?, ?, 'placed', datetime('now', '-3 days'))"
    ).run(customerId, JSON.stringify([{ product_id: productId, qty: 1, price: 2500 }]), 2500);
    const oldOrderId = oldOrderResult.lastInsertRowid as number;

    const followups = getPendingFollowups(new Date());
    const matched = followups.find((f) => f.order_id === oldOrderId);
    assert(matched !== undefined, 'Unpaid 3-day-old order appears in pending follow-ups');
    assert(matched?.overdue === false, 'Not overdue yet (< 7 days)');

    console.log('\n=== ALL VERSION 2 TESTS PASSED PERFECTLY ===\n');
  } finally {
    // Clean up test rows
    db.prepare('delete from ledger where customer_id = ?').run(customerId);
    db.prepare('delete from orders where customer_id = ?').run(customerId);
    db.prepare('delete from messages where customer_id = ?').run(customerId);
    db.prepare('delete from checkpoints where customer_id = ?').run(customerId);
    db.prepare('delete from customers where id = ?').run(customerId);
    db.prepare('delete from products where id = ?').run(productId);
  }
}

if (require.main === module) {
  runV2Verification().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
