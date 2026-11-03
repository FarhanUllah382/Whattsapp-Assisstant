import assert from 'node:assert/strict';
import { test } from 'node:test';

// Re-verifier findings, fix round 2 (2026-11-02). Each test below failed on
// 67071a5 before its fix.

process.env.GEMINI_API_KEY = 'TEST-GEMINI-KEY-fix-round-2';
for (const key of Object.keys(process.env)) {
  if (key.startsWith('PAYMENT_')) delete process.env[key];
}

import { runTurn } from '../src/agent';
import { checkHoldingMessageReply } from '../src/agent/send-guards';
import { db } from '../src/db';
import { PACING_DEFAULTS } from '../src/guardrails/pacing/defaults';
import { rupeesToMinor } from '../src/money';
import { METRIC, readCounter } from '../src/obs/metrics';
import { normalizeOutgoingBody } from '../src/outbound-format';
import { checkUnconfiguredPaymentMethodReply } from '../src/payment-instructions';
import { canonicalPaymentMethod, recordPaymentClaim } from '../src/payments';
import { createNotifyOwnerTool, isDiscountRequest } from '../src/tools/handoff';

function setPacingWindow(start: number, end: number): () => void {
  const original = { start: PACING_DEFAULTS.windowStartHour, end: PACING_DEFAULTS.windowEndHour, sunday: PACING_DEFAULTS.allowSunday };
  PACING_DEFAULTS.windowStartHour = start;
  PACING_DEFAULTS.windowEndHour = end;
  PACING_DEFAULTS.allowSunday = true;
  return () => {
    PACING_DEFAULTS.windowStartHour = original.start;
    PACING_DEFAULTS.windowEndHour = original.end;
    PACING_DEFAULTS.allowSunday = original.sunday;
  };
}

/** A one-hour window that starts two hours from now (shop timezone): sends are outside it. */
function closePacingWindow(): () => void {
  const hour = Number(new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit', hourCycle: 'h23', timeZone: PACING_DEFAULTS.timezone,
  }).format(new Date()));
  return setPacingWindow((hour + 2) % 24, (hour + 3) % 24 || 24);
}

let seq = 0;
function newCustomer(): { phone: string; customerId: number } {
  seq += 1;
  const phone = `9237${String(Date.now()).slice(-6)}${String(seq).padStart(3, '0')}`;
  const customerId = Number(
    db.prepare("insert into customers (phone, disclosure_sent_at) values (?, datetime('now'))").run(phone).lastInsertRowid,
  );
  db.prepare("insert into checkpoints (customer_id, summary, updated_at) values (?, ?, datetime('now', '-1 hour'))")
    .run(customerId, 'Customer browses hoodies; nothing ordered or owed.');
  return { phone, customerId };
}

type Part = { functionCall: { name: string; args: Record<string, unknown> } } | { text: string };
const fc = (name: string, args: Record<string, unknown> = {}): Part => ({ functionCall: { name, args } });

