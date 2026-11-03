import assert from 'node:assert/strict';
import { test } from 'node:test';

// owner.ts reads AHMED_OWNER_PHONE once at module load, so configure it before
// loading any project module (synthetic test number, not a real phone).
const OWNER_PHONE = '923000000001';
process.env.AHMED_OWNER_PHONE = OWNER_PHONE;
delete process.env.GEMINI_API_KEY;

/* eslint-disable @typescript-eslint/no-var-requires */
const { db } = require('../src/db') as typeof import('../src/db');
const { handleOwnerFulfilmentCommand } = require('../src/fulfilment-commands') as typeof import('../src/fulfilment-commands');
const { getOrderPublicReference } = require('../src/order-access') as typeof import('../src/order-access');
const { createRequestRefundTool } = require('../src/refunds') as typeof import('../src/refunds');
const { runOwnerTurn, runTurn } = require('../src/agent') as typeof import('../src/agent');
const { PACING_DEFAULTS } = require('../src/guardrails/pacing/defaults') as typeof import('../src/guardrails/pacing/defaults');

let sequence = 0;

function ownerId(): number {
  const existing = db.prepare('select id from customers where phone = ?').get(OWNER_PHONE) as { id: number } | undefined;
  if (existing) return existing.id;
  return Number(db.prepare('insert into customers (phone) values (?)').run(OWNER_PHONE).lastInsertRowid);
}

function setup(status: string, paymentMethod: string | null = 'easypaisa') {
  sequence += 1;
  const customerId = Number(db.prepare('insert into customers (phone) values (?)')
    .run(`92301${String(sequence).padStart(7, '0')}`).lastInsertRowid);
  const orderId = Number(db.prepare(`
    insert into orders (customer_id, items_json, total_minor, status, payment_method)
    values (?, '[{"product_id":1,"qty":2,"price_minor":40000}]', 80000, ?, ?)
  `).run(customerId, status, paymentMethod).lastInsertRowid);
  return { owner: ownerId(), customerId, orderId, ref: getOrderPublicReference(orderId) };
}

function cmd(owner: number, text: string, suffix: string) {
  return handleOwnerFulfilmentCommand(text, { ownerCustomerId: owner, eventKey: `wa-msg-${sequence}-${suffix}` });
}

function status(orderId: number): string {
  return (db.prepare('select status from orders where id = ?').get(orderId) as { status: string }).status;
}

function events(orderId: number, to?: string): number {
  return (db.prepare(`select count(*) n from order_status_events where order_id = ? ${to ? 'and to_status = ?' : ''}`)
    .get(...(to ? [orderId, to] : [orderId])) as { n: number }).n;
}

function snapshot(orderId: number) {
  return {
    status: status(orderId),
    events: events(orderId),
    ledger: (db.prepare('select count(*) n from ledger').get() as { n: number }).n,
    stock: (db.prepare('select coalesce(sum(stock), 0) s from products').get() as { s: number }).s,
  };
}

test('ship requires an exact prepare and a later exact confirm; one owner event with provider evidence', async () => {
  db.exec('begin');
  try {
    const { owner, orderId, ref } = setup('paid');
    const before = snapshot(orderId);
    const prepared = await cmd(owner, `ship order ${ref.toLowerCase()}`, 'prepare');
    assert.equal(prepared?.mutation, 'none');
    assert.match(prepared!.response, new RegExp(`CONFIRM SHIP ORDER ${ref}`));
    assert.match(prepared!.response, /nothing has changed yet/i);
    // The internal numeric id must not leak. Judge it with the public ref
    // removed and as a standalone number: a random hex ref ending in the id's
    // digits ("ORD-…A1 · status") used to make this a ~1-in-16 flake.
    assert.doesNotMatch(
      prepared!.response.split(ref).join('<REF>'),
      new RegExp(`(?<![\\d.,])${orderId}(?![\\d,]|\\.\\d|\\s+items?\\b)`),
    );
    assert.deepEqual(snapshot(orderId), before);

    const vague = await cmd(owner, 'yes confirm', 'vague');
    assert.equal(vague, null, 'non-command text falls through to normal owner handling');
    assert.equal(status(orderId), 'paid');

    const confirmed = await cmd(owner, `CONFIRM SHIP ORDER ${ref}`, 'confirm');
    assert.equal(confirmed?.mutation, 'shipped');
    assert.equal(status(orderId), 'shipped');
    const event = db.prepare(`
      select from_status, to_status, actor_type, actor_customer_id, source, source_event_key, evidence
        from order_status_events where order_id = ? and to_status = 'shipped'
    `).get(orderId) as any;
    assert.equal(event.from_status, 'paid');
    assert.equal(event.actor_type, 'owner');
    assert.equal(event.actor_customer_id, owner);
    assert.equal(event.source, 'owner_fulfilment_command');
    assert.equal(event.source_event_key, `wa-msg-${sequence}-confirm`);
    assert.match(event.evidence, /prepared by event wa-msg-\d+-prepare/);
    assert.equal(snapshot(orderId).ledger, before.ledger);
    assert.equal(snapshot(orderId).stock, before.stock);
  } finally {
    db.exec('rollback');
  }
});

