import { db } from '../src/db';
import { checkStock, confirmOrder, prepareOrder, updateOrderStatus } from '../src/tools';
import { getBalance } from '../src/ledger';
import { getPendingFollowups } from '../src/followups';
import { validateOrderItems } from '../src/tools';
import { claimPayment } from '../src/payments';
import { handleOwnerPaymentCommand } from '../src/payment-resolution';
import { rupeesToMinor } from '../src/money';

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`FAIL: ${message}`);
  }
  console.log(`  ✓ PASS: ${message}`);
}

async function runV2Verification(): Promise<void> {
  console.log('=== Starting Comprehensive Version 2 Verification ===\n');

  // Everything below runs inside one transaction that is rolled back at the
  // end. Approved payment-claim history is append-only (SQLite triggers
  // forbid deleting it), so row-by-row cleanup is not possible.
  db.exec('begin');
  const testRunId = Date.now();
  const testPhone = `test-v2-${testRunId}`;
  const testProductName = `test-shirt-${testRunId}`;
  const customerResult = db.prepare('insert into customers (phone, name) values (?, ?)').run(testPhone, 'Test Customer');
  const customerId = customerResult.lastInsertRowid as number;

  const productResult = db.prepare(
    'insert into products (name, size, color, price_minor, stock) values (?, ?, ?, ?, ?)'
  ).run(testProductName, 'medium', 'black', rupeesToMinor(2500), 10);
  const productId = productResult.lastInsertRowid as number;
  const ownerId = db.prepare('insert into customers (phone, name) values (?, ?)')
    .run(`test-v2-owner-${testRunId}`, 'Test Owner').lastInsertRowid as number;

  const ctx = { customerId };

  try {
    // 1. Stock Check
    console.log('Test 1: Stock checking via check_stock');
    const stockCheck: any = checkStock.execute(
      { name: testProductName, size: 'medium', color: 'black', requested_qty: 2 },
      ctx,
    );
    assert(stockCheck.ok === true && stockCheck.found === true && stockCheck.products.length === 1, 'Found product by name, size, color');
    assert(stockCheck.products[0].availability === 'in_stock', 'Customer receives public in-stock status');
    assert(stockCheck.products[0].can_fulfill_requested_qty === true, 'Requested quantity can be fulfilled');
    assert(!Object.hasOwn(stockCheck.products[0], 'stock'), 'Exact stock count is not exposed by the customer tool');
    const initialStock: any = db.prepare('select stock from products where id = ?').get(productId);
    assert(initialStock.stock === 10, 'Internal stock remains exactly 10');

    // 2. Two-step booking, step 1: prepare_order saves a draft only
    console.log('\nTest 2: prepare_order saves a server-priced draft without booking');
    const prepareResult: any = prepareOrder.execute({
      items: [{ product_id: productId, qty: 2 }],
      recipient_name: 'Test Customer',
      contact_phone: '03120000000',
      delivery_address: 'House 1, Main Road, Sector F',
      city: 'Islamabad',
      payment_method: 'cash on delivery',
    }, { customerId, idempotencyKey: `test-v2-${testRunId}-prepare` });
    assert(prepareResult.ok === true, 'prepare_order succeeded');
    assert(prepareResult.total === 5000, 'Draft total is the server catalog price (Rs 5000)');
    const ordersAfterPrepare: any = db.prepare('select count(*) n from orders where customer_id = ?').get(customerId);
    assert(ordersAfterPrepare.n === 0, 'No order exists before explicit confirmation');
    assert(getBalance(customerId) === 0, 'No ledger debit before explicit confirmation');
    const stockAfterPrepare: any = db.prepare('select stock from products where id = ?').get(productId);
    assert(stockAfterPrepare.stock === 10, 'Stock remains unchanged while only a draft exists');

    const bareYes: any = confirmOrder.execute({}, {
      customerId,
      idempotencyKey: `test-v2-${testRunId}-bare-yes`,
      inboundText: 'yes',
    });
    assert(bareYes.ok === false, 'A bare "yes" cannot book the order');

    // 3. Two-step booking, step 2: explicit confirm books + reserves stock
    console.log('\nTest 3: confirm_order books the order, debits the ledger and reserves stock');
    const confirmResult: any = confirmOrder.execute({}, {
      customerId,
      idempotencyKey: `test-v2-${testRunId}-confirm`,
      inboundText: 'Confirm order',
    });
    assert(confirmResult.ok === true, 'confirm_order succeeded');
    const orderReference = confirmResult.order_reference;
    assert(/^ORD-[0-9A-F]{20}$/.test(orderReference), 'Generated public order reference');
    assert(!Object.hasOwn(confirmResult, 'order_id'), 'Internal order id is not exposed to the model');
    const orderRow: any = db.prepare('select * from orders where public_ref = ?').get(orderReference);
    const orderId = orderRow?.id;
    assert(typeof orderId === 'number', 'Generated orderId');
    assert(orderRow.status === 'confirmed', 'Status after explicit confirmation is "confirmed"');
    assert(orderRow.total_minor === rupeesToMinor(5000), 'Order total is exactly 500000 paisas (Rs 5000)');
    const placedAudit: any = db.prepare(
      'select from_status, to_status, actor_type, source, evidence from order_status_events where order_id = ? order by id limit 1',
    ).get(orderId);
    assert(placedAudit?.from_status === null && placedAudit?.to_status === 'placed', 'Initial placed status is audited');
    assert(placedAudit?.actor_type === 'customer' && placedAudit?.source === 'whatsapp_fulfillment_confirmation', 'Order creation records customer actor and source');
    const confirmAudit: any = db.prepare(
      "select actor_type, source, evidence from order_status_events where order_id = ? and to_status = 'confirmed'",
    ).get(orderId);
    assert(confirmAudit?.actor_type === 'customer' && confirmAudit?.source === 'whatsapp_fulfillment_confirmation', 'Confirmation records customer actor and source');

    const balanceAfterOrder = getBalance(customerId);
    assert(balanceAfterOrder === 5000, 'Ledger balance owed is 5000 (debit recorded)');

    const stockAfterConfirm: any = db.prepare('select stock from products where id = ?').get(productId);
    assert(stockAfterConfirm.stock === 8, 'Stock decremented from 10 to 8');

    // 4. State Machine Guards (invalid backward / skip transitions)
    console.log('\nTest 4: Rejecting invalid state transitions');
    const backwardAttempt: any = updateOrderStatus.execute({ order_reference: orderReference, status: 'placed' }, ctx);
    assert(backwardAttempt.ok === false, 'Cannot move backward to "placed"');

    const skipAttempt: any = updateOrderStatus.execute({ order_reference: orderReference, status: 'delivered' }, ctx);
    assert(skipAttempt.ok === false, 'Cannot skip from confirmed directly to delivered');

    // 5. Payment: customer claim, then owner-verified two-step approval
    console.log('\nTest 5: Payment claim + owner approval reduces balance');
    const paymentResult: any = await claimPayment.execute(
      { amount: 3000, method: 'Easypaisa' },
      { customerId, idempotencyKey: `test-v2-${testRunId}-claim` },
    );
    assert(paymentResult.ok === true && paymentResult.status === 'pending', 'claim_payment of 3000 created a pending claim');
    assert(paymentResult.ledger_credited === false, 'claim_payment reports no ledger credit');
    assert(getBalance(customerId) === 5000, 'Unverified claim does not change the balance');

    const verifiedRef = `EP-V2-${testRunId}`;
    const preparedApproval = handleOwnerPaymentCommand({
      ownerCustomerId: ownerId,
      text: `APPROVE CLAIM ${paymentResult.claim_id} REF ${verifiedRef}`,
      eventKey: `test-v2-${testRunId}-owner-prepare`,
    });
    assert(preparedApproval.mutation === 'none', 'Owner APPROVE step alone changes nothing');
    assert(getBalance(customerId) === 5000, 'Balance unchanged before owner CONFIRM');
    const confirmedApproval = handleOwnerPaymentCommand({
      ownerCustomerId: ownerId,
      text: `CONFIRM APPROVE CLAIM ${paymentResult.claim_id} REF ${verifiedRef}`,
      eventKey: `test-v2-${testRunId}-owner-confirm`,
    });
    assert(confirmedApproval.mutation === 'approved', 'Owner CONFIRM APPROVE credits the claim');

    const balanceAfterPayment = getBalance(customerId);
    assert(balanceAfterPayment === 2000, 'Customer balance owed reduced from 5000 to 2000');

    // 6. Safety Net Validation
    console.log('\nTest 6: Safety net validation logic');
    const validCheck = validateOrderItems([{ product_id: productId, qty: 1, price: 1 }]);
    assert(validCheck.ok === true && validCheck.total === 2500, 'Server uses catalog price, not a supplied price');
    assert(validCheck.ok === true && validCheck.items[0].price_minor === rupeesToMinor(2500), 'Normalized item stores exact catalog price');

    const invalidCheck = validateOrderItems([{ product_id: 999999, qty: 1 }]);
    assert(invalidCheck.ok === false, 'Invalid product_id rejected by safety net');

    // 7. Cancellation before shipping -> Stock Restores & Ledger Reverses
    console.log('\nTest 7: Cancelling confirmed order restores stock and reverses debit');
    const cancelResult: any = updateOrderStatus.execute({ order_reference: orderReference, status: 'cancelled' }, ctx);
    assert(cancelResult.ok === true, 'updateOrderStatus to cancelled succeeded');

    const stockAfterCancel: any = db.prepare('select stock from products where id = ?').get(productId);
    assert(stockAfterCancel.stock === 10, 'Stock restored back to 10');

    const balanceAfterCancel = getBalance(customerId);
    assert(balanceAfterCancel === -3000, 'Balance is -3000 (payment remains credited, order debit reversed)');

    // 8. Follow-up Tracking (injectable time)
    console.log('\nTest 8: Follow-up tracking for unpaid orders');
    // Create an unpaid order backdated 3 days
    const oldOrderResult = db.prepare(
      "insert into orders (customer_id, items_json, total_minor, status, created_at) values (?, ?, ?, 'placed', datetime('now', '-3 days'))"
    ).run(customerId, JSON.stringify([{ product_id: productId, qty: 1, price_minor: rupeesToMinor(2500) }]), rupeesToMinor(2500));
    const oldOrderId = oldOrderResult.lastInsertRowid as number;

    const followups = getPendingFollowups(new Date());
    const matched = followups.find((f) => f.order_id === oldOrderId);
    assert(matched !== undefined, 'Unpaid 3-day-old order appears in pending follow-ups');
    assert(matched?.overdue === false, 'Not overdue yet (< 7 days)');

    console.log('\n=== ALL VERSION 2 TESTS PASSED PERFECTLY ===\n');
  } finally {
    db.exec('rollback');
  }
}

if (require.main === module) {
  runV2Verification().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
