// The guarded customer send_message tool and its customer-send checks
// (consent, confirmation claims, wording vetoes, pacing, spinning, discount,
// one-time disclosure, send-ledger idempotency). Split out of agent.ts.

import { createHash } from 'node:crypto';

import { isCustomerOptedOut } from '../consent';
import { checkCheckoutCollectionReply, checkCustomerReplyScript } from '../customer-reply-safety';
import { db } from '../db';
import { checkDiscountRule } from '../guardrails/discount-rules';
import { checkHandoffClaimReply } from '../handoff-claims';
import { PACING_DEFAULTS } from '../guardrails/pacing/defaults';
import { decideSharedPacing } from '../guardrails/pacing/configured';
import { SPINNING_DEFAULTS } from '../guardrails/spinning/defaults';
import { decideSpinning, hashNormalized, normalizeCopy, type RecentCopy } from '../guardrails/spinning/engine';
import { checkInventoryDisclosureReply } from '../inventory-visibility';
import { checkSupportUpsellReply } from '../business-grounding';
import { createLogger } from '../obs/logger';
import { checkDeterministicOrderSummaryReply } from '../order-summary';
import {
  beginOutboundAttempt,
  inspectOutboundAttempt,
  markOutboundFailure,
  markOutboundSent,
} from '../outbound-delivery';
import { checkPaymentInstructionReply } from '../payment-instructions';
import { checkRefundCompletionClaim } from '../refunds';
import { checkSensitiveActionReply, type SensitiveActionFacts } from '../sensitive-action-wording';
import { checkInternalDisclosureReply } from '../untrusted-data';
import { getPendingOrderDraft } from '../tools';
import type { ToolContext, ToolDef } from '../types';
import {
  getPacingState,
  nowSql,
  SEND_RETRY_WINDOW_MS,
  sleep,
  withSendLock,
  type SendTextOperation,
} from './shared';

const log = createLogger();

// Sent exactly once per customer, prepended to their first-ever reply.
const DISCLOSURE_TEXT =
  "Just so you know — I'm a virtual assistant helping out with Ahmed's shop. Happy to help!";

// Percentages already on record for this customer — from their own
// persisted notes/checkpoint, not anything this turn's model output could
// invent — so discount-rules.ts can tell a recall of a past ask apart from
// a fresh offer. See discount-rules.ts's own comment for why this alone
// isn't sufficient (paired there with a retrospective-language check).
const PERCENT_IN_TEXT = /\b(\d{1,3})\s*%/g;

function getKnownDiscountPercents(customerId: number): Set<number> {
  const notes = db
    .prepare('select body from customer_notes where customer_id = ? and superseded_by is null')
    .all(customerId) as { body: string }[];
  const checkpoint = db
    .prepare('select summary from checkpoints where customer_id = ?')
    .get(customerId) as { summary: string } | undefined;

  const percents = new Set<number>();
  for (const text of [...notes.map((n) => n.body), checkpoint?.summary ?? '']) {
    for (const m of text.matchAll(PERCENT_IN_TEXT)) {
      const n = Number(m[1]);
      if (Number.isFinite(n)) percents.add(n);
    }
  }
  return percents;
}

function getRecentOutboundWindow(limit: number): RecentCopy[] {
  const rows = db
    .prepare("select body from messages where direction = 'outbound' order by id desc limit ?")
    .all(limit) as { body: string }[];
  return rows.map((r) => {
    const normalizedText = normalizeCopy(r.body);
    return { normalizedText, normalizedHash: hashNormalized(normalizedText) };
  });
}

/**
 * Runs when the AI decides to send an ordinary reply, and is also reused by the
 * deterministic payment-instructions tool. `turnKey` identifies the inbound message that triggered this turn
 * (see runTurn) — combined with the reply body, it's what makes a retried turn
 * that regenerates the same reply collide with its own prior send attempt.
 */
