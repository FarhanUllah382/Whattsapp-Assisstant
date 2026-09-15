import assert from 'node:assert/strict';

import { deliverOwnerAlert, retryPendingOwnerAlerts } from '../src/alerts';
import { db } from '../src/db';

async function run(): Promise<void> {
  db.exec('begin');
  try {
    // Keep this regression test from treating genuine live pending alerts as
    // mock-delivered. The surrounding rollback restores their exact statuses.
    db.prepare("update owner_alerts set status = 'sent' where status = 'pending'").run();

    const customerId = Number(
      db.prepare('insert into customers (phone) values (?)').run(`v33-test-${Date.now()}`).lastInsertRowid,
    );

    const sentBodies: string[] = [];
    const send = async (body: string): Promise<void> => {
      sentBodies.push(body);
    };

    const first = await deliverOwnerAlert({
      kind: 'customer_handoff',
      eventKey: 'v33:success:one',
      customerId,
      reason: 'Customer needs a decision.',
      send,
    });
    const retry = await deliverOwnerAlert({
      kind: 'customer_handoff',
      eventKey: 'v33:success:one',
      customerId,
      reason: 'Customer needs a decision.',
      send,
    });
    assert.equal(first.status, 'sent');
    assert.equal(retry.status, 'already_sent');
    assert.equal(sentBodies.length, 1);

    let failOnce = true;
    const recoveredBodies: string[] = [];
    const flakySend = async (body: string): Promise<void> => {
      if (failOnce) {
        failOnce = false;
        throw new Error('simulated gateway outage');
      }
      recoveredBodies.push(body);
    };

    const failed = await deliverOwnerAlert({
      kind: 'unlogged_order',
      eventKey: 'v33:pending:first',
      customerId,
      reason: 'First possible order.',
      send: flakySend,
    });
    const recovered = await retryPendingOwnerAlerts(flakySend);
    const recoveredRetry = await deliverOwnerAlert({
      kind: 'unlogged_order',
      eventKey: 'v33:pending:first',
      customerId,
      reason: 'First possible order.',
      send: flakySend,
    });

    assert.equal(failed.status, 'pending');
    assert.equal(recovered.length, 1);
    assert.equal(recovered[0].status, 'sent');
    assert.equal(recoveredRetry.status, 'already_sent');
    assert.equal(recoveredBodies.length, 1);

    const alwaysFail = async (): Promise<void> => {
      throw new Error('simulated sustained outage');
    };
    await deliverOwnerAlert({
      kind: 'unlogged_payment',
      eventKey: 'v33:group:first',
      customerId,
      reason: 'First possible payment.',
      send: alwaysFail,
    });
    const groupedPending = await deliverOwnerAlert({
      kind: 'unlogged_payment',
      eventKey: 'v33:group:second',
      customerId,
      reason: 'Second possible payment.',
      send: alwaysFail,
    });
    const groupedBodies: string[] = [];
    const groupedRecovery = await retryPendingOwnerAlerts(async (body) => {
      groupedBodies.push(body);
    });
    assert.equal(groupedPending.status, 'pending');
    assert.equal(groupedRecovery.length, 1);
    assert.equal(groupedRecovery[0].status, 'sent');
    assert.equal(groupedBodies.length, 1);
    assert.match(groupedBodies[0], /Occurrences grouped: 2/);
    assert.match(groupedBodies[0], /Second possible payment/);

    const alert = db.prepare('select status, occurrence_count from owner_alerts where id = ?').get(
      groupedPending.alertId,
    ) as { status: string; occurrence_count: number };
    assert.deepEqual(alert, { status: 'sent', occurrence_count: 2 });
    assert.equal(
      (db.prepare('select count(*) as n from owner_alert_events where alert_id = ?').get(
        groupedPending.alertId,
      ) as { n: number }).n,
      2,
    );

    process.stdout.write('  ✔ V3.3 owner alerts deliver once, recover, and group pending duplicates\n');
  } finally {
    db.exec('rollback');
  }
}

run().catch((err) => {
  process.stderr.write(`${err instanceof Error ? err.stack : String(err)}\n`);
  process.exitCode = 1;
});
