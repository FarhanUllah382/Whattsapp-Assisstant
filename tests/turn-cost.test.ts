import assert from 'node:assert/strict';
import { test } from 'node:test';

// FIX5 — cost reduction (live 2 Nov: ~6 Gemini calls and ~28k prompt tokens
// per customer message). Pins the call/token budget for ordinary messages and
// proves the CLOSE safety net still runs whenever an order/payment could be
// involved. Measurement helpers live in tests/turn-cost-harness.ts
// (`npm run cost:measure` prints the full before/after table).

import {
  estTokens,
  measureScenario,
  SCENARIOS,
  type Scenario,
} from './turn-cost-harness';
import { runTurn } from '../src/agent';
import {
  decideCloseModelCall,
  hasCloseSignal,
  readCheckpointEveryNTurns,
} from '../src/agent/turn-close';
import { db } from '../src/db';
import { PACING_DEFAULTS } from '../src/guardrails/pacing/defaults';

function openPacingWindow(): () => void {
  const original = { start: PACING_DEFAULTS.windowStartHour, end: PACING_DEFAULTS.windowEndHour };
  PACING_DEFAULTS.windowStartHour = 0;
  PACING_DEFAULTS.windowEndHour = 24;
  return () => {
    PACING_DEFAULTS.windowStartHour = original.start;
    PACING_DEFAULTS.windowEndHour = original.end;
  };
}

function seedProducts(): number[] {
  const insert = db.prepare('insert into products (sku, name, category, size, color, price_minor, stock) values (?, ?, ?, ?, ?, ?, ?)');
  return [
    Number(insert.run('TC-HD-BM', 'Black Hoodie', 'hoodie', 'medium', 'black', 80_000, 12).lastInsertRowid),
    Number(insert.run('TC-RS-43', 'Running Shoes', 'shoes', '43', 'black', 480_000, 5).lastInsertRowid),
  ];
}

const productIds = seedProducts();
const scenario = (name: string): Scenario => {
  const found = SCENARIOS.find((s) => s.name === name);
  assert.ok(found, name);
  return found;
};
const totalChars = (calls: Array<{ totalChars: number }>) => calls.reduce((sum, c) => sum + c.totalChars, 0);

test('a simple question costs at most 3 model calls and 12k estimated prompt tokens', async () => {
  const restore = openPacingWindow();
  try {
    for (const name of ['greeting', 'stock question', 'price question', 'policy question', 'stock q, model repeats send']) {
      const result = await measureScenario(scenario(name), productIds);
      assert.equal(result.sends.length, 1, `${name}: exactly one reply`);
      assert.ok(result.calls.length <= 3, `${name}: ${result.calls.length} model calls`);
      const tokens = estTokens(totalChars(result.calls));
      assert.ok(tokens <= 12_000, `${name}: ~${tokens} prompt tokens`);
    }
  } finally {
    restore();
  }
});

test('the loop stops right after a delivered reply, and after 3 vetoed sends', async () => {
  const restore = openPacingWindow();
  try {
    const repeated = await measureScenario(scenario('stock q, model repeats send'), productIds);
    assert.equal(repeated.calls.filter((c) => c.phase === 'LOOP').length, 2, 'check_stock + send_message, no re-call');

    const vetoed = await measureScenario(scenario('every reply vetoed'), productIds);
    assert.equal(vetoed.calls.filter((c) => c.phase === 'LOOP').length, 3, 'first try + two re-calls, then fallback');
    assert.equal(vetoed.sends.length, 1);
    assert.doesNotMatch(vetoed.sends[0], /7 pieces/);
    // A turn without its own reply always runs the CLOSE call.
    assert.equal(vetoed.calls.filter((c) => c.phase === 'CLOSE').length, 1);
  } finally {
    restore();
  }
});

let phoneSeq = 0;
function customerWithCheckpoint(): { phone: string; customerId: number } {
  phoneSeq += 1;
  const phone = `9238${String(Date.now()).slice(-6)}${String(phoneSeq).padStart(2, '0')}`;
  const customerId = Number(db.prepare("insert into customers (phone, disclosure_sent_at) values (?, datetime('now'))").run(phone).lastInsertRowid);
  db.prepare('insert into checkpoints (customer_id, summary, updated_at) values (?, ?, datetime(\'now\', \'-1 hour\'))')
    .run(customerId, 'Customer browses hoodies; nothing ordered or owed.');
  db.prepare("insert into messages (customer_id, direction, body, created_at) values (?, 'inbound', 'hi', datetime('now', '-2 hours'))").run(customerId);
  return { phone, customerId };
}