export function makeSendMessageTool(
  sendToCustomer: SendTextOperation,
  turnKey: string,
  options: {
    allowOptedOut?: boolean;
    skipSpinning?: boolean;
    skipDisclosure?: boolean;
    permanentIdempotency?: boolean;
    minimumRepeatIntervalMs?: number;
    authorizedPaymentBody?: string;
    authorizedHandoffBody?: string;
    authorizedOrderSummaryBody?: string;
    sensitiveActionFacts?: Readonly<SensitiveActionFacts>;
  } = {},
): ToolDef {
  return {
    name: 'send_message',
    description: 'Send a WhatsApp message to the customer. This is the only way to reply.',
    input_schema: {
      type: 'object',
      properties: { body: { type: 'string', description: 'the message text' } },
      required: ['body'],
    },
    execute: async ({ body }, ctx) => {
      if (typeof body !== 'string' || body.trim() === '') {
        return { ok: false, error: 'Message text must be a non-empty string.' };
      }

      const consentCheck = checkAutomatedCustomerSendAllowed(ctx.customerId, options.allowOptedOut === true);
      if (!consentCheck.ok) return consentCheck;

      const confirmationClaim = checkOrderConfirmationReply(body, ctx);
      if (!confirmationClaim.ok) return confirmationClaim;

      const orderSummaryCheck = checkDeterministicOrderSummaryReply(
        body,
        Boolean(getPendingOrderDraft(ctx.customerId)),
        options.authorizedOrderSummaryBody,
      );
      if (!orderSummaryCheck.ok) return orderSummaryCheck;

      const inventoryDisclosure = checkInventoryDisclosureReply(body, ctx.inboundText);
      if (!inventoryDisclosure.ok) return inventoryDisclosure;

      const refundClaim = checkRefundCompletionClaim(body);
      if (!refundClaim.ok) return refundClaim;

      const sensitiveActionCheck = checkSensitiveActionReply(body, options.sensitiveActionFacts);
      if (!sensitiveActionCheck.ok) return sensitiveActionCheck;

      const supportUpsell = checkSupportUpsellReply(ctx.inboundText, body);
      if (!supportUpsell.ok) return supportUpsell;

      const checkoutCollection = checkCheckoutCollectionReply(ctx.inboundText, body);
      if (!checkoutCollection.ok) return checkoutCollection;

      const scriptConsistency = checkCustomerReplyScript(ctx.inboundText, body);
      if (!scriptConsistency.ok) return scriptConsistency;

      const paymentInstructionCheck = checkPaymentInstructionReply(body, options.authorizedPaymentBody);
      if (!paymentInstructionCheck.ok) return paymentInstructionCheck;

      const handoffClaimCheck = checkHandoffClaimReply(body, options.authorizedHandoffBody);
      if (!handoffClaimCheck.ok) return handoffClaimCheck;

      const disclosureCheck = checkInternalDisclosureReply(body);
      if (!disclosureCheck.ok) return disclosureCheck;

      const sendId = createHash('sha256').update(`${turnKey}:${body}`).digest('hex');
      const bodyHash = createHash('sha256').update(body).digest('hex');
      const eventKeyHash = createHash('sha256').update(turnKey).digest('hex');
      const resendAfterMs = options.permanentIdempotency ? undefined : SEND_RETRY_WINDOW_MS;
      const prior = inspectOutboundAttempt(sendId, resendAfterMs);
      if (prior === 'already_sent') return { ok: true, status: 'already_sent', delivery_confirmed: true };
      if (prior === 'uncertain') {
        return { ok: true, status: 'delivery_uncertain', delivery_confirmed: false };
      }

      let attemptStarted = false;
      try {
        // Everything below reads and then acts on shared, order-sensitive
        // state (pacing's last-sent tracking, spinning's recent-outbound
        // window) — serialized through withSendLock so a concurrent turn
        // can't read the same stale state before this one commits its send.
        return await withSendLock(async () => {
          // Pacing: is Ahmed's number allowed to send right now? Outside the
          // sending window or over a daily cap, we don't send at all — the bounded
          // inbound queue is intentionally short-lived, and sleeping for hours would
          // hang this request. Only the short throttle/jitter gap (at most a couple
          // seconds by default) is worth actually blocking on.
          const now = new Date();
          if (options.minimumRepeatIntervalMs && options.minimumRepeatIntervalMs > 0) {
            const latestMatching = db.prepare(`
              select created_at
              from messages
              where customer_id = ? and direction = 'outbound' and body = ?
              order by id desc
              limit 1
            `).get(ctx.customerId, body) as { created_at: string } | undefined;
            if (latestMatching) {
              const lastSentAt = new Date(latestMatching.created_at.replace(' ', 'T') + 'Z').getTime();
              if (Number.isFinite(lastSentAt) && now.getTime() - lastSentAt < options.minimumRepeatIntervalMs) {
                return { ok: true, status: 'cooldown_suppressed' };
              }
            }
          }
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

          // Spinning: is this text a near-duplicate of a recent send to someone
          // else? Unlike pacing, waiting doesn't fix this — the model needs to
          // vary the wording, so this is a hard refusal with a teaching-text
          // reason rather than a delay.
          if (!options.skipSpinning) {
            const spinningDecision = decideSpinning({
              candidate: body,
              window: getRecentOutboundWindow(SPINNING_DEFAULTS.windowSize),
              knobs: SPINNING_DEFAULTS,
            });
            if (!spinningDecision.allow) {
              return { ok: false, error: spinningDecision.reason };
            }
          }

          // Unauthorized-discount guardrail: block before it ever reaches the
          // customer. A teaching-text reason, same as every other guardrail
          // here, so the model can reformulate instead of the turn crashing.
          const discountCheck = checkDiscountRule(body, getKnownDiscountPercents(ctx.customerId));
          if (!discountCheck.ok) {
            return { ok: false, error: discountCheck.reason };
          }

          // One-time "I'm a virtual assistant" disclosure on this customer's
          // first-ever reply. Prepended only to what's actually sent over the
          // wire — the stored transcript keeps the model's own undecorated text.
          const customerRow = db
            .prepare('select disclosure_sent_at from customers where id = ?')
            .get(ctx.customerId) as { disclosure_sent_at: string | null } | undefined;
          const needsDisclosure = !options.skipDisclosure && !customerRow?.disclosure_sent_at;
          const outgoingBody = needsDisclosure ? `${DISCLOSURE_TEXT}\n\n${body}` : body;

          const start = beginOutboundAttempt({
            id: sendId,
            customerId: ctx.customerId,
            recipientKind: 'customer',
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
          const receipt = await sendToCustomer(outgoingBody);

          markOutboundSent(sendId, receipt?.providerMessageId);
          db.prepare(
            'insert into messages (customer_id, direction, body, created_at) values (?, ?, ?, ?)',
          ).run(ctx.customerId, 'outbound', body, nowSql());
          if (needsDisclosure) {
            db.prepare("update customers set disclosure_sent_at = datetime('now') where id = ?").run(
              ctx.customerId,
            );
          }

          return { ok: true };
        });
      } catch (err) {
        const deliveryStatus = attemptStarted ? markOutboundFailure(sendId, err) : undefined;
        // The model only ever sees the teaching-text error below (never a
        // thrown exception, per this file's own rule) — but a swallowed send
        // failure with no trace anywhere is a real operational blind spot, so
        // log the actual cause here even though the tool contract stays the same.
        log.error('send_message failed', {
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

export function checkAutomatedCustomerSendAllowed(
  customerId: number,
  allowOptedOut = false,
): { ok: true } | { ok: false; error: string } {
  if (!allowOptedOut && isCustomerOptedOut(customerId)) {
    return {
      ok: false,
      error: 'Customer opted out — automated WhatsApp replies are disabled until an explicit START command.',
    };
  }
  return { ok: true };
}

export function checkOrderConfirmationReply(
  body: string,
  ctx: ToolContext,
): { ok: true } | { ok: false; error: string } {
  const normalized = body.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+/g, ' ');
  const claimsSuccess =
    /\b(?:your |aapka |apka )?order\b.{0,45}\b(?:confirmed|booked|placed|done|complete)\b/.test(normalized) ||
    /\b(?:your |aapka |apka )?order\b.{0,45}\b(?:confirm|book) ho (?:gaya|gayi)\b/.test(normalized);
  if (!claimsSuccess) return { ok: true };
  if (!ctx.idempotencyKey) {
    return { ok: false, error: 'Cannot claim an order was confirmed without a verified inbound event.' };
  }
  const evidence = db.prepare(`
    select 1
    from order_status_events e
    join orders o on o.id = e.order_id
    where o.customer_id = ? and e.to_status = 'confirmed' and e.source_event_key = ?
    limit 1
  `).get(ctx.customerId, ctx.idempotencyKey);
  return evidence
    ? { ok: true }
    : {
        ok: false,
        error:
          'This reply says the order is confirmed, but no confirmed order was recorded for this message. ' +
          'Do not claim success; explain the confirmation error instead.',
      };
}
