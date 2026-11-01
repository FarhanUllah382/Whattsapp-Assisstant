import { db } from './db';
import { createLogger } from './obs/logger';
import { sanitizeMemoryText } from './privacy';

const log = createLogger();

export interface InboundJobConfig {
  workerCount: number;
  maxPendingJobs: number;
  leaseSeconds: number;
  maxAttempts: number;
  retryBaseSeconds: number;
}

export const INBOUND_JOB_DEFAULTS: InboundJobConfig = {
  workerCount: 4,
  maxPendingJobs: 500,
  leaseSeconds: 300,
  maxAttempts: 5,
  retryBaseSeconds: 30,
};

function boundedInteger(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  if (value === undefined || value.trim() === '') return fallback;
  if (!/^\d+$/.test(value.trim())) return fallback;
  const parsed = Number(value.trim());
  return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum
    ? parsed
    : fallback;
}

export function readInboundJobConfig(env: NodeJS.ProcessEnv = process.env): InboundJobConfig {
  return {
    workerCount: boundedInteger(env.INBOUND_JOB_WORKERS, INBOUND_JOB_DEFAULTS.workerCount, 1, 50),
    maxPendingJobs: boundedInteger(
      env.INBOUND_JOB_MAX_PENDING,
      INBOUND_JOB_DEFAULTS.maxPendingJobs,
      1,
      10_000,
    ),
    leaseSeconds: boundedInteger(
      env.INBOUND_JOB_LEASE_SECONDS,
      INBOUND_JOB_DEFAULTS.leaseSeconds,
      30,
      3_600,
    ),
    maxAttempts: boundedInteger(
      env.INBOUND_JOB_MAX_ATTEMPTS,
      INBOUND_JOB_DEFAULTS.maxAttempts,
      1,
      100,
    ),
    retryBaseSeconds: boundedInteger(
      env.INBOUND_JOB_RETRY_BASE_SECONDS,
      INBOUND_JOB_DEFAULTS.retryBaseSeconds,
      1,
      3_600,
    ),
  };
}

export interface InboundJob {
  id: number;
  eventKey: string;
  customerId: number;
  phone: string;
  body: string;
  turnKind: 'customer' | 'owner';
  attemptCount: number;
}

export type EnqueueInboundJobResult =
  | { queued: true; jobId: number; status: 'queued' | 'requeued' | 'already_queued'; pending: number; limit: number }
  | { queued: false; reason: 'queue_full' | 'invalid_body'; pending: number; limit: number };

function normalizePhone(phone: string): string {
  return phone.replace(/\D/g, '');
}

function getOrCreateCustomerId(phone: string): number {
  const normalized = normalizePhone(phone);
  const existing = db.prepare('select id from customers where phone = ?').get(normalized) as
    | { id: number }
    | undefined;
  if (existing) return existing.id;
  return Number(db.prepare('insert into customers (phone) values (?)').run(normalized).lastInsertRowid);
}

