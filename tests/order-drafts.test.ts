import assert from 'node:assert/strict';
import { test } from 'node:test';

// Live test 2026-11-01/02 (FIX2): customer #117 still had draft #8
// awaiting_confirmation 17 hours after it was prepared, and a plain price
// answer ("cheapest item is Black Hoodie Rs 800 ... order?") was vetoed three
// times as a rewritten order summary, so the customer only got the fallback.
// On 2026-11-01 the order flow looped: the model could not re-send the
// prepared draft, wrote its own summary and was blocked. These tests pin the
// draft lifecycle (TTL + supersede), the narrower summary detector, and the
// show_pending_order path that re-sends the exact server summary.

process.env.GEMINI_API_KEY = 'TEST-GEMINI-KEY-order-drafts';

import { runTurn } from '../src/agent';
import { db } from '../src/db';
import { PACING_DEFAULTS } from '../src/guardrails/pacing/defaults';
import { rupeesToMinor } from '../src/money';
import { checkDeterministicOrderSummaryReply } from '../src/order-summary';
import {
  draftResult,
  getExpiredOrderDraft,
  getPendingOrderDraft,
  orderDraftTtlHours,
} from '../src/tools/order-drafts';
import { confirmOrder, prepareOrder } from '../src/tools/orders';

let seq = 0;
function uniquePhone(prefix: string): string {
  seq += 1;
  return `${prefix}${String(Date.now()).slice(-7)}${seq}`;
}

function seedCustomerWithDraft(phone: string, recipient = 'Zainab Fixture') {
  const customerId = db.prepare('insert into customers (phone) values (?)').run(phone).lastInsertRowid as number;
  const productId = db.prepare('insert into products (name, price_minor, stock) values (?, ?, ?)')
    .run(`Black Hoodie ${phone}`, rupeesToMinor(800), 10).lastInsertRowid as number;
  const prepared = prepareOrder.execute({
    items: [{ product_id: productId, qty: 1 }],
    recipient_name: recipient,
    contact_phone: '03001234567',
    delivery_address: 'House 7, Street 3, Model Town',
    city: 'Lahore',
    payment_method: 'cod',
  }, { customerId, idempotencyKey: `prev-turn-${phone}` }) as { ok: boolean; draft_id: number; server_summary: string };
  assert.equal(prepared.ok, true);
  return { customerId, productId, draftId: prepared.draft_id, serverSummary: prepared.server_summary };
}

function backdateDraft(draftId: number, hours: number): void {
  db.prepare(`update order_drafts set created_at = datetime('now', ?) where id = ?`).run(`-${hours} hours`, draftId);
}

