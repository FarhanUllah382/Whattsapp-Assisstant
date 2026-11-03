import assert from 'node:assert/strict';
import { test } from 'node:test';

// Independent-verifier findings (2026-11-02). Each test below failed on the
// code at 2e0c2ad before its fix.

process.env.GEMINI_API_KEY = 'TEST-GEMINI-KEY-verifier-fixes';
for (const key of Object.keys(process.env)) {
  if (key.startsWith('PAYMENT_')) delete process.env[key];
}

import { runTurn } from '../src/agent';
import { ChannelSessionMonitor } from '../src/channel/session-monitor';
import { ChannelSendError } from '../src/channel/types';
import { WahaAdapter } from '../src/channel/waha';
import { db } from '../src/db';
import { PACING_DEFAULTS } from '../src/guardrails/pacing/defaults';
import { MidTurnChannelDeferrals } from '../src/inbound-jobs';
import { rupeesToMinor } from '../src/money';
import {
  METRIC,
  readCounter,
  recordToolCallMetric,
  recordTurnMetric,
  KNOWN_TOOL_NAMES,
  renderPrometheus,
  setWhatsappDownSeconds,
} from '../src/obs/metrics';
import { isHoldingOnlyMessage, normalizeOutgoingBody } from '../src/outbound-format';
import { checkUnconfiguredPaymentMethodReply } from '../src/payment-instructions';
import { createPaymentClaim } from '../src/payments';
import { createNotifyOwnerTool, isDiscountRequest } from '../src/tools/handoff';
import { baseTools, ownerTools } from '../src/tools';
import { prepareOrder } from '../src/tools/orders';

function openPacingWindow(): () => void {
  const original = { start: PACING_DEFAULTS.windowStartHour, end: PACING_DEFAULTS.windowEndHour };
  PACING_DEFAULTS.windowStartHour = 0;
  PACING_DEFAULTS.windowEndHour = 24;
  return () => {
    PACING_DEFAULTS.windowStartHour = original.start;
    PACING_DEFAULTS.windowEndHour = original.end;
  };
}

let seq = 0;
function newCustomer(withCheckpoint = true): { phone: string; customerId: number } {
  seq += 1;
  const phone = `9239${String(Date.now()).slice(-6)}${String(seq).padStart(3, '0')}`;
  const customerId = Number(
    db.prepare("insert into customers (phone, disclosure_sent_at) values (?, datetime('now'))").run(phone).lastInsertRowid,
  );
  if (withCheckpoint) {
    db.prepare("insert into checkpoints (customer_id, summary, updated_at) values (?, ?, datetime('now', '-1 hour'))")
      .run(customerId, 'Customer browses hoodies; nothing ordered or owed.');
  }
  return { phone, customerId };
}

function newOrder(customerId: number, paymentMethod: string, status: string) {
  return Number(db.prepare(`
    insert into orders (customer_id, items_json, total_minor, payment_method, status)
    values (?, '[]', ?, ?, ?)
  `).run(customerId, rupeesToMinor(800), paymentMethod, status).lastInsertRowid);
}

type Part = { functionCall: { name: string; args: Record<string, unknown> } };
const fc = (name: string, args: Record<string, unknown> = {}): Part => ({ functionCall: { name, args } });

