import assert from 'node:assert/strict';
import { checkOrderStatusTransition, OrderStateMachine, transitionOrderStatus } from '../src/orders';
import { LedgerAccount } from '../src/ledger';
import { checkDiscountRule } from '../src/guardrails/discount-rules';
import { detectHumanPromise } from '../src/guardrails/human-promise';
import { isOwnerPhone } from '../src/owner';
import { parseCatalog, findBestMatch, loadCatalogSections } from '../src/catalog';
import { wahaAdapter, WahaAdapter } from '../src/channel/waha';
import { normalizeGeminiFunctionResponse } from '../src/llm';
import { checkAutomatedCustomerSendAllowed, checkOrderConfirmationReply } from '../src/agent';
import { checkCheckoutCollectionReply, checkCustomerReplyScript } from '../src/customer-reply-safety';
import {
  detectConsentCommand,
  getPendingConsentConfirmations,
  isCustomerOptedOut,
  markConsentConfirmationSent,
  recordConsentCommand,
} from '../src/consent';
import { db } from '../src/db';
import {
  baseTools,
  checkStock,
  confirmOrder,
  isExplicitOrderConfirmation,
  ownerTools,
  confirmPendingOrderDraft,
  insertValidatedOrder,
  prepareOrder,
  updateOrderStatus,
  validateOrderItems,
} from '../src/tools';
import * as toolExports from '../src/tools';
import { createPaymentClaim, pendingPaymentClaims, resolvePaymentClaim } from '../src/payments';
import { handleOwnerPaymentCommand } from '../src/payment-resolution';
import { minorToRupees, multiplyMinor, positiveRupeesToMinor, rupeesToMinor } from '../src/money';
import {
  buildDeterministicOrderSummary,
  checkDeterministicOrderSummaryReply,
} from '../src/order-summary';
import { importInventoryCsv, parseInventoryCsv } from '../src/inventory';
import {
  claimInboundEvent,
  completeInboundEvent,
  failInboundEvent,
  initializeInboundReplayGuard,
  parseInboundAcceptAfter,
} from '../src/inbound-events';

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

// Books an order through the live two-step path: prepare_order saves a
// server-priced draft on one inbound event, then confirmPendingOrderDraft
// (what confirm_order wraps) books it on a later event with explicit
// confirmation wording.
function bookOrderViaTwoStep(
  customerId: number,
  items: unknown[],
  eventKey: string,
): { ok: boolean; order_id?: number; total?: number; already_confirmed?: boolean; error?: string } {
  const prepared = prepareOrder.execute({
    items,
    recipient_name: 'Test Customer',
    contact_phone: '03120000000',
    delivery_address: 'House 1, Main Road, Sector F',
    city: 'Islamabad',
    payment_method: 'cash on delivery',
  }, { customerId, idempotencyKey: `${eventKey}:prepare-event` }) as { ok: boolean; error?: string };
  if (!prepared.ok) return prepared;
  return confirmPendingOrderDraft({
    customerId,
    idempotencyKey: `${eventKey}:confirm-event`,
    inboundText: 'Confirm order',
  }) as { ok: boolean; order_id?: number; total?: number };
}

// Creates a 'placed' order through the same domain functions the booking
// path uses (server pricing + order/debit/initial-audit insert), for tests
// that need to walk the FSM from 'placed'.
function placeOrderForTest(customerId: number, items: unknown[], idempotencyKey?: string): number {
  const check = validateOrderItems(items);
  if (!check.ok) throw new Error(check.error);
  return insertValidatedOrder(customerId, check.items, check.totalMinor, {
    actorType: 'customer',
    actorCustomerId: customerId,
    source: idempotencyKey ? 'whatsapp_customer_tool' : 'direct_customer_tool',
    sourceEventKey: idempotencyKey,
    evidence: 'Customer confirmed the order contents before placement.',
  });
}

function exportsAnyToolNamed(name: string): boolean {
  return Object.values(toolExports).some((value: any) =>
    value?.name === name || (Array.isArray(value) && value.some((tool: any) => tool?.name === name)));
}

console.log('\n============================================================');
console.log("       Ahmed's Assistant — Comprehensive Test Suite         ");
console.log('============================================================\n');

// --- Suite 0: Exact Money Boundaries ---
console.log('▶ Exact Money Boundaries');
it('converts rupees to exact integer paisas and back', () => {
  assert.equal(rupeesToMinor(0), 0);
  assert.equal(rupeesToMinor(10.29), 1029);
  assert.equal(rupeesToMinor(800), 80000);
  assert.equal(minorToRupees(1029), 10.29);
  assert.equal(positiveRupeesToMinor(0.01), 1);
});

it('rejects invalid, negative, over-precise, zero-positive, and unsafe money values', () => {
  assert.throws(() => rupeesToMinor(Number.NaN), /finite non-negative/);
  assert.throws(() => rupeesToMinor(Number.POSITIVE_INFINITY), /finite non-negative/);
  assert.throws(() => rupeesToMinor(-1), /finite non-negative/);
  assert.throws(() => rupeesToMinor(10.001), /at most two decimal places/);
  assert.throws(() => positiveRupeesToMinor(0), /greater than 0/);
  assert.throws(() => minorToRupees(1.5), /safe integer/);
  assert.throws(() => rupeesToMinor(Number.MAX_SAFE_INTEGER), /at most two decimal places/);
});

it('multiplies prices in minor units without floating-point drift', () => {
  const totalMinor = multiplyMinor(rupeesToMinor(10.29), 3);
  assert.equal(totalMinor, 3087);
  assert.equal(minorToRupees(totalMinor), 30.87);
});

it('database constraints reject fractional paisas in every financial table', () => {
  db.exec('begin');
  try {
    const customerId = db.prepare('insert into customers (phone) values (?)').run(`minor-check-${Date.now()}`).lastInsertRowid;
    assert.throws(
      () => db.prepare('insert into products (name, price_minor, stock) values (?, ?, ?)').run('fractional product', 10.5, 1),
      /CHECK constraint failed/,
    );
    assert.throws(
      () => db.prepare("insert into orders (customer_id, items_json, total_minor, status) values (?, '[]', ?, 'placed')").run(customerId, 10.5),
      /CHECK constraint failed/,
    );
    assert.throws(
      () => db.prepare("insert into ledger (customer_id, kind, amount_minor) values (?, 'debit', ?)").run(customerId, 10.5),
      /CHECK constraint failed/,
    );
    assert.throws(
      () => db.prepare('insert into payment_claims (customer_id, amount_minor) values (?, ?)').run(customerId, 10.5),
      /CHECK constraint failed/,
    );
  } finally {
    db.exec('rollback');
  }
});

// --- Suite 0B: CSV Inventory Onboarding ---
console.log('\n▶ CSV Inventory Onboarding');
it('parses quoted CSV fields, exact prices, aliases, and normalized sizes', () => {
  const rows = parseInventoryCsv(
    'sku,name,category,size,color,price,stock,active,aliases\n' +
      'TEST-CSV-1,"Shirt, Casual",shirts,M,Navy,10.29,3,yes,"shirt|tee"\n',
  );
  assert.deepEqual(rows, [{
    sku: 'TEST-CSV-1',
    name: 'Shirt, Casual',
    category: 'shirts',
    size: 'medium',
    color: 'navy',
    priceMinor: 1029,
    stock: 3,
    active: true,
    aliases: ['shirt', 'tee'],
    imageFilename: null,
  }]);
  assert.throws(
    () => parseInventoryCsv('sku,name,category,size,color,price,stock,active,aliases\nTEST-2,"Broken"text,shirts,M,black,1,1,true,\n'),
    /Unexpected text after a closing quote/,
  );
});

it('database constraints reject invalid SKU, active state, and alias JSON', () => {
  db.exec('begin');
  try {
    assert.throws(
      () => db.prepare('insert into products (sku, name, price_minor, stock) values (?, ?, ?, ?)').run('X', 'bad sku', 100, 1),
      /product sku must contain|CHECK constraint failed/,
    );
    assert.throws(
      () => db.prepare('insert into products (sku, name, price_minor, stock, active) values (?, ?, ?, ?, ?)').run(`ACTIVE-${Date.now()}`, 'bad active', 100, 1, 2),
      /CHECK constraint failed/,
    );
    assert.throws(
      () => db.prepare('insert into products (sku, name, price_minor, stock, aliases_json) values (?, ?, ?, ?, ?)').run(`ALIAS-${Date.now()}`, 'bad aliases', 100, 1, '{}'),
      /CHECK constraint failed/,
    );
  } finally {
    db.exec('rollback');
  }
});

it('rejects the complete CSV before writing when any row is invalid', () => {
  const sku = `ATOMIC-${Date.now()}`;
  const before = (db.prepare('select count(*) n from products where sku = ?').get(sku) as { n: number }).n;
  const csv =
    'sku,name,category,size,color,price,stock,active,aliases\n' +
    `${sku},Valid Shirt,shirts,M,black,2500,2,true,shirt\n` +
    `BROKEN-${Date.now()},Broken Shirt,shirts,M,black,25.001,2,true,shirt\n`;
  assert.throws(() => importInventoryCsv(csv, true), /price must be/);
  assert.equal((db.prepare('select count(*) n from products where sku = ?').get(sku) as { n: number }).n, before);
});

