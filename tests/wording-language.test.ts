import assert from 'node:assert/strict';
import { test } from 'node:test';

// FIX4 (live 2026-11-01/02): a Roman Urdu human promise slipped past the
// guard, the handoff confirmation went out in English to a Roman Urdu
// customer, replies carried literal "\n\n" and emojis, and a plain discount
// question was handed straight to Ahmed instead of getting the policy answer.

process.env.GEMINI_API_KEY = 'TEST-GEMINI-KEY-wording-language';

import { runTurn } from '../src/agent';
import { chooseFallbackReply } from '../src/agent/customer-turn';
import { makeSendMessageTool } from '../src/agent/send-guards';
import { db } from '../src/db';
import { detectHumanPromise } from '../src/guardrails/human-promise';
import { PACING_DEFAULTS } from '../src/guardrails/pacing/defaults';
import { buildHandoffStatusMessage, checkHandoffClaimReply } from '../src/handoff-claims';
import { checkRefundCompletionClaim } from '../src/refunds';
import {
  PAYMENT_CLAIM_PENDING_MESSAGE,
  checkSensitiveActionReply,
  type RefundCustomerStatus,
  type SensitiveActionFacts,
} from '../src/sensitive-action-wording';

const LIVE_ROMAN_URDU_DISCOUNT_QUESTION = 'Koi discount hn iss pa ?';
const LIVE_ENGLISH_HANDOFF_TEXT = "Your request has been recorded, and an alert was sent to Ahmed's WhatsApp.";

function newCustomer(label: string): number {
  return Number(
    db.prepare('insert into customers (phone) values (?)')
      .run(`wording-${label}-${Date.now()}-${Math.random()}`).lastInsertRowid,
  );
}

function openPacingWindow(): () => void {
  const original = { start: PACING_DEFAULTS.windowStartHour, end: PACING_DEFAULTS.windowEndHour };
  PACING_DEFAULTS.windowStartHour = 0;
  PACING_DEFAULTS.windowEndHour = 24;
  return () => {
    PACING_DEFAULTS.windowStartHour = original.start;
    PACING_DEFAULTS.windowEndHour = original.end;
  };
}

type LoopStep = (lastContent: string) => unknown[];

