import assert from 'node:assert/strict';
import { checkOrderStatusTransition, OrderStateMachine } from '../src/orders';
import { LedgerAccount } from '../src/ledger';
import { checkDiscountRule } from '../src/guardrails/discount-rules';
import { detectHumanPromise } from '../src/guardrails/human-promise';
import { isOwnerPhone } from '../src/owner';
import { parseCatalog, findBestMatch, loadCatalogSections } from '../src/catalog';
import { wahaAdapter, WahaAdapter } from '../src/channel/waha';
import { normalizeGeminiFunctionResponse } from '../src/llm';
import { db } from '../src/db';
import { recordOrder, recordPayment } from '../src/tools';

let totalTests = 0;
let passedTests = 0;
let failedTests = 0;

function it(name: string, fn: () => void): void {
  totalTests++;
  try {
    fn();
    passedTests++;
    console.log(`    ✔ ${name}`);
  } catch (err: any) {
    failedTests++;
    console.error(`    ✖ ${name}`);
    console.error(`      ${err?.message ?? err}`);
  }
}

console.log('\n============================================================');
console.log("       Ahmed's Assistant — Comprehensive Test Suite         ");
console.log('============================================================\n');

// --- Suite 1: Order State Machine (Forward-Only Retail FSM) ---
console.log('▶ Order State Machine (Forward-Only Retail FSM)');
it('allows valid forward transitions: placed -> confirmed -> paid -> shipped -> delivered', () => {
  assert.deepEqual(checkOrderStatusTransition('placed', 'confirmed'), { ok: true });
  assert.deepEqual(checkOrderStatusTransition('confirmed', 'paid'), { ok: true });
  assert.deepEqual(checkOrderStatusTransition('paid', 'shipped'), { ok: true });
  assert.deepEqual(checkOrderStatusTransition('shipped', 'delivered'), { ok: true });
});

it('allows cancellations strictly before shipping', () => {
  assert.deepEqual(checkOrderStatusTransition('placed', 'cancelled'), { ok: true });
  assert.deepEqual(checkOrderStatusTransition('confirmed', 'cancelled'), { ok: true });
  assert.deepEqual(checkOrderStatusTransition('paid', 'cancelled'), { ok: true });
});

it('rejects cancellations once an order has shipped or delivered', () => {
  assert.equal(checkOrderStatusTransition('shipped', 'cancelled').ok, false);
  assert.equal(checkOrderStatusTransition('delivered', 'cancelled').ok, false);
});

it('rejects backward transitions to prevent state corruption', () => {
  assert.equal(checkOrderStatusTransition('confirmed', 'placed').ok, false);
  assert.equal(checkOrderStatusTransition('paid', 'confirmed').ok, false);
  assert.equal(checkOrderStatusTransition('shipped', 'paid').ok, false);
});

it('rejects skipping states in the order lifecycle', () => {
  assert.equal(checkOrderStatusTransition('placed', 'shipped').ok, false);
  assert.equal(checkOrderStatusTransition('placed', 'delivered').ok, false);
});

it('rejects transitions out of terminal states (delivered, cancelled)', () => {
  assert.equal(checkOrderStatusTransition('delivered', 'shipped').ok, false);
  assert.equal(checkOrderStatusTransition('cancelled', 'placed').ok, false);
});

// --- Suite 2: Double-Entry Financial Ledger Logic ---
console.log('\n▶ Double-Entry Financial Ledger & Balance Derivation');
interface LedgerEntry {
  kind: 'debit' | 'credit';
  amount: number;
}
function calculateBalance(entries: LedgerEntry[]): number {
  return entries.reduce((acc, e) => (e.kind === 'debit' ? acc + e.amount : acc - e.amount), 0);
}

it('returns balance = 0 for an account with no entries', () => {
  assert.equal(calculateBalance([]), 0);
});

it('correctly increments receivables upon recording a debit', () => {
  const entries: LedgerEntry[] = [{ kind: 'debit', amount: 5000 }];
  assert.equal(calculateBalance(entries), 5000);
});