export function enqueueInboundJob(input: {
  eventKey: string;
  phone: string;
  body: string;
  owner: boolean;
  now?: Date;
  config?: InboundJobConfig;
}): EnqueueInboundJobResult {
  const config = input.config ?? readInboundJobConfig();
  if (typeof input.body !== 'string' || input.body.length < 1 || input.body.length > 65_536) {
    return { queued: false, reason: 'invalid_body', pending: 0, limit: config.maxPendingJobs };
  }
  const now = input.now ?? new Date();
  const nowSql = now.toISOString().slice(0, 19).replace('T', ' ');

  return db.transaction((): EnqueueInboundJobResult => {
    const existing = db.prepare(
      'select id, status from inbound_jobs where event_key = ?',
    ).get(input.eventKey) as { id: number; status: string } | undefined;
    const pending = (db.prepare(
      "select count(*) as count from inbound_jobs where status = 'pending'",
    ).get() as { count: number }).count;
    if (existing && existing.status !== 'failed') {
      return {
        queued: true,
        jobId: existing.id,
        status: 'already_queued',
        pending,
        limit: config.maxPendingJobs,
      };
    }
    if (pending >= config.maxPendingJobs) {
      return { queued: false, reason: 'queue_full', pending, limit: config.maxPendingJobs };
    }

    if (existing?.status === 'failed') {
      db.prepare(`
        update inbound_jobs
           set status = 'pending', body = ?, attempt_count = 0, available_at = ?,
               lease_expires_at = null, last_error = null, completed_at = null, updated_at = ?
         where id = ?
      `).run(input.body, nowSql, nowSql, existing.id);
      return {
        queued: true,
        jobId: existing.id,
        status: 'requeued',
        pending: pending + 1,
        limit: config.maxPendingJobs,
      };
    }

    const customerId = getOrCreateCustomerId(input.phone);
    const result = db.prepare(`
      insert into inbound_jobs
        (event_key, customer_id, turn_kind, body, available_at, created_at, updated_at)
      values (?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.eventKey,
      customerId,
      input.owner ? 'owner' : 'customer',
      input.body,
      nowSql,
      nowSql,
      nowSql,
    );
    return {
      queued: true,
      jobId: Number(result.lastInsertRowid),
      status: 'queued',
      pending: pending + 1,
      limit: config.maxPendingJobs,
    };
  }).immediate();
}

export function recoverInboundJobs(now: Date = new Date()): number {
  const nowSql = now.toISOString().slice(0, 19).replace('T', ' ');
  return db.prepare(`
    update inbound_jobs
       set status = 'pending', lease_expires_at = null, available_at = ?, updated_at = ?
     where status = 'processing'
  `).run(nowSql, nowSql).changes;
}

export function claimNextInboundJob(
  config: InboundJobConfig = readInboundJobConfig(),
  now: Date = new Date(),
): InboundJob | null {
  const nowSql = now.toISOString().slice(0, 19).replace('T', ' ');
  const leaseSql = new Date(now.getTime() + config.leaseSeconds * 1_000)
    .toISOString()
    .slice(0, 19)
    .replace('T', ' ');

  return db.transaction((): InboundJob | null => {
    const row = db.prepare(`
      select j.id
      from inbound_jobs j
      where (j.status = 'pending' and j.available_at <= ?)
         or (j.status = 'processing' and j.lease_expires_at <= ?)
      order by j.id
      limit 1
    `).get(nowSql, nowSql) as { id: number } | undefined;
    if (!row) return null;

    db.prepare(`
      update inbound_jobs
         set status = 'processing', attempt_count = attempt_count + 1,
             lease_expires_at = ?, updated_at = ?
       where id = ?
    `).run(leaseSql, nowSql, row.id);
    const job = db.prepare(`
      select j.id, j.event_key, j.customer_id, c.phone, j.body,
             j.turn_kind, j.attempt_count
      from inbound_jobs j
      join customers c on c.id = j.customer_id
      where j.id = ?
    `).get(row.id) as {
      id: number;
      event_key: string;
      customer_id: number;
      phone: string;
      body: string;
      turn_kind: 'customer' | 'owner';
      attempt_count: number;
    };
    return {
      id: job.id,
      eventKey: job.event_key,
      customerId: job.customer_id,
      phone: job.phone,
      body: job.body,
      turnKind: job.turn_kind,
      attemptCount: job.attempt_count,
    };
  }).immediate();
}

export function completeInboundJob(job: InboundJob, now: Date = new Date()): void {
  const nowSql = now.toISOString().slice(0, 19).replace('T', ' ');
  db.transaction(() => {
    const completed = db.prepare(`
      update inbound_jobs
         set status = 'completed', body = null, lease_expires_at = null,
             last_error = null, completed_at = ?, updated_at = ?
       where id = ? and status = 'processing'
    `).run(nowSql, nowSql, job.id);
    if (completed.changes !== 1) {
      throw new Error(`Inbound job ${job.id} was not processing at completion.`);
    }
    db.prepare(`
      update inbound_events
         set status = 'completed', completed_at = ?, last_error = null, updated_at = ?
       where event_key = ? and status = 'processing'
    `).run(now.toISOString(), now.toISOString(), job.eventKey);
  }).immediate();
}

function safeError(error: unknown): string {
  return sanitizeMemoryText(error instanceof Error ? error.message : String(error)).slice(0, 1_000);
}

export function deferInboundJob(
  job: InboundJob,
  error: unknown,
  delayMs: number,
  preserveAttempt = false,
  now: Date = new Date(),
): void {
  const availableAt = new Date(now.getTime() + Math.max(1_000, delayMs))
    .toISOString()
    .slice(0, 19)
    .replace('T', ' ');
  const nowSql = now.toISOString().slice(0, 19).replace('T', ' ');
  db.prepare(`
    update inbound_jobs
       set status = 'pending',
           attempt_count = case when ? = 1 and attempt_count > 0 then attempt_count - 1 else attempt_count end,
           available_at = ?, lease_expires_at = null, last_error = ?, updated_at = ?
     where id = ? and status = 'processing'
  `).run(preserveAttempt ? 1 : 0, availableAt, safeError(error), nowSql, job.id);
}

export function failOrRetryInboundJob(
  job: InboundJob,
  error: unknown,
  config: InboundJobConfig = readInboundJobConfig(),
  now: Date = new Date(),
): 'pending' | 'failed' {
  const detail = safeError(error);
  const nowSql = now.toISOString().slice(0, 19).replace('T', ' ');
  if (job.attemptCount < config.maxAttempts) {
    const exponent = Math.max(0, job.attemptCount - 1);
    const delaySeconds = Math.min(config.retryBaseSeconds * 2 ** exponent, 900);
    deferInboundJob(job, detail, delaySeconds * 1_000, false, now);
    return 'pending';
  }

  db.transaction(() => {
    db.prepare(`
      update inbound_jobs
         set status = 'failed', lease_expires_at = null, last_error = ?, updated_at = ?
       where id = ? and status = 'processing'
    `).run(detail, nowSql, job.id);
    db.prepare(`
      update inbound_events
         set status = 'failed', processing_started_at = null, last_error = ?, updated_at = ?
       where event_key = ? and status = 'processing'
    `).run(detail, now.toISOString(), job.eventKey);
  }).immediate();
  return 'failed';
}

export class InboundJobDeferredError extends Error {
  constructor(
    message: string,
    public readonly delayMs: number,
  ) {
    super(message);
    this.name = 'InboundJobDeferredError';
  }
}

export class InboundJobWorkerPool {
  private active = 0;
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly config: InboundJobConfig,
    private readonly processJob: (job: InboundJob) => Promise<void>,
  ) {}

  start(): void {
    recoverInboundJobs();
    this.kick();
    this.timer = setInterval(() => this.kick(), 1_000);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  snapshot(): { active: number; workers: number } {
    return { active: this.active, workers: this.config.workerCount };
  }

  kick(): void {
    while (this.active < this.config.workerCount) {
      const job = claimNextInboundJob(this.config);
      if (!job) break;
      this.active += 1;
      void this.run(job);
    }
  }

  private async run(job: InboundJob): Promise<void> {
    try {
      await this.processJob(job);
      completeInboundJob(job);
      log.info('durable inbound job completed', { jobId: job.id, attempt: job.attemptCount });
    } catch (error) {
      if (error instanceof InboundJobDeferredError) {
        deferInboundJob(job, error, error.delayMs, true);
        log.warn('durable inbound job deferred', {
          jobId: job.id,
          delayMs: error.delayMs,
          reason: sanitizeMemoryText(error.message),
        });
      } else {
        const status = failOrRetryInboundJob(job, error, this.config);
        log.error('durable inbound job attempt failed', {
          jobId: job.id,
          attempt: job.attemptCount,
          status,
          error: safeError(error),
        });
      }
    } finally {
      this.active = Math.max(0, this.active - 1);
      queueMicrotask(() => this.kick());
    }
  }
}
