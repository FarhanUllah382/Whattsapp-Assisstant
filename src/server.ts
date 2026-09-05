// ═══════════════════════════════════════════════════════════════════════════
// Where a WhatsApp message enters the system. Compare to `main.ts` + the
// `drainLoop` in the big reference file: that version turns inbound events
// into queued jobs, processed by a pool of workers. We don't need a queue
// yet — one Ahmed doesn't produce enough concurrent messages to need one.
// Handle each message inline, as it arrives.
//
// The actual WhatsApp connection lives behind `ChannelAdapter`
// (src/channel/types.ts) — this file only does two things:
//   1. call `runTurn()` when the adapter recognizes an inbound message
//   2. give `runTurn()` a `sendToCustomer` that calls the adapter's sendText
// Swapping providers later (Cloud API, Twilio, ...) means writing a new
// adapter and changing the one import below — nothing else in this file,
// and nothing in agent.ts/tools.ts, needs to change.
// ═══════════════════════════════════════════════════════════════════════════

import express from 'express';
import { runOwnerTurn, runTurn } from './agent';
import { wahaAdapter } from './channel/waha';
import { createLogger } from './obs/logger';
import { isOwnerPhone } from './owner';

const app = express();
app.use(express.json());

const channel = wahaAdapter;
const log = createLogger();

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
      await runTurn(inbound.phone, inbound.text, (body) => channel.sendText(inbound.phone, body));
    }
    log.info('turn completed', { phone: inbound.phone, turnKind: isOwner ? 'owner' : 'customer' });
    res.sendStatus(200);
  } catch (err) {
    log.error('turn failed', {
      phone: inbound.phone,
      turnKind: isOwner ? 'owner' : 'customer',
      error: err instanceof Error ? err.message : String(err),
    });
    res.sendStatus(500); // let the provider retry, if it supports that
  }
});

const PORT = process.env.PORT ?? 3000;
app.listen(PORT, () => log.info('listening', { port: PORT, channel: channel.channel }));