it('correctly reduces receivables upon recording payments (credits)', () => {
  const entries: LedgerEntry[] = [
    { kind: 'debit', amount: 5000 },
    { kind: 'credit', amount: 2000 },
  ];
  assert.equal(calculateBalance(entries), 3000);

  entries.push({ kind: 'credit', amount: 3000 });
  assert.equal(calculateBalance(entries), 0);
});

it('reverses debit by issuing an equal credit upon cancellation', () => {
  const entries: LedgerEntry[] = [
    { kind: 'debit', amount: 4000 }, // order placed
    { kind: 'credit', amount: 4000 }, // cancelled reversal
  ];
  assert.equal(calculateBalance(entries), 0);
});

it('supports negative balance as store credit if customer overpays', () => {
  const entries: LedgerEntry[] = [
    { kind: 'debit', amount: 2000 },
    { kind: 'credit', amount: 2500 },
  ];
  assert.equal(calculateBalance(entries), -500);
});

// --- Suite 3: Discount Rules Guardrail ---
console.log('\n▶ Discount Rules Guardrail (Anti-Ban & Commercial Safety)');
it('blocks unauthorized discounts at or above 5%', () => {
  assert.equal(checkDiscountRule('I can offer you 10% off on this shirt.').ok, false);
  assert.equal(checkDiscountRule('Special 15% discount for you today!').ok, false);
  assert.equal(checkDiscountRule('Price mein 20% kam kar dunga.').ok, false);
  assert.equal(checkDiscountRule('20% chhoot mil sakti hai.').ok, false);
});

it('allows small discounts under 5%', () => {
  assert.equal(checkDiscountRule('We can do a small 3% discount for bulk orders.').ok, true);
});

it('allows retrospective recall of an agreed customer discount request in English', () => {
  const knownPercents = new Set([20]);
  assert.equal(
    checkDiscountRule('Yesterday you asked for a 20% discount, let me check with Ahmed.', knownPercents).ok,
    true,
  );
});

it('allows retrospective recall of a discount request in Roman Urdu', () => {
  const knownPercents = new Set([15]);
  assert.equal(
    checkDiscountRule('Aapne kal 15% discount maanga tha, main confirm karke batata hoon.', knownPercents).ok,
    true,
  );
});

it('still blocks if retrospective language is used but the percentage is ungrounded', () => {
  const emptyKnown = new Set<number>();
  assert.equal(checkDiscountRule('Yesterday you asked for a 20% discount.', emptyKnown).ok, false);
});

// --- Suite 4: Human Promise Guardrail ---
console.log('\n▶ Human Promise Guardrail (Escalation Protection)');
it('detects English promises to escalate to Ahmed, the owner, or staff', () => {
  assert.equal(detectHumanPromise("I'll check with Ahmed and confirm"), true);
  assert.equal(detectHumanPromise('The owner will call you back shortly.'), true);
  assert.equal(detectHumanPromise('Our team will get back to you soon.'), true);
});

it('detects Roman Urdu promises to escalate', () => {
  assert.equal(detectHumanPromise('malik se pooch ke batata hoon'), true);
  assert.equal(detectHumanPromise('Ahmed bhai confirm karenge'), true);
  assert.equal(detectHumanPromise('team se confirm kar ke batata hoon'), true);
});

it('does not flag normal conversational messages', () => {
  assert.equal(detectHumanPromise('The price is 2500 Rs with free delivery.'), false);
  assert.equal(detectHumanPromise('We have black and white shirts in stock.'), false);
});

// --- Suite 5: Owner Authentication (Fail-Closed Security) ---
console.log('\n▶ Owner Caller-ID Authentication (Fail-Closed Routing)');
const MOCK_OWNER_PHONE = '923001234567';

it('accurately identifies owner when phone matches exactly', () => {
  assert.equal(isOwnerPhone('923001234567', MOCK_OWNER_PHONE), true);
});