function withStubbedGemini(
  loopReply: (loopCall: number) => unknown[],
  onRequest?: (request: any) => void,
) {
  const originalFetch = globalThis.fetch;
  const originalWindow = { start: PACING_DEFAULTS.windowStartHour, end: PACING_DEFAULTS.windowEndHour };
  PACING_DEFAULTS.windowStartHour = 0;
  PACING_DEFAULTS.windowEndHour = 24;
  const state = { loopCalls: 0 };
  globalThis.fetch = (async (_url: unknown, init?: { body?: string }) => {
    const request = JSON.parse(String(init?.body ?? '{}'));
    let parts: unknown[];
    if (Array.isArray(request.tools) && request.tools.length > 0) {
      state.loopCalls += 1;
      onRequest?.(request);
      parts = loopReply(state.loopCalls);
    } else {
      parts = [{ text: '{}' }];
    }
    return new Response(JSON.stringify({
      candidates: [{ content: { parts } }],
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return {
    state,
    restore() {
      globalThis.fetch = originalFetch;
      PACING_DEFAULTS.windowStartHour = originalWindow.start;
      PACING_DEFAULTS.windowEndHour = originalWindow.end;
    },
  };
}

test('ORDER_DRAFT_TTL_HOURS is parsed fail-safe (default 6)', () => {
  const original = process.env.ORDER_DRAFT_TTL_HOURS;
  try {
    delete process.env.ORDER_DRAFT_TTL_HOURS;
    assert.equal(orderDraftTtlHours(), 6);
    for (const bad of ['', 'abc', '0', '-3', 'NaN', 'Infinity', '100000']) {
      process.env.ORDER_DRAFT_TTL_HOURS = bad;
      assert.equal(orderDraftTtlHours(), 6, `value ${JSON.stringify(bad)}`);
    }
    process.env.ORDER_DRAFT_TTL_HOURS = '2';
    assert.equal(orderDraftTtlHours(), 2);
    process.env.ORDER_DRAFT_TTL_HOURS = ' 1.5 ';
    assert.equal(orderDraftTtlHours(), 1.5);
  } finally {
    if (original === undefined) delete process.env.ORDER_DRAFT_TTL_HOURS;
    else process.env.ORDER_DRAFT_TTL_HOURS = original;
  }
});

test('a 17-hour-old draft is no longer pending and cannot be confirmed', () => {
  const { customerId, draftId } = seedCustomerWithDraft(uniquePhone('9240'));
  assert.equal(getPendingOrderDraft(customerId)?.id, draftId);
  backdateDraft(draftId, 17);
  assert.equal(getPendingOrderDraft(customerId), undefined);
  assert.equal(getExpiredOrderDraft(customerId)?.id, draftId);

  const result = confirmOrder.execute({}, {
    customerId,
    idempotencyKey: `confirm-expired-${draftId}`,
    inboundText: 'Confirm order',
  }) as { ok: boolean; error?: string };
  assert.equal(result.ok, false);
  assert.match(result.error ?? '', /expired/i);
  assert.equal((db.prepare('select count(*) n from orders where customer_id = ?').get(customerId) as { n: number }).n, 0);
  // History is kept: the row is not deleted or rewritten by the read path.
  assert.equal((db.prepare('select status from order_drafts where id = ?').get(draftId) as { status: string }).status, 'awaiting_confirmation');
});

test('a new prepare_order supersedes the old draft, including an expired one', () => {
  const phone = uniquePhone('9241');
  const { customerId, productId, draftId } = seedCustomerWithDraft(phone);
  backdateDraft(draftId, 17);
  const second = prepareOrder.execute({
    items: [{ product_id: productId, qty: 2 }],
    recipient_name: 'Zainab Fixture',
    contact_phone: '03001234567',
    delivery_address: 'House 7, Street 3, Model Town',
    city: 'Lahore',
    payment_method: 'cod',
  }, { customerId, idempotencyKey: `second-${phone}` }) as { ok: boolean; draft_id: number };
  assert.equal(second.ok, true);
  assert.equal((db.prepare('select status from order_drafts where id = ?').get(draftId) as { status: string }).status, 'superseded');
  assert.equal(getPendingOrderDraft(customerId)?.id, second.draft_id);
  assert.equal(getExpiredOrderDraft(customerId), undefined);
});

test('a price answer that mentions "order?" passes while a draft is pending', () => {
  const allowed = [
    'Cheapest item is Black Hoodie Rs 800. Order karna hai?',
    'The cheapest item is the Black Hoodie at Rs 800 ... want to order?',
    'Black Hoodie Rs 800 hai aur Basic T-Shirt Rs 1,200. Aap order karna chahenge?',
    'Your order is waiting for confirmation. Reply "confirm order" when ready.',
  ];
  for (const body of allowed) {
    assert.deepEqual(checkDeterministicOrderSummaryReply(body, true), { ok: true }, body);
  }
});

test('a rewritten order summary is still blocked while a draft is pending', () => {
  const blocked = [
    'ORDER SUMMARY: Black Hoodie x1 = Rs 800',
    'Your order: Black Hoodie, Qty 1, Total Rs 800, Delivery free, Payment method: COD',
    'Aapka order: Black Hoodie quantity 1, total Rs 800, recipient Ali, address House 7 Lahore',
    'Black Hoodie x1 — Subtotal Rs 800, Delivery Free, Total Rs 800',
    'Black Hoodie Rs 800. Total Rs 800. Reply confirm order to book it.',
    'Total: 800 rupees, delivery free, quantity 1',
  ];
  for (const body of blocked) {
    const result = checkDeterministicOrderSummaryReply(body, true);
    assert.equal(result.ok, false, body);
  }
  // Without a pending draft nothing here is a draft summary to protect.
  assert.deepEqual(checkDeterministicOrderSummaryReply(blocked[1], false), { ok: true });
});

test('a 17-hour-old draft does not block a summary-like price answer (stubbed turn)', async () => {
  const phone = uniquePhone('9242');
  const { draftId } = seedCustomerWithDraft(phone);
  backdateDraft(draftId, 17);
  const answer = 'Black Hoodie Rs 800 hai, delivery free, total Rs 800 for quantity 1. Order karna hai?';
  const stub = withStubbedGemini(() => [{ functionCall: { name: 'send_message', args: { body: answer } } }]);
  const sends: string[] = [];
  try {
    await runTurn(phone, 'cheapest item kya hai?', async (body) => {
      sends.push(body);
      return { providerMessageId: `p-${sends.length}` };
    }, `expired-price-${phone}`);
  } finally {
    stub.restore();
  }
  assert.equal(sends.length, 1, `expected one reply, got ${JSON.stringify(sends)}`);
  assert.ok(sends[0].includes(answer), sends[0]);
  assert.doesNotMatch(sends[0], /Maazrat/);
});

test('asking again re-sends exactly one server summary, with no loop (stubbed turn)', async () => {
  const phone = uniquePhone('9243');
  const { customerId, draftId, serverSummary } = seedCustomerWithDraft(phone, 'Zainab Privatename');
  // The earlier turn already delivered this exact summary to the customer.
  db.prepare("insert into messages (customer_id, direction, body) values (?, 'outbound', ?)").run(customerId, serverSummary);
  const rewritten = 'Your order: Black Hoodie, Qty 1, Total Rs 800, Delivery free, Payment method: COD';
  let openingRequest = '';
  const stub = withStubbedGemini(
    (loopCall) => loopCall === 1
      ? [{ functionCall: { name: 'show_pending_order', args: {} } }]
      : [{ functionCall: { name: 'send_message', args: { body: rewritten } } }],
    (request) => { if (!openingRequest) openingRequest = JSON.stringify(request.contents?.[0] ?? request); },
  );
  const sends: string[] = [];
  try {
    await runTurn(phone, 'mera order dobara dikha do please', async (body) => {
      sends.push(body);
      return { providerMessageId: `p-${sends.length}` };
    }, `show-pending-${phone}`);
  } finally {
    stub.restore();
  }
  assert.equal(stub.state.loopCalls, 1, 'the loop must stop after the server summary was sent');
  assert.equal(sends.length, 1, `expected exactly one reply, got ${JSON.stringify(sends)}`);
  assert.ok(sends[0].endsWith(serverSummary), sends[0]);
  assert.equal(draftResult(getPendingOrderDraft(customerId)!).server_summary, serverSummary);
  assert.equal(getPendingOrderDraft(customerId)?.id, draftId);

  // OPEN context tells the model about the draft (id, item count, expiry) without PII.
  assert.match(openingRequest, /draft_id/);
  assert.match(openingRequest, /item_count/);
  assert.match(openingRequest, /expires_at/);
  assert.doesNotMatch(openingRequest, /Privatename/);
  assert.doesNotMatch(openingRequest, /4567/);
  assert.doesNotMatch(openingRequest, /Model Town/);
});

test('prepare_order on a real (event-keyed) turn delivers its server summary once', async () => {
  // "ORDER SUMMARY — NOT BOOKED YET" used to trip the "order ... booked"
  // success-claim veto, so the automatic summary itself was blocked and the
  // model then looped on rewritten copies (live 2026-11-01).
  const phone = uniquePhone('9246');
  db.prepare('insert into customers (phone) values (?)').run(phone);
  const productId = db.prepare('insert into products (name, price_minor, stock) values (?, ?, ?)')
    .run(`Grey Hoodie ${phone}`, rupeesToMinor(800), 10).lastInsertRowid as number;
  const stub = withStubbedGemini(() => [{
    functionCall: {
      name: 'prepare_order',
      args: {
        items: [{ product_id: productId, qty: 1 }],
        recipient_name: 'Bilal Fixture',
        contact_phone: '03001234567',
        delivery_address: 'House 9, Street 1, Gulberg',
        city: 'Lahore',
        payment_method: 'cod',
      },
    },
  }]);
  const sends: string[] = [];
  try {
    await runTurn(phone, 'Bilal Fixture, 03001234567, House 9 Street 1 Gulberg Lahore, COD please', async (body) => {
      sends.push(body);
      return { providerMessageId: `p-${sends.length}` };
    }, `prepare-real-${phone}`);
  } finally {
    stub.restore();
  }
  assert.equal(stub.state.loopCalls, 1);
  assert.equal(sends.length, 1, `expected one reply, got ${JSON.stringify(sends)}`);
  assert.match(sends[0], /ORDER SUMMARY — NOT BOOKED YET/);
  assert.doesNotMatch(sends[0], /Maazrat/);
});

test('show_pending_order with no pending draft teaches instead of sending', async () => {
  const phone = uniquePhone('9244');
  const { draftId } = seedCustomerWithDraft(phone);
  backdateDraft(draftId, 17);
  let toolResultText = '';
  const stub = withStubbedGemini(
    (loopCall) => loopCall === 1
      ? [{ functionCall: { name: 'show_pending_order', args: {} } }]
      : [{ functionCall: { name: 'send_message', args: { body: 'Aapka pichla summary expire ho gaya hai, details dobara bhej dein.' } } }],
    (request) => { toolResultText = JSON.stringify(request.contents ?? []); },
  );
  const sends: string[] = [];
  try {
    await runTurn(phone, 'mera order dikha do', async (body) => {
      sends.push(body);
      return { providerMessageId: `p-${sends.length}` };
    }, `show-expired-${phone}`);
  } finally {
    stub.restore();
  }
  assert.match(toolResultText, /expired/i);
  assert.equal(sends.length, 1);
  assert.doesNotMatch(sends[0], /ORDER SUMMARY/);
});

test('the model cannot claim the pending order is confirmed without confirm_order this turn', async () => {
  const phone = uniquePhone('9245');
  seedCustomerWithDraft(phone);
  const stub = withStubbedGemini(() => [{ functionCall: { name: 'send_message', args: { body: 'Your order is confirmed! Thank you.' } } }]);
  const sends: string[] = [];
  try {
    await runTurn(phone, 'theek hai', async (body) => {
      sends.push(body);
      return { providerMessageId: `p-${sends.length}` };
    }, `claim-confirmed-${phone}`);
  } finally {
    stub.restore();
  }
  assert.equal(sends.length, 1);
  assert.doesNotMatch(sends[0], /confirmed/i);
});