test('confirm without a prepared action, or in the same message as the prepare, changes nothing', async () => {
  db.exec('begin');
  try {
    const { owner, orderId, ref } = setup('paid');
    const before = snapshot(orderId);
    const unprepared = await cmd(owner, `CONFIRM SHIP ORDER ${ref}`, 'unprepared');
    assert.equal(unprepared?.mutation, 'none');
    assert.match(unprepared!.response, /No matching prepared fulfilment action/);

    const combined = await cmd(owner, `SHIP ORDER ${ref}\nCONFIRM SHIP ORDER ${ref}`, 'combined');
    assert.equal(combined?.mutation, 'none');
    assert.match(combined!.response, /Not an exact fulfilment command/);
    assert.deepEqual(snapshot(orderId), before);
    assert.equal((db.prepare('select count(*) n from order_fulfilment_intents where order_id = ?').get(orderId) as any).n, 0);

    // A prepared SHIP cannot be confirmed as DELIVER or for another order.
    const other = setup('paid');
    await cmd(owner, `SHIP ORDER ${ref}`, 'prepare');
    assert.equal((await cmd(owner, `CONFIRM DELIVER ORDER ${ref}`, 'wrong-verb'))?.mutation, 'none');
    assert.equal((await cmd(owner, `CONFIRM SHIP ORDER ${other.ref}`, 'wrong-order'))?.mutation, 'none');
    assert.equal(status(orderId), 'paid');
    assert.equal(status(other.orderId), 'paid');

    // Expired intents cannot be confirmed.
    db.prepare("update order_fulfilment_intents set expires_at = datetime('now', '-1 minute') where order_id = ?").run(orderId);
    assert.equal((await cmd(owner, `CONFIRM SHIP ORDER ${ref}`, 'expired'))?.mutation, 'none');
    assert.equal(status(orderId), 'paid');
    assert.equal(events(orderId), before.events);
  } finally {
    db.exec('rollback');
  }
});

test('unknown, malformed and foreign references are handled without leaking', async () => {
  db.exec('begin');
  try {
    const { owner } = setup('paid');
    const missing = await cmd(owner, 'SHIP ORDER ORD-00000000000000000000', 'missing');
    assert.equal(missing?.mutation, 'none');
    assert.equal(missing!.response, 'No order matches that reference. Nothing was changed.');
    const malformed = await cmd(owner, 'SHIP ORDER 5', 'numeric');
    assert.equal(malformed?.mutation, 'none');
    assert.match(malformed!.response, /Use exactly: SHIP ORDER ORD-/);
    const short = await cmd(owner, 'DELIVER ORDER ORD-1234', 'short');
    assert.equal(short?.mutation, 'none');
    assert.doesNotMatch(short!.response, /\b\d{10,}\b/);
    assert.equal((db.prepare('select count(*) n from order_fulfilment_intents').get() as any).n, 0);
  } finally {
    db.exec('rollback');
  }
});

test('a customer id (not the owner phone) gets no effect, even with exact commands', async () => {
  db.exec('begin');
  try {
    const { customerId, orderId, ref } = setup('paid');
    const before = snapshot(orderId);
    assert.equal(await cmd(customerId, `SHIP ORDER ${ref}`, 'cust-prepare'), null);
    assert.equal(await cmd(customerId, `CONFIRM SHIP ORDER ${ref}`, 'cust-confirm'), null);
    assert.deepEqual(snapshot(orderId), before);
    assert.equal((db.prepare('select count(*) n from order_fulfilment_intents').get() as any).n, 0);
  } finally {
    db.exec('rollback');
  }
});

