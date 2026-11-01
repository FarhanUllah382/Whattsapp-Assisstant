import assert from 'node:assert/strict';
import { test } from 'node:test';

// Live test 2026-11-01: seven customer messages got no reply at all. Two root
// causes: (1) the stock-count backstop vetoed sizes and prices ("size 43 mein
// available hain"), and (2) the fixed fallback was then blocked by the
// near-duplicate check or by the payment-claim wording check. These tests pin
// both fixes and prove a blocked turn still reaches the customer.

process.env.GEMINI_API_KEY = 'TEST-GEMINI-KEY-silent-reply';

import { runTurn } from '../src/agent';
import { chooseFallbackReply } from '../src/agent/customer-turn';
import { db } from '../src/db';
import { PACING_DEFAULTS } from '../src/guardrails/pacing/defaults';
import { checkInventoryDisclosureReply } from '../src/inventory-visibility';
import {
  PAYMENT_CLAIM_PENDING_MESSAGE,
  REFUND_REQUEST_PENDING_MESSAGE,
} from '../src/sensitive-action-wording';

test('sizes, prices and numbers the customer used are not treated as stock counts', () => {
  const allowed: Array<[string, string | undefined]> = [
    ['Ji haan, running shoes size 43 mein available hain. Price Rs. 4,800 hai.', 'size 43 running shoes?'],
    ['Running shoes in size 43 are available.', undefined],
    ['Size 43 is in stock.', undefined],
    ['We have running shoes in size 43 in stock, price Rs 4,800.', undefined],
    ['Black hoodie Rs 800 available hai.', undefined],
    ['Jeans sizes 30, 32 and 34 available hain.', undefined],
    ['Yes, 3 pieces available for your order.', 'Can I get 3 XL black shirts?'],
    ['Basic T-Shirt costs 1,200 rupees and is available.', undefined],
  ];
  for (const [body, inbound] of allowed) {
    assert.deepEqual(checkInventoryDisclosureReply(body, inbound), { ok: true }, body);
  }
});

test('a real exact stock count is still blocked', () => {
  const blocked: Array<[string, string | undefined]> = [
    ['We have 7 pieces left.', 'how many black hoodies?'],
    ['Stock is 12 right now.', undefined],
    ['Size 43 mein sirf 2 pairs left hain.', 'size 43 running shoes?'],
    ['There are 16 hoodies in stock.', undefined],
    ['Only 4 left in XL.', 'Can I get 3 XL black shirts?'],
  ];
  for (const [body, inbound] of blocked) {
    assert.equal(checkInventoryDisclosureReply(body, inbound).ok, false, body);
  }
});

test('fallback uses the exact server status text after a claim or refund action', () => {
  assert.equal(chooseFallbackReply({ paymentClaimPending: true }), PAYMENT_CLAIM_PENDING_MESSAGE);
  assert.equal(chooseFallbackReply({ refundStatus: 'requested' }), REFUND_REQUEST_PENDING_MESSAGE);
  const generic = chooseFallbackReply({});
  assert.match(generic, /Maazrat/);
  assert.doesNotMatch(generic, /\d/);
  assert.doesNotMatch(generic, /ahmed|owner|get back/i);
});

test('a turn whose every reply is blocked still reaches the customer, every time', async () => {
  const originalFetch = globalThis.fetch;
  const originalWindow = { start: PACING_DEFAULTS.windowStartHour, end: PACING_DEFAULTS.windowEndHour };
  PACING_DEFAULTS.windowStartHour = 0;
  PACING_DEFAULTS.windowEndHour = 24;
  // Gemini stub: during the tool loop it always tries to leak an exact count;
  // the closing summary call (no tools) gets an empty JSON object.
  globalThis.fetch = (async (_url: unknown, init?: { body?: string }) => {
    const request = JSON.parse(String(init?.body ?? '{}'));
    const parts = Array.isArray(request.tools) && request.tools.length > 0
      ? [{ functionCall: { name: 'send_message', args: { body: 'We have 7 pieces left in that size.' } } }]
      : [{ text: '{}' }];
    return new Response(JSON.stringify({
      candidates: [{ content: { parts } }],
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;

  const phone = `9230${String(Date.now()).slice(-8)}`;
  const sends: string[] = [];
  try {
    for (let i = 0; i < 3; i += 1) {
      await runTurn(
        phone,
        'How many running shoes of size 43 do u have?',
        async (body) => { sends.push(body); return { providerMessageId: `p-${i}` }; },
        `silent-reply-${phone}-${i}`,
      );
    }
  } finally {
    globalThis.fetch = originalFetch;
    PACING_DEFAULTS.windowStartHour = originalWindow.start;
    PACING_DEFAULTS.windowEndHour = originalWindow.end;
  }

  // One reply per turn, even though the same fallback text repeats.
  assert.equal(sends.length, 3, `expected 3 replies, got ${sends.length}`);
  for (const body of sends) {
    assert.match(body, /Maazrat/);
    assert.doesNotMatch(body, /7 pieces/);
  }
  const customer = db.prepare('select id from customers where phone = ?').get(phone) as { id: number };
  const outbound = db.prepare(
    "select count(*) n from messages where customer_id = ? and direction = 'outbound'",
  ).get(customer.id) as { n: number };
  assert.equal(outbound.n, 3);
});
