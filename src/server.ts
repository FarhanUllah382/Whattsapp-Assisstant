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
import { runTurn } from './agent';
import { wahaAdapter } from './channel/waha';
import { createLogger } from './obs/logger';

const app = express();
app.use(express.json());

const channel = wahaAdapter;
const log = createLogger();

app.post('/webhook/whatsapp', async (req, res) => {
  const inbound = channel.parseInboundWebhook(req.body);
  if (!inbound) {
    res.sendStatus(200); // not a customer text message (status update, our own echo, etc.) — nothing to do
    return;
  }

  try {
    await runTurn(inbound.phone, inbound.text, (body) => channel.sendText(inbound.phone, body));
    res.sendStatus(200);
  } catch (err) {
    log.error('turn failed', { error: err instanceof Error ? err.message : String(err) });
    res.sendStatus(500); // let the provider retry, if it supports that
  }
});

const PORT = process.env.PORT ?? 3000;
app.listen(PORT, () => log.info('listening', { port: PORT, channel: channel.channel }));
