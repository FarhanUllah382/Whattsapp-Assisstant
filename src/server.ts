// ═══════════════════════════════════════════════════════════════════════════
// Where a WhatsApp message enters the system. Compare to `main.ts` + the
// `drainLoop` in the big reference file: that version turns inbound events
// into queued jobs, processed by a pool of workers. This service now follows
// that durable pattern: accepted model-backed messages are committed to SQLite
// before WAHA is acknowledged, then a bounded worker pool drains them.
//
// The actual WhatsApp connection lives behind `ChannelAdapter`
// (src/channel/types.ts) — this file does three things:
//   1. call `runTurn()` when the adapter recognizes an inbound message
//   2. give `runTurn()` a `sendToCustomer` that calls the adapter's sendText
//   3. intercept deterministic STOP/START consent commands before the model
// Swapping providers later (Cloud API, Twilio, ...) means writing a new
// adapter and changing the one import below — nothing else in this file,
// and nothing in agent.ts/tools.ts, needs to change.
// ═══════════════════════════════════════════════════════════════════════════

import express from 'express';
import { admitInboundTurn, readInboundAbuseConfig } from './abuse-control';
import { AiBudgetExceededError } from './ai-budget';
import { AI_BUDGET_DEFERRED_REPLY } from './busy-reply';
import {
  retryOwnerAlerts,
  runOwnerTurn,
  runTurn,
  sendConsentConfirmation,
  sendTemporaryBusyReply,
} from './agent';
import { wahaAdapter } from './channel/waha';
import { createVerifiedBackup, readBackupConfig } from './database-backup';
import {
  consentConfirmationText,
  detectConsentCommand,
  getPendingConsentConfirmations,
  isPhoneOptedOut,
  markConsentConfirmationSent,
  recordConsentCommand,
  type ConsentEvent,
} from './consent';
import { createLogger } from './obs/logger';
import {
  livenessPayload,
  operationsAccessAllowed,
  readOperationalMetrics,
  readinessPayload,
} from './operations';
import { AHMED_OWNER_PHONE, isOwnerPhone } from './owner';
import {
  claimInboundEvent,
  completeInboundEvent,
  failInboundEvent,
  initializeInboundReplayGuard,
} from './inbound-events';
import {
  enqueueInboundJob,
  InboundJobDeferredError,
  InboundJobWorkerPool,
  readInboundJobConfig,
  type InboundJob,
} from './inbound-jobs';
import { verifyWahaWebhook } from './webhook-auth';

const app = express();

type RawBodyRequest = express.Request & { rawBody?: Buffer };

app.use(express.json({
  limit: '256kb',
  verify: (req, _res, body) => {
    (req as RawBodyRequest).rawBody = Buffer.from(body);
  },
}));

const channel = wahaAdapter;
const log = createLogger();
const configuredOwnerPhone = AHMED_OWNER_PHONE;
const inboundAcceptAfter = initializeInboundReplayGuard();
const inboundAbuseConfig = readInboundAbuseConfig();
const inboundJobConfig = readInboundJobConfig();
const backupConfig = readBackupConfig();
const sendOwnerAlert = configuredOwnerPhone
  ? (body: string) => channel.sendText(configuredOwnerPhone, body)
  : undefined;

// Consent commands and their acknowledgements are serialized so a later
// START cannot overtake an in-flight STOP acknowledgement (or vice versa).
// This is intentionally one small global chain: customer sends are already
// globally paced for the single WhatsApp number, and consent commands are rare.
let consentSequence: Promise<void> = Promise.resolve();
let busyReplyRunning = false;
function withConsentSequence<T>(operation: () => Promise<T>): Promise<T> {
  const result = consentSequence.then(operation, operation);
  consentSequence = result.then(() => undefined, () => undefined);
  return result;
}

async function deliverConsentConfirmation(event: ConsentEvent): Promise<void> {
  if (event.confirmation_status !== 'pending') return;
  const result = await sendConsentConfirmation(
    event.customer_id,
    `consent:${event.event_key}`,
    consentConfirmationText(event.action),
    (body) => channel.sendText(event.phone, body),
  );
  if (result.ok) {
    markConsentConfirmationSent(event.event_key);
    log.info('customer consent confirmation delivered', {
      customerId: event.customer_id,
      action: event.action,
    });
  } else {
    log.warn('customer consent confirmation remains pending', {
      customerId: event.customer_id,
      action: event.action,
      error: result.error,
    });
  }
}

async function retryConsentConfirmations(): Promise<void> {
  await withConsentSequence(async () => {
    for (const event of getPendingConsentConfirmations()) {
      await deliverConsentConfirmation(event);
    }
  });
}

async function trySendTemporaryBusyReply(input: {
  phone: string;
  eventKey: string;
  send: (body: string) => ReturnType<typeof channel.sendText>;
  body?: string;
}): Promise<void> {
  // Do not let a many-sender rejection burst build a second unbounded queue
  // behind the globally paced outbound sender. One busy reply may be in flight;
  // per-customer rolling suppression handles sequential repeats.
  if (busyReplyRunning) {
    log.info('temporary busy reply globally suppressed', { reason: 'send_in_progress' });
    return;
  }
  busyReplyRunning = true;
  try {
    const result = await sendTemporaryBusyReply(input.phone, input.eventKey, input.send, input.body);
    log.info('temporary busy reply checked', {
      ok: result.ok,
      status: result.status,
      error: result.error,
    });
  } finally {
    busyReplyRunning = false;
  }
}