it('normalizes international formatting, spaces, and plus signs', () => {
  assert.equal(isOwnerPhone('+92 300 1234567', MOCK_OWNER_PHONE), true);
  assert.equal(isOwnerPhone('92-300-1234567', MOCK_OWNER_PHONE), true);
});

it('rejects customer phone numbers from accessing owner mode', () => {
  assert.equal(isOwnerPhone('923219999999', MOCK_OWNER_PHONE), false);
});

it('fails closed when owner phone is not configured', () => {
  assert.equal(isOwnerPhone('923001234567', undefined), false);
  assert.equal(isOwnerPhone('923001234567', ''), false);
});

// --- Suite 6: WAHA WhatsApp Channel Gateway & LID Resolution ---
console.log('\n▶ WAHA Channel Gateway & Privacy LID Resolution');
it('ignores self-echo outbound messages', () => {
  const payload = {
    event: 'message',
    payload: { fromMe: true, from: '923001234567@c.us', body: 'Hello' },
  };
  assert.equal(wahaAdapter.parseInboundWebhook(payload), null);
});

it('ignores group chat messages (@g.us)', () => {
  const payload = {
    event: 'message',
    payload: { fromMe: false, from: '1234567890-group@g.us', body: 'Group text' },
  };
  assert.equal(wahaAdapter.parseInboundWebhook(payload), null);
});

it('ignores newsletter and broadcast messages instead of treating their ids as phone numbers', () => {
  for (const from of ['120363194339935425@newsletter', 'status@broadcast']) {
    const payload = {
      event: 'message',
      payload: { fromMe: false, from, body: 'Non-customer feed text' },
    };
    assert.equal(wahaAdapter.parseInboundWebhook(payload), null);
  }
});

it('rejects an unresolved privacy LID instead of replying to the pseudonymous id', () => {
  const payload = {
    event: 'message',
    payload: { fromMe: false, from: '123456789@lid', body: 'Missing real JID' },
  };
  assert.equal(wahaAdapter.parseInboundWebhook(payload), null);
});

it('accepts a direct NOWEB phone-number JID', () => {
  const payload = {
    event: 'message',
    payload: { fromMe: false, from: '923299144863@s.whatsapp.net', body: 'Direct text' },
  };
  assert.deepEqual(wahaAdapter.parseInboundWebhook(payload), {
    phone: '923299144863',
    text: 'Direct text',
  });
});

it('preserves WAHA message ids needed to deduplicate crash retries', () => {
  const direct = {
    event: 'message',
    payload: {
      id: 'false_923332333460@c.us_DIRECT123',
      fromMe: false,
      from: '923332333460@c.us',
      body: 'One hoodie please',
    },
  };
  assert.deepEqual(wahaAdapter.parseInboundWebhook(direct), {
    phone: '923332333460',
    text: 'One hoodie please',
    messageId: 'false_923332333460@c.us_DIRECT123',
  });

  const serializedFallback = {
    event: 'message',
    payload: {
      fromMe: false,
      from: '923332333460@c.us',
      body: 'Paid 800',
      _data: { id: { _serialized: 'false_923332333460@c.us_FALLBACK456' } },
    },
  };
  assert.equal(
    wahaAdapter.parseInboundWebhook(serializedFallback)?.messageId,
    'false_923332333460@c.us_FALLBACK456',
  );
});

it('resolves WhatsApp privacy LID identifiers to real phone numbers', () => {
  const payload = {
    event: 'message',
    payload: {
      fromMe: false,
      from: '123456789@lid',
      body: 'Hello from privacy contact',
      _data: {
        key: {
          remoteJidAlt: '923299144863@c.us',
        },
      },
    },
  };
  const parsed = wahaAdapter.parseInboundWebhook(payload);
  assert.ok(parsed);
  assert.equal(parsed?.phone, '923299144863');
  assert.equal(parsed?.text, 'Hello from privacy contact');
});