async function scriptedTurn(input: {
  phone: string;
  inbound: string;
  loop: Part[][];
  pacing?: 'open' | 'closed';
}): Promise<{ loopCalls: number; sends: string[] }> {
  const originalFetch = globalThis.fetch;
  const restore = input.pacing === 'closed' ? closePacingWindow() : setPacingWindow(0, 24);
  let loopCalls = 0;
  globalThis.fetch = (async (_url: unknown, init?: { body?: string }) => {
    const request = JSON.parse(String(init?.body ?? '{}'));
    let parts: unknown[];
    if (Array.isArray(request.tools) && request.tools.length > 0) {
      parts = input.loop[loopCalls] ?? [{ text: 'done' }];
      loopCalls += 1;
    } else {
      parts = [{ text: JSON.stringify({ summary: 's', new_notes: [], unlogged_order: null, unlogged_payment: null }) }];
    }
    return new Response(JSON.stringify({
      candidates: [{ content: { parts } }],
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  const sends: string[] = [];
  try {
    await runTurn(
      input.phone,
      input.inbound,
      async (body) => { sends.push(body); return { providerMessageId: `fr2-${input.phone}-${sends.length}` }; },
      `fr2-${input.phone}-${seq}`,
    );
  } finally {
    globalThis.fetch = originalFetch;
    restore();
  }
  return { loopCalls, sends };
}

const handoffCount = (customerId: number) =>
  (db.prepare("select count(*) n from handoff_ledger where customer_id = ? and reason not like 'Bot %'").get(customerId) as { n: number }).n;

// ── A. Holding messages are vetoed; the real reply is delivered ──────────

test('a holding-only message is vetoed with teaching text', () => {
  for (const text of [
    'Ek minute, main dekhta hoon.', 'Ek second, check karta hoon', 'Main check karti hoon',
    'Let me check that for you.', 'One moment please', 'Hold on, checking.',
    'Please wait while I check.', 'Ek lamha, main pata karta hoon',
  ]) {
    const result = checkHoldingMessageReply(text);
    assert.equal(result.ok, false, text);
    if (!result.ok) assert.match(result.error, /Do not send a holding message\. Call the tools you need first, then send one complete reply\./);
  }
});

test('substantive replies that mention waiting or checking are not vetoed', () => {
  for (const text of [
    'thoda wait karein, rider raste mein hai',
    'Please wait 2-3 din, delivery ho jayegi',
    'Hum dekhte hain',
    'I will check with Ahmed',
    'Ek minute, black hoodie medium available hai, price Rs 2,500.',
    'Let me check — kaunsa size chahiye aap ko?',
    'Ji haan, black hoodie available hai.',
    'Running shoes ki price Rs 4,800 hai.',
  ]) {
    assert.equal(checkHoldingMessageReply(text).ok, true, text);
  }
});

test('a vetoed holding message is retried in the same turn: handoff recorded and the real reply delivered', async () => {
  const { phone, customerId } = newCustomer();
  const result = await scriptedTurn({
    phone,
    inbound: 'Mere parcel mein ek item kam hai',
    loop: [
      [fc('send_message', { body: 'Ek minute, main dekhta hoon.' })],
      [fc('notify_owner', { reason: 'Customer reports an item missing from the delivered parcel.' })],
      // The real reply after a handoff is the exact server handoff status.
      [fc('send_handoff_status')],
    ],
  });
  assert.equal(handoffCount(customerId), 1, 'the handoff must be recorded');
  assert.equal(result.sends.length, 1, JSON.stringify(result.sends));
  assert.match(result.sends[0], /Ahmed/, 'the delivered reply is the real handoff status');
  assert.ok(!result.sends.some((s) => /ek minute|dekhta hoon/i.test(s)), 'the holding text never reaches the customer');
  assert.equal(result.loopCalls, 3);
});

test('a delivered reply ends the loop, but the rest of THAT response still runs ([send_message, notify_owner])', async () => {
  const { phone, customerId } = newCustomer();
  const result = await scriptedTurn({
    phone,
    inbound: 'Mera size galat aya hai',
    loop: [
      [
        fc('send_message', { body: 'Maafi chahta hoon, yeh galat hua.' }),
        fc('notify_owner', { reason: 'Customer received the wrong size.' }),
      ],
      [fc('send_message', { body: 'A second reply that must never be requested.' })],
    ],
  });
  assert.equal(handoffCount(customerId), 1, 'notify_owner after the reply in the same response must run');
  assert.deepEqual(result.sends, ['Maafi chahta hoon, yeh galat hua.']);
  assert.equal(result.loopCalls, 1, 'no extra model call after the reply');
});

// ── B. Discount detection ────────────────────────────────────────────────

test('price-reduction phrasing is a discount question unless a complaint signal is present', () => {
  for (const text of [
    'kuch kam ho jayega?', 'kam kar do bhai', 'sasta kar do', 'is it on sale?', 'koi offer hai?',
    'thora kam ho sakta hai?', 'best price batao', 'last price kya hai?', 'koi deal hai?', 'sasti kar do na',
    'Koi discount hn iss pa ?', 'price kam kar do', '10% off?',
  ]) {
    assert.equal(isDiscountRequest(text), true, text);
  }
  for (const text of [
    'Mere parcel mein ek item kam hai', 'order mein ek item kam aya hai', 'parcel kam aaya',
    'item damaged hai, kuch kam kar do', 'wrong item aya, sasta kar do ya refund', 'size thora kam hai',
    'drop it off at my door', 'one item less in my parcel',
  ]) {
    assert.equal(isDiscountRequest(text), false, text);
  }
});

test('"kam kar do bhai" (plain) gets the discount policy first; a complaint is still handed off', async () => {
  const tool = createNotifyOwnerTool();
  const plain = newCustomer();
  const refused = await tool.execute(
    { reason: 'Customer asks for a discount / lower price.' },
    { customerId: plain.customerId, inboundText: 'kam kar do bhai' },
  ) as { ok: boolean };
  assert.equal(refused.ok, false);

  const complaint = newCustomer();
  const handed = await tool.execute(
    { reason: 'Customer says one item is missing from the order; wants the price reduced.' },
    { customerId: complaint.customerId, inboundText: 'order mein ek item kam aya hai' },
  ) as { ok: boolean; error?: string };
  assert.equal(handed.ok, true, handed.error);
});

// ── C. Duplicate payment claims ──────────────────────────────────────────

function newOrder(customerId: number, paymentMethod: string): number {
  return Number(db.prepare(`
    insert into orders (customer_id, items_json, total_minor, payment_method, status)
    values (?, '[]', ?, ?, 'confirmed')
  `).run(customerId, rupeesToMinor(800), paymentMethod).lastInsertRowid);
}
const claims = (customerId: number) =>
  (db.prepare('select count(*) n from payment_claims where customer_id = ?').get(customerId) as { n: number }).n;

test('payment methods are canonicalised from free text', () => {
  assert.equal(canonicalPaymentMethod('JazzCash'), 'jazzcash');
  assert.equal(canonicalPaymentMethod('jazzcash se'), 'jazzcash');
  assert.equal(canonicalPaymentMethod('Jazz Cash account'), 'jazzcash');
  assert.equal(canonicalPaymentMethod('easy paisa'), 'easypaisa');
  assert.equal(canonicalPaymentMethod('Bank Transfer '), 'bank_transfer');
  assert.equal(canonicalPaymentMethod('Meezan bank'), 'bank_transfer');
  assert.equal(canonicalPaymentMethod('cash on delivery'), 'cod');
  assert.equal(canonicalPaymentMethod(undefined), 'unknown');
  assert.equal(canonicalPaymentMethod('online'), 'unknown');
});

test('one Rs 800 payment told four ways makes ONE pending claim', () => {
  const { customerId } = newCustomer();
  const orderId = newOrder(customerId, 'jazzcash');
  const a = recordPaymentClaim({ customerId, orderId, amount: 800, method: 'JazzCash', eventKey: `fr2-c1-${seq}` });
  const b = recordPaymentClaim({ customerId, orderId, amount: 800, method: 'jazzcash se', eventKey: `fr2-c2-${seq}` });
  const c = recordPaymentClaim({ customerId, orderId, amount: 800, eventKey: `fr2-c3-${seq}` });
  const d = recordPaymentClaim({ customerId, amount: 800, inferMethodFromOrders: true, eventKey: `fr2-c4-${seq}` });
  assert.equal(claims(customerId), 1);
  for (const outcome of [b, c, d]) {
    assert.equal(outcome.claim.id, a.claim.id);
    assert.equal(outcome.duplicate, true);
  }
});

test('a second instalment (different amount, same order) and a different known method are new claims', () => {
  const { customerId } = newCustomer();
  const orderId = newOrder(customerId, 'jazzcash');
  recordPaymentClaim({ customerId, orderId, amount: 400, method: 'jazzcash', eventKey: `fr2-i1-${seq}` });
  recordPaymentClaim({ customerId, orderId, amount: 400 + 400, method: 'jazzcash', eventKey: `fr2-i2-${seq}` });
  assert.equal(claims(customerId), 2);
  recordPaymentClaim({ customerId, orderId, amount: 400, method: 'Easypaisa', eventKey: `fr2-i3-${seq}` });
  assert.equal(claims(customerId), 3, 'same amount via another known method is a different payment');
});

// ── D. Default-ignorable / format characters ─────────────────────────────

test('soft hyphen, LRM, invisible separator, CGJ etc. are removed and cannot dodge the payment-method guard', () => {
  const env = {} as NodeJS.ProcessEnv;
  for (const ch of ['­', '‎', '‏', '⁣', '͏', '⁡', '᠎', '‪', '⁦', '︀', '\u{E0041}']) {
    const body = normalizeOutgoingBody(`You can pay via Jazz${ch}Cash.`, env);
    assert.equal(body, 'You can pay via JazzCash.', `U+${ch.codePointAt(0)!.toString(16)}`);
    assert.equal(checkUnconfiguredPaymentMethodReply(body, env).ok, false);
  }
  // ZWJ / VS16 survive only inside an allowed emoji sequence.
  const allow = { ALLOW_EMOJI: 'true' } as NodeJS.ProcessEnv;
  assert.equal(normalizeOutgoingBody('Hi 👨‍👩‍👧 ❤️', allow), 'Hi 👨‍👩‍👧 ❤️');
  assert.equal(normalizeOutgoingBody('Jazz‍Cash and Easy️paisa', allow), 'JazzCash and Easypaisa');
  assert.equal(normalizeOutgoingBody('Hi 👨‍👩‍👧 there ❤️', env), 'Hi there');
});

test('a sent reply has the soft hyphen removed on the wire', async () => {
  const { phone } = newCustomer();
  const result = await scriptedTurn({
    phone,
    inbound: 'COD hai?',
    loop: [[fc('send_message', { body: 'Ji, COD avail­able hai.' })]],
  });
  assert.deepEqual(result.sends, ['Ji, COD available hai.']);
});

// ── E. Pacing-held replies are dropped, so they are no_reply ─────────────

test('a reply held by pacing is never resent, so the turn counts as no_reply (not silenced)', async () => {
  const { phone } = newCustomer();
  const silencedBefore = readCounter(METRIC.turns, { turn_kind: 'customer', outcome: 'silenced' });
  const noReplyBefore = readCounter(METRIC.turns, { turn_kind: 'customer', outcome: 'no_reply' });
  const result = await scriptedTurn({
    phone,
    inbound: 'Black hoodie available hai?',
    loop: [[fc('send_message', { body: 'Ji haan, available hai.' })]],
    pacing: 'closed',
  });
  assert.equal(result.sends.length, 0);
  assert.equal(readCounter(METRIC.turns, { turn_kind: 'customer', outcome: 'no_reply' }), noReplyBefore + 1);
  assert.equal(readCounter(METRIC.turns, { turn_kind: 'customer', outcome: 'silenced' }), silencedBefore);
});
