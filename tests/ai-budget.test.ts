import assert from 'node:assert/strict';
import test from 'node:test';

import {
  AiBudgetExceededError,
  AI_BUDGET_DEFAULTS,
  budgetDayKey,
  finishAiModelCall,
  readAiBudgetConfig,
  reserveAiModelCall,
  type AiBudgetConfig,
} from '../src/ai-budget';
import { db } from '../src/db';

function cleanup(prefix: string): void {
  db.prepare('delete from ai_model_calls where id like ?').run(`${prefix}%`);
}

test('missing and invalid budget configuration stays finite in Karachi time', () => {
  assert.deepEqual(readAiBudgetConfig({}), AI_BUDGET_DEFAULTS);
  assert.deepEqual(readAiBudgetConfig({
    AI_BUDGET_TIMEZONE: 'Not/A_Timezone',
    AI_DAILY_CALL_LIMIT: 'unlimited',
    AI_DAILY_TOKEN_LIMIT: '0',
  }), AI_BUDGET_DEFAULTS);
  assert.equal(budgetDayKey(new Date('2026-10-03T20:30:00.000Z'), 'Asia/Karachi'), '2026-10-04');
});

test('daily call reservations are atomic, finite, and include failures', () => {
  const prefix = `ai-call-budget-${Date.now()}-`;
  const config: AiBudgetConfig = { timezone: 'Asia/Karachi', dailyCallLimit: 2, dailyTokenLimit: 1000 };
  const now = new Date('2026-10-04T05:00:00.000Z');
  try {
    const first = reserveAiModelCall({ model: 'test-model', now, config, reservationId: `${prefix}1` });
    finishAiModelCall({ id: first.id, status: 'failed', now });
    const second = reserveAiModelCall({ model: 'test-model', now, config, reservationId: `${prefix}2` });
    finishAiModelCall({ id: second.id, status: 'succeeded', totalTokens: 10, now });
    assert.throws(
      () => reserveAiModelCall({ model: 'test-model', now, config, reservationId: `${prefix}3` }),
      (error) => error instanceof AiBudgetExceededError && error.reason === 'daily_call_limit',
    );
    assert.equal((db.prepare('select count(*) n from ai_model_calls where id like ?')
      .get(`${prefix}%`) as { n: number }).n, 2);
  } finally {
    cleanup(prefix);
  }
});

test('reported token usage closes the daily token budget', () => {
  const prefix = `ai-token-budget-${Date.now()}-`;
  const config: AiBudgetConfig = { timezone: 'Asia/Karachi', dailyCallLimit: 10, dailyTokenLimit: 1000 };
  const now = new Date('2026-10-04T05:00:00.000Z');
  try {
    const reservation = reserveAiModelCall({ model: 'test-model', now, config, reservationId: `${prefix}1` });
    finishAiModelCall({
      id: reservation.id,
      status: 'succeeded',
      promptTokens: 700,
      outputTokens: 300,
      totalTokens: 1000,
      now,
    });
    assert.throws(
      () => reserveAiModelCall({ model: 'test-model', now, config, reservationId: `${prefix}2` }),
      (error) => error instanceof AiBudgetExceededError && error.reason === 'daily_token_limit',
    );
  } finally {
    cleanup(prefix);
  }
});

test('a new Karachi day receives a fresh independent budget', () => {
  const prefix = `ai-day-budget-${Date.now()}-`;
  const config: AiBudgetConfig = { timezone: 'Asia/Karachi', dailyCallLimit: 1, dailyTokenLimit: 1000 };
  try {
    const beforeMidnight = new Date('2026-10-04T18:59:59.000Z');
    const afterMidnight = new Date('2026-10-04T19:00:01.000Z');
    reserveAiModelCall({ model: 'test-model', now: beforeMidnight, config, reservationId: `${prefix}1` });
    assert.equal(
      reserveAiModelCall({ model: 'test-model', now: afterMidnight, config, reservationId: `${prefix}2` }).callsUsed,
      1,
    );
  } finally {
    cleanup(prefix);
  }
});

