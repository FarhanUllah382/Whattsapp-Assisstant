// ═══════════════════════════════════════════════════════════════════════════
// Where a WhatsApp message enters the system. Compare to `main.ts` + the
// `drainLoop` in the big reference file: that version turns inbound events
// into queued jobs, processed by a pool of workers. We don't need a queue
// yet — one Ahmed doesn't produce enough concurrent messages to need one.
// Handle each message inline, as it arrives.
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
import { retryOwnerAlerts, runOwnerTurn, runTurn, sendConsentConfirmation } from './agent';
import { wahaAdapter } from './channel/waha';
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
import { AHMED_OWNER_PHONE, isOwnerPhone } from './owner';
import {
  claimInboundEvent,
  completeInboundEvent,
  failInboundEvent,
  initializeInboundReplayGuard,
} from './inbound-events';

const app = express();
app.use(express.json());

const channel = wahaAdapter;
const log = createLogger();
const configuredOwnerPhone = AHMED_OWNER_PHONE;
const inboundAcceptAfter = initializeInboundReplayGuard();
const sendOwnerAlert = configuredOwnerPhone
  ? (body: string) => channel.sendText(configuredOwnerPhone, body)
  : undefined;

// Consent commands and their acknowledgements are serialized so a later
// START cannot overtake an in-flight STOP acknowledgement (or vice versa).
// This is intentionally one small global chain: customer sends are already
// globally paced for the single WhatsApp number, and consent commands are rare.
let consentSequence: Promise<void> = Promise.resolve();
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

app.post('/webhook/whatsapp', async (req, res) => {
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
  log.info('turn starting', { phone: inbound.phone, turnKind: isOwner ? 'owner' : 'customer' });
  try {
    if (isOwner) {
      await runOwnerTurn(inbound.phone, inbound.text, (body) => channel.sendText(inbound.phone, body));
    } else {
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
      await runTurn(
        inbound.phone,
        inbound.text,
        (body) => channel.sendText(inbound.phone, body),
        claim.eventKey,
        sendOwnerAlert,
      );
    }
    completeInboundEvent(claim.eventKey);
    log.info('turn completed', { phone: inbound.phone, turnKind: isOwner ? 'owner' : 'customer' });
    res.sendStatus(200);
  } catch (err) {
    failInboundEvent(claim.eventKey, err);
    log.error('turn failed', {
      phone: inbound.phone,
      turnKind: isOwner ? 'owner' : 'customer',
      error: err instanceof Error ? err.message : String(err),
    });
    res.sendStatus(500); // let the provider retry, if it supports that
  }
});

const PORT = process.env.PORT ?? 3000;
app.listen(PORT, () => {
  log.info('listening', {
    port: PORT,
    channel: channel.channel,
    inboundAcceptAfter: inboundAcceptAfter.toISOString(),
  });
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
