import assert from 'node:assert/strict';
import test from 'node:test';

import {
  deliverOwnerAlert,
  OWNER_ALERT_FLOOD_DEFAULTS,
  readOwnerAlertFloodConfig,
  retryPendingOwnerAlerts,
  type OwnerAlertFloodConfig,
} from '../src/alerts';
import { db } from '../src/db';

test('invalid owner-alert flood configuration remains finite', () => {
  assert.deepEqual(readOwnerAlertFloodConfig({}), OWNER_ALERT_FLOOD_DEFAULTS);
  assert.deepEqual(readOwnerAlertFloodConfig({
    OWNER_ALERT_WINDOW_MINUTES: '0',
    OWNER_ALERT_MAX_SENDS_PER_WINDOW: 'unlimited',
  }), OWNER_ALERT_FLOOD_DEFAULTS);
});

test('excess owner alerts remain pending and the existing retry path sends them later', async () => {
  db.exec('begin');
  try {
    db.prepare("update owner_alerts set status = 'sent', sent_at = '2000-01-01 00:00:00'").run();
    const phone = `999${Date.now()}`;
    const customerId = Number(
      db.prepare('insert into customers (phone) values (?)').run(phone).lastInsertRowid,
    );
    const config: OwnerAlertFloodConfig = { windowMinutes: 10, maxSendsPerWindow: 2 };
    const start = new Date('2030-01-01T05:00:00.000Z');
    const sentBodies: string[] = [];
    const send = async (body: string): Promise<void> => {
      sentBodies.push(body);
    };

    const first = await deliverOwnerAlert({
      kind: 'customer_handoff',
      eventKey: `${phone}:1`,
      customerId,
      reason: 'First alert.',
      send,
      floodConfig: config,
      now: start,
    });
    const second = await deliverOwnerAlert({
      kind: 'customer_handoff',
      eventKey: `${phone}:2`,
      customerId,
      reason: 'Second alert.',
      send,
      floodConfig: config,
      now: new Date(start.getTime() + 1_000),
    });
    const limited = await deliverOwnerAlert({
      kind: 'customer_handoff',
      eventKey: `${phone}:3`,
      customerId,
      reason: 'Third alert.',
      send,
      floodConfig: config,
      now: new Date(start.getTime() + 2_000),
    });

    assert.equal(first.status, 'sent');
    assert.equal(second.status, 'sent');
    assert.equal(limited.status, 'pending');
    assert.equal(limited.reason, 'rate_limited');
    assert.equal(sentBodies.length, 2);

    const stillLimited = await retryPendingOwnerAlerts(
      send,
      config,
      new Date(start.getTime() + 5 * 60_000),
    );
    assert.equal(stillLimited.length, 1);
    assert.equal(stillLimited[0].reason, 'rate_limited');
    assert.equal(sentBodies.length, 2);

    const recovered = await retryPendingOwnerAlerts(
      send,
      config,
      new Date(start.getTime() + 11 * 60_000),
    );
    assert.equal(recovered.length, 1);
    assert.equal(recovered[0].status, 'sent');
    assert.equal(sentBodies.length, 3);
  } finally {
    db.exec('rollback');
  }
});
