import assert from 'node:assert/strict';
import { test } from 'node:test';

// FIX3 (live evidence 2026-11-02): customers filed payment claims on COD
// orders that were not delivered yet, the same order got two open claims
// (#7 and #8), and the bot listed payment methods that are not configured.

process.env.GEMINI_API_KEY = 'TEST-GEMINI-KEY-payment-claims';
for (const key of Object.keys(process.env)) {
  if (key.startsWith('PAYMENT_')) delete process.env[key];
}

import { runTurn } from '../src/agent';
import { db } from '../src/db';
import { PACING_DEFAULTS } from '../src/guardrails/pacing/defaults';
import { rupeesToMinor } from '../src/money';
import {
  checkUnconfiguredPaymentMethodReply,
  createSendPaymentInstructionsTool,
} from '../src/payment-instructions';
import { createClaimPaymentTool, createPaymentClaim } from '../src/payments';

let sequence = 0;
function newCustomer(): number {
  sequence += 1;
  return Number(db.prepare('insert into customers (phone) values (?)')
    .run(`9230777${String(sequence).padStart(4, '0')}`).lastInsertRowid);
}

function newOrder(customerId: number, paymentMethod: string | null, status: string, total = 800) {
  const id = Number(db.prepare(`
    insert into orders (customer_id, items_json, total_minor, payment_method, status)
    values (?, '[]', ?, ?, ?)
  `).run(customerId, rupeesToMinor(total), paymentMethod, status).lastInsertRowid);
  const { public_ref } = db.prepare('select public_ref from orders where id = ?').get(id) as { public_ref: string };
  return { id, ref: public_ref };
}

function claimCount(customerId: number): number {
  return (db.prepare('select count(*) n from payment_claims where customer_id = ?').get(customerId) as { n: number }).n;
}

const CONFIGURED_ALL = {
  PAYMENT_EASYPAISA_ACCOUNT_NAME: 'Test Store',
  PAYMENT_EASYPAISA_NUMBER: '03001234567',
  PAYMENT_JAZZCASH_ACCOUNT_NAME: 'Test Store',
  PAYMENT_JAZZCASH_NUMBER: '03001234567',
  PAYMENT_BANK_NAME: 'Example Bank',
  PAYMENT_BANK_ACCOUNT_TITLE: 'Test Store',
  PAYMENT_BANK_IBAN: 'PK36SCBL0000001123456702',
};

// ---------------------------------------------------------------- 1. COD

test('claim_payment on an undelivered COD order is refused with teaching text and creates no row', async () => {
  const tool = createClaimPaymentTool();
  for (const status of ['placed', 'confirmed', 'shipped']) {
    const customerId = newCustomer();
    const order = newOrder(customerId, 'cod', status);
    const result = await tool.execute(
      { amount: 800, order_reference: order.ref, method: 'COD' },
      { customerId, idempotencyKey: `cod-${status}-${sequence}` },
    ) as { ok: boolean; error?: string; claim_created?: boolean };
    assert.equal(result.ok, false, status);
    assert.match(result.error ?? '', /COD is paid to the rider at delivery; no claim is needed/);
    assert.equal(result.claim_created, false);
    assert.equal(claimCount(customerId), 0, status);
  }
});

test('a COD-method claim without an order reference is refused while the only COD order is undelivered', async () => {
  const tool = createClaimPaymentTool();
  const customerId = newCustomer();
  newOrder(customerId, 'cod', 'confirmed');
  const result = await tool.execute(
    { amount: 800, method: 'cash on delivery' },
    { customerId, idempotencyKey: `cod-noref-${sequence}` },
  ) as { ok: boolean; error?: string };
  assert.equal(result.ok, false);
  assert.match(result.error ?? '', /no claim is needed/);
  assert.equal(claimCount(customerId), 0);
});

test('COD claims after delivery, non-COD orders and order-less claims are still recorded', async () => {
  const tool = createClaimPaymentTool();

  const delivered = newCustomer();
  const deliveredOrder = newOrder(delivered, 'cod', 'delivered');
  const a = await tool.execute(
    { amount: 800, order_reference: deliveredOrder.ref, method: 'COD' },
    { customerId: delivered, idempotencyKey: `cod-delivered-${sequence}` },
  ) as { ok: boolean; status?: string };
  assert.equal(a.ok, true);
  assert.equal(a.status, 'pending');
  assert.equal(claimCount(delivered), 1);

  const bank = newCustomer();
  const bankOrder = newOrder(bank, 'bank_transfer', 'confirmed');
  const b = await tool.execute(
    { amount: 800, order_reference: bankOrder.ref, method: 'bank transfer' },
    { customerId: bank, idempotencyKey: `bank-${sequence}` },
  ) as { ok: boolean };
  assert.equal(b.ok, true);
  assert.equal(claimCount(bank), 1);

  const noOrders = newCustomer();
  const c = await tool.execute(
    { amount: 800, method: 'COD' },
    { customerId: noOrders, idempotencyKey: `no-orders-${sequence}` },
  ) as { ok: boolean };
  assert.equal(c.ok, true);
  assert.equal(claimCount(noOrders), 1);
});