test('customer WhatsApp path sending the exact commands never changes the order', async () => {
  const { customerId, orderId, ref } = setup('paid');
  const phone = (db.prepare('select phone from customers where id = ?').get(customerId) as { phone: string }).phone;
  const before = snapshot(orderId);
  const sends: string[] = [];
  for (const [index, text] of [`SHIP ORDER ${ref}`, `CONFIRM SHIP ORDER ${ref}`].entries()) {
    try {
      await runTurn(phone, text, async (body) => { sends.push(body); }, `cust-wa-${sequence}-${index}`);
    } catch {
      // No model key in tests: the customer turn may fail; it must still have no effect.
    }
  }
  assert.deepEqual(snapshot(orderId), before);
  assert.equal((db.prepare('select count(*) n from order_fulfilment_intents').get() as any).n, 0);
  assert.equal(sends.some((body) => /CONFIRM SHIP ORDER/.test(body)), false);
});

test('natural language never mutates and is answered without calling the model', async () => {
  db.exec('begin');
  try {
    const { owner, orderId, ref } = setup('paid');
    for (const [index, text] of [
      'ship order 5 please',
      `please mark ${ref} as delivered`,
      `${ref} ship kar do aur bhej do`,
    ].entries()) {
      const result = await cmd(owner, text, `nl-${index}`);
      assert.equal(result?.mutation, 'none');
      assert.match(result!.response, /Nothing was changed/);
      assert.match(result!.response, /(?:SHIP|DELIVER) ORDER /);
    }
    assert.equal(await cmd(owner, 'how many orders were delivered this week?', 'question'), null);
    assert.equal(status(orderId), 'paid');
    assert.equal((db.prepare('select count(*) n from order_fulfilment_intents').get() as any).n, 0);
  } finally {
    db.exec('rollback');
  }
});

test('duplicate and replayed confirmations record exactly one status event', async () => {
  db.exec('begin');
  try {
    const { owner, orderId, ref } = setup('paid');
    await cmd(owner, `SHIP ORDER ${ref}`, 'prepare');
    const retryPrepare = await cmd(owner, `SHIP ORDER ${ref}`, 'prepare');
    assert.match(retryPrepare!.response, /already prepared/);
    assert.equal((await cmd(owner, `CONFIRM SHIP ORDER ${ref}`, 'confirm'))?.mutation, 'shipped');
    const replay = await cmd(owner, `CONFIRM SHIP ORDER ${ref}`, 'confirm');
    assert.equal(replay?.mutation, 'none');
    assert.match(replay!.response, /already applied/);
    const duplicate = await cmd(owner, `CONFIRM SHIP ORDER ${ref}`, 'confirm-again');
    assert.equal(duplicate?.mutation, 'none');
    assert.match(duplicate!.response, /already shipped/);
    assert.equal(events(orderId, 'shipped'), 1);
    assert.equal(status(orderId), 'shipped');
  } finally {
    db.exec('rollback');
  }
});

test('illegal transitions are refused with teaching text and unchanged state', async () => {
  db.exec('begin');
  try {
    const cod = setup('confirmed', 'cod');
    const codResult = await cmd(cod.owner, `SHIP ORDER ${cod.ref}`, 'cod-ship');
    assert.equal(codResult?.mutation, 'none');
    assert.match(codResult!.response, /not paid yet/);
    assert.match(codResult!.response, /cash-on-delivery/);
    assert.equal(status(cod.orderId), 'confirmed');

    for (const [current, text] of [
      ['placed', 'SHIP'],
      ['paid', 'DELIVER'],
      ['confirmed', 'DELIVER'],
      ['cancelled', 'SHIP'],
      ['delivered', 'DELIVER'],
      ['delivered', 'SHIP'],
      ['shipped', 'SHIP'],
    ] as const) {
      const fixture = setup(current);
      const before = snapshot(fixture.orderId);
      const result = await cmd(fixture.owner, `${text} ORDER ${fixture.ref}`, `illegal-${current}-${text}`);
      assert.equal(result?.mutation, 'none', `${text} from ${current}`);
      assert.match(result!.response, /Nothing was changed/);
      assert.deepEqual(snapshot(fixture.orderId), before);
    }
    assert.equal((db.prepare("select count(*) n from order_fulfilment_intents").get() as any).n, 0);

    // State changed between prepare and confirm (e.g. cancelled meanwhile).
    const raced = setup('paid');
    await cmd(raced.owner, `SHIP ORDER ${raced.ref}`, 'race-prepare');
    db.prepare("update orders set status = 'cancelled' where id = ?").run(raced.orderId);
    const racedConfirm = await cmd(raced.owner, `CONFIRM SHIP ORDER ${raced.ref}`, 'race-confirm');
    assert.equal(racedConfirm?.mutation, 'none');
    assert.equal(status(raced.orderId), 'cancelled');

    // CANCEL FULFILMENT ACTION discards a pending intent.
    const cancelled = setup('paid');
    await cmd(cancelled.owner, `SHIP ORDER ${cancelled.ref}`, 'cancel-prepare');
    assert.match((await cmd(cancelled.owner, 'cancel fulfilment action', 'cancel'))!.response, /was cancelled/);
    assert.equal((await cmd(cancelled.owner, `CONFIRM SHIP ORDER ${cancelled.ref}`, 'cancel-confirm'))?.mutation, 'none');
    assert.equal(status(cancelled.orderId), 'paid');
  } finally {
    db.exec('rollback');
  }
});