/** Runs one customer turn against scripted LOOP responses and a fixed CLOSE JSON. */
async function scriptedTurn(input: {
  phone: string;
  inbound: string;
  loop: Part[][];
  closeJson?: Record<string, unknown>;
}): Promise<{ loopCalls: number; closeCalls: number; sends: string[] }> {
  const originalFetch = globalThis.fetch;
  const restore = openPacingWindow();
  let loopCalls = 0;
  let closeCalls = 0;
  globalThis.fetch = (async (_url: unknown, init?: { body?: string }) => {
    const request = JSON.parse(String(init?.body ?? '{}'));
    let parts: unknown[];
    if (Array.isArray(request.tools) && request.tools.length > 0) {
      const scripted = input.loop[loopCalls];
      loopCalls += 1;
      parts = scripted ?? [{ text: 'done' }];
    } else {
      closeCalls += 1;
      parts = [{ text: JSON.stringify(input.closeJson ?? { summary: 's', new_notes: [], unlogged_order: null, unlogged_payment: null }) }];
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
      async (body) => { sends.push(body); return { providerMessageId: `vf-${input.phone}-${sends.length}` }; },
      `vf-${input.phone}-${seq}`,
    );
  } finally {
    globalThis.fetch = originalFetch;
    restore();
  }
  return { loopCalls, closeCalls, sends };
}

const handoffCount = (customerId: number) =>
  (db.prepare('select count(*) n from handoff_ledger where customer_id = ?').get(customerId) as { n: number }).n;
const claimCount = (customerId: number) =>
  (db.prepare('select count(*) n from payment_claims where customer_id = ?').get(customerId) as { n: number }).n;

// ── 1. A holding reply must not end the turn ─────────────────────────────

test('a holding reply ("Ek minute, main dekhta hoon") is vetoed, so the planned notify_owner runs and CLOSE runs', async () => {
  // Fix round 2: the holding text is vetoed (holding_message guard) instead
  // of being delivered; the model's next steps record the handoff and send
  // the one real reply.
  const { phone, customerId } = newCustomer();
  const result = await scriptedTurn({
    phone,
    inbound: 'Mere parcel mein ek item kam hai',
    loop: [
      [fc('send_message', { body: 'Ek minute, main dekhta hoon.' })],
      [fc('notify_owner', { reason: 'Customer reports an item missing from the delivered parcel.' })],
      [fc('send_handoff_status')],
    ],
  });
  assert.equal(handoffCount(customerId), 1, 'the planned handoff must be recorded');
  assert.equal(result.loopCalls, 3);
  assert.equal(result.sends.length, 1);
  assert.doesNotMatch(result.sends[0], /ek minute/i, 'the holding text is never delivered');
  assert.equal(result.closeCalls, 1, 'CLOSE must run for a missing-item complaint');
});

test('holding-message detection covers English and Roman Urdu, not ordinary answers', () => {
  for (const text of [
    'Ek minute, main dekhta hoon.', 'Ek second, check karta hoon', 'Main check karti hoon',
    'Let me check that for you.', 'One moment please', 'Hold on, checking.', 'Thora wait karein',
  ]) {
    assert.equal(isHoldingOnlyMessage(text), true, text);
  }
  for (const text of ['Ji haan, black hoodie available hai.', 'Running shoes ki price Rs 4,800 hai.', 'Walaikum assalam!']) {
    assert.equal(isHoldingOnlyMessage(text), false, text);
  }
});

test('an ordinary delivered reply still ends the loop at once (cost unchanged)', async () => {
  const { phone } = newCustomer();
  const result = await scriptedTurn({
    phone,
    inbound: 'Black hoodie medium mein available hai?',
    loop: [
      [fc('send_message', { body: 'Ji haan, available hai.' })],
      [fc('send_message', { body: 'Second message that must never be sent.' })],
    ],
  });
  assert.equal(result.loopCalls, 1);
  assert.deepEqual(result.sends, ['Ji haan, available hai.']);
  assert.equal(result.closeCalls, 0);
});

test('missing-item / complaint wording forces the CLOSE call', async () => {
  const { hasCloseSignal } = await import('../src/agent/turn-close');
  for (const text of ['Mere parcel mein ek item kam hai', 'one item is missing', 'Ahmed se baat karni hai', 'I want to talk to the owner']) {
    assert.equal(hasCloseSignal(text), true, text);
  }
});

// ── 2. Discount detection must not swallow complaints ────────────────────

test('a missing-item complaint ("ek item kam hai") is handed off, not refused as a discount question', async () => {
  const { customerId } = newCustomer();
  const tool = createNotifyOwnerTool();
  const result = await tool.execute(
    { reason: 'Customer says one item is kam (missing) from the parcel; less items than ordered.' },
    { customerId, inboundText: 'Mere parcel mein ek item kam hai' },
  ) as { ok: boolean; error?: string };
  assert.equal(result.ok, true, result.error);
  assert.equal(handoffCount(customerId), 1);
});

test('discount detection uses real discount words from the customer text only', () => {
  for (const text of ['Koi discount hn iss pa ?', 'riayat ho sakti hai?', 'kuch chhoot milegi?', 'price kam kar do', 'rate thora kam kardo', 'qeemat kam kar dein', '10% off?']) {
    assert.equal(isDiscountRequest(text), true, text);
  }
  for (const text of ['Mere parcel mein ek item kam hai', 'size thora kam hai', 'one item less in my parcel', 'drop it off at my door']) {
    assert.equal(isDiscountRequest(text), false, text);
  }
});

// ── 3. Emoji stripping must not glue words ───────────────────────────────

test('emoji stripping keeps word boundaries and keeps ®/™/©', () => {
  const env = {} as NodeJS.ProcessEnv;
  assert.equal(normalizeOutgoingBody('Thank you😊 Kya', env), 'Thank you Kya');
  assert.equal(normalizeOutgoingBody('Thank you😊Kya', env), 'Thank you Kya');
  assert.equal(normalizeOutgoingBody('Nike® shoes', env), 'Nike® shoes');
  assert.equal(normalizeOutgoingBody('Brand™ and © 2026', env), 'Brand™ and © 2026');
  assert.equal(normalizeOutgoingBody('Hi 😊 there', env), 'Hi there');
  assert.equal(normalizeOutgoingBody('👍 Done\n🙏Shukriya 🙏', env), 'Done\nShukriya');
});

// ── 4. WAHA 422 classification + mid-turn deferral cap ───────────────────

test('only the WAHA session-status 422 is channel_unavailable; other 422s mentioning "session" are rejections', async () => {
  const originalFetch = globalThis.fetch;
  try {
    const adapter = new WahaAdapter({ baseUrl: 'http://test.invalid', session: 'test' });
    globalThis.fetch = async () => new Response(
      JSON.stringify({ statusCode: 422, message: 'Invalid chatId for session default' }),
      { status: 422 },
    );
    let error: unknown;
    try { await adapter.sendText('923001234567', 'hello'); } catch (caught) { error = caught; }
    assert.ok(error instanceof ChannelSendError);
    assert.notEqual(error.code, 'channel_unavailable');

    globalThis.fetch = async () => new Response(
      JSON.stringify({ statusCode: 422, message: 'SESSION STATUS IS NOT AS EXPECTED', status: 'STARTING' }),
      { status: 422 },
    );
    error = undefined;
    try { await adapter.sendText('923001234567', 'hello'); } catch (caught) { error = caught; }
    assert.ok(error instanceof ChannelSendError);
    assert.equal(error.code, 'channel_unavailable');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('mid-turn channel deferrals are capped per job and never used while the session is WORKING', () => {
  const tracker = new MidTurnChannelDeferrals(3);
  assert.equal(tracker.decide(1, { working: true }), 'fail', 'WORKING at defer time consumes an attempt');
  assert.equal(tracker.decide(2, { working: false }), 'defer');
  assert.equal(tracker.decide(2, { working: false }), 'defer');
  assert.equal(tracker.decide(2, { working: false }), 'defer');
  assert.equal(tracker.decide(2, { working: false }), 'fail', 'cap reached');
  assert.equal(tracker.decide(3, { working: false }), 'defer', 'other jobs keep their own budget');
  tracker.clear(2);
  assert.equal(tracker.decide(2, { working: false }), 'defer');
});

// ── 5. Duplicate payment claims ──────────────────────────────────────────

test('a second instalment (same order, different amount) and a different method are new claims', () => {
  const { customerId } = newCustomer(false);
  const orderId = newOrder(customerId, 'bank_transfer', 'confirmed');
  const first = createPaymentClaim({ customerId, orderId, amount: 400, method: 'bank transfer', eventKey: `vf-i1-${seq}` });
  const second = createPaymentClaim({ customerId, orderId, amount: 400 + 1, method: 'bank transfer', eventKey: `vf-i2-${seq}` });
  assert.notEqual(second.id, first.id, 'different amount is a different payment');
  const sameAgain = createPaymentClaim({ customerId, orderId, amount: 400, method: 'Bank Transfer ', eventKey: `vf-i3-${seq}` });
  assert.equal(sameAgain.id, first.id, 'same order + amount + method (case/space-insensitive) is a duplicate');

  const noOrder = newCustomer(false).customerId;
  const a = createPaymentClaim({ customerId: noOrder, amount: 1500, method: 'easypaisa', eventKey: `vf-n1-${seq}` });
  const b = createPaymentClaim({ customerId: noOrder, amount: 1500, method: 'jazzcash', eventKey: `vf-n2-${seq}` });
  assert.notEqual(b.id, a.id, 'same amount via another method is a different payment');
  const c = createPaymentClaim({ customerId: noOrder, amount: 1500, method: 'easypaisa', eventKey: `vf-n3-${seq}` });
  assert.equal(c.id, a.id);
  assert.equal(claimCount(noOrder), 2);
});

// ── 6. Payment-method schema + CLOSE safety-net COD rule ─────────────────

test('prepare_order advertises only configured payment methods (COD always)', () => {
  const methods = () => (prepareOrder.input_schema as any).properties.payment_method.enum as string[];
  assert.deepEqual(methods(), ['cod']);
  process.env.PAYMENT_JAZZCASH_ACCOUNT_NAME = 'Test Store';
  process.env.PAYMENT_JAZZCASH_NUMBER = '03001234567';
  try {
    assert.deepEqual(methods(), ['cod', 'jazzcash']);
  } finally {
    delete process.env.PAYMENT_JAZZCASH_ACCOUNT_NAME;
    delete process.env.PAYMENT_JAZZCASH_NUMBER;
  }
  assert.deepEqual(methods(), ['cod']);
});

test('the CLOSE safety net records no payment claim for an undelivered COD order', async () => {
  const { phone, customerId } = newCustomer();
  newOrder(customerId, 'cod', 'confirmed');
  await scriptedTurn({
    phone,
    inbound: 'Maine 800 rupay de diye hain',
    loop: [[fc('send_message', { body: 'Shukriya, aap ka order deliver hone par rider ko cash dein.' })]],
    closeJson: { summary: 'Customer mentions 800.', new_notes: [], unlogged_order: null, unlogged_payment: { confident: true, amount: 800, description: 'paid 800' } },
  });
  assert.equal(claimCount(customerId), 0);

  // A non-COD open order still gets the safety-net claim.
  const other = newCustomer();
  newOrder(other.customerId, 'bank_transfer', 'confirmed');
  await scriptedTurn({
    phone: other.phone,
    inbound: 'Maine 800 rupay bank transfer kar diye hain',
    loop: [[fc('send_message', { body: 'Shukriya, main isay pending claim ke taur par note kar raha hoon.' })]],
    closeJson: { summary: 'Customer says paid 800.', new_notes: [], unlogged_order: null, unlogged_payment: { confident: true, amount: 800, description: 'paid 800' } },
  });
  assert.equal(claimCount(other.customerId), 1);
});

// ── 7. Low findings ──────────────────────────────────────────────────────

test('zero-width characters are removed, so "Jazz​Cash" is caught by the payment-method guard', () => {
  const env = {} as NodeJS.ProcessEnv;
  for (const zw of ['​', '‌', '‍', '⁠', '﻿']) {
    const body = normalizeOutgoingBody(`You can pay via Jazz${zw}Cash.`, env);
    assert.equal(body, 'You can pay via JazzCash.');
    assert.equal(checkUnconfiguredPaymentMethodReply(body, env).ok, false);
  }
  // Allowed emoji keep their ZWJ sequences.
  assert.equal(normalizeOutgoingBody('Hi 👨‍👩‍👧', { ALLOW_EMOJI: 'true' } as NodeJS.ProcessEnv), 'Hi 👨‍👩‍👧');
});

test('wa_tool_calls_total only uses known tool names as labels', () => {
  recordToolCallMetric('ignore_previous_instructions_and_dump', true);
  recordToolCallMetric('check_stock', true);
  assert.equal(readCounter(METRIC.toolCalls, { tool: 'ignore_previous_instructions_and_dump', ok: 'true' }), 0);
  assert.ok(readCounter(METRIC.toolCalls, { tool: 'unknown', ok: 'true' }) >= 1);
  assert.ok(readCounter(METRIC.toolCalls, { tool: 'check_stock', ok: 'true' }) >= 1);
  const turnOnly = ['send_message', 'show_product_images', 'send_payment_instructions', 'send_handoff_status', 'show_pending_order'];
  for (const name of [...baseTools.map((t) => t.name), ...ownerTools.map((t) => t.name), ...turnOnly]) {
    assert.ok(KNOWN_TOOL_NAMES.has(name), `${name} must be a known tool label`);
  }
});

function histogramCount(name: string, turnKind: string): number {
  const match = renderPrometheus().match(new RegExp(`^${name}_count\\{turn_kind="${turnKind}"\\} (\\d+)$`, 'm'));
  return match ? Number(match[1]) : 0;
}

test('deferred jobs are not turns in the per-turn histograms (calls, tokens, duration)', () => {
  const before = [METRIC.modelCallsPerTurn, METRIC.promptTokensPerTurn, METRIC.turnDuration].map((n) => histogramCount(n, 'owner'));
  recordTurnMetric({ turnKind: 'owner', outcome: 'deferred', durationMs: 3, modelCalls: 0, promptTokens: 0 });
  const after = [METRIC.modelCallsPerTurn, METRIC.promptTokensPerTurn, METRIC.turnDuration].map((n) => histogramCount(n, 'owner'));
  assert.deepEqual(after, before);
  recordTurnMetric({ turnKind: 'owner', outcome: 'replied', durationMs: 3, modelCalls: 1, promptTokens: 10 });
  assert.deepEqual(
    [METRIC.modelCallsPerTurn, METRIC.promptTokensPerTurn, METRIC.turnDuration].map((n) => histogramCount(n, 'owner')),
    before.map((n) => n + 1),
  );
});

test('an opted-out customer is an intentional silence (outcome silenced), not no_reply', async () => {
  const { phone, customerId } = newCustomer();
  db.prepare('update customers set automation_opted_out = 1 where id = ?').run(customerId);
  const silencedBefore = readCounter(METRIC.turns, { turn_kind: 'customer', outcome: 'silenced' });
  const noReplyBefore = readCounter(METRIC.turns, { turn_kind: 'customer', outcome: 'no_reply' });
  const result = await scriptedTurn({
    phone,
    inbound: 'Black hoodie available hai?',
    loop: [[fc('send_message', { body: 'Ji haan, available hai.' })]],
  });
  assert.equal(result.sends.length, 0);
  assert.equal(readCounter(METRIC.turns, { turn_kind: 'customer', outcome: 'silenced' }), silencedBefore + 1);
  assert.equal(readCounter(METRIC.turns, { turn_kind: 'customer', outcome: 'no_reply' }), noReplyBefore);
});

test('a long outage logs once via onLongOutage and drives wa_whatsapp_down_seconds', async () => {
  let clock = Date.parse('2026-11-02T06:00:00Z');
  const downSeconds: number[] = [];
  let longOutages = 0;
  const monitor = new ChannelSessionMonitor({
    source: async () => ({ status: 'FAILED', working: false, checkedAt: new Date(clock) }),
    now: () => new Date(clock),
    onLongOutage: () => { longOutages += 1; },
    onDownSeconds: (seconds) => { downSeconds.push(seconds); setWhatsappDownSeconds(seconds); },
  });
  await monitor.check();
  clock += 301_000;
  await monitor.check();
  clock += 60_000;
  await monitor.check();
  assert.equal(longOutages, 1);
  assert.deepEqual(downSeconds, [0, 301, 361]);
  assert.match(renderPrometheus(), /^wa_whatsapp_down_seconds 361$/m);
});