it('previews safely, upserts by SKU, searches aliases, and hides inactive products', () => {
  const sku = `UPSERT-${Date.now()}`;
  const header = 'sku,name,category,size,color,price,stock,active,aliases\n';
  try {
    const firstCsv = header + `${sku},Everyday Shirt,shirts,M,navy,2750,4,true,shirt|tee\n`;
    const preview = importInventoryCsv(firstCsv, false);
    assert.equal(preview.applied, false);
    assert.equal(preview.inserted, 1);
    assert.equal(preview.reconciliation.catalogOnlyCategories.includes('product'), false);
    assert.equal((db.prepare('select count(*) n from products where sku = ?').get(sku) as { n: number }).n, 0);

    const first = importInventoryCsv(firstCsv, true);
    assert.deepEqual({ applied: first.applied, inserted: first.inserted, updated: first.updated }, {
      applied: true,
      inserted: 1,
      updated: 0,
    });
    const original = db.prepare('select id, price_minor, stock, created_at, updated_at from products where sku = ?').get(sku) as {
      id: number;
      price_minor: number;
      stock: number;
      created_at: string;
      updated_at: string;
    };
    assert.deepEqual({ price_minor: original.price_minor, stock: original.stock }, { price_minor: 275000, stock: 4 });
    assert.equal(typeof original.created_at, 'string');
    assert.equal(typeof original.updated_at, 'string');

    const aliasResult = checkStock.execute(
      { name: 'tee', size: 'M', color: 'NAVY' },
      { customerId: 1 },
    ) as { ok: boolean; found: boolean; products: Array<{ product_id: number; availability: string }> };
    assert.equal(aliasResult.ok, true);
    assert.equal(aliasResult.found, true);
    assert.equal(aliasResult.products.some((row) => row.product_id === original.id), true);
    assert.equal(aliasResult.products.some((row) => Object.hasOwn(row, 'stock')), false);

    const updatedCsv = header + `${sku},Everyday Shirt,shirts,medium,navy,2800,7,true,shirt|tee\n`;
    const updated = importInventoryCsv(updatedCsv, true);
    assert.equal(updated.inserted, 0);
    assert.equal(updated.updated, 1);
    const replacement = db.prepare('select id, price_minor, stock from products where sku = ?').get(sku) as {
      id: number;
      price_minor: number;
      stock: number;
    };
    assert.deepEqual(replacement, { id: original.id, price_minor: 280000, stock: 7 });

    importInventoryCsv(header + `${sku},Everyday Shirt,shirts,M,navy,2800,7,false,shirt|tee\n`, true);
    const hidden = checkStock.execute({ name: 'tee', size: 'M' }, { customerId: 1 }) as {
      found: boolean;
      products?: Array<{ product_id: number }>;
    };
    assert.equal(hidden.products?.some((row) => row.product_id === original.id) ?? false, false);
  } finally {
    db.prepare('delete from products where sku = ?').run(sku);
  }
});

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