async function processDurableInboundJob(job: InboundJob): Promise<void> {
  let customerReplyDelivered = false;
  const sendToJobPhone = async (body: string) => {
    const receipt = await channel.sendText(job.phone, body);
    customerReplyDelivered = true;
    return receipt;
  };
  const sendImageToJobPhone = async (image: Parameters<typeof channel.sendImage>[1]) => {
    const receipt = await channel.sendImage(job.phone, image);
    customerReplyDelivered = true;
    return receipt;
  };

  log.info('durable inbound job processing', {
    jobId: job.id,
    turnKind: job.turnKind,
    attempt: job.attemptCount,
  });
  try {
    if (job.turnKind === 'owner') {
      await runOwnerTurn(
        job.phone,
        job.body,
        (body) => channel.sendText(job.phone, body),
        undefined,
        job.eventKey,
      );
    } else {
      await runTurn(
        job.phone,
        job.body,
        sendToJobPhone,
        job.eventKey,
        sendOwnerAlert,
        sendImageToJobPhone,
      );
    }
    log.info('durable inbound job processed', { jobId: job.id, turnKind: job.turnKind });
  } catch (error) {
    if (error instanceof AiBudgetExceededError) {
      if (job.turnKind === 'customer' && !customerReplyDelivered) {
        await trySendTemporaryBusyReply({
          phone: job.phone,
          eventKey: job.eventKey,
          send: sendToJobPhone,
          body: AI_BUDGET_DEFERRED_REPLY,
        });
      }
      log.warn('durable inbound job deferred by daily AI budget', {
        jobId: job.id,
        turnKind: job.turnKind,
        reason: error.reason,
        dayKey: error.dayKey,
        used: error.used,
        limit: error.limit,
      });
      // Preserve the job and its attempt allowance. Hourly checks are cheap
      // because reserveAiModelCall fails before any provider network request;
      // the job will continue automatically after the Karachi-day reset.
      throw new InboundJobDeferredError(error.message, 60 * 60_000);
    }
    throw error;
  }
}

const inboundJobWorker = new InboundJobWorkerPool(inboundJobConfig, processDurableInboundJob);

app.get('/health', (_req, res) => {
  res.status(200).json(livenessPayload());
});

app.get('/ready', async (_req, res) => {
  const readiness = await readinessPayload(channel, inboundJobWorker.snapshot());
  res.status(readiness.ready ? 200 : 503).json(readiness.payload);
});

app.get('/operations/metrics', (req, res) => {
  if (!operationsAccessAllowed(req.headers['x-operations-key'])) {
    res.sendStatus(401);
    return;
  }
  res.status(200).json(readOperationalMetrics(inboundJobWorker.snapshot()));
});

