import assert from 'node:assert/strict';
import test from 'node:test';

import {
  admitInboundTurn,
  INBOUND_ABUSE_DEFAULTS,
  readInboundAbuseConfig,
  type InboundAbuseConfig,
} from '../src/abuse-control';
import { db } from '../src/db';

const config: InboundAbuseConfig = {
  windowMinutes: 10,
  customerTurnsPerWindow: 2,
  ownerTurnsPerWindow: 3,
};

function cleanup(prefix: string): void {
  db.prepare('delete from inbound_abuse_events where event_key like ?').run(`${prefix}%`);
}

test('invalid or missing configuration remains finite and conservative', () => {
  assert.deepEqual(readInboundAbuseConfig({}), INBOUND_ABUSE_DEFAULTS);
  assert.deepEqual(readInboundAbuseConfig({
    INBOUND_RATE_WINDOW_MINUTES: '0',
    INBOUND_CUSTOMER_TURNS_PER_WINDOW: 'unlimited',
    INBOUND_OWNER_TURNS_PER_WINDOW: '-1',
  }), INBOUND_ABUSE_DEFAULTS);
});

test('customer turns are admitted up to the limit and then rejected without a model call', () => {
  const prefix = `abuse-customer-${Date.now()}-`;
  const phone = `92300${Date.now()}`;
  const now = new Date('2026-10-04T05:00:00.000Z');
  try {
    assert.equal(admitInboundTurn({ phone, eventKey: `${prefix}1`, owner: false, now, config }).allow, true);
    assert.equal(admitInboundTurn({ phone, eventKey: `${prefix}2`, owner: false, now, config }).allow, true);
    const blocked = admitInboundTurn({ phone, eventKey: `${prefix}3`, owner: false, now, config });
    assert.equal(blocked.allow, false);
    if (!blocked.allow) {
      assert.equal(blocked.reason, 'rate_limited');
      assert.equal(blocked.used, 2);
      assert.equal(blocked.retryAfterSeconds, 600);
    }
  } finally {
    cleanup(prefix);
  }
});

test('one provider event receives one durable admission decision', () => {
  const prefix = `abuse-idempotent-${Date.now()}-`;
  const eventKey = `${prefix}1`;
  try {
    const first = admitInboundTurn({ phone: '923001111111', eventKey, owner: false, config });
    const retry = admitInboundTurn({ phone: '923001111111', eventKey, owner: false, config });
    assert.equal(first.allow, true);
    assert.equal(retry.allow, true);
    if (retry.allow) assert.equal(retry.reason, 'already_admitted');
    const rows = (db.prepare('select count(*) as count from inbound_abuse_events where event_key = ?')
      .get(eventKey) as { count: number }).count;
    assert.equal(rows, 1);
  } finally {
    cleanup(prefix);
  }
});

test('the owner has a separate finite limit and expired events leave the window', () => {
  const prefix = `abuse-owner-${Date.now()}-`;
  const phone = `92301${Date.now()}`;
  const start = new Date('2026-10-04T05:00:00.000Z');
  try {
    for (let index = 1; index <= 3; index++) {
      assert.equal(admitInboundTurn({ phone, eventKey: `${prefix}${index}`, owner: true, now: start, config }).allow, true);
    }
    assert.equal(admitInboundTurn({ phone, eventKey: `${prefix}4`, owner: true, now: start, config }).allow, false);
    const later = new Date(start.getTime() + 10 * 60_000 + 1);
    assert.equal(admitInboundTurn({ phone, eventKey: `${prefix}5`, owner: true, now: later, config }).allow, true);
  } finally {
    cleanup(prefix);
  }
});