it('preserves WAHA original Unix timestamps for retained-message detection', () => {
  const parsed = wahaAdapter.parseInboundWebhook({
    event: 'message',
    payload: {
      id: 'timestamped-message',
      timestamp: 1_757_865_600.125,
      fromMe: false,
      from: '923332333460@c.us',
      body: 'Fresh message',
    },
  });
  assert.equal(parsed?.occurredAt?.toISOString(), '2025-09-14T16:00:00.125Z');
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
  assert.equal(typeof customAdapter.sendImage, 'function');
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

// --- Suite 10: Server-authoritative order pricing ---
console.log('\n▶ Server-Authoritative Order Pricing');
it('ignores a model-supplied price and records the product database price', () => {
  db.exec('begin');
  try {
    const customerId = db.prepare('insert into customers (phone) values (?)').run(`price-test-${Date.now()}`)
      .lastInsertRowid as number;
    const productId = db
      .prepare('insert into products (name, size, color, price_minor, stock) values (?, ?, ?, ?, ?)')
      .run(`server-priced-kurta-${Date.now()}`, 'medium', 'black', rupeesToMinor(3200), 5).lastInsertRowid as number;

    // `price` is deliberately malicious extra input. The tool schema no longer
    // advertises it, and server validation must ignore it even if a caller
    // bypasses the schema and invokes the tool directly.
    const result = bookOrderViaTwoStep(
      customerId,
      [{ product_id: productId, qty: 2, price: 1 }],
      `price-test-event-${Date.now()}`,
    );

    assert.equal(result.ok, true);
    assert.equal(result.total, 6400);
    const order = db.prepare('select items_json, total_minor from orders where id = ?').get(result.order_id) as {
      items_json: string;
      total_minor: number;
    };
    assert.equal(order.total_minor, rupeesToMinor(6400));
    assert.deepEqual(JSON.parse(order.items_json), [{ product_id: productId, qty: 2, price_minor: rupeesToMinor(3200) }]);
    const debit = db
      .prepare("select amount_minor from ledger where order_id = ? and kind = 'debit'")
      .get(result.order_id) as { amount_minor: number };
    assert.equal(debit.amount_minor, rupeesToMinor(6400));

    db.prepare('update products set price_minor = ? where id = ?').run(rupeesToMinor(4100), productId);
    const preserved = db.prepare('select items_json, total_minor from orders where id = ?').get(result.order_id) as {
      items_json: string;
      total_minor: number;
    };
    assert.equal(preserved.total_minor, rupeesToMinor(6400));
    assert.deepEqual(JSON.parse(preserved.items_json), [{ product_id: productId, qty: 2, price_minor: rupeesToMinor(3200) }]);
  } finally {
    db.exec('rollback');
  }
});

it('records an order when the model supplies only product_id and quantity', () => {
  db.exec('begin');
  try {
    const customerId = db.prepare('insert into customers (phone) values (?)').run(`price-shape-${Date.now()}`)
      .lastInsertRowid as number;
    const productId = db
      .prepare('insert into products (name, size, color, price_minor, stock) values (?, ?, ?, ?, ?)')
      .run(`server-priced-shirt-${Date.now()}`, 'large', 'navy', rupeesToMinor(2750), 3).lastInsertRowid as number;
    const result = bookOrderViaTwoStep(customerId, [{ product_id: productId, qty: 1 }], `price-shape-${Date.now()}`);
    assert.equal(result.ok, true);
    assert.equal(typeof result.order_id, 'number');
    assert.equal(result.total, 2750);
  } finally {
    db.exec('rollback');
  }
});

// --- Suite 11: Bookkeeping crash-retry idempotency ---
console.log('\n▶ Bookkeeping Crash-Retry Idempotency');
it('deduplicates order/payment effects for one provider event but permits a new event', () => {
  db.exec('begin');
  try {
    const productPriceMinor = rupeesToMinor(1800);
    const productId = Number(db.prepare(
      'insert into products (name, size, color, price_minor, stock) values (?, ?, ?, ?, ?)',
    ).run(`retry-product-${Date.now()}`, 'medium', 'navy', productPriceMinor, 5).lastInsertRowid);
    const product = { id: productId, price_minor: productPriceMinor };
    const customerId = db.prepare('insert into customers (phone) values (?)').run(`retry-test-${Date.now()}`)
      .lastInsertRowid as number;
    const items = [{ product_id: product.id, qty: 1 }];
    const eventKey = `waha:test-order-${Date.now()}`;

    const firstOrder = bookOrderViaTwoStep(customerId, items, eventKey);
    assert.equal(firstOrder.ok, true);
    // WAHA redelivers the same confirmation event after a crash.
    const retriedOrder = confirmPendingOrderDraft({
      customerId,
      idempotencyKey: `${eventKey}:confirm-event`,
      inboundText: 'Confirm order',
    }) as { ok: boolean; order_id?: number; already_confirmed?: boolean };
    assert.equal(retriedOrder.ok, true);
    assert.equal(retriedOrder.order_id, firstOrder.order_id);
    assert.equal(retriedOrder.already_confirmed, true);
    assert.equal(
      (db.prepare('select count(*) n from orders where customer_id = ?').get(customerId) as { n: number }).n,
      1,
    );
    assert.equal(
      (db.prepare("select count(*) n from ledger where customer_id = ? and kind = 'debit'").get(customerId) as { n: number }).n,
      1,
    );

    assert.equal(bookOrderViaTwoStep(customerId, items, `${eventKey}-separate-message`).ok, true);
    assert.equal(
      (db.prepare('select count(*) n from orders where customer_id = ?').get(customerId) as { n: number }).n,
      2,
    );

    // Payments: a customer can only create a claim (keyed per provider event,
    // exactly as claim_payment does); the ledger credit is written once, on
    // owner approval, and neither a redelivered claim event nor a redelivered
    // owner confirmation duplicates it.
    const ownerId = db.prepare('insert into customers (phone) values (?)').run(`retry-owner-${Date.now()}`)
      .lastInsertRowid as number;
    const paymentKey = `waha:test-payment-${Date.now()}:payment_claim`;
    const paymentRupees = minorToRupees(product.price_minor);
    const firstPayment = createPaymentClaim({ customerId, amount: paymentRupees, eventKey: paymentKey });
    const retriedPayment = createPaymentClaim({ customerId, amount: paymentRupees, eventKey: paymentKey });
    assert.deepEqual(retriedPayment, firstPayment);
    assert.equal(
      (db.prepare("select count(*) n from ledger where customer_id = ? and kind = 'credit'").get(customerId) as {
        n: number;
      }).n,
      0,
    );
    const verifiedRef = `EP-RETRY-${Date.now()}`;
    assert.equal(handleOwnerPaymentCommand({
      ownerCustomerId: ownerId,
      text: `APPROVE CLAIM ${firstPayment.id} REF ${verifiedRef}`,
      eventKey: `${paymentKey}:owner-prepare`,
    }).mutation, 'none');
    const ownerConfirm = {
      ownerCustomerId: ownerId,
      text: `CONFIRM APPROVE CLAIM ${firstPayment.id} REF ${verifiedRef}`,
      eventKey: `${paymentKey}:owner-confirm`,
    };
    assert.equal(handleOwnerPaymentCommand(ownerConfirm).mutation, 'approved');
    assert.equal(handleOwnerPaymentCommand(ownerConfirm).mutation, 'none');
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

// --- Suite 12: Inbound webhook replay protection ---
console.log('\n▶ Inbound Webhook Replay Protection');
it('requires an unambiguous timezone on configured rollout cutoffs', () => {
  assert.equal(parseInboundAcceptAfter(undefined), null);
  assert.equal(parseInboundAcceptAfter(''), null);
  assert.equal(
    parseInboundAcceptAfter('2026-09-27T19:00:00+05:00')?.toISOString(),
    '2026-09-27T14:00:00.000Z',
  );
  assert.throws(() => parseInboundAcceptAfter('2026-09-27T19:00:00'), /explicit UTC offset/);
  assert.throws(() => parseInboundAcceptAfter('not-a-date'), /explicit UTC offset/);
});

it('advances the durable cutoff on restart and never moves it backward', () => {
  db.exec('begin');
  try {
    db.prepare('delete from inbound_guard_state').run();
    const first = initializeInboundReplayGuard(
      new Date('2026-09-27T14:00:00.987Z'),
      '2026-09-27T19:00:00+05:00',
    );
    const afterRestart = initializeInboundReplayGuard(
      new Date('2026-10-01T10:00:00.000Z'),
      '2026-10-01T15:00:00+05:00',
    );
    assert.equal(first.toISOString(), '2026-09-27T14:00:00.000Z');
    assert.equal(afterRestart.toISOString(), '2026-10-01T10:00:00.000Z');
    const clockMovedBackward = initializeInboundReplayGuard(
      new Date('2026-09-30T10:00:00.000Z'),
      undefined,
    );
    assert.equal(clockMovedBackward.toISOString(), afterRestart.toISOString());
  } finally {
    db.exec('rollback');
  }
});

it('accepts a fresh message once and deduplicates it before either agent path', () => {
  const suffix = `${Date.now()}-fresh`;
  const messageId = `inbound-test-${suffix}`;
  const eventKey = `waha:${messageId}`;
  try {
    const first = claimInboundEvent({
      channel: 'waha',
      messageId,
      occurredAt: new Date('2026-09-27T14:00:01.000Z'),
      acceptAfter: new Date('2026-09-27T14:00:00.000Z'),
      now: new Date('2026-09-27T14:00:02.000Z'),
    });
    assert.deepEqual(first, { action: 'process', eventKey, reason: 'new' });
    completeInboundEvent(eventKey, new Date('2026-09-27T14:00:03.000Z'));
    assert.deepEqual(
      claimInboundEvent({
        channel: 'waha',
        messageId,
        occurredAt: new Date('2026-09-27T14:00:01.000Z'),
        acceptAfter: new Date('2026-09-27T14:00:00.000Z'),
        now: new Date('2026-09-27T14:00:04.000Z'),
      }),
      { action: 'duplicate', eventKey, reason: 'completed' },
    );
  } finally {
    db.prepare('delete from inbound_events where event_key = ?').run(eventKey);
  }
});

it('quarantines retained history and remembers the ignored id', () => {
  const messageId = `inbound-test-${Date.now()}-historical`;
  const eventKey = `waha:${messageId}`;
  const input = {
    channel: 'waha',
    messageId,
    occurredAt: new Date('2026-09-27T13:59:59.000Z'),
    acceptAfter: new Date('2026-09-27T14:00:00.000Z'),
    now: new Date('2026-09-27T14:00:02.000Z'),
  };
  try {
    assert.deepEqual(claimInboundEvent(input), { action: 'ignore', eventKey, reason: 'historical' });
    assert.deepEqual(claimInboundEvent(input), { action: 'duplicate', eventKey, reason: 'ignored' });
  } finally {
    db.prepare('delete from inbound_events where event_key = ?').run(eventKey);
  }
});

it('fails closed when message identity or provider timestamp is missing', () => {
  const cutoff = new Date('2026-09-27T14:00:00.000Z');
  assert.deepEqual(
    claimInboundEvent({ channel: 'waha', occurredAt: cutoff, acceptAfter: cutoff, now: cutoff }),
    { action: 'ignore', reason: 'missing_message_id' },
  );
  assert.deepEqual(
    claimInboundEvent({ channel: 'waha', messageId: 'no-time', acceptAfter: cutoff, now: cutoff }),
    { action: 'ignore', eventKey: 'waha:no-time', reason: 'missing_timestamp' },
  );
});

it('allows a failed turn to retry but blocks a concurrent in-progress duplicate', () => {
  const messageId = `inbound-test-${Date.now()}-retry`;
  const eventKey = `waha:${messageId}`;
  const input = {
    channel: 'waha',
    messageId,
    occurredAt: new Date('2026-09-27T14:00:01.000Z'),
    acceptAfter: new Date('2026-09-27T14:00:00.000Z'),
    now: new Date('2026-09-27T14:00:02.000Z'),
  };
  try {
    assert.equal(claimInboundEvent(input).action, 'process');
    assert.deepEqual(claimInboundEvent(input), { action: 'duplicate', eventKey, reason: 'processing' });
    failInboundEvent(eventKey, new Error('transient model failure'), new Date('2026-09-27T14:00:03.000Z'));
    assert.deepEqual(
      claimInboundEvent({ ...input, now: new Date('2026-09-27T14:00:04.000Z') }),
      { action: 'process', eventKey, reason: 'retry' },
    );
  } finally {
    db.prepare('delete from inbound_events where event_key = ?').run(eventKey);
  }
});

it('does not retry a failed event that became historical across a restart', () => {
  const messageId = `inbound-test-${Date.now()}-offline`;
  const eventKey = `waha:${messageId}`;
  const occurredAt = new Date('2026-09-27T14:00:01.000Z');
  try {
    assert.equal(claimInboundEvent({
      channel: 'waha', messageId, occurredAt,
      acceptAfter: new Date('2026-09-27T14:00:00.000Z'),
      now: new Date('2026-09-27T14:00:02.000Z'),
    }).action, 'process');
    failInboundEvent(eventKey, new Error('process stopped'));
    assert.deepEqual(claimInboundEvent({
      channel: 'waha', messageId, occurredAt,
      acceptAfter: new Date('2026-09-29T04:18:51.000Z'),
      now: new Date('2026-09-29T04:18:52.000Z'),
    }), { action: 'ignore', eventKey, reason: 'historical' });
  } finally {
    db.prepare('delete from inbound_events where event_key = ?').run(eventKey);
  }
});

// --- Suite 13: Atomic stock reservation ---
console.log('\n▶ Atomic Stock Reservation');
const customerAudit = (customerId: number, evidence = 'Deterministic customer transition test.') => ({
  actorType: 'customer' as const,
  actorCustomerId: customerId,
  source: 'deterministic_test',
  evidence,
});

it('rejects an over-stock confirmation without changing status, stock, or ledger', () => {
  db.exec('begin');
  try {
    const customerId = db.prepare('insert into customers (phone) values (?)').run(`stock-limit-${Date.now()}`)
      .lastInsertRowid as number;
    const productId = db.prepare(
      'insert into products (name, size, color, price_minor, stock) values (?, ?, ?, ?, ?)',
    ).run('atomic-kurta', 'medium', 'black', rupeesToMinor(3200), 1).lastInsertRowid as number;
    const orderId = db.prepare(
      "insert into orders (customer_id, items_json, total_minor, status) values (?, ?, ?, 'placed')",
    ).run(customerId, JSON.stringify([{ product_id: productId, qty: 2, price_minor: rupeesToMinor(3200) }]), rupeesToMinor(6400))
      .lastInsertRowid as number;
    db.prepare("insert into ledger (customer_id, order_id, kind, amount_minor) values (?, ?, 'debit', ?)")
      .run(customerId, orderId, rupeesToMinor(6400));

    const beforeLedger = (db.prepare('select count(*) n from ledger where order_id = ?').get(orderId) as { n: number }).n;
    const result = transitionOrderStatus(orderId, 'confirmed', customerAudit(customerId));
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.match(result.error, /requested quantity \(2\) cannot currently be fulfilled/i);
      assert.doesNotMatch(result.error, /available 1/i);
    }
    assert.equal((db.prepare('select status from orders where id = ?').get(orderId) as { status: string }).status, 'placed');
    assert.equal((db.prepare('select stock from products where id = ?').get(productId) as { stock: number }).stock, 1);
    assert.equal(
      (db.prepare('select count(*) n from ledger where order_id = ?').get(orderId) as { n: number }).n,
      beforeLedger,
    );
  } finally {
    db.exec('rollback');
  }
});

it('allows exactly one of two competing orders to reserve the final unit', () => {
  db.exec('begin');
  try {
    const customerId = db.prepare('insert into customers (phone) values (?)').run(`stock-race-${Date.now()}`)
      .lastInsertRowid as number;
    const productId = db.prepare(
      'insert into products (name, size, color, price_minor, stock) values (?, ?, ?, ?, ?)',
    ).run('last-unit-shirt', 'large', 'navy', rupeesToMinor(2500), 1).lastInsertRowid as number;
    const insertOrder = db.prepare(
      "insert into orders (customer_id, items_json, total_minor, status) values (?, ?, ?, 'placed')",
    );
    const items = JSON.stringify([{ product_id: productId, qty: 1, price_minor: rupeesToMinor(2500) }]);
    const firstId = insertOrder.run(customerId, items, rupeesToMinor(2500)).lastInsertRowid as number;
    const secondId = insertOrder.run(customerId, items, rupeesToMinor(2500)).lastInsertRowid as number;

    assert.equal(transitionOrderStatus(firstId, 'confirmed', customerAudit(customerId)).ok, true);
    assert.equal(transitionOrderStatus(secondId, 'confirmed', customerAudit(customerId)).ok, false);
    assert.equal((db.prepare('select stock from products where id = ?').get(productId) as { stock: number }).stock, 0);
    const statuses = db.prepare('select id, status from orders where id in (?, ?) order by id').all(firstId, secondId) as {
      id: number;
      status: string;
    }[];
    assert.deepEqual(statuses.map((row) => row.status), ['confirmed', 'placed']);
  } finally {
    db.exec('rollback');
  }
});

it('rolls back earlier item reservations when a later item is unavailable', () => {
  db.exec('begin');
  try {
    const customerId = db.prepare('insert into customers (phone) values (?)').run(`stock-rollback-${Date.now()}`)
      .lastInsertRowid as number;
    const availableId = db.prepare(
      'insert into products (name, size, color, price_minor, stock) values (?, ?, ?, ?, ?)',
    ).run('available-item', 'medium', 'black', rupeesToMinor(1000), 2).lastInsertRowid as number;
    const unavailableId = db.prepare(
      'insert into products (name, size, color, price_minor, stock) values (?, ?, ?, ?, ?)',
    ).run('unavailable-item', 'medium', 'white', rupeesToMinor(1000), 0).lastInsertRowid as number;
    const orderId = db.prepare(
      "insert into orders (customer_id, items_json, total_minor, status) values (?, ?, ?, 'placed')",
    ).run(customerId, JSON.stringify([
      { product_id: availableId, qty: 1, price_minor: rupeesToMinor(1000) },
      { product_id: unavailableId, qty: 1, price_minor: rupeesToMinor(1000) },
    ]), rupeesToMinor(2000)).lastInsertRowid as number;

    assert.equal(transitionOrderStatus(orderId, 'confirmed', customerAudit(customerId)).ok, false);
    assert.equal((db.prepare('select stock from products where id = ?').get(availableId) as { stock: number }).stock, 2);
    assert.equal((db.prepare('select stock from products where id = ?').get(unavailableId) as { stock: number }).stock, 0);
    assert.equal((db.prepare('select status from orders where id = ?').get(orderId) as { status: string }).status, 'placed');
  } finally {
    db.exec('rollback');
  }
});

it('database backstop rejects a direct negative-stock write', () => {
  db.exec('begin');
  try {
    const productId = db.prepare(
      'insert into products (name, size, color, price_minor, stock) values (?, ?, ?, ?, ?)',
    ).run('stock-trigger-item', 'small', 'grey', rupeesToMinor(500), 0).lastInsertRowid as number;
    assert.throws(
      () => db.prepare('update products set stock = -1 where id = ?').run(productId),
      /product stock cannot be negative/,
    );
    assert.equal((db.prepare('select stock from products where id = ?').get(productId) as { stock: number }).stock, 0);
  } finally {
    db.exec('rollback');
  }
});

it('rolls back cancellation status and stock when its ledger reversal fails', () => {
  db.exec('begin');
  try {
    const customerId = db.prepare('insert into customers (phone) values (?)').run(`cancel-rollback-${Date.now()}`)
      .lastInsertRowid as number;
    const productId = db.prepare(
      'insert into products (name, size, color, price_minor, stock) values (?, ?, ?, ?, ?)',
    ).run('cancel-rollback-item', 'medium', 'black', rupeesToMinor(1200), 3).lastInsertRowid as number;
    const orderId = db.prepare(
      "insert into orders (customer_id, items_json, total_minor, status) values (?, ?, ?, 'placed')",
    ).run(customerId, JSON.stringify([{ product_id: productId, qty: 1, price_minor: rupeesToMinor(1200) }]), rupeesToMinor(1200))
      .lastInsertRowid as number;
    db.prepare("insert into ledger (customer_id, order_id, kind, amount_minor) values (?, ?, 'debit', ?)")
      .run(customerId, orderId, rupeesToMinor(1200));
    assert.equal(transitionOrderStatus(orderId, 'confirmed', customerAudit(customerId)).ok, true);
    assert.equal((db.prepare('select stock from products where id = ?').get(productId) as { stock: number }).stock, 2);

    db.exec(`
      create trigger test_reject_cancellation_credit
      before insert on ledger
      when new.kind = 'credit' and new.order_id = ${orderId}
      begin
        select raise(abort, 'simulated ledger failure');
      end;
    `);
    const result = transitionOrderStatus(orderId, 'cancelled', customerAudit(customerId));
    assert.equal(result.ok, false);
    assert.equal((db.prepare('select status from orders where id = ?').get(orderId) as { status: string }).status, 'confirmed');
    assert.equal((db.prepare('select stock from products where id = ?').get(productId) as { stock: number }).stock, 2);
    assert.equal(
      (db.prepare("select count(*) n from ledger where order_id = ? and kind = 'credit'").get(orderId) as { n: number }).n,
      0,
    );
  } finally {
    db.exec('rollback');
  }
});

// --- Suite 14: Order status authority and audit history ---
console.log('\n▶ Order Status Authority & Audit History');
it('fails closed without audit context and enforces actor-specific transition authority', () => {
  db.exec('begin');
  try {
    const customerId = db.prepare('insert into customers (phone) values (?)').run(`audit-customer-${Date.now()}`)
      .lastInsertRowid as number;
    const otherCustomerId = db.prepare('insert into customers (phone) values (?)').run(`audit-other-${Date.now()}`)
      .lastInsertRowid as number;
    const productId = db.prepare(
      'insert into products (name, size, color, price_minor, stock) values (?, ?, ?, ?, ?)',
    ).run('audit-shirt', 'medium', 'navy', rupeesToMinor(1000), 5).lastInsertRowid as number;
    const order = { order_id: placeOrderForTest(customerId, [{ product_id: productId, qty: 1 }], `waha:audit-create-${Date.now()}`) };

    const creation = db.prepare('select * from order_status_events where order_id = ?').get(order.order_id) as {
      from_status: string | null;
      to_status: string;
      actor_type: string;
      actor_customer_id: number;
      source: string;
      source_event_key: string;
      evidence: string;
    };
    assert.equal(creation.from_status, null);
    assert.equal(creation.to_status, 'placed');
    assert.equal(creation.actor_type, 'customer');
    assert.equal(creation.actor_customer_id, customerId);
    assert.equal(creation.source, 'whatsapp_customer_tool');
    assert.match(creation.evidence, /confirmed the order contents/i);

    const missingAudit = (transitionOrderStatus as any)(order.order_id, 'confirmed') as { ok: boolean; error: string };
    assert.equal(missingAudit.ok, false);
    assert.match(missingAudit.error, /actor is required/i);
    const wrongCustomer = transitionOrderStatus(order.order_id, 'confirmed', customerAudit(otherCustomerId));
    assert.equal(wrongCustomer.ok, false);
    const providerConfirm = transitionOrderStatus(order.order_id, 'confirmed', {
      actorType: 'payment_provider',
      source: 'provider_webhook',
      sourceEventKey: 'provider-confirm-forbidden',
      evidence: 'Provider event cannot confirm merchandise selection.',
    });
    assert.equal(providerConfirm.ok, false);
    const systemConfirm = transitionOrderStatus(order.order_id, 'confirmed', {
      actorType: 'system',
      source: 'background_worker',
      evidence: 'A background worker attempted an unauthorized transition.',
    });
    assert.equal(systemConfirm.ok, false);
    assert.equal((db.prepare('select status from orders where id = ?').get(order.order_id) as { status: string }).status, 'placed');
    assert.equal((db.prepare('select count(*) n from order_status_events where order_id = ?').get(order.order_id) as { n: number }).n, 1);
  } finally {
    db.exec('rollback');
  }
});

it('records every permitted actor transition with source and evidence', () => {
  db.exec('begin');
  try {
    const customerId = db.prepare('insert into customers (phone) values (?)').run(`audit-chain-${Date.now()}`)
      .lastInsertRowid as number;
    const productId = db.prepare(
      'insert into products (name, size, color, price_minor, stock) values (?, ?, ?, ?, ?)',
    ).run('audit-kurta', 'large', 'black', rupeesToMinor(2000), 2).lastInsertRowid as number;
    const order = { order_id: placeOrderForTest(customerId, [{ product_id: productId, qty: 1 }], `waha:audit-chain-${Date.now()}`) };
    assert.equal(transitionOrderStatus(order.order_id, 'confirmed', customerAudit(customerId, 'Customer confirmed order.')).ok, true);
    const providerWithoutEventKey = transitionOrderStatus(order.order_id, 'paid', {
      actorType: 'payment_provider',
      source: 'easypaisa_webhook',
      evidence: 'Unidentifiable provider event.',
    });
    assert.equal(providerWithoutEventKey.ok, false);
    assert.equal(transitionOrderStatus(order.order_id, 'paid', {
      actorType: 'payment_provider',
      source: 'easypaisa_webhook',
      sourceEventKey: 'EP-AUDIT-1',
      evidence: 'Verified provider settlement event.',
    }).ok, true);
    assert.equal(transitionOrderStatus(order.order_id, 'shipped', {
      actorType: 'courier',
      source: 'courier_webhook',
      sourceEventKey: 'SHIP-AUDIT-1',
      evidence: 'Courier accepted parcel and issued tracking.',
    }).ok, true);
    assert.equal(transitionOrderStatus(order.order_id, 'delivered', {
      actorType: 'courier',
      source: 'courier_webhook',
      sourceEventKey: 'DELIVERY-AUDIT-1',
      evidence: 'Courier delivery confirmation event.',
    }).ok, true);

    const events = db.prepare(`
      select from_status, to_status, actor_type, source, source_event_key, evidence
      from order_status_events where order_id = ? order by id
    `).all(order.order_id) as Array<{ from_status: string | null; to_status: string; actor_type: string; source: string; source_event_key: string | null; evidence: string }>;
    assert.deepEqual(events.map((event) => event.to_status), ['placed', 'confirmed', 'paid', 'shipped', 'delivered']);
    assert.deepEqual(events.map((event) => event.actor_type), ['customer', 'customer', 'payment_provider', 'courier', 'courier']);
    assert.ok(events.every((event) => event.source.length > 0 && event.evidence.length > 0));
  } finally {
    db.exec('rollback');
  }
});

it('rolls back status and stock when the audit event cannot be written', () => {
  db.exec('begin');
  try {
    const customerId = db.prepare('insert into customers (phone) values (?)').run(`audit-rollback-${Date.now()}`)
      .lastInsertRowid as number;
    const productId = db.prepare(
      'insert into products (name, size, color, price_minor, stock) values (?, ?, ?, ?, ?)',
    ).run('audit-rollback-shirt', 'small', 'white', rupeesToMinor(900), 1).lastInsertRowid as number;
    const orderId = db.prepare(
      "insert into orders (customer_id, items_json, total_minor, status) values (?, ?, ?, 'placed')",
    ).run(customerId, JSON.stringify([{ product_id: productId, qty: 1, price_minor: rupeesToMinor(900) }]), rupeesToMinor(900)).lastInsertRowid as number;
    db.exec(`
      create trigger test_reject_order_status_audit
      before insert on order_status_events
      when new.order_id = ${orderId}
      begin
        select raise(abort, 'simulated audit failure');
      end;
    `);

    const result = transitionOrderStatus(orderId, 'confirmed', customerAudit(customerId));
    assert.equal(result.ok, false);
    assert.equal((db.prepare('select status from orders where id = ?').get(orderId) as { status: string }).status, 'placed');
    assert.equal((db.prepare('select stock from products where id = ?').get(productId) as { stock: number }).stock, 1);
    assert.equal((db.prepare('select count(*) n from order_status_events where order_id = ?').get(orderId) as { n: number }).n, 0);
  } finally {
    db.exec('rollback');
  }
});

it('rolls back order and debit when the initial audit event cannot be written', () => {
  db.exec('begin');
  try {
    const customerId = db.prepare('insert into customers (phone) values (?)').run(`audit-create-rollback-${Date.now()}`)
      .lastInsertRowid as number;
    const productId = db.prepare(
      'insert into products (name, size, color, price_minor, stock) values (?, ?, ?, ?, ?)',
    ).run('audit-create-rollback', 'medium', 'grey', rupeesToMinor(1100), 2).lastInsertRowid as number;
    db.exec(`
      create trigger test_reject_initial_order_audit
      before insert on order_status_events
      when new.source = 'whatsapp_fulfillment_confirmation' and new.from_status is null
      begin
        select raise(abort, 'simulated initial audit failure');
      end;
    `);
    const beforeOrders = (db.prepare('select count(*) n from orders where customer_id = ?').get(customerId) as { n: number }).n;
    const result = bookOrderViaTwoStep(customerId, [{ product_id: productId, qty: 1 }], `audit-create-rollback-${Date.now()}`);
    assert.equal(result.ok, false);
    assert.equal((db.prepare('select stock from products where id = ?').get(productId) as { stock: number }).stock, 2);
    assert.equal((db.prepare('select count(*) n from orders where customer_id = ?').get(customerId) as { n: number }).n, beforeOrders);
    assert.equal((db.prepare('select count(*) n from ledger where customer_id = ?').get(customerId) as { n: number }).n, 0);
  } finally {
    db.exec('rollback');
  }
});

// --- Suite 15: Trusted payment claims ---
console.log('\n▶ Trusted Payment Claims');
it('exposes claims—not verified-payment mutation—to customers and keeps resolution owner-only', () => {
  assert.equal(baseTools.some((tool) => tool.name === 'record_payment'), false);
  assert.equal(ownerTools.some((tool) => tool.name === 'record_payment'), false);
  assert.equal(exportsAnyToolNamed('record_payment'), false);
  assert.equal(baseTools.some((tool) => tool.name === 'claim_payment'), true);
  assert.equal(baseTools.some((tool) => tool.name === 'resolve_payment_claim'), false);
  assert.equal(ownerTools.some((tool) => tool.name === 'pending_payment_claims'), true);
  assert.equal(ownerTools.some((tool) => tool.name === 'resolve_payment_claim'), false);
});

it('records a customer payment statement as one pending claim without crediting the ledger', () => {
  db.exec('begin');
  try {
    const customerId = db.prepare('insert into customers (phone) values (?)').run(`payment-claim-${Date.now()}`)
      .lastInsertRowid as number;
    const eventKey = `waha:payment-claim-${Date.now()}:payment_claim`;
    const first = createPaymentClaim({ customerId, amount: 800, method: 'Easypaisa', eventKey });
    const retry = createPaymentClaim({ customerId, amount: 800, method: 'Easypaisa', eventKey });
    assert.equal(first.id, retry.id);
    assert.equal(first.status, 'pending');
    assert.equal(
      (db.prepare("select count(*) n from ledger where customer_id = ? and kind = 'credit'").get(customerId) as { n: number }).n,
      0,
    );
  } finally {
    db.exec('rollback');
  }
});

it('prevents the customer status tool from marking orders paid, shipped, or delivered', () => {
  db.exec('begin');
  try {
    const customerId = db.prepare('insert into customers (phone) values (?)').run(`payment-permission-${Date.now()}`)
      .lastInsertRowid as number;
    const orderId = db.prepare(
      "insert into orders (customer_id, items_json, total_minor, status) values (?, '[]', ?, 'confirmed')",
    ).run(customerId, rupeesToMinor(800)).lastInsertRowid as number;
    const orderReference = (db.prepare('select public_ref from orders where id = ?').get(orderId) as { public_ref: string }).public_ref;
    for (const status of ['paid', 'shipped', 'delivered']) {
      const result = updateOrderStatus.execute({ order_reference: orderReference, status }, { customerId }) as {
        ok: boolean;
        error?: string;
      };
      assert.equal(result.ok, false);
      assert.match(result.error ?? '', /trusted verification/);
    }
    assert.equal((db.prepare('select status from orders where id = ?').get(orderId) as { status: string }).status, 'confirmed');
  } finally {
    db.exec('rollback');
  }
});

it('legacy direct approval is disabled and cannot change a claim or ledger', () => {
  db.exec('begin');
  try {
    const customerId = db.prepare('insert into customers (phone) values (?)').run(`payment-owner-customer-${Date.now()}`)
      .lastInsertRowid as number;
    const ownerId = db.prepare('insert into customers (phone) values (?)').run(`payment-owner-${Date.now()}`)
      .lastInsertRowid as number;
    const orderId = db.prepare(
      "insert into orders (customer_id, items_json, total_minor, status) values (?, '[]', ?, 'confirmed')",
    ).run(customerId, rupeesToMinor(800)).lastInsertRowid as number;
    db.prepare("insert into ledger (customer_id, order_id, kind, amount_minor) values (?, ?, 'debit', ?)")
      .run(customerId, orderId, rupeesToMinor(800));
    const claim = createPaymentClaim({ customerId, orderId, amount: 800, eventKey: `approve-${Date.now()}` });

    const pending = pendingPaymentClaims.execute({}, { customerId: ownerId }) as { claims: { claim_id: number }[] };
    assert.ok(pending.claims.some((row) => row.claim_id === claim.id));
    const approved = resolvePaymentClaim.execute(
      { claim_id: claim.id, decision: 'approve' },
      { customerId: ownerId },
    ) as { ok: boolean; error?: string };
    assert.equal(approved.ok, false);
    assert.match(approved.error ?? '', /disabled/i);
    assert.equal(
      (db.prepare('select status from payment_claims where id = ?').get(claim.id) as { status: string }).status,
      'pending',
    );
    assert.equal(
      (db.prepare("select count(*) n from ledger where order_id = ? and kind = 'credit'").get(orderId) as { n: number }).n,
      0,
    );
    assert.equal((db.prepare('select status from orders where id = ?').get(orderId) as { status: string }).status, 'confirmed');
  } finally {
    db.exec('rollback');
  }
});

it('legacy direct rejection is disabled and leaves the claim pending', () => {
  db.exec('begin');
  try {
    const customerId = db.prepare('insert into customers (phone) values (?)').run(`payment-reject-customer-${Date.now()}`)
      .lastInsertRowid as number;
    const ownerId = db.prepare('insert into customers (phone) values (?)').run(`payment-reject-owner-${Date.now()}`)
      .lastInsertRowid as number;
    const claim = createPaymentClaim({ customerId, amount: 500, eventKey: `reject-${Date.now()}` });
    const rejected = resolvePaymentClaim.execute(
      { claim_id: claim.id, decision: 'reject' },
      { customerId: ownerId },
    ) as { ok: boolean; error?: string };
    assert.equal(rejected.ok, false);
    assert.match(rejected.error ?? '', /disabled/i);
    assert.equal(
      (db.prepare('select status from payment_claims where id = ?').get(claim.id) as { status: string }).status,
      'pending',
    );
    assert.equal(
      (db.prepare("select count(*) n from ledger where customer_id = ? and kind = 'credit'").get(customerId) as { n: number }).n,
      0,
    );
  } finally {
    db.exec('rollback');
  }
});

it('keeps a claim pending when owner approval cannot write its ledger credit', () => {
  db.exec('begin');
  try {
    const customerId = db.prepare('insert into customers (phone) values (?)').run(`payment-fail-customer-${Date.now()}`)
      .lastInsertRowid as number;
    const ownerId = db.prepare('insert into customers (phone) values (?)').run(`payment-fail-owner-${Date.now()}`)
      .lastInsertRowid as number;
    const claim = createPaymentClaim({ customerId, amount: 600, eventKey: `approval-fail-${Date.now()}` });
    db.exec(`
      create trigger test_reject_payment_claim_credit
      before insert on ledger
      when new.kind = 'credit' and new.customer_id = ${customerId}
      begin
        select raise(abort, 'simulated payment credit failure');
      end;
    `);
    const result = resolvePaymentClaim.execute(
      { claim_id: claim.id, decision: 'approve' },
      { customerId: ownerId },
    ) as { ok: boolean };
    assert.equal(result.ok, false);
    assert.equal(
      (db.prepare('select status from payment_claims where id = ?').get(claim.id) as { status: string }).status,
      'pending',
    );
    assert.equal(
      (db.prepare("select count(*) n from ledger where customer_id = ? and kind = 'credit'").get(customerId) as { n: number }).n,
      0,
    );
  } finally {
    db.exec('rollback');
  }
});

// --- Suite 16: Two-step fulfillment ---
console.log('\n▶ Two-step Fulfillment');
it('exposes prepare/confirm but not the immediate record_order tool to customers', () => {
  assert.equal(baseTools.some((tool) => tool.name === 'record_order'), false);
  assert.equal(ownerTools.some((tool) => tool.name === 'record_order'), false);
  assert.equal(exportsAnyToolNamed('record_order'), false);
  assert.equal(baseTools.some((tool) => tool.name === 'prepare_order'), true);
  assert.equal(baseTools.some((tool) => tool.name === 'confirm_order'), true);
});

it('fails closed on missing delivery details and never creates a draft or order', () => {
  db.exec('begin');
  try {
    const customerId = db.prepare('insert into customers (phone) values (?)').run(`fulfillment-missing-${Date.now()}`).lastInsertRowid as number;
    const productId = db.prepare(
      'insert into products (name, price_minor, stock) values (?, ?, ?)',
    ).run('fulfillment kurta', rupeesToMinor(2500), 4).lastInsertRowid as number;
    const ordersBefore = (db.prepare('select count(*) n from orders where customer_id = ?').get(customerId) as { n: number }).n;
    const result = prepareOrder.execute(
      { items: [{ product_id: productId, qty: 1 }], recipient_name: 'Ali' },
      { customerId, idempotencyKey: 'fulfillment-missing' },
    ) as { ok: boolean };
    assert.equal(result.ok, false);
    assert.equal((db.prepare('select count(*) n from order_drafts where customer_id = ?').get(customerId) as { n: number }).n, 0);
    assert.equal((db.prepare('select count(*) n from orders where customer_id = ?').get(customerId) as { n: number }).n, ordersBefore);
  } finally {
    db.exec('rollback');
  }
});

it('rejects an unconfigured digital payment method before creating a draft', () => {
  const keys = ['PAYMENT_EASYPAISA_ACCOUNT_NAME', 'PAYMENT_EASYPAISA_NUMBER'] as const;
  const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  for (const key of keys) delete process.env[key];
  db.exec('begin');
  try {
    const customerId = db.prepare('insert into customers (phone) values (?)').run(`payment-config-${Date.now()}`).lastInsertRowid as number;
    const productId = db.prepare(
      'insert into products (name, price_minor, stock) values (?, ?, ?)',
    ).run('Payment-config kurta', rupeesToMinor(1800), 2).lastInsertRowid as number;
    const result = prepareOrder.execute({
      items: [{ product_id: productId, qty: 1 }],
      recipient_name: 'Ali Khan',
      contact_phone: '03120000000',
      delivery_address: 'House 1, Main Road, Sector F',
      city: 'Islamabad',
      payment_method: 'easypaisa',
    }, { customerId, idempotencyKey: 'payment-config-prepare' }) as { ok: boolean; error?: string };
    assert.equal(result.ok, false);
    assert.match(result.error ?? '', /not currently available/i);
    assert.equal((db.prepare('select count(*) n from order_drafts where customer_id = ?').get(customerId) as { n: number }).n, 0);
  } finally {
    db.exec('rollback');
    for (const key of keys) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
});

it('never substitutes COD for the payment method explicitly selected by the customer', () => {
  const keys = ['PAYMENT_EASYPAISA_ACCOUNT_NAME', 'PAYMENT_EASYPAISA_NUMBER'] as const;
  const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  for (const key of keys) delete process.env[key];
  db.exec('begin');
  try {
    const customerId = db.prepare('insert into customers (phone) values (?)').run(`payment-choice-${Date.now()}`).lastInsertRowid as number;
    const productId = db.prepare(
      'insert into products (name, price_minor, stock) values (?, ?, ?)',
    ).run('Payment-choice shoes', rupeesToMinor(4500), 2).lastInsertRowid as number;
    const common = {
      items: [{ product_id: productId, qty: 1 }],
      recipient_name: 'Asad Khan',
      contact_phone: '03120000000',
      delivery_address: 'House 1, Main Road, Topi',
      city: 'Swabi',
    };
    const inboundText = 'Asad / 03120000000 / House 1 Main Road Topi Swabi / Easypaisa';

    const substituted = prepareOrder.execute(
      { ...common, payment_method: 'cod' },
      { customerId, idempotencyKey: 'payment-choice-substitute', inboundText },
    ) as { ok: boolean; error?: string };
    assert.equal(substituted.ok, false);
    assert.match(substituted.error ?? '', /selected Easypaisa/i);
    assert.match(substituted.error ?? '', /never be substituted/i);
    assert.equal((db.prepare('select count(*) n from order_drafts where customer_id = ?').get(customerId) as { n: number }).n, 0);

    const unavailable = prepareOrder.execute(
      { ...common, payment_method: 'easypaisa' },
      { customerId, idempotencyKey: 'payment-choice-unavailable', inboundText },
    ) as { ok: boolean; error?: string };
    assert.equal(unavailable.ok, false);
    assert.match(unavailable.error ?? '', /not currently available/i);
    assert.equal((db.prepare('select count(*) n from order_drafts where customer_id = ?').get(customerId) as { n: number }).n, 0);
  } finally {
    db.exec('rollback');
    for (const key of keys) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
});

it('stores the configured payment method exactly as the customer selected it', () => {
  const keys = ['PAYMENT_EASYPAISA_ACCOUNT_NAME', 'PAYMENT_EASYPAISA_NUMBER'] as const;
  const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  process.env.PAYMENT_EASYPAISA_ACCOUNT_NAME = 'Ahmed Store';
  process.env.PAYMENT_EASYPAISA_NUMBER = '03120000000';
  db.exec('begin');
  try {
    const customerId = db.prepare('insert into customers (phone) values (?)').run(`payment-preserve-${Date.now()}`).lastInsertRowid as number;
    const productId = db.prepare(
      'insert into products (name, price_minor, stock) values (?, ?, ?)',
    ).run('Payment-preserve shoes', rupeesToMinor(4500), 2).lastInsertRowid as number;
    const prepared = prepareOrder.execute({
      items: [{ product_id: productId, qty: 1 }],
      recipient_name: 'Asad Khan',
      contact_phone: '03120000000',
      delivery_address: 'House 1, Main Road, Topi',
      city: 'Swabi',
      payment_method: 'easypaisa',
    }, {
      customerId,
      idempotencyKey: 'payment-preserve-prepare',
      inboundText: 'My payment method is Easy Paisa',
    }) as { ok: boolean; draft_id: number; payment_method: string };
    assert.equal(prepared.ok, true);
    assert.equal(prepared.payment_method, 'easypaisa');
    assert.equal(
      (db.prepare('select payment_method from order_drafts where id = ?').get(prepared.draft_id) as { payment_method: string }).payment_method,
      'easypaisa',
    );
  } finally {
    db.exec('rollback');
    for (const key of keys) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
});

it('builds the customer order summary only from server-priced draft data', () => {
  db.exec('begin');
  try {
    const customerId = db.prepare('insert into customers (phone) values (?)').run(`server-summary-${Date.now()}`).lastInsertRowid as number;
    const productId = db.prepare(
      'insert into products (name, size, color, price_minor, stock) values (?, ?, ?, ?, ?)',
    ).run('Basic T-Shirt', 'S', 'White', rupeesToMinor(1200), 5).lastInsertRowid as number;
    const prepared = prepareOrder.execute({
      items: [{ product_id: productId, qty: 2, price: 1 }],
      recipient_name: 'Hassan Khan',
      contact_phone: '03466788766',
      delivery_address: 'GIK Institute, Topi, Swabi',
      city: 'Swabi',
      payment_method: 'cod',
    }, {
      customerId,
      idempotencyKey: 'server-summary-prepare',
      inboundText: 'Use COD for this order',
    }) as { ok: boolean; server_summary: string; summary_generated_by: string };
    assert.equal(prepared.ok, true);
    assert.equal(prepared.summary_generated_by, 'server');
    assert.match(prepared.server_summary, /White \/ S \/ Basic T-Shirt/);
    assert.match(prepared.server_summary, /Qty 2 × Rs 1,200 = Rs 2,400/);
    assert.match(prepared.server_summary, /Total: Rs 2,400/);
    assert.match(prepared.server_summary, /Delivery: Free/);
    assert.match(prepared.server_summary, /Payment method: Cash on Delivery \(COD\)/);
    assert.doesNotMatch(prepared.server_summary, /03466788766/);
  } finally {
    db.exec('rollback');
  }
});

it('allows the exact server summary and rejects an AI-written replacement', () => {
  const summary = buildDeterministicOrderSummary({
    items: [{ name: 'Basic T-Shirt', size: 'S', color: 'White', qty: 1, unitPriceMinor: 120000 }],
    subtotalMinor: 120000,
    deliveryMinor: 0,
    recipientName: 'Hassan Khan',
    maskedContactPhone: '*******8766',
    deliveryAddress: 'GIK Institute, Topi, Swabi',
    city: 'Swabi',
    postalCode: null,
    deliveryInstructions: null,
    paymentMethod: 'cod',
  });
  assert.equal(checkDeterministicOrderSummaryReply(summary, true, summary).ok, true);
  const invented = summary.replaceAll('Rs 1,200', 'Rs 900');
  const rejected = checkDeterministicOrderSummaryReply(invented, true);
  assert.equal(rejected.ok, false);
  if (!rejected.ok) assert.match(rejected.error, /server-generated draft/i);
  assert.equal(checkDeterministicOrderSummaryReply('Which colour would you like?', false).ok, true);
});

it('requires one explicit payment method in the current customer message', () => {
  db.exec('begin');
  try {
    const customerId = db.prepare('insert into customers (phone) values (?)').run(`payment-explicit-${Date.now()}`).lastInsertRowid as number;
    const productId = db.prepare(
      'insert into products (name, price_minor, stock) values (?, ?, ?)',
    ).run('Payment-explicit shirt', rupeesToMinor(1800), 2).lastInsertRowid as number;
    const input = {
      items: [{ product_id: productId, qty: 1 }],
      recipient_name: 'Ali Khan',
      contact_phone: '03120000000',
      delivery_address: 'House 1, Main Road, Sector F',
      city: 'Islamabad',
      payment_method: 'cod',
    };
    const missing = prepareOrder.execute(input, {
      customerId,
      idempotencyKey: 'payment-explicit-missing',
      inboundText: 'These are all my delivery details',
    }) as { ok: boolean; error?: string };
    assert.equal(missing.ok, false);
    assert.match(missing.error ?? '', /explicitly name exactly one payment method/i);

    const ambiguous = prepareOrder.execute(input, {
      customerId,
      idempotencyKey: 'payment-explicit-ambiguous',
      inboundText: 'Should I use Easypaisa or COD?',
    }) as { ok: boolean; error?: string };
    assert.equal(ambiguous.ok, false);
    assert.match(ambiguous.error ?? '', /more than one payment method/i);
    assert.equal((db.prepare('select count(*) n from order_drafts where customer_id = ?').get(customerId) as { n: number }).n, 0);
  } finally {
    db.exec('rollback');
  }
});

it('rejects an invalid Pakistani delivery contact before writing a draft', () => {
  db.exec('begin');
  try {
    const customerId = db.prepare('insert into customers (phone) values (?)').run(`invalid-contact-${Date.now()}`).lastInsertRowid as number;
    const productId = db.prepare(
      'insert into products (name, price_minor, stock) values (?, ?, ?)',
    ).run('Contact-validation shirt', rupeesToMinor(1200), 2).lastInsertRowid as number;
    const result = prepareOrder.execute({
      items: [{ product_id: productId, qty: 1 }],
      recipient_name: 'Hassan Khan',
      contact_phone: '034000000000',
      delivery_address: 'GIK Institute, Topi, Swabi',
      city: 'Swabi',
      payment_method: 'cod',
    }, { customerId, idempotencyKey: 'invalid-contact-prepare' }) as { ok: boolean; error?: string };
    assert.equal(result.ok, false);
    assert.match(result.error ?? '', /valid Pakistani mobile number/i);
    assert.equal((db.prepare('select count(*) n from order_drafts where customer_id = ?').get(customerId) as { n: number }).n, 0);
  } finally {
    db.exec('rollback');
  }
});

it('blocks checkout-detail collection that omits payment method', () => {
  const unsafe = checkCheckoutCollectionReply(
    'White S Basic T-Shirt book this for me',
    'Please send your full name, contact number, complete delivery address, and city.',
  );
  assert.equal(unsafe.ok, false);
  assert.equal(checkCheckoutCollectionReply(
    'White S Basic T-Shirt book this for me',
    'Please send your full name, contact number, address, city, and choose COD as the available payment method.',
  ).ok, true);
  assert.equal(checkCheckoutCollectionReply('Show me shirts', 'Which colour do you prefer?').ok, true);
});

it('blocks accidental Devanagari fragments for Roman-Urdu customers without blocking real Devanagari input', () => {
  assert.equal(checkCustomerReplyScript(
    'Book this for me',
    'Apna address bata d\u0947\u0902.',
  ).ok, false);
  assert.equal(checkCustomerReplyScript(
    'Book this for me',
    'Apna address bata dein.',
  ).ok, true);
  assert.equal(checkCustomerReplyScript(
    '\u092e\u0941\u091d\u0947 \u092f\u0939 \u091a\u093e\u0939\u093f\u090f',
    '\u0905\u092a\u0928\u093e \u092a\u0924\u093e \u092c\u0924\u093e \u0926\u0947\u0902\u0964',
  ).ok, true);
});

it('prepares without booking, then explicit confirmation atomically books and reserves stock once', () => {
  db.exec('begin');
  try {
    const customerId = db.prepare('insert into customers (phone) values (?)').run(`fulfillment-ok-${Date.now()}`).lastInsertRowid as number;
    const productId = db.prepare(
      'insert into products (name, size, color, price_minor, stock) values (?, ?, ?, ?, ?)',
    ).run('Cotton Kurta', 'medium', 'navy', rupeesToMinor(3200), 5).lastInsertRowid as number;
    const prepareInput = {
      items: [{ product_id: productId, qty: 2 }],
      recipient_name: 'Sara Khan',
      contact_phone: '+92 312 000 0000',
      delivery_address: 'House 12, Street 8, F-10',
      city: 'Islamabad',
      postal_code: '44000',
      delivery_instructions: 'Call at the gate',
      payment_method: 'cash on delivery',
    };
    const prepared = prepareOrder.execute(prepareInput, {
      customerId,
      idempotencyKey: 'fulfillment-prepare-event',
    }) as { ok: boolean; draft_id: number; total: number; delivery_charge: number; needs_explicit_confirmation: boolean };
    const retriedPrepare = prepareOrder.execute(prepareInput, {
      customerId,
      idempotencyKey: 'fulfillment-prepare-event',
    }) as { draft_id: number };
    assert.equal(prepared.ok, true);
    assert.equal(prepared.total, 6400);
    assert.equal(prepared.delivery_charge, 0);
    assert.equal(prepared.needs_explicit_confirmation, true);
    assert.equal(retriedPrepare.draft_id, prepared.draft_id);
    assert.equal((db.prepare('select count(*) n from orders where customer_id = ?').get(customerId) as { n: number }).n, 0);
    assert.equal((db.prepare('select stock from products where id = ?').get(productId) as { stock: number }).stock, 5);

    const sameTurn = confirmOrder.execute({}, {
      customerId,
      idempotencyKey: 'fulfillment-prepare-event',
      inboundText: 'Yes, confirm my order',
    }) as { ok: boolean; error?: string };
    assert.equal(sameTurn.ok, false);
    assert.match(sameTurn.error ?? '', /new customer message/i);
    assert.equal((db.prepare('select count(*) n from orders where customer_id = ?').get(customerId) as { n: number }).n, 0);

    const rejected = confirmOrder.execute({}, {
      customerId,
      idempotencyKey: 'fulfillment-reject-event',
      inboundText: 'Please change the address first',
    }) as { ok: boolean };
    assert.equal(rejected.ok, false);
    assert.equal((db.prepare('select count(*) n from orders where customer_id = ?').get(customerId) as { n: number }).n, 0);

    const ambiguous = confirmOrder.execute({}, {
      customerId,
      idempotencyKey: 'fulfillment-ambiguous-event',
      inboundText: 'Yes',
    }) as { ok: boolean; error?: string };
    assert.equal(ambiguous.ok, false);
    assert.match(ambiguous.error ?? '', /explicitly confirm/i);
    assert.equal((db.prepare('select count(*) n from orders where customer_id = ?').get(customerId) as { n: number }).n, 0);

    const confirmationContext = {
      customerId,
      idempotencyKey: 'fulfillment-confirm-event',
      inboundText: 'Yes, confirm my order',
    };
    const confirmed = confirmOrder.execute({}, confirmationContext) as { ok: boolean; order_reference: string; stock_reserved: boolean };
    const retried = confirmOrder.execute({}, confirmationContext) as { ok: boolean; order_reference: string; already_confirmed?: boolean };
    assert.equal(confirmed.ok, true);
    assert.equal(confirmed.stock_reserved, true);
    assert.equal(retried.ok, true);
    assert.equal(retried.order_reference, confirmed.order_reference);
    assert.equal(retried.already_confirmed, true);
    assert.match(confirmed.order_reference, /^ORD-[0-9A-F]{20}$/);
    assert.equal(Object.hasOwn(confirmed, 'order_id'), false);
    const confirmedOrderId = (db.prepare('select id from orders where public_ref = ?').get(confirmed.order_reference) as { id: number }).id;
    const order = db.prepare(`
      select status, total_minor, shipping_minor, recipient_name, contact_phone,
             delivery_address, city, postal_code, delivery_instructions, payment_method
      from orders where id = ?
    `).get(confirmedOrderId) as Record<string, unknown>;
    assert.deepEqual(order, {
      status: 'confirmed',
      total_minor: rupeesToMinor(6400),
      shipping_minor: 0,
      recipient_name: 'Sara Khan',
      contact_phone: '+923120000000',
      delivery_address: 'House 12, Street 8, F-10',
      city: 'Islamabad',
      postal_code: '44000',
      delivery_instructions: 'Call at the gate',
      payment_method: 'cod',
    });
    assert.equal((db.prepare('select stock from products where id = ?').get(productId) as { stock: number }).stock, 3);
    assert.equal((db.prepare("select count(*) n from ledger where order_id = ? and kind = 'debit'").get(confirmedOrderId) as { n: number }).n, 1);
    assert.equal((db.prepare('select count(*) n from orders where customer_id = ?').get(customerId) as { n: number }).n, 1);
  } finally {
    db.exec('rollback');
  }
});

it('rejects stale draft prices without creating any partial order', () => {
  db.exec('begin');
  try {
    const customerId = db.prepare('insert into customers (phone) values (?)').run(`fulfillment-stale-${Date.now()}`).lastInsertRowid as number;
    const productId = db.prepare(
      'insert into products (name, price_minor, stock) values (?, ?, ?)',
    ).run('Price-change shirt', rupeesToMinor(1000), 2).lastInsertRowid as number;
    const prepared = prepareOrder.execute({
      items: [{ product_id: productId, qty: 1 }],
      recipient_name: 'Hamza Ali',
      contact_phone: '03120000000',
      delivery_address: 'Office 4, Main Boulevard',
      city: 'Lahore',
      payment_method: 'cod',
    }, { customerId, idempotencyKey: 'fulfillment-stale-prepare' }) as { ok: boolean };
    assert.equal(prepared.ok, true);
    db.prepare('update products set price_minor = ? where id = ?').run(rupeesToMinor(1100), productId);
    const result = confirmOrder.execute({}, {
      customerId,
      idempotencyKey: 'fulfillment-stale-confirm',
      inboundText: 'Confirm order',
    }) as { ok: boolean; error?: string };
    assert.equal(result.ok, false);
    assert.match(result.error ?? '', /price changed/i);
    assert.equal((db.prepare('select count(*) n from orders where customer_id = ?').get(customerId) as { n: number }).n, 0);
    assert.equal((db.prepare("select status from order_drafts where customer_id = ?").get(customerId) as { status: string }).status, 'awaiting_confirmation');
  } finally {
    db.exec('rollback');
  }
});

it('recognizes explicit confirmation conservatively', () => {
  assert.equal(isExplicitOrderConfirmation('Yes'), false);
  assert.equal(isExplicitOrderConfirmation('OK'), false);
  assert.equal(isExplicitOrderConfirmation('Haan'), false);
  assert.equal(isExplicitOrderConfirmation('Ji'), false);
  assert.equal(isExplicitOrderConfirmation('Done'), false);
  assert.equal(isExplicitOrderConfirmation('Order confirm kar dein'), true);
  assert.equal(isExplicitOrderConfirmation('Please book it'), true);
  assert.equal(isExplicitOrderConfirmation('Confirm bhai'), true);
  assert.equal(isExplicitOrderConfirmation('Yes, confirm my order'), true);
  assert.equal(isExplicitOrderConfirmation('What is the total?'), false);
  assert.equal(isExplicitOrderConfirmation('No, do not confirm order'), false);
  assert.equal(isExplicitOrderConfirmation("Don't confirm it yet"), false);
  assert.equal(isExplicitOrderConfirmation(undefined), false);
});

it('blocks a false confirmation reply unless this inbound event actually confirmed an order', () => {
  db.exec('begin');
  try {
    const customerId = db.prepare('insert into customers (phone) values (?)').run(`confirmation-claim-${Date.now()}`).lastInsertRowid as number;
    const productId = db.prepare(
      'insert into products (name, price_minor, stock) values (?, ?, ?)',
    ).run('Confirmation guard shirt', rupeesToMinor(900), 2).lastInsertRowid as number;
    const eventKey = 'confirmation-claim-event';
    assert.equal(checkOrderConfirmationReply('Bhai, order confirm ho gaya hai!', { customerId, idempotencyKey: eventKey }).ok, false);
    assert.equal(checkOrderConfirmationReply('Please confirm your order.', { customerId, idempotencyKey: eventKey }).ok, true);
    const order = { order_id: placeOrderForTest(customerId, [{ product_id: productId, qty: 1 }], 'confirmation-claim-create') };
    assert.equal(transitionOrderStatus(order.order_id, 'confirmed', {
      actorType: 'customer',
      actorCustomerId: customerId,
      source: 'test_confirmation_claim',
      sourceEventKey: eventKey,
      evidence: 'Test customer explicitly confirmed.',
    }).ok, true);
    assert.equal(checkOrderConfirmationReply('Your order is confirmed.', { customerId, idempotencyKey: eventKey }).ok, true);
  } finally {
    db.exec('rollback');
  }
});

// --- Suite 17: Deterministic STOP / START consent ---
console.log('\n▶ Deterministic STOP / START Consent');
it('recognizes only explicit standalone opt-out and opt-in commands', () => {
  assert.equal(detectConsentCommand('STOP'), 'opt_out');
  assert.equal(detectConsentCommand('Unsubscribe!'), 'opt_out');
  assert.equal(detectConsentCommand("Don't message me"), 'opt_out');
  assert.equal(detectConsentCommand('Messages band karo'), 'opt_out');
  assert.equal(detectConsentCommand('Messages band karo bhai'), 'opt_out');
  assert.equal(detectConsentCommand('Please unsubscribe'), 'opt_out');
  assert.equal(detectConsentCommand('Mujhe messages mat bhejo'), 'opt_out');
  assert.equal(detectConsentCommand('START'), 'opt_in');
  assert.equal(detectConsentCommand('Messages dobara shuru karo'), 'opt_in');
  assert.equal(detectConsentCommand('Start bhai'), 'opt_in');
  assert.equal(detectConsentCommand('Please stop by the shop'), null);
  assert.equal(detectConsentCommand("Don't stop messages"), null);
  assert.equal(detectConsentCommand('I want to start an order'), null);
});

it('persists consent idempotently and blocks automated sends until START', () => {
  db.exec('begin');
  try {
    const phone = `92300${String(Date.now()).slice(-7)}`;
    const customerId = db.prepare('insert into customers (phone) values (?)').run(phone).lastInsertRowid as number;
    assert.deepEqual(checkAutomatedCustomerSendAllowed(customerId), { ok: true });

    const stopped = recordConsentCommand({
      phone,
      eventKey: 'consent-stop-event',
      text: 'Messages band karo',
      action: 'opt_out',
    });
    assert.equal(stopped.confirmation_status, 'pending');
    assert.equal(isCustomerOptedOut(customerId), true);
    assert.equal(checkAutomatedCustomerSendAllowed(customerId).ok, false);
    assert.equal(checkAutomatedCustomerSendAllowed(customerId, true).ok, true);
    assert.equal(getPendingConsentConfirmations().filter((event) => event.event_key === stopped.event_key).length, 1);
    assert.equal(markConsentConfirmationSent(stopped.event_key), true);

    const duplicate = recordConsentCommand({
      phone,
      eventKey: 'consent-stop-event',
      text: 'Messages band karo',
      action: 'opt_out',
    });
    assert.equal(duplicate.id, stopped.id);
    assert.equal(duplicate.confirmation_status, 'sent');
    assert.equal((db.prepare('select count(*) n from customer_consent_events where event_key = ?').get(stopped.event_key) as { n: number }).n, 1);

    const repeatedStop = recordConsentCommand({
      phone,
      eventKey: 'consent-stop-repeat',
      text: 'STOP',
      action: 'opt_out',
    });
    assert.equal(repeatedStop.confirmation_status, 'not_required');

    const started = recordConsentCommand({
      phone,
      eventKey: 'consent-start-event',
      text: 'START',
      action: 'opt_in',
    });
    assert.equal(started.confirmation_status, 'pending');
    assert.equal(isCustomerOptedOut(customerId), false);
    assert.deepEqual(checkAutomatedCustomerSendAllowed(customerId), { ok: true });
  } finally {
    db.exec('rollback');
  }
});

it('supersedes an undelivered old-state acknowledgement when consent changes again', () => {
  db.exec('begin');
  try {
    const phone = `92301${String(Date.now()).slice(-7)}`;
    const customerId = db.prepare('insert into customers (phone) values (?)').run(phone).lastInsertRowid as number;
    const stopped = recordConsentCommand({ phone, eventKey: 'consent-race-stop-1', text: 'STOP', action: 'opt_out' });
    const started = recordConsentCommand({ phone, eventKey: 'consent-race-start', text: 'START', action: 'opt_in' });
    const stoppedAgain = recordConsentCommand({ phone, eventKey: 'consent-race-stop-2', text: 'STOP', action: 'opt_out' });
    const statuses = db.prepare(
      'select event_key, confirmation_status from customer_consent_events where customer_id = ? order by id',
    ).all(customerId) as Array<{ event_key: string; confirmation_status: string }>;
    assert.deepEqual(statuses, [
      { event_key: stopped.event_key, confirmation_status: 'not_required' },
      { event_key: started.event_key, confirmation_status: 'not_required' },
      { event_key: stoppedAgain.event_key, confirmation_status: 'pending' },
    ]);
    assert.equal(isCustomerOptedOut(customerId), true);
    assert.deepEqual(
      getPendingConsentConfirmations().filter((event) => event.customer_id === customerId).map((event) => event.event_key),
      [stoppedAgain.event_key],
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
