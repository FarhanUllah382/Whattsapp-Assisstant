// FIX5 measurement harness: runs stubbed Gemini customer turns for a few
// representative messages and reports, per turn, how many model calls were
// made and how big each request was (characters of the request JSON, tokens
// estimated as chars/4), split into system prompt / tool schemas / opening
// context (memory + history + request) / later loop content (model calls and
// tool results) / CLOSE instruction.
//
// Run on an isolated temp DB only (never ahmed.db):
//   npm run cost:measure
// which is `tsx scripts/run-isolated-tests.ts tests/turn-cost-harness.ts`.
// Add `--json` after `--` to also print raw per-call rows.

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

process.env.GEMINI_API_KEY = 'TEST-GEMINI-KEY-cost-harness';
process.env.APPROVED_CATALOG_SHA256 = createHash('sha256')
  .update(fs.readFileSync(path.resolve(__dirname, '..', 'catalog.md')))
  .digest('hex');

// eslint-disable-next-line import/first
import { runTurn } from '../src/agent';
import { db } from '../src/db';
import { PACING_DEFAULTS } from '../src/guardrails/pacing/defaults';

export interface CallMeasure {
  phase: 'LOOP' | 'CLOSE';
  totalChars: number;
  systemChars: number;
  toolChars: number;
  toolCount: number;
  openingChars: number;
  loopContentChars: number;
  closeInstructionChars: number;
}

export interface TurnMeasure {
  scenario: string;
  calls: CallMeasure[];
  sends: string[];
}

type Step = (ctx: { productIds: number[] }) => unknown[];

export interface Scenario {
  name: string;
  inbound: string;
  steps: Step[];
  /** What the model does once the script is used up (default: plain text). */
  after?: Step;
}

const call = (name: string, args: Record<string, unknown> = {}) => [{ functionCall: { name, args } }];
const textDone = () => [{ text: 'Reply sent.' }];

// Each scripted loop step is what a real model plausibly does; once the
// script runs out, the model answers with plain text (a common real Gemini
// behaviour after a successful send) — that extra call is what "continue
// after a successful send" costs.
export const SCENARIOS: Scenario[] = [
  {
    name: 'greeting',
    inbound: 'Assalam o alaikum',
    steps: [
      () => call('send_message', { body: 'Walaikum assalam! Bataiye, aaj main aap ki kya madad kar sakta hoon?' }),
    ],
  },
  {
    name: 'stock question',
    inbound: 'Black hoodie medium mein available hai?',
    steps: [
      () => call('check_stock', { name: 'hoodie', color: 'black', size: 'medium' }),
      () => call('send_message', { body: 'Ji haan, black hoodie medium size mein available hai.' }),
    ],
  },
  {
    name: 'price question',
    inbound: 'Running shoes ka price kya hai?',
    steps: [
      () => call('check_stock', { name: 'running shoes' }),
      () => call('send_message', { body: 'Running shoes ki price Rs 4,800 hai.' }),
    ],
  },
  {
    name: 'policy question',
    inbound: 'What is your return policy?',
    steps: [
      () => call('search_catalog', { query: 'return policy' }),
      () => call('send_message', { body: 'You can return unused items within 7 days with the receipt.' }),
    ],
  },
  {
    name: 'order step',
    inbound: 'Mujhe 2 black hoodie medium chahiye, order karna hai',
    steps: [
      () => call('check_stock', { name: 'hoodie', color: 'black', size: 'medium', requested_qty: 2 }),
      () => call('get_payment_options'),
      () => call('send_message', {
        body: 'Zaroor! Order ke liye apna naam, contact number, poora address, city aur payment method (COD) bata dein.',
      }),
    ],
  },
  {
    // Live 2 Nov shape: after a successful send the model keeps calling
    // send_message again with the same body (each is an idempotent no-op).
    name: 'stock q, model repeats send',
    inbound: 'Grey hoodie available hai?',
    steps: [
      () => call('check_stock', { name: 'hoodie', color: 'grey' }),
    ],
    after: () => call('send_message', { body: 'Ji haan, grey hoodie medium mein available hai.' }),
  },
  {
    // Every reply is vetoed by a guard (exact stock count) -> fixed fallback.
    name: 'every reply vetoed',
    inbound: 'Kitne black hoodies bache hain?',
    steps: [],
    after: () => call('send_message', { body: 'We have 7 pieces left in that size.' }),
  },
  {
    name: 'payment question',
    inbound: 'Payment kaise karun?',
    steps: [
      () => call('send_payment_instructions', { method: 'cod' }),
    ],
  },
];