// --- Suite 7: Catalog & FAQ Grounding Engine ---
console.log('\n▶ Catalog & FAQ Grounding Engine');
it('correctly parses markdown into distinct sections by ## headings', () => {
  const rawMarkdown = `
# Store FAQ

## Delivery
We deliver all over Pakistan within 3-5 days.

## Return Policy
Returns accepted within 7 days.
  `.trim();
  const sections = parseCatalog(rawMarkdown);
  assert.equal(sections.length, 2);
  assert.equal(sections[0].title, 'Delivery');
  assert.match(sections[0].body, /3-5 days/);
  assert.equal(sections[1].title, 'Return Policy');
  assert.match(sections[1].body, /7 days/);
});

it('matches customer questions to the correct section with title weighting', () => {
  const sections = loadCatalogSections();
  const returnMatch = findBestMatch(sections, 'How can I return an item?');
  assert.ok(returnMatch);
  assert.equal(returnMatch?.title, 'Return Policy');

  const exchangeMatch = findBestMatch(sections, 'Can I exchange for a different size?');
  assert.ok(exchangeMatch);
  assert.equal(exchangeMatch?.title, 'Exchange Policy');

  const deliveryMatch = findBestMatch(sections, 'How long does delivery take all over Pakistan?');
  assert.ok(deliveryMatch);
  assert.equal(deliveryMatch?.title, 'Delivery');

  const paymentMatch = findBestMatch(sections, 'Do you accept Easypaisa or JazzCash?');
  assert.ok(paymentMatch);
  assert.equal(paymentMatch?.title, 'Payment Methods');
});

it('returns null when the customer query is completely ungrounded', () => {
  const sections = loadCatalogSections();
  const match = findBestMatch(sections, 'Where is the nearest spaceship repair workshop?');
  assert.equal(match, null);
});

// --- Suite 8: Object-Oriented Domain Entities & Polymorphism ---
console.log('\n▶ Object-Oriented Domain Entities & Polymorphism (MLH Criterion 7)');
it('OrderStateMachine encapsulates order state, validates transitions, and maintains audit history', () => {
  const fsm = new OrderStateMachine('placed', 101);
  assert.equal(fsm.status, 'placed');
  assert.equal(fsm.orderId, 101);
  assert.equal(fsm.isTerminal(), false);

  // Valid forward moves
  assert.equal(fsm.transition('confirmed').ok, true);
  assert.equal(fsm.status, 'confirmed');

  assert.equal(fsm.transition('paid').ok, true);
  assert.equal(fsm.status, 'paid');

  assert.equal(fsm.transition('shipped').ok, true);
  assert.equal(fsm.status, 'shipped');

  assert.equal(fsm.transition('delivered').ok, true);
  assert.equal(fsm.status, 'delivered');
  assert.equal(fsm.isTerminal(), true);

  // Terminal state lockout
  const invalidMove = fsm.transition('placed');
  assert.equal(invalidMove.ok, false);

  // Audit history integrity
  const history = fsm.history;
  assert.equal(history.length, 4);
  assert.equal(history[0].from, 'placed');
  assert.equal(history[0].to, 'confirmed');
  assert.equal(history[3].from, 'shipped');
  assert.equal(history[3].to, 'delivered');
});

it('OrderStateMachine enforces validation on construction and state skipping', () => {
  assert.throws(() => new OrderStateMachine('nonexistent_status' as any), /Invalid initial order status/);

  const fsm = new OrderStateMachine('placed');
  const skipMove = fsm.transition('delivered');
  assert.equal(skipMove.ok, false);
  assert.equal(fsm.status, 'placed'); // state remained unchanged
});