// ---------------------------------------------------------- 2. duplicates

test('a second claim for the same order returns the existing open claim and sends no second alert', async () => {
  const alerts: string[] = [];
  const tool = createClaimPaymentTool(async ({ eventKey }) => {
    alerts.push(eventKey);
    return { ok: true, status: 'sent', alertId: alerts.length };
  });
  const customerId = newCustomer();
  const order = newOrder(customerId, 'easypaisa', 'confirmed');
  const first = await tool.execute(
    { amount: 800, order_reference: order.ref, method: 'Easypaisa', reference: 'EP-1' },
    { customerId, idempotencyKey: `dup-order-1-${sequence}` },
  ) as { ok: boolean; claim_id: number; duplicate?: boolean };
  const second = await tool.execute(
    { amount: 800, order_reference: order.ref, method: 'Easypaisa', reference: 'EP-1' },
    { customerId, idempotencyKey: `dup-order-2-${sequence}` },
  ) as { ok: boolean; claim_id: number; status: string; duplicate?: boolean; new_claim_created?: boolean; instruction?: string };
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(second.claim_id, first.claim_id);
  assert.equal(second.status, 'pending');
  assert.equal(second.duplicate, true);
  assert.equal(second.new_claim_created, false);
  assert.match(second.instruction ?? '', /pending owner verification/);
  assert.equal(claimCount(customerId), 1);
  assert.equal(alerts.length, 1);
});

test('without an order, the same customer and amount within 24 h reuses the open claim', () => {
  const customerId = newCustomer();
  const first = createPaymentClaim({ customerId, amount: 1500, eventKey: `dup-noorder-1-${sequence}` });
  const second = createPaymentClaim({ customerId, amount: 1500, eventKey: `dup-noorder-2-${sequence}` });
  assert.equal(second.id, first.id);
  assert.equal(claimCount(customerId), 1);

  // A different amount is a different claim.
  const other = createPaymentClaim({ customerId, amount: 900, eventKey: `dup-noorder-3-${sequence}` });
  assert.notEqual(other.id, first.id);

  // Older than 24 h, or already resolved, no longer blocks a new claim.
  db.prepare("update payment_claims set created_at = datetime('now', '-25 hours') where id = ?").run(first.id);
  const later = createPaymentClaim({ customerId, amount: 1500, eventKey: `dup-noorder-4-${sequence}` });
  assert.notEqual(later.id, first.id);
  assert.equal(claimCount(customerId), 3);
});

test('a rejected claim for an order does not block a new claim for that order', () => {
  const customerId = newCustomer();
  const order = newOrder(customerId, 'bank_transfer', 'confirmed');
  const first = createPaymentClaim({ customerId, orderId: order.id, amount: 800, eventKey: `rej-1-${sequence}` });
  db.prepare("update payment_claims set status = 'rejected', resolved_at = datetime('now') where id = ?").run(first.id);
  const second = createPaymentClaim({ customerId, orderId: order.id, amount: 800, eventKey: `rej-2-${sequence}` });
  assert.notEqual(second.id, first.id);
});

// ------------------------------------------------------ 3. payment methods

test('send guard vetoes unconfigured methods presented as available', () => {
  const blocked = [
    'You can pay via JazzCash or COD.',
    'We accept COD, EasyPaisa and bank transfer.',
    'Aap JazzCash par payment bhej sakte hain.',
    'Please transfer the amount to our IBAN.',
    'You can also pay by credit card.',
    'Payment options: Cash on Delivery, Easy Paisa, Jazz Cash.',
    'Sure! Send it through Easypaisa and share the screenshot.',
    "Don't forget to pay through JazzCash today.",
  ];
  for (const body of blocked) {
    const result = checkUnconfiguredPaymentMethodReply(body, {});
    assert.equal(result.ok, false, body);
    if (!result.ok) {
      assert.equal(result.check, 'unconfigured_payment_method');
      assert.match(result.error, /not configured/);
      assert.match(result.error, /Cash on Delivery/);
    }
  }
});

test('send guard allows saying a method is unavailable, COD-only wording, and the customer\'s own claim', () => {
  const allowed: Array<[string, string?]> = [
    ['We only accept Cash on Delivery right now.'],
    ['Abhi sirf COD available hai.'],
    ['Sorry, JazzCash is not available right now. We only accept Cash on Delivery.', 'can I pay with jazzcash?'],
    ['JazzCash abhi available nahi hai, sirf COD hai.', 'jazzcash se pay kar sakta hoon?'],
    ['We only accept COD at the moment, not JazzCash or bank transfer.', 'jazzcash or bank?'],
    ["EasyPaisa and bank transfer aren't available yet; payment is collected on delivery.", 'easypaisa?'],
    ['We do not accept card payments. Cash on Delivery is available.', 'card?'],
    ['Your JazzCash payment claim has been recorded and is pending owner verification.', 'I paid 800 via JazzCash'],
    ['Black hoodie Rs 800 available hai.'],
  ];
  for (const [body, inbound] of allowed) {
    assert.deepEqual(checkUnconfiguredPaymentMethodReply(body, {}, inbound), { ok: true }, body);
  }
});

