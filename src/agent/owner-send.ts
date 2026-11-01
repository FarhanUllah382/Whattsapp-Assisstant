// Owner-directed sends: the paced owner send_message tool (shared pacing and
// send lock, send-ledger idempotency), the paced owner-alert sender, and the
// pending-alert retry entry point. Split out of agent.ts.

import { createHash } from 'node:crypto';

import { retryPendingOwnerAlerts } from '../alerts';
import { db } from '../db';
import { PACING_DEFAULTS } from '../guardrails/pacing/defaults';
import { decideSharedPacing } from '../guardrails/pacing/configured';
import { createLogger } from '../obs/logger';
import { AHMED_OWNER_PHONE } from '../owner';
import {
  beginOutboundAttempt,
  inspectOutboundAttempt,
  markOutboundFailure,
  markOutboundSent,
} from '../outbound-delivery';
import { checkInternalDisclosureReply } from '../untrusted-data';
import type { ToolDef } from '../types';
import {
  getOrCreateCustomer,
  getPacingState,
  nowSql,
  SEND_RETRY_WINDOW_MS,
  sleep,
  withSendLock,
  type SendTextOperation,
} from './shared';

const log = createLogger();

export function makePacedOwnerAlertSend(
  sendToOwner?: SendTextOperation,
): ((body: string) => Promise<void>) | undefined {
  if (!sendToOwner || !AHMED_OWNER_PHONE) return undefined;
  const owner = getOrCreateCustomer(AHMED_OWNER_PHONE.replace(/\D/g, ''));
  return async (body: string): Promise<void> => {
    const output = await makeOwnerSendTool(sendToOwner, `owner-alert:${body}`).execute(
      { body },
      { customerId: owner.id },
    ) as { ok?: boolean; delivery_confirmed?: boolean; error?: string };
    if (!output.ok || output.delivery_confirmed === false) {
      throw new Error(output.error ?? 'Owner alert delivery is uncertain and remains pending.');
    }
  };
}

export function makeOwnerSendTool(
  sendToOwner: SendTextOperation,
  turnKey: string,
  permanentIdempotency = false,
): ToolDef {
  return {
    name: 'send_message',
    description: 'Reply to Ahmed. This is the only way to reply to him.',
    input_schema: {
      type: 'object',
      properties: { body: { type: 'string', description: 'the message text' } },
      required: ['body'],
    },
    execute: async ({ body }, ctx) => {
      if (typeof body !== 'string' || body.trim() === '') {
        return { ok: false, error: 'Message text must be a non-empty string.' };
      }
      const disclosureCheck = checkInternalDisclosureReply(body);
      if (!disclosureCheck.ok) return disclosureCheck;
      const sendId = createHash('sha256').update(`owner:${turnKey}:${body}`).digest('hex');
      const bodyHash = createHash('sha256').update(body).digest('hex');
      const eventKeyHash = createHash('sha256').update(`owner:${turnKey}`).digest('hex');
      const resendAfterMs = permanentIdempotency ? undefined : SEND_RETRY_WINDOW_MS;
      const prior = inspectOutboundAttempt(sendId, resendAfterMs);
      if (prior === 'already_sent') return { ok: true, status: 'already_sent', delivery_confirmed: true };
      if (prior === 'uncertain') {
        return { ok: true, status: 'delivery_uncertain', delivery_confirmed: false };
      }
      let attemptStarted = false;
      try {
        return await withSendLock(async () => {
          const now = new Date();
          const pacingDecision = decideSharedPacing(
            now,
            getPacingState(PACING_DEFAULTS.timezone, now),
          );
          if (!pacingDecision.allow) {
            return { ok: false, error: `Not sending right now — ${pacingDecision.reason}` };
          }
          if (pacingDecision.waitMs > 0) {
            await sleep(pacingDecision.waitMs);
          }

          const start = beginOutboundAttempt({
            id: sendId,
            customerId: ctx.customerId,
            recipientKind: 'owner',
            eventKey: eventKeyHash,
            bodyHash,
            resendAfterMs,
          });
          if (start === 'already_sent') {
            return { ok: true, status: 'already_sent', delivery_confirmed: true };
          }
          if (start === 'uncertain') {
            return { ok: true, status: 'delivery_uncertain', delivery_confirmed: false };
          }
          attemptStarted = true;
          const receipt = await sendToOwner(body);
          markOutboundSent(sendId, receipt?.providerMessageId);
          db.prepare(
            'insert into messages (customer_id, direction, body, created_at) values (?, ?, ?, ?)',
          ).run(ctx.customerId, 'outbound', body, nowSql());
          return { ok: true };
        });
      } catch (err) {
        const deliveryStatus = attemptStarted ? markOutboundFailure(sendId, err) : undefined;
        log.error('owner send_message failed', {
          customerId: ctx.customerId,
          error: err instanceof Error ? err.message : String(err),
        });
        return deliveryStatus === 'uncertain'
          ? {
              ok: true,
              status: 'delivery_uncertain',
              delivery_confirmed: false,
              warning: 'Delivery could not be confirmed. Do not send another copy automatically.',
            }
          : { ok: false, error: 'Could not send the message — please try again.' };
      }
    },
  };
}

export async function retryOwnerAlerts(
  sendToOwner: SendTextOperation,
): Promise<void> {
  const send = makePacedOwnerAlertSend(sendToOwner);
  if (!send) return;
  const results = await retryPendingOwnerAlerts(send);
  if (results.length > 0) {
    log.info('pending owner alerts checked', {
      total: results.length,
      sent: results.filter((result) => result.ok).length,
      stillPending: results.filter((result) => !result.ok).length,
    });
  }
}