const HISTORY: Array<['inbound' | 'outbound', string]> = [
  ['inbound', 'Salam, aap ke paas hoodies hain?'],
  ['outbound', 'Walaikum assalam! Ji haan, hamare paas black aur grey hoodies hain, sizes S se XL tak. Kaunsa rang pasand karenge?'],
  ['inbound', 'Black wali ka price kya hai?'],
  ['outbound', 'Black hoodie ki price Rs 800 hai. Medium aur large dono available hain.'],
  ['inbound', 'Delivery kitne din mein hoti hai Lahore mein?'],
  ['outbound', 'Lahore mein delivery usually 2 se 3 working days mein ho jati hai.'],
  ['inbound', 'Aur jeans bhi hain?'],
  ['outbound', 'Ji haan, slim fit jeans available hain, sizes 30 se 36. Price Rs 2,200 hai.'],
  ['inbound', 'Theek hai main sochta hoon'],
  ['outbound', 'Bilkul, jab chahein message kar dein. Shukriya!'],
  ['inbound', 'Running shoes bhi milte hain?'],
  ['outbound', 'Ji haan, running shoes sizes 40 se 44 mein available hain.'],
  ['inbound', 'Size 43 hai?'],
  ['outbound', 'Size 43 abhi in stock hai.'],
  ['inbound', 'Colour kaunse hain?'],
  ['outbound', 'Running shoes black aur white mein available hain.'],
  ['inbound', 'Exchange ho sakta hai agar size na aaye?'],
  ['outbound', 'Ji haan, unused item 7 din ke andar exchange ho sakta hai, receipt ke saath.'],
  ['inbound', 'Ok shukriya'],
  ['outbound', 'Aap ka shukriya! Kuch aur chahiye ho to bata dein.'],
];

function seedProducts(): number[] {
  const insert = db.prepare(
    'insert into products (sku, name, category, size, color, price_minor, stock) values (?, ?, ?, ?, ?, ?, ?)',
  );
  const ids: number[] = [];
  const rows: Array<[string, string, string, string, string, number, number]> = [
    ['COST-HD-BM', 'Black Hoodie', 'hoodie', 'medium', 'black', 80_000, 12],
    ['COST-HD-BL', 'Black Hoodie', 'hoodie', 'large', 'black', 80_000, 3],
    ['COST-HD-GM', 'Grey Hoodie', 'hoodie', 'medium', 'grey', 85_000, 9],
    ['COST-RS-43', 'Running Shoes', 'shoes', '43', 'black', 480_000, 5],
    ['COST-RS-42', 'Running Shoes', 'shoes', '42', 'white', 480_000, 0],
    ['COST-JN-32', 'Slim Fit Jeans', 'jeans', '32', 'blue', 220_000, 15],
  ];
  for (const row of rows) {
    const existing = db.prepare('select id from products where sku = ?').get(row[0]) as { id: number } | undefined;
    ids.push(existing?.id ?? Number(insert.run(...row).lastInsertRowid));
  }
  return ids;
}

let phoneSeq = 0;
function seedCustomer(): string {
  phoneSeq += 1;
  const phone = `9239${String(Date.now()).slice(-6)}${String(phoneSeq).padStart(2, '0')}`;
  const customerId = Number(db.prepare(
    "insert into customers (phone, disclosure_sent_at) values (?, datetime('now', '-2 days'))",
  ).run(phone).lastInsertRowid);
  const insertMessage = db.prepare(
    "insert into messages (customer_id, direction, body, created_at) values (?, ?, ?, datetime('now', '-1 day'))",
  );
  for (const [direction, body] of HISTORY) insertMessage.run(customerId, direction, body);
  db.prepare('insert into checkpoints (customer_id, summary) values (?, ?)').run(
    customerId,
    'Customer is browsing hoodies (likes black, medium), jeans and size 43 running shoes; asked about Lahore delivery ' +
      'time and the exchange policy. No order placed yet and nothing owed.',
  );
  db.prepare('insert into customer_notes (customer_id, headline, body) values (?, ?, ?)').run(
    customerId, 'Prefers black', 'Usually asks for black items first.',
  );
  return phone;
}

