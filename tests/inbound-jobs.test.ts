import assert from 'node:assert/strict';
import test from 'node:test';

import { db } from '../src/db';
import { recordInboundMessageOnce } from '../src/agent';
import {
  claimNextInboundJob,
  completeInboundJob,
  enqueueInboundJob,
  failOrRetryInboundJob,
  INBOUND_JOB_DEFAULTS,
  InboundJobWorkerPool,
  readInboundJobConfig,
  recoverInboundJobs,
  type InboundJobConfig,
} from '../src/inbound-jobs';
import { initializeInboundReplayGuard } from '../src/inbound-events';

const baseConfig: InboundJobConfig = {
  workerCount: 2,
  maxPendingJobs: 500,
  leaseSeconds: 60,
  maxAttempts: 2,
  retryBaseSeconds: 1,
};

function insertInboundEvent(eventKey: string, occurredAt = new Date('2030-01-01T00:00:00.000Z')): void {
  const now = occurredAt.toISOString();
  db.prepare(`
    insert into inbound_events
      (event_key, channel, message_id, occurred_at, status, processing_started_at, updated_at)
    values (?, 'test', ?, ?, 'processing', ?, ?)
  `).run(eventKey, eventKey, now, now, now);
}

test('invalid durable-queue configuration remains finite', () => {
  assert.deepEqual(readInboundJobConfig({}), INBOUND_JOB_DEFAULTS);
  assert.deepEqual(readInboundJobConfig({
    INBOUND_JOB_WORKERS: '0',
    INBOUND_JOB_MAX_PENDING: 'unlimited',
    INBOUND_JOB_LEASE_SECONDS: '-1',
    INBOUND_JOB_MAX_ATTEMPTS: '0',
    INBOUND_JOB_RETRY_BASE_SECONDS: 'none',
  }), INBOUND_JOB_DEFAULTS);
});

test('durable queue is bounded, FIFO, idempotent, and clears text only after completion', () => {
  db.exec('begin');
  try {
    const prefix = `queue-${Date.now()}`;
    const existingPending = (db.prepare(
      "select count(*) as count from inbound_jobs where status = 'pending'",
    ).get() as { count: number }).count;
    const config = { ...baseConfig, maxPendingJobs: existingPending + 2 };
    for (let index = 1; index <= 3; index += 1) insertInboundEvent(`${prefix}:${index}`);

    const firstQueued = enqueueInboundJob({
      eventKey: `${prefix}:1`, phone: `${Date.now()}01`, body: 'first', owner: false, config,
    });
    const duplicate = enqueueInboundJob({
      eventKey: `${prefix}:1`, phone: `${Date.now()}01`, body: 'first', owner: false, config,
    });
    const secondQueued = enqueueInboundJob({
      eventKey: `${prefix}:2`, phone: `${Date.now()}02`, body: 'second', owner: false, config,
    });
    const full = enqueueInboundJob({
      eventKey: `${prefix}:3`, phone: `${Date.now()}03`, body: 'third', owner: false, config,
    });
    assert.equal(firstQueued.queued, true);
    assert.equal(duplicate.queued && duplicate.status, 'already_queued');
    assert.equal(secondQueued.queued, true);
    assert.deepEqual(full.queued ? null : full.reason, 'queue_full');

    const first = claimNextInboundJob(config, new Date('2030-01-01T00:00:01.000Z'));
    assert.ok(first);
    assert.equal(first.eventKey, `${prefix}:1`);
    completeInboundJob(first, new Date('2030-01-01T00:00:02.000Z'));
    const stored = db.prepare(
      'select status, body from inbound_jobs where id = ?',
    ).get(first.id) as { status: string; body: string | null };
    assert.deepEqual(stored, { status: 'completed', body: null });
    assert.equal(
      (db.prepare('select status from inbound_events where event_key = ?').get(first.eventKey) as { status: string }).status,
      'completed',
    );

    const second = claimNextInboundJob(config, new Date('2030-01-01T00:00:03.000Z'));
    assert.ok(second);
    assert.equal(second.eventKey, `${prefix}:2`);
  } finally {
    db.exec('rollback');
  }
});

test('default-sized durable queue retains 500 waiting messages and refuses the 501st', () => {
  db.exec('begin');
  try {
    const prefix = `capacity-500-${Date.now()}`;
    const existingPending = (db.prepare(
      "select count(*) as count from inbound_jobs where status = 'pending'",
    ).get() as { count: number }).count;
    const config = { ...baseConfig, maxPendingJobs: existingPending + 500 };
    for (let index = 0; index <= 500; index += 1) {
      insertInboundEvent(`${prefix}:${index}`);
    }
    for (let index = 0; index < 500; index += 1) {
      const result = enqueueInboundJob({
        eventKey: `${prefix}:${index}`,
        phone: `997${Date.now()}${index}`,
        body: `durable message ${index}`,
        owner: false,
        config,
      });
      assert.equal(result.queued, true);
    }
    const overflow = enqueueInboundJob({
      eventKey: `${prefix}:500`,
      phone: `997${Date.now()}500`,
      body: 'must be retried by provider',
      owner: false,
      config,
    });
    assert.equal(overflow.queued, false);
    if (!overflow.queued) assert.equal(overflow.reason, 'queue_full');
    assert.equal(
      (db.prepare('select count(*) as count from inbound_jobs where event_key like ?')
        .get(`${prefix}:%`) as { count: number }).count,
      500,
    );
  } finally {
    db.exec('rollback');
  }
});