/** Gemini stub in the tests/silent-reply.test.ts style: scripted tool loop, empty CLOSE. */
async function withGeminiStub<T>(steps: LoopStep[], run: () => Promise<T>): Promise<T> {
  const originalFetch = globalThis.fetch;
  const restorePacing = openPacingWindow();
  let loopCalls = 0;
  globalThis.fetch = (async (_url: unknown, init?: { body?: string }) => {
    const request = JSON.parse(String(init?.body ?? '{}'));
    let parts: unknown[];
    if (Array.isArray(request.tools) && request.tools.length > 0) {
      const step = steps[Math.min(loopCalls, steps.length - 1)];
      loopCalls += 1;
      const contents = Array.isArray(request.contents) ? request.contents : [];
      parts = step(JSON.stringify(contents[contents.length - 1] ?? {}));
    } else {
      parts = [{ text: '{}' }];
    }
    return new Response(JSON.stringify({
      candidates: [{ content: { parts } }],
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  try {
    return await run();
  } finally {
    globalThis.fetch = originalFetch;
    restorePacing();
  }
}

const call = (name: string, args: Record<string, unknown> = {}) => [{ functionCall: { name, args } }];

// ── 1. Human-promise guard: Roman Urdu / Urdu ──────────────────────────

test('Roman Urdu and Urdu human promises are detected, including the exact live sentence', () => {
  const promises = [
    'Woh jald hi aap se rabta karein ge!',
    'Woh jald hi aap se rabta karenge.',
    'Ahmed aap se contact karein ge.',
    'Owner aapko call karein ge.',
    'Ahmed bhai jald jawab denge.',
    'Ahmed bhai aap se baat karein ge.',
    'Hum wapas aap ko batayen ge.',
    'Woh aapko bata dein ge.',
    'Ahmed sahab confirm karein ge.',
    'وہ جلد آپ سے رابطہ کریں گے۔',
    'احمد بھائی آپ کو جواب دیں گے',
  ];
  for (const body of promises) {
    assert.equal(detectHumanPromise(body), true, body);
    assert.equal(checkHandoffClaimReply(body).ok, false, body);
  }
});

test('truthful or unrelated Roman Urdu is not treated as a human promise', () => {
  const allowed = [
    'Maine Ahmed ko alert bhej diya hai.',
    'Black hoodie Rs 800 mein available hai.',
    'Aapka order 3 se 5 din mein deliver ho jaye ga.',
    'Yeh rang aapko zaroor pasand aaye ga.',
    'Aap kis size mein lena chahen ge?',
  ];
  for (const body of allowed) {
    assert.equal(detectHumanPromise(body), false, body);
  }
});

// ── 2. Language of fixed server texts ──────────────────────────────────

test('customer language detection uses a simple Roman Urdu word heuristic', async () => {
  const { detectCustomerLanguage } = await import('../src/customer-language');
  assert.equal(detectCustomerLanguage(LIVE_ROMAN_URDU_DISCOUNT_QUESTION), 'roman_ur');
  assert.equal(detectCustomerLanguage('Bhai is ka price kya hai?'), 'roman_ur');
  assert.equal(detectCustomerLanguage('Mujhe 10% discount chahiye warna order nahi karunga'), 'roman_ur');
  assert.equal(detectCustomerLanguage('Is there any discount on this?'), 'en');
  assert.equal(detectCustomerLanguage('I had paid 800 on cash on delivery'), 'en');
  assert.equal(detectCustomerLanguage('ok'), 'mixed');
  assert.equal(detectCustomerLanguage('Price?'), 'mixed');
  assert.equal(detectCustomerLanguage(undefined), 'mixed');
});

test('handoff status is built in the customer language; English stays the exact old text', async () => {
  const facts = { recorded: true, alertStatus: 'sent' as const };
  const english = buildHandoffStatusMessage(facts, 'en');
  assert.ok(english?.startsWith(LIVE_ENGLISH_HANDOFF_TEXT));
  const romanUrdu = buildHandoffStatusMessage(facts, 'roman_ur');
  assert.ok(romanUrdu);
  assert.doesNotMatch(romanUrdu, /Your request/);
  assert.match(romanUrdu, /record ho gayi hai/);
  const mixed = buildHandoffStatusMessage(facts, 'mixed');
  assert.ok(mixed?.includes(english!) && mixed.includes(romanUrdu));
});

test('fallback texts follow the customer language and keep the bilingual text when unsure', () => {
  const romanUrdu = chooseFallbackReply({}, LIVE_ROMAN_URDU_DISCOUNT_QUESTION);
  assert.match(romanUrdu, /Maazrat/);
  assert.doesNotMatch(romanUrdu, /Sorry/);
  const english = chooseFallbackReply({}, 'How many running shoes of size 43 do you have?');
  assert.match(english, /Sorry/);
  assert.doesNotMatch(english, /Maazrat/);
  const unsure = chooseFallbackReply({}, 'ok');
  assert.match(unsure, /Sorry/);
  assert.match(unsure, /Maazrat/);

  assert.equal(chooseFallbackReply({ paymentClaimPending: true }, 'I had paid 800 on COD'), PAYMENT_CLAIM_PENDING_MESSAGE);
  const urduPayment = chooseFallbackReply({ paymentClaimPending: true }, 'Maine 800 COD pe de diye hain');
  assert.notEqual(urduPayment, PAYMENT_CLAIM_PENDING_MESSAGE);
  assert.match(urduPayment, /tasdeeq/);
});

test('every localized fixed text passes every send guard for its own facts', async () => {
  const restorePacing = openPacingWindow();
  try {
    const customerId = newCustomer('fixed-texts');
    db.prepare("update customers set disclosure_sent_at = datetime('now') where id = ?").run(customerId);
    const languageSamples: Record<string, string> = {
      en: 'I want a refund for my order please',
      roman_ur: 'Mujhe apne order ka refund chahiye bhai',
      mixed: 'ok',
    };
    const factSets: SensitiveActionFacts[] = [
      { paymentClaimPending: true },
      ...(['requested', 'approved_pending_execution', 'rejected'] as RefundCustomerStatus[])
        .map((refundStatus) => ({ refundStatus })),
      {},
    ];
    let index = 0;
    for (const [language, inboundText] of Object.entries(languageSamples)) {
      for (const facts of factSets) {
        index += 1;
        const body = chooseFallbackReply(facts, inboundText);
        assert.deepEqual(checkSensitiveActionReply(body, facts), { ok: true }, `${language}: ${body}`);
        assert.deepEqual(checkHandoffClaimReply(body), { ok: true }, `${language}: ${body}`);
        assert.deepEqual(checkRefundCompletionClaim(body), { ok: true }, `${language}: ${body}`);
        const sent: string[] = [];
        const tool = makeSendMessageTool(
          async (text) => { sent.push(text); return { providerMessageId: `fixed-${index}` }; },
          `fixed-text-${customerId}-${index}`,
          { sensitiveActionFacts: facts, skipSpinning: true },
        );
        const result = await tool.execute({ body }, { customerId, inboundText }) as { ok?: boolean; error?: string };
        assert.equal(result.ok, true, `${language}: ${result.error ?? ''}`);
        assert.equal(sent[0], body);
      }
      for (const alertStatus of ['sent', 'pending', 'none'] as const) {
        const body = buildHandoffStatusMessage({ recorded: true, alertStatus }, language as 'en');
        assert.ok(body);
        assert.equal(detectHumanPromise(body), false, body);
        assert.deepEqual(checkHandoffClaimReply(body, body), { ok: true });
      }
    }
  } finally {
    restorePacing();
  }
});

test('a Roman Urdu customer whose handoff is real gets the handoff status in Roman Urdu (live 2026-11-02)', async () => {
  const phone = `9232${String(Date.now()).slice(-8)}`;
  const sends: string[] = [];
  await withGeminiStub(
    [
      () => call('notify_owner', { reason: 'Customer insists on a 10% discount' }),
      () => call('send_handoff_status'),
      () => [{ text: 'done' }],
    ],
    () => runTurn(
      phone,
      'Mujhe 10% discount chahiye, Ahmed bhai se baat karao',
      async (body) => { sends.push(body); return { providerMessageId: 'p-handoff-ur' }; },
      `wording-handoff-ur-${phone}`,
    ),
  );
  assert.equal(sends.length, 1, sends.join(' | '));
  assert.doesNotMatch(sends[0], /Your request has been recorded/);
  assert.match(sends[0], /Aapki request/);
});

// ── 3. Formatting normalisation ────────────────────────────────────────

test('outgoing bodies: literal \\n becomes a newline, at most 2 newlines, emojis stripped before hashing', async () => {
  const restorePacing = openPacingWindow();
  const originalAllow = process.env.ALLOW_EMOJI;
  try {
    delete process.env.ALLOW_EMOJI;
    const customerId = newCustomer('format');
    db.prepare("update customers set disclosure_sent_at = datetime('now') where id = ?").run(customerId);
    const sent: string[] = [];
    const tool = makeSendMessageTool(
      async (text) => { sent.push(text); return { providerMessageId: `fmt-${sent.length}` }; },
      `format-${customerId}`,
      { skipSpinning: true },
    );
    const raw = 'Assalam o Alaikum! 😊\\n\\nBlack hoodie available hai 👍🏽\n\n\n\nAur kuch? 🇵🇰';
    const result = await tool.execute({ body: raw }, { customerId }) as { ok?: boolean; error?: string };
    assert.equal(result.ok, true, result.error);
    assert.equal(sent[0], 'Assalam o Alaikum!\n\nBlack hoodie available hai\n\nAur kuch?');
    const stored = db.prepare(
      "select body from messages where customer_id = ? and direction = 'outbound' order by id desc limit 1",
    ).get(customerId) as { body: string };
    assert.equal(stored.body, sent[0]);

    // Same text with different emoji/escapes is the same send (idempotency sees the final text).
    const again = await tool.execute(
      { body: 'Assalam o Alaikum!\n\nBlack hoodie available hai\n\nAur kuch? ✨' },
      { customerId },
    ) as { ok?: boolean; status?: string };
    assert.equal(again.status, 'already_sent');
    assert.equal(sent.length, 1);

    // Emoji-only body becomes empty and is refused, never sent.
    const empty = await tool.execute({ body: '👍' }, { customerId }) as { ok?: boolean };
    assert.equal(empty.ok, false);

    process.env.ALLOW_EMOJI = 'true';
    const { normalizeOutgoingBody } = await import('../src/outbound-format');
    assert.equal(normalizeOutgoingBody('Shukriya 😊\\nAllah Hafiz'), 'Shukriya 😊\nAllah Hafiz');
  } finally {
    if (originalAllow === undefined) delete process.env.ALLOW_EMOJI;
    else process.env.ALLOW_EMOJI = originalAllow;
    restorePacing();
  }
});

// ── 4. Over-eager handoff ──────────────────────────────────────────────

test('a plain discount question gets the policy answer, not an immediate handoff (live 2026-11-02)', async () => {
  const phone = `9233${String(Date.now()).slice(-8)}`;
  const sends: string[] = [];
  const policyAnswer =
    'Abhi koi discount guaranteed nahi hai. 5% ya us se zyada discount sirf Ahmed ki approval se mil sakta hai.';
  await withGeminiStub(
    [
      () => call('notify_owner', { reason: 'Customer is asking for a discount' }),
      (last) => /answer the discount policy first/i.test(last)
        ? call('send_message', { body: policyAnswer })
        : call('send_handoff_status'),
      () => [{ text: 'done' }],
    ],
    () => runTurn(
      phone,
      LIVE_ROMAN_URDU_DISCOUNT_QUESTION,
      async (body) => { sends.push(body); return { providerMessageId: 'p-discount' }; },
      `wording-discount-${phone}`,
    ),
  );
  const customer = db.prepare('select id from customers where phone = ?').get(phone) as { id: number };
  const handoffs = db.prepare('select count(*) n from handoff_ledger where customer_id = ?').get(customer.id) as { n: number };
  assert.equal(handoffs.n, 0, 'a plain discount question must not raise a handoff');
  assert.deepEqual(sends.map((s) => s.replace(/^Just so you know[^\n]*\n\n/, '')), [policyAnswer]);
});

test('a discount handoff is still allowed when the customer insists or asks above policy', async () => {
  const { createNotifyOwnerTool } = await import('../src/tools/handoff');
  const tool = createNotifyOwnerTool();
  const customerId = newCustomer('discount-insist');
  for (const inboundText of [
    'Mujhe 10% discount chahiye',
    'Please ask Ahmed for a bigger discount, I insist',
    'Thora aur discount do na, owner se baat karo',
  ]) {
    const result = await tool.execute(
      { reason: 'Customer wants a discount' },
      { customerId, inboundText },
    ) as { ok?: boolean; handoff_id?: number };
    assert.equal(result.ok, true, inboundText);
    assert.ok(result.handoff_id);
  }

  // A repeat ask after the policy answer (recorded inbound history) counts as insisting.
  const repeatCustomer = newCustomer('discount-repeat');
  db.prepare("insert into messages (customer_id, direction, body) values (?, 'inbound', ?)")
    .run(repeatCustomer, LIVE_ROMAN_URDU_DISCOUNT_QUESTION);
  db.prepare("insert into messages (customer_id, direction, body) values (?, 'outbound', ?)")
    .run(repeatCustomer, 'Abhi koi discount guaranteed nahi hai.');
  db.prepare("insert into messages (customer_id, direction, body) values (?, 'inbound', ?)")
    .run(repeatCustomer, 'Koi discount to do');
  const repeat = await tool.execute(
    { reason: 'Customer asking for discount again' },
    { customerId: repeatCustomer, inboundText: 'Koi discount to do' },
  ) as { ok?: boolean };
  assert.equal(repeat.ok, true);

  // A non-discount handoff during a discount question is unaffected.
  const other = await tool.execute(
    { reason: 'Customer wants a custom tailored size' },
    { customerId: newCustomer('other'), inboundText: 'Koi discount hai? custom size bana do ge?' },
  ) as { ok?: boolean };
  assert.equal(other.ok, true);
});