async function stubbedTurn(
  inbound: string,
  replyBody: string,
  closeJson: Record<string, unknown>,
): Promise<{ customerId: number; loopCalls: number; closeCalls: number; sends: string[] }> {
  const { phone, customerId } = customerWithCheckpoint();
  const originalFetch = globalThis.fetch;
  const restore = openPacingWindow();
  let loopCalls = 0;
  let closeCalls = 0;
  globalThis.fetch = (async (_url: unknown, init?: { body?: string }) => {
    const request = JSON.parse(String(init?.body ?? '{}'));
    let parts: unknown[];
    if (Array.isArray(request.tools) && request.tools.length > 0) {
      loopCalls += 1;
      parts = [{ functionCall: { name: 'send_message', args: { body: replyBody } } }];
    } else {
      closeCalls += 1;
      parts = [{ text: JSON.stringify(closeJson) }];
    }
    return new Response(JSON.stringify({
      candidates: [{ content: { parts } }],
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  const sends: string[] = [];
  try {
    await runTurn(phone, inbound, async (body) => { sends.push(body); return { providerMessageId: `tc-${phone}-${sends.length}` }; }, `turn-cost-${phone}`);
  } finally {
    globalThis.fetch = originalFetch;
    restore();
  }
  return { customerId, loopCalls, closeCalls, sends };
}

const handoffs = (customerId: number, prefix: string) =>
  (db.prepare('select count(*) n from handoff_ledger where customer_id = ? and reason like ?').get(customerId, `${prefix}%`) as { n: number }).n;

test('the payment safety net still runs when the inbound text has a payment signal', async () => {
  const result = await stubbedTurn(
    'Maine kal 800 rupay jazzcash pe bhej diye the',
    'Shukriya, main check karwa deta hoon.',
    { summary: 'Customer says they paid 800.', new_notes: [], unlogged_order: null, unlogged_payment: { confident: false, amount: null, description: 'Customer says they sent 800 via JazzCash.' } },
  );
  assert.equal(result.loopCalls, 1);
  assert.equal(result.closeCalls, 1, 'CLOSE must run on a payment signal');
  assert.equal(handoffs(result.customerId, 'Possible unlogged payment'), 1);
});

test('the order safety net still runs when the inbound text has an order signal', async () => {
  const result = await stubbedTurn(
    'Theek hai 2 black hoodie bhej do',
    'Zaroor, apna address aur payment method bata dein.',
    { summary: 'Customer wants 2 black hoodies.', new_notes: [], unlogged_order: { confident: false, items: null, description: 'Customer wants 2 black hoodies sent.' }, unlogged_payment: null },
  );
  assert.equal(result.closeCalls, 1, 'CLOSE must run on an order signal');
  assert.equal(handoffs(result.customerId, 'Possible order needs'), 1);
});

test('a plain read-only question skips CLOSE; the checkpoint is still refreshed every N turns', async () => {
  const result = await stubbedTurn('Black hoodie medium mein available hai?', 'Ji haan, available hai.', { summary: 'x' });
  assert.equal(result.loopCalls, 1);
  assert.equal(result.closeCalls, 0);

  const original = process.env.CHECKPOINT_EVERY_N_TURNS;
  try {
    delete process.env.CHECKPOINT_EVERY_N_TURNS;
    assert.equal(readCheckpointEveryNTurns(), 4);
    for (const bad of ['', '0', '11', 'abc', '-1', '2.5']) {
      process.env.CHECKPOINT_EVERY_N_TURNS = bad;
      assert.equal(readCheckpointEveryNTurns(), 4, bad);
    }
    process.env.CHECKPOINT_EVERY_N_TURNS = '1';
    const always = await stubbedTurn('Black hoodie medium mein available hai?', 'Ji haan, available hai.', { summary: 'y' });
    assert.equal(always.closeCalls, 1, 'N=1 restores CLOSE on every turn');
  } finally {
    if (original === undefined) delete process.env.CHECKPOINT_EVERY_N_TURNS;
    else process.env.CHECKPOINT_EVERY_N_TURNS = original;
  }

  // The 4th inbound message since the last checkpoint write forces a refresh.
  const { customerId } = customerWithCheckpoint();
  const base = { customerId, hasCheckpoint: true, replied: true, toolsCalledThisTurn: new Set(['check_stock', 'send_message']), incomingText: 'hoodie available?' };
  const addInbound = () => db.prepare("insert into messages (customer_id, direction, body, created_at) values (?, 'inbound', 'q', datetime('now'))").run(customerId);
  addInbound(); addInbound(); addInbound();
  assert.equal(decideCloseModelCall(base).run, false);
  addInbound();
  assert.deepEqual(decideCloseModelCall(base), { run: true, reason: 'periodic' });
});

test('CLOSE gating is conservative: new customers, no reply, state-changing tools and signals all force it', () => {
  const { customerId } = customerWithCheckpoint();
  const base = { customerId, hasCheckpoint: true, replied: true, toolsCalledThisTurn: new Set(['send_message']), incomingText: 'hello' };
  assert.equal(decideCloseModelCall(base).run, false);
  assert.equal(decideCloseModelCall({ ...base, hasCheckpoint: false }).run, true);
  assert.equal(decideCloseModelCall({ ...base, replied: false }).run, true);
  for (const tool of ['prepare_order', 'confirm_order', 'claim_payment', 'request_refund', 'notify_owner', 'get_payment_options', 'get_my_order_status', 'some_future_tool']) {
    assert.equal(decideCloseModelCall({ ...base, toolsCalledThisTurn: new Set(['send_message', tool]) }).run, true, tool);
  }
  for (const text of [
    'I want to order 2 hoodies', 'confirm order', 'mujhe yeh chahiye', 'cancel kar do',
    'I paid 800', 'payment kar di hai', 'easypaisa se bhej diye', 'COD', 'refund chahiye',
    'mera naam Ali hai', 'address: house 5 street 2', '03001234567', '+923001234567',
    'I prefer black', 'mujhe black pasand hai', 'wrong size aaya hai',
  ]) {
    assert.equal(hasCloseSignal(text), true, text);
  }
  for (const text of ['Assalam o alaikum', 'Black hoodie medium mein available hai?', 'Running shoes ka price kya hai?', 'What is your return policy?', 'size 43 hai?', 'shukriya']) {
    assert.equal(hasCloseSignal(text), false, text);
  }
});

test('hidden tools still execute their real teaching path when called', async () => {
  // update_order_status is not advertised to a customer without orders, but a
  // call must still reach the real tool (no "unknown tool").
  const { phone } = customerWithCheckpoint();
  const originalFetch = globalThis.fetch;
  const restore = openPacingWindow();
  let toolResult = '';
  let advertised: string[] = [];
  let loopCalls = 0;
  globalThis.fetch = (async (_url: unknown, init?: { body?: string }) => {
    const request = JSON.parse(String(init?.body ?? '{}'));
    let parts: unknown[];
    if (Array.isArray(request.tools) && request.tools.length > 0) {
      loopCalls += 1;
      if (loopCalls === 1) {
        advertised = request.tools[0].functionDeclarations.map((d: { name: string }) => d.name);
        parts = [{ functionCall: { name: 'update_order_status', args: { order_reference: 'ORD-00000000000000000000', status: 'cancelled' } } }];
      } else {
        toolResult = JSON.stringify(request.contents.at(-1));
        parts = [{ functionCall: { name: 'send_message', args: { body: 'Aap ka koi order nahi mila.' } } }];
      }
    } else {
      parts = [{ text: '{}' }];
    }
    return new Response(JSON.stringify({ candidates: [{ content: { parts } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  try {
    await runTurn(phone, 'cancel my order', async () => ({ providerMessageId: `hidden-${phone}` }), `hidden-${phone}`);
  } finally {
    globalThis.fetch = originalFetch;
    restore();
  }
  for (const hidden of ['update_order_status', 'confirm_order', 'show_pending_order', 'get_customer_note']) {
    assert.ok(!advertised.includes(hidden), `${hidden} should not be advertised`);
  }
  assert.ok(advertised.includes('send_message') && advertised.includes('check_stock'));
  assert.ok(toolResult.includes('update_order_status'), toolResult);
  assert.doesNotMatch(toolResult, /unknown tool/);
});