test('ship then deliver makes the order refund-eligible through the existing refund request path', async () => {
  db.exec('begin');
  try {
    const { owner, customerId, orderId, ref } = setup('paid');
    const refundTool = createRequestRefundTool();
    const early = await refundTool.execute({ order_reference: ref, reason: 'Wrong size received' }, { customerId }) as any;
    assert.equal(early.ok, false);

    await cmd(owner, `SHIP ORDER ${ref}`, 'ship');
    assert.equal((await cmd(owner, `CONFIRM SHIP ORDER ${ref}`, 'confirm-ship'))?.mutation, 'shipped');
    await cmd(owner, `DELIVER ORDER ${ref}`, 'deliver');
    assert.equal((await cmd(owner, `CONFIRM DELIVER ORDER ${ref}`, 'confirm-deliver'))?.mutation, 'delivered');
    assert.equal(status(orderId), 'delivered');
    assert.equal(events(orderId, 'delivered'), 1);

    const ledgerBefore = (db.prepare('select count(*) n from ledger').get() as { n: number }).n;
    const refund = await refundTool.execute({ order_reference: ref, reason: 'Wrong size received' }, { customerId }) as any;
    assert.equal(refund.ok, true);
    assert.equal(refund.eligibility, 'eligible');
    assert.equal(refund.money_refunded, false);
    assert.equal(status(orderId), 'delivered');
    assert.equal((db.prepare('select count(*) n from ledger').get() as { n: number }).n, ledgerBefore);
  } finally {
    db.exec('rollback');
  }
});

test('runOwnerTurn routes exact commands before the model and replies with the server text', async () => {
  const originalWindow = { start: PACING_DEFAULTS.windowStartHour, end: PACING_DEFAULTS.windowEndHour };
  try {
    PACING_DEFAULTS.windowStartHour = 0;
    PACING_DEFAULTS.windowEndHour = 24;
    const { orderId, ref } = setup('paid');
    const replies: string[] = [];
    const send = async (body: string) => {
      replies.push(body);
      return { providerMessageId: `owner-provider-${sequence}-${replies.length}` };
    };
    const modelCaller = async () => {
      throw new Error('the model must not be called for fulfilment commands');
    };
    await runOwnerTurn(OWNER_PHONE, `SHIP ORDER ${ref}`, send, modelCaller as any, `owner-wa-${sequence}-1`);
    assert.equal(status(orderId), 'paid');
    assert.match(replies.at(-1) ?? '', new RegExp(`CONFIRM SHIP ORDER ${ref}`));
    await runOwnerTurn(OWNER_PHONE, `CONFIRM SHIP ORDER ${ref}`, send, modelCaller as any, `owner-wa-${sequence}-2`);
    assert.equal(status(orderId), 'shipped');
    assert.match(replies.at(-1) ?? '', /^SHIPPED:/);
    // Provider redelivers the same confirmation message.
    await runOwnerTurn(OWNER_PHONE, `CONFIRM SHIP ORDER ${ref}`, send, modelCaller as any, `owner-wa-${sequence}-2`);
    assert.equal(events(orderId, 'shipped'), 1);
  } finally {
    PACING_DEFAULTS.windowStartHour = originalWindow.start;
    PACING_DEFAULTS.windowEndHour = originalWindow.end;
  }
});