app.post('/webhook/whatsapp', (req, res, next) => {
  const auth = verifyWahaWebhook({
    rawBody: (req as RawBodyRequest).rawBody,
    signature: req.headers['x-webhook-hmac'],
    algorithm: req.headers['x-webhook-hmac-algorithm'],
    secret: process.env.WAHA_WEBHOOK_HMAC_KEY,
  });
  if (!auth.ok) {
    log.warn('webhook authentication rejected', { reason: auth.reason });
    res.sendStatus(401);
    return;
  }
  next();
}, async (req, res) => {
  const inbound = channel.parseInboundWebhook(req.body);
  if (!inbound) {
    // Was a genuine operational blind spot: this branch never logged anything,
    // so a webhook silently ignored for the wrong reason (parser bug, unexpected
    // payload shape, etc.) looked identical to a correctly-ignored status update.
    log.info('webhook ignored', { event: (req.body as { event?: unknown })?.event });
    res.sendStatus(200); // not a customer text message (status update, our own echo, etc.) — nothing to do
    return;
  }

  const claim = claimInboundEvent({
    channel: channel.channel,
    messageId: inbound.messageId,
    occurredAt: inbound.occurredAt,
    acceptAfter: inboundAcceptAfter,
  });
  if (claim.action !== 'process') {
    log.info('inbound event skipped', {
      eventKey: claim.eventKey,
      action: claim.action,
      reason: claim.reason,
    });
    res.sendStatus(200);
    return;
  }

  // Version 3.1: the ONLY place this routing decision is made. isOwnerPhone
  // is fail-closed (see owner.ts) — an unconfigured/misconfigured owner
  // number just means every sender is treated as a customer, never the
  // other way around.
  const isOwner = isOwnerPhone(inbound.phone);
  const sendBusyIfNeeded = async (): Promise<void> => {
    if (isOwner) return;
    await trySendTemporaryBusyReply({
      phone: inbound.phone,
      eventKey: claim.eventKey,
      send: (body) => channel.sendText(inbound.phone, body),
    });
  };
  log.info('inbound event admission starting', { turnKind: isOwner ? 'owner' : 'customer' });
  try {
    if (!isOwner) {
      const consentAction = detectConsentCommand(inbound.text);
      if (consentAction) {
        const consentEvent = await withConsentSequence(async () => {
          const event = recordConsentCommand({
            phone: inbound.phone,
            eventKey: claim.eventKey,
            text: inbound.text,
            action: consentAction,
          });
          await deliverConsentConfirmation(event);
          return event;
        });
        completeInboundEvent(claim.eventKey);
        log.info('customer consent command completed', {
          customerId: consentEvent.customer_id,
          action: consentAction,
        });
        res.sendStatus(200);
        return;
      }
      if (isPhoneOptedOut(inbound.phone)) {
        completeInboundEvent(claim.eventKey);
        log.info('opted-out customer message recorded without an automated turn', {
          eventKey: claim.eventKey,
        });
        res.sendStatus(200);
        return;
      }
    }

    const admission = admitInboundTurn({
      phone: inbound.phone,
      eventKey: claim.eventKey,
      owner: isOwner,
      config: inboundAbuseConfig,
    });
    if (!admission.allow) {
      await sendBusyIfNeeded();
      completeInboundEvent(claim.eventKey);
      log.warn('inbound model turn rate limited', {
        turnKind: isOwner ? 'owner' : 'customer',
        used: admission.used,
        limit: admission.limit,
        retryAfterSeconds: admission.retryAfterSeconds,
      });
      res.sendStatus(200);
      return;
    }

    const queued = enqueueInboundJob({
      eventKey: claim.eventKey,
      phone: inbound.phone,
      body: inbound.text,
      owner: isOwner,
      config: inboundJobConfig,
    });
    if (!queued.queued) {
      await sendBusyIfNeeded();
      const error = new Error(`Durable inbound queue rejected message: ${queued.reason}`);
      failInboundEvent(claim.eventKey, error);
      log.warn('durable inbound queue rejected event', {
        turnKind: isOwner ? 'owner' : 'customer',
        reason: queued.reason,
        pending: queued.pending,
        limit: queued.limit,
      });
      // Queue saturation is retryable: never tell WAHA the message was safely
      // accepted when no durable job exists. The busy reply is independently
      // idempotent and cooldown-limited if the provider retries.
      res.sendStatus(queued.reason === 'queue_full' ? 503 : 422);
      return;
    }
    inboundJobWorker.kick();
    log.info('durable inbound job accepted', {
      jobId: queued.jobId,
      queueStatus: queued.status,
      turnKind: isOwner ? 'owner' : 'customer',
      pending: queued.pending,
      limit: queued.limit,
    });
    res.sendStatus(200);
  } catch (err) {
    failInboundEvent(claim.eventKey, err);
    log.error('inbound event admission failed', {
      turnKind: isOwner ? 'owner' : 'customer',
      error: err instanceof Error ? err.message : String(err),
    });
    res.sendStatus(500); // let the provider retry, if it supports that
  }
});

inboundJobWorker.start();

const PORT = process.env.PORT ?? 3000;
app.listen(PORT, () => {
  log.info('listening', {
    port: PORT,
    channel: channel.channel,
    inboundAcceptAfter: inboundAcceptAfter.toISOString(),
    inboundRateWindowMinutes: inboundAbuseConfig.windowMinutes,
    inboundCustomerTurnsPerWindow: inboundAbuseConfig.customerTurnsPerWindow,
    inboundOwnerTurnsPerWindow: inboundAbuseConfig.ownerTurnsPerWindow,
    inboundJobWorkers: inboundJobConfig.workerCount,
    inboundJobMaxPending: inboundJobConfig.maxPendingJobs,
    inboundJobLeaseSeconds: inboundJobConfig.leaseSeconds,
    databaseBackupEnabled: backupConfig.enabled,
    databaseBackupIntervalHours: backupConfig.intervalHours,
    databaseBackupRetentionCount: backupConfig.retentionCount,
  });
  let backupRunning = false;
  const backup = (): void => {
    if (!backupConfig.enabled || backupRunning) return;
    backupRunning = true;
    void createVerifiedBackup(backupConfig)
      .then((result) => {
        log.info('verified database backup completed', {
          filename: result.path.split(/[\\/]/).pop(),
          sizeBytes: result.verification.sizeBytes,
          sha256: result.verification.sha256,
          removedCount: result.removed.length,
        });
      })
      .catch((error) => {
        log.error('verified database backup failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        backupRunning = false;
      });
  };
  backup();
  if (backupConfig.enabled) {
    setInterval(backup, backupConfig.intervalHours * 60 * 60_000).unref();
  }
  let retryRunning = false;
  const retry = (): void => {
    if (retryRunning) return;
    retryRunning = true;
    void (async () => {
      try {
        await retryConsentConfirmations();
        if (sendOwnerAlert) await retryOwnerAlerts(sendOwnerAlert);
      } catch (err) {
        log.error('pending delivery retry failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      } finally {
        retryRunning = false;
      }
    })();
  };
  retry();
  setInterval(retry, 60_000).unref();
});