test('restart recovery preserves queued text and replay guard does not quarantine its event', () => {
  db.exec('begin');
  try {
    const eventKey = `recovery-${Date.now()}`;
    insertInboundEvent(eventKey, new Date('2098-12-31T23:00:00.000Z'));
    enqueueInboundJob({
      eventKey,
      phone: `${Date.now()}11`,
      body: 'survive restart',
      owner: false,
      config: baseConfig,
      now: new Date('2098-12-31T23:00:00.000Z'),
    });
    const claimed = claimNextInboundJob(baseConfig, new Date('2098-12-31T23:00:01.000Z'));
    assert.ok(claimed);
    assert.equal(recoverInboundJobs(new Date('2098-12-31T23:00:02.000Z')), 1);
    initializeInboundReplayGuard(new Date('2099-01-01T00:00:00.000Z'));
    assert.equal(
      (db.prepare('select status from inbound_events where event_key = ?').get(eventKey) as { status: string }).status,
      'processing',
    );
    const reclaimed = claimNextInboundJob(baseConfig, new Date('2099-01-01T00:00:01.000Z'));
    assert.ok(reclaimed);
    assert.equal(reclaimed.body, 'survive restart');
    assert.equal(reclaimed.attemptCount, 2);
  } finally {
    db.exec('rollback');
  }
});

test('transient failures retry with backoff and final failure remains inspectable', () => {
  db.exec('begin');
  try {
    const eventKey = `failure-${Date.now()}`;
    insertInboundEvent(eventKey);
    enqueueInboundJob({
      eventKey, phone: `${Date.now()}21`, body: 'retain on failure', owner: false, config: baseConfig,
    });
    const first = claimNextInboundJob(baseConfig, new Date('2030-01-01T00:00:01.000Z'));
    assert.ok(first);
    assert.equal(
      failOrRetryInboundJob(first, new Error('temporary outage'), baseConfig, new Date('2030-01-01T00:00:02.000Z')),
      'pending',
    );
    const second = claimNextInboundJob(baseConfig, new Date('2030-01-01T00:00:04.000Z'));
    assert.ok(second);
    assert.equal(
      failOrRetryInboundJob(second, new Error('continued outage'), baseConfig, new Date('2030-01-01T00:00:05.000Z')),
      'failed',
    );
    const stored = db.prepare(
      'select status, body, attempt_count from inbound_jobs where id = ?',
    ).get(second.id) as { status: string; body: string; attempt_count: number };
    assert.deepEqual(stored, { status: 'failed', body: 'retain on failure', attempt_count: 2 });
  } finally {
    db.exec('rollback');
  }
});

test('automatic retry records one inbound transcript row per provider event', () => {
  db.exec('begin');
  try {
    const phone = `${Date.now()}25`;
    const customerId = Number(
      db.prepare('insert into customers (phone) values (?)').run(phone).lastInsertRowid,
    );
    const eventKey = `transcript-${Date.now()}`;
    recordInboundMessageOnce(customerId, 'same retained message', eventKey);
    recordInboundMessageOnce(customerId, 'same retained message', eventKey);
    assert.equal(
      (db.prepare('select count(*) as count from messages where source_event_key = ?')
        .get(eventKey) as { count: number }).count,
      1,
    );
  } finally {
    db.exec('rollback');
  }
});

test('worker pool never exceeds configured concurrency and drains all durable jobs', async () => {
  db.exec('begin');
  let pool: InboundJobWorkerPool | undefined;
  try {
    const prefix = `workers-${Date.now()}`;
    for (let index = 0; index < 5; index += 1) {
      const eventKey = `${prefix}:${index}`;
      insertInboundEvent(eventKey);
      enqueueInboundJob({
        eventKey,
        phone: `${Date.now()}3${index}`,
        body: `job ${index}`,
        owner: index === 4,
        config: baseConfig,
      });
    }

    let active = 0;
    let maximumActive = 0;
    pool = new InboundJobWorkerPool(baseConfig, async () => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise((resolve) => setTimeout(resolve, 10));
      active -= 1;
    });
    pool.kick();

    await new Promise<void>((resolve, reject) => {
      const deadline = Date.now() + 2_000;
      const timer = setInterval(() => {
        const completed = (db.prepare(`
          select count(*) as count from inbound_jobs
          where event_key like ? and status = 'completed'
        `).get(`${prefix}:%`) as { count: number }).count;
        if (completed === 5) {
          clearInterval(timer);
          resolve();
        } else if (Date.now() >= deadline) {
          clearInterval(timer);
          reject(new Error(`Timed out with ${completed}/5 jobs completed.`));
        }
      }, 10);
    });
    assert.equal(maximumActive, 2);
    assert.equal(
      (db.prepare(`
        select count(*) as count from inbound_jobs
        where event_key like ? and body is not null
      `).get(`${prefix}:%`) as { count: number }).count,
      0,
    );
  } finally {
    pool?.stop();
    db.exec('rollback');
  }
});