function measureRequest(request: any): CallMeasure {
  const totalChars = JSON.stringify(request).length;
  const systemChars = JSON.stringify(request.system_instruction ?? '').length;
  const toolDecls = request.tools?.[0]?.functionDeclarations ?? [];
  const toolChars = request.tools ? JSON.stringify(request.tools).length : 0;
  const contents: any[] = Array.isArray(request.contents) ? request.contents : [];
  const openingChars = contents.length > 0 ? JSON.stringify(contents[0]).length : 0;
  const hasTools = toolDecls.length > 0;
  const closeInstructionChars = !hasTools && contents.length > 1
    ? JSON.stringify(contents[contents.length - 1]).length
    : 0;
  const loopContentChars = contents
    .slice(1, closeInstructionChars > 0 ? -1 : undefined)
    .reduce((sum, c) => sum + JSON.stringify(c).length, 0);
  return {
    phase: hasTools ? 'LOOP' : 'CLOSE',
    totalChars,
    systemChars,
    toolChars,
    toolCount: toolDecls.length,
    openingChars,
    loopContentChars,
    closeInstructionChars,
  };
}

/** Runs one scenario with a stubbed Gemini; returns per-call request measurements. */
export async function measureScenario(scenario: Scenario, productIds: number[]): Promise<TurnMeasure> {
  const originalFetch = globalThis.fetch;
  const calls: CallMeasure[] = [];
  let loopCalls = 0;
  globalThis.fetch = (async (_url: unknown, init?: { body?: string }) => {
    const request = JSON.parse(String(init?.body ?? '{}'));
    const measure = measureRequest(request);
    calls.push(measure);
    let parts: unknown[];
    if (measure.phase === 'LOOP') {
      const step = scenario.steps[loopCalls] ?? scenario.after ?? textDone;
      loopCalls += 1;
      parts = step({ productIds });
    } else {
      parts = [{ text: JSON.stringify({ summary: 'Customer asked a question and got an answer.', new_notes: [], unlogged_order: null, unlogged_payment: null }) }];
    }
    return new Response(JSON.stringify({
      candidates: [{ content: { parts } }],
      usageMetadata: {
        promptTokenCount: Math.ceil(measure.totalChars / 4),
        candidatesTokenCount: 20,
        totalTokenCount: Math.ceil(measure.totalChars / 4) + 20,
      },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;

  const phone = seedCustomer();
  const sends: string[] = [];
  try {
    await runTurn(
      phone,
      scenario.inbound,
      async (body) => { sends.push(body); return { providerMessageId: `cost-${phone}-${sends.length}` }; },
      `cost-${phone}`,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
  return { scenario: scenario.name, calls, sends };
}

export async function measureAll(): Promise<TurnMeasure[]> {
  const original = { start: PACING_DEFAULTS.windowStartHour, end: PACING_DEFAULTS.windowEndHour, throttle: PACING_DEFAULTS.throttleMs };
  PACING_DEFAULTS.windowStartHour = 0;
  PACING_DEFAULTS.windowEndHour = 24;
  const productIds = seedProducts();
  const results: TurnMeasure[] = [];
  try {
    for (const scenario of SCENARIOS) results.push(await measureScenario(scenario, productIds));
  } finally {
    PACING_DEFAULTS.windowStartHour = original.start;
    PACING_DEFAULTS.windowEndHour = original.end;
  }
  return results;
}

export const estTokens = (chars: number) => Math.ceil(chars / 4);

function sum(calls: CallMeasure[], key: keyof CallMeasure): number {
  return calls.reduce((total, c) => total + (c[key] as number), 0);
}

async function main(): Promise<void> {
  const results = await measureAll();
  const rows = results.map((r) => {
    const loop = r.calls.filter((c) => c.phase === 'LOOP').length;
    const close = r.calls.length - loop;
    return {
      scenario: r.scenario,
      calls: r.calls.length,
      loop,
      close,
      est_prompt_tokens: estTokens(sum(r.calls, 'totalChars')),
      system: estTokens(sum(r.calls, 'systemChars')),
      tools: estTokens(sum(r.calls, 'toolChars')),
      opening: estTokens(sum(r.calls, 'openingChars')),
      loop_content: estTokens(sum(r.calls, 'loopContentChars')),
      close_instr: estTokens(sum(r.calls, 'closeInstructionChars')),
      tool_schemas_sent: r.calls.map((c) => c.toolCount).join('/'),
      sends: r.sends.length,
    };
  });
  console.table(rows);
  const first = results[0]?.calls[0];
  if (first) {
    console.log(
      `Per-call fixed cost (first LOOP call of "${results[0].scenario}"): ` +
        `system ${estTokens(first.systemChars)} tok, tool schemas ${estTokens(first.toolChars)} tok ` +
        `(${first.toolCount} tools), opening context ${estTokens(first.openingChars)} tok, ` +
        `total ${estTokens(first.totalChars)} tok.`,
    );
  }
  if (process.argv.includes('--json')) console.log(JSON.stringify(results, null, 2));
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