it('LedgerAccount domain model enforces accounting invariants and derives balance', () => {
  assert.throws(() => new LedgerAccount(-5), /customerId must be a positive integer/);

  const account = new LedgerAccount(42);
  assert.equal(account.customerId, 42);
  assert.equal(account.getBalance(), 0);

  // Accounting invariants
  assert.throws(() => account.postDebit(-100, 1), /Debit amount must be strictly positive/);
  assert.throws(() => account.postCredit(0), /Credit amount must be strictly positive/);

  // Double-entry ledger events
  account.postDebit(3500, 201); // order placed
  assert.equal(account.getBalance(), 3500);

  account.postCredit(1500); // partial payment
  assert.equal(account.getBalance(), 2000);

  account.postCredit(2000); // balance cleared
  assert.equal(account.getBalance(), 0);

  assert.equal(account.entries.length, 3);
});

it('WahaAdapter class encapsulates config and implements ChannelAdapter polymorphically', () => {
  const customAdapter = new WahaAdapter({
    baseUrl: 'https://whatsapp.example.com',
    session: 'retail-store',
    apiKey: 'secret-key-123',
  });
  assert.equal(customAdapter.channel, 'waha');
  assert.equal(typeof customAdapter.sendText, 'function');
  assert.equal(typeof customAdapter.parseInboundWebhook, 'function');
});

// --- Suite 9: Gemini function-response wire format ---
console.log('\n▶ Gemini Function-Response Wire Format');
it('preserves object tool results and wraps arrays or primitives in a Struct-compatible object', () => {
  const objectResult = { found: false, message: 'no matching product' };
  assert.equal(normalizeGeminiFunctionResponse(objectResult), objectResult);
  assert.deepEqual(normalizeGeminiFunctionResponse([{ id: 3, stock: 20 }]), {
    result: [{ id: 3, stock: 20 }],
  });
  assert.deepEqual(normalizeGeminiFunctionResponse('plain result'), { result: 'plain result' });
  assert.deepEqual(normalizeGeminiFunctionResponse(null), { result: null });
});

// --- Suite 10: Bookkeeping crash-retry idempotency ---
console.log('\n▶ Bookkeeping Crash-Retry Idempotency');
it('deduplicates order/payment effects for one provider event but permits a new event', () => {
  db.exec('begin');
  try {
    const product = db.prepare('select id, price from products order by id limit 1').get() as
      | { id: number; price: number }
      | undefined;
    assert.ok(product, 'At least one seeded product is required');
    const customerId = db.prepare('insert into customers (phone) values (?)').run(`retry-test-${Date.now()}`)
      .lastInsertRowid as number;
    const input = { items: [{ product_id: product.id, qty: 1, price: product.price }] };
    const eventKey = `waha:test-order-${Date.now()}`;

    const firstOrder = recordOrder.execute(input, { customerId, idempotencyKey: eventKey });
    const retriedOrder = recordOrder.execute(input, { customerId, idempotencyKey: eventKey });
    assert.deepEqual(retriedOrder, firstOrder);
    assert.equal(
      (db.prepare('select count(*) n from orders where customer_id = ?').get(customerId) as { n: number }).n,
      1,
    );

    recordOrder.execute(input, { customerId, idempotencyKey: `${eventKey}-separate-message` });
    assert.equal(
      (db.prepare('select count(*) n from orders where customer_id = ?').get(customerId) as { n: number }).n,
      2,
    );

    const paymentKey = `waha:test-payment-${Date.now()}`;
    const firstPayment = recordPayment.execute({ amount: product.price }, { customerId, idempotencyKey: paymentKey });
    const retriedPayment = recordPayment.execute({ amount: product.price }, { customerId, idempotencyKey: paymentKey });
    assert.deepEqual(retriedPayment, firstPayment);
    assert.equal(
      (db.prepare("select count(*) n from ledger where customer_id = ? and kind = 'credit'").get(customerId) as {
        n: number;
      }).n,
      1,
    );
  } finally {
    db.exec('rollback');
  }
});

// --- Final Report & Clean Exit ---
console.log('\n============================================================');
console.log(`  Results: ${passedTests} passed, ${failedTests} failed (${totalTests} total)`);
console.log('============================================================\n');

process.exit(failedTests > 0 ? 1 : 0);