test('configured methods may be presented as available', () => {
  for (const body of [
    'You can pay via JazzCash or COD.',
    'We accept COD, EasyPaisa and bank transfer.',
  ]) {
    assert.deepEqual(checkUnconfiguredPaymentMethodReply(body, CONFIGURED_ALL), { ok: true }, body);
  }
  // Card is never a configurable method.
  assert.equal(checkUnconfiguredPaymentMethodReply('You can pay by debit card.', CONFIGURED_ALL).ok, false);
  // Only JazzCash configured: EasyPaisa is still vetoed.
  const jazzOnly = {
    PAYMENT_JAZZCASH_ACCOUNT_NAME: 'Test Store',
    PAYMENT_JAZZCASH_NUMBER: '03001234567',
  };
  assert.deepEqual(checkUnconfiguredPaymentMethodReply('Pay via JazzCash or COD.', jazzOnly), { ok: true });
  assert.equal(checkUnconfiguredPaymentMethodReply('Pay via JazzCash or EasyPaisa.', jazzOnly).ok, false);
});

test('the model only sees configured payment methods in tool schemas', () => {
  const instructions = createSendPaymentInstructionsTool(() => ({ ok: true }), {});
  const methodSchema = (instructions.input_schema as any).properties.method;
  assert.deepEqual(methodSchema.enum, ['cod']);
  assert.doesNotMatch(instructions.description, /jazz|easypaisa|bank/i);

  const configured = createSendPaymentInstructionsTool(() => ({ ok: true }), CONFIGURED_ALL);
  assert.deepEqual(
    (configured.input_schema as any).properties.method.enum,
    ['cod', 'bank_transfer', 'easypaisa', 'jazzcash'],
  );

  const claim = createClaimPaymentTool();
  const text = JSON.stringify({ d: claim.description, s: claim.input_schema });
  assert.doesNotMatch(text, /jazz|easypaisa|bank transfer/i);
});

async function stubbedTurn(replyBody: string, inbound: string) {
  const originalFetch = globalThis.fetch;
  const originalWindow = { start: PACING_DEFAULTS.windowStartHour, end: PACING_DEFAULTS.windowEndHour };
  PACING_DEFAULTS.windowStartHour = 0;
  PACING_DEFAULTS.windowEndHour = 24;
  const toolResults: unknown[] = [];
  globalThis.fetch = (async (_url: unknown, init?: { body?: string }) => {
    const request = JSON.parse(String(init?.body ?? '{}'));
    for (const content of request.contents ?? []) {
      for (const part of content.parts ?? []) {
        if (part.functionResponse?.name === 'send_message') toolResults.push(part.functionResponse.response);
      }
    }
    const parts = Array.isArray(request.tools) && request.tools.length > 0
      ? [{ functionCall: { name: 'send_message', args: { body: replyBody } } }]
      : [{ text: '{}' }];
    return new Response(JSON.stringify({
      candidates: [{ content: { parts } }],
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;

  sequence += 1;
  const phone = `9232${String(Date.now()).slice(-6)}${String(sequence).padStart(2, '0')}`;
  const sends: string[] = [];
  try {
    await runTurn(
      phone,
      inbound,
      async (body) => { sends.push(body); return { providerMessageId: `p-${sequence}-${sends.length}` }; },
      `payment-methods-${phone}`,
    );
  } finally {
    globalThis.fetch = originalFetch;
    PACING_DEFAULTS.windowStartHour = originalWindow.start;
    PACING_DEFAULTS.windowEndHour = originalWindow.end;
  }
  return { sends, toolResults };
}

test('end-to-end: a reply offering unconfigured JazzCash never reaches the customer', async () => {
  const { sends, toolResults } = await stubbedTurn('You can pay via JazzCash or COD, whichever you like.', 'how can I pay?');
  assert.equal(sends.length, 1, `expected exactly one (fallback) reply, got ${sends.length}`);
  assert.doesNotMatch(sends[0], /jazz/i);
  assert.ok(
    toolResults.some((r: any) => r?.check === 'unconfigured_payment_method' || /not configured/.test(JSON.stringify(r))),
    JSON.stringify(toolResults),
  );
});

test('end-to-end: telling a JazzCash customer it is unavailable is delivered', async () => {
  const body = 'Sorry, JazzCash is not available right now. We only accept Cash on Delivery.';
  const { sends } = await stubbedTurn(body, 'can I pay with jazzcash?');
  assert.equal(sends.length, 1);
  assert.ok(sends[0].endsWith(body), sends[0]);
});
