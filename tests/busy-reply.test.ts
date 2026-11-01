import assert from 'node:assert/strict';
import test from 'node:test';

import { sendTemporaryBusyReply } from '../src/agent';
import {
  AI_BUDGET_DEFERRED_REPLY,
  BUSY_REPLY_DEFAULTS,
  readBusyReplyConfig,
  TEMPORARILY_BUSY_REPLY,
} from '../src/busy-reply';
import { db } from '../src/db';

test('invalid busy-reply cooldown remains finite', () => {
  assert.deepEqual(readBusyReplyConfig({}), BUSY_REPLY_DEFAULTS);
  assert.deepEqual(readBusyReplyConfig({ BUSY_REPLY_COOLDOWN_MINUTES: '0' }), BUSY_REPLY_DEFAULTS);
  assert.deepEqual(
    readBusyReplyConfig({ BUSY_REPLY_COOLDOWN_MINUTES: 'unlimited' }),
    BUSY_REPLY_DEFAULTS,
  );
});

test('daily AI-budget notice is truthful, confirms persistence, and tells the customer not to resend', () => {
  assert.match(AI_BUDGET_DEFERRED_REPLY, /message is saved/i);
  assert.match(AI_BUDGET_DEFERRED_REPLY, /12:00 AM Pakistan time/i);
  assert.match(AI_BUDGET_DEFERRED_REPLY, /do not resend/i);
  assert.doesNotMatch(AI_BUDGET_DEFERRED_REPLY, /many messages|few minutes/i);
});

test('recent deterministic busy reply suppresses another send without calling Gemini', async () => {
  db.exec('begin');
  try {
    const phone = `998${Date.now()}`;
    const customerId = Number(
      db.prepare('insert into customers (phone) values (?)').run(phone).lastInsertRowid,
    );
    const nowSql = new Date().toISOString().slice(0, 23).replace('T', ' ');
    db.prepare(`
      insert into messages (customer_id, direction, body, created_at)
      values (?, 'outbound', ?, ?)
    `).run(customerId, TEMPORARILY_BUSY_REPLY, nowSql);

    let sends = 0;
    const result = await sendTemporaryBusyReply(phone, `${phone}:busy`, async () => {
      sends += 1;
    });
    assert.equal(result.ok, true);
    assert.equal(result.status, 'cooldown_suppressed');
    assert.equal(sends, 0);
    assert.equal(
      (db.prepare(`
        select count(*) as count from messages
        where customer_id = ? and direction = 'outbound' and body = ?
      `).get(customerId, TEMPORARILY_BUSY_REPLY) as { count: number }).count,
      1,
    );
  } finally {
    db.exec('rollback');
  }
});
