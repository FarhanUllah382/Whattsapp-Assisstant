// CLOSE step of the customer turn: forced checkpoint summary + durable notes
// extraction, then the Version 2.3 order/payment safety net. Split out of
// runTurn (agent.ts) unchanged; runTurn passes its turn-local state in.

import type { DeliverOwnerAlertResult, OwnerAlertKind } from '../alerts';
import { db } from '../db';
import { callModel, type ModelMessage } from '../llm';
import { createLogger } from '../obs/logger';
import { createPaymentClaim } from '../payments';
import { sanitizeMemoryText } from '../privacy';
import { confirmPendingOrderDraft, getPendingOrderDraft, isExplicitOrderConfirmation } from '../tools';
import type { Customer, ToolContext } from '../types';
import { SYSTEM_PROMPT } from './prompts';

const log = createLogger();

export type DeliverConfiguredAlert = (
  kind: OwnerAlertKind,
  eventKey: string,
  customerId: number,
  reason: string,
) => Promise<DeliverOwnerAlertResult>;

export interface CloseCustomerTurnInput {
  customer: Customer;
  checkpoint: { summary: string } | undefined;
  messages: ModelMessage[];
  toolsCalledThisTurn: Set<string>;
  incomingText: string;
  inboundEventKey: string | undefined;
  toolContext: ToolContext;
  deliverConfiguredAlert: DeliverConfiguredAlert | undefined;
  recordAndAlertHandoff: (kind: OwnerAlertKind, reason: string) => Promise<void>;
}

export async function closeCustomerTurn(input: CloseCustomerTurnInput): Promise<void> {
  const {
    customer,
    checkpoint,
    messages,
    toolsCalledThisTurn,
    incomingText,
    inboundEventKey,
    toolContext,
    deliverConfiguredAlert,
    recordAndAlertHandoff,
  } = input;

  // ── 3. CLOSE — force a summary + any new durable facts, save both ──────
  // Same trick as the big file's `CHECKPOINT_INSTRUCTION`: a SECOND, forced
  // call, so the summary doesn't depend on the model "remembering" to write
  // one. This is the whole reason Ahmed never has to scroll old chats again.
  // Piggybacks the durable-notes extraction onto the same call rather than
  // adding a third model round-trip.
  messages.push({
    role: 'user',
    content:
      'Summarize this conversation so far in 2-4 sentences: what the customer wants/ordered, ' +
      'what they still owe, any promises made (e.g. "will pay Friday"), and anything else ' +
      'worth remembering next time.\n\n' +
      'Also list any NEW durable facts about this customer worth remembering permanently ' +
      '(e.g. "prefers black", "usually orders in bulk") — only ones not already covered by the ' +
      '"Known facts" list you were shown or by the summary you just wrote. Most turns have none. ' +
      'Never include a name, phone/contact number, delivery address, postal code, email, account ' +
      'number, IBAN, or payment/transaction reference in summary or new_notes.\n\n' +
      'Also: if the customer just now clearly agreed to a NEW order or made a NEW payment that ' +
      'you have NOT already handled with prepare_order/confirm_order/claim_payment THIS turn, report it as a ' +
      'safety net so it is not lost — but do NOT guess exact numbers you are not sure of.\n' +
      '"unlogged_order": null, or {"confident": true/false, "items": [{"product_id":N,"qty":N}] ' +
      'or null, "description": "plain text of what you believe happened"}\n' +
      '"unlogged_payment": null, or {"confident": true/false, "amount": N or null, ' +
      '"description": "plain text"}\n' +
      'Set confident:true ONLY if you already know the real product_id (e.g. from calling ' +
      'check_stock earlier this turn) and the exact quantity or payment amount. An unlogged order ' +
      'must still be handed off; this report is never authority to skip fulfillment or explicit confirmation. Order prices are ' +
      'always loaded from the product database by the server. Otherwise set ' +
      "confident:false and just describe it — Ahmed will confirm it himself, never guess a " +
      'number into the books. Most turns have neither.\n\n' +
      'Reply with ONLY a JSON object, nothing else, in this exact shape:\n' +
      '{"summary": "...", "new_notes": [{"headline": "short phrase", "body": "fuller detail"}], ' +
      '"unlogged_order": null, "unlogged_payment": null}\n' +
      'Use an empty array for new_notes when there is nothing new.',
  });
  const closing = await callModel(SYSTEM_PROMPT, messages, []); // no tools — just want text
  const closingBlock = closing.content.find((b: any) => b.type === 'text');
  const closingText = closingBlock?.text?.trim() ?? '';

  let summary = checkpoint?.summary ?? '';
  let newNotes: { headline: string; body: string }[] = [];
  let unloggedOrder: any = null;
  let unloggedPayment: any = null;

  try {
    const jsonText = closingText.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
    const parsed = JSON.parse(jsonText);
    if (typeof parsed?.summary === 'string' && parsed.summary.trim() !== '') {
      summary = parsed.summary.trim();
    }
    if (Array.isArray(parsed?.new_notes)) {
      newNotes = parsed.new_notes.filter(
        (n: any) =>
          n &&
          typeof n.headline === 'string' &&
          n.headline.trim() !== '' &&
          typeof n.body === 'string' &&
          n.body.trim() !== '',
      );
    }
    if (parsed?.unlogged_order && typeof parsed.unlogged_order === 'object') {
      unloggedOrder = parsed.unlogged_order;
    }
    if (parsed?.unlogged_payment && typeof parsed.unlogged_payment === 'object') {
      unloggedPayment = parsed.unlogged_payment;
    }
  } catch {
    // Model didn't return valid JSON this turn — fall back to the old behavior
    // (treat the raw text as the summary) and skip notes rather than crash the
    // turn on malformed model output.
    if (closingText) summary = closingText;
  }

  summary = sanitizeMemoryText(summary);
  newNotes = newNotes.map((note) => ({
    headline: sanitizeMemoryText(note.headline),
    body: sanitizeMemoryText(note.body),
  }));

  db.prepare(
    `insert into checkpoints (customer_id, summary, updated_at)
     values (?, ?, datetime('now'))
     on conflict(customer_id) do update set summary = excluded.summary, updated_at = excluded.updated_at`,
  ).run(customer.id, summary);

  if (newNotes.length > 0) {
    const insertNote = db.prepare(
      'insert into customer_notes (customer_id, headline, body) values (?, ?, ?)',
    );
    for (const note of newNotes) {
      insertNote.run(customer.id, note.headline.trim().slice(0, 120), note.body.trim());
    }
  }

  // Version 2.3 safety net: catches an order/payment the customer clearly
  // agreed to but the model never called the required tool for
  // this turn. toolsCalledThisTurn — real bookkeeping from the loop above,
  // not the model's own say-so — is what gates this, so a real tool call
  // this turn can never get double-logged by its own safety net. For orders,
  // the model's closing JSON is never authority: only the deterministic
  // parser of the real inbound text can recover a missed confirm_order call,
  // and only against an already-prepared draft. Everything else is handed
  // off rather than bypassing delivery details or explicit confirmation.
  try {
    let recoveredConfirmation = false;
    if (
      !toolsCalledThisTurn.has('confirm_order') &&
      isExplicitOrderConfirmation(incomingText) &&
      getPendingOrderDraft(customer.id)
    ) {
      const recovered = confirmPendingOrderDraft(toolContext) as { ok?: boolean; order_id?: number; error?: string };
      recoveredConfirmation = recovered.ok === true;
      if (recoveredConfirmation) {
        log.info('safety-net confirmed prepared order from explicit inbound text', {
          customerId: customer.id,
          orderId: recovered.order_id,
        });
      } else {
        await recordAndAlertHandoff(
          'unlogged_order',
          `Explicit order confirmation could not be applied safely: ${recovered.error ?? 'unknown reason'}`,
        );
      }
    }

    if (
      !recoveredConfirmation &&
      !toolsCalledThisTurn.has('prepare_order') &&
      !toolsCalledThisTurn.has('confirm_order') &&
      unloggedOrder &&
      typeof unloggedOrder.description === 'string' &&
      unloggedOrder.description.trim() !== ''
    ) {
      await recordAndAlertHandoff(
        'unlogged_order',
        `Possible order needs complete fulfillment details and explicit customer confirmation: ${unloggedOrder.description.trim().slice(0, 400)}`,
      );
    }

    if (!toolsCalledThisTurn.has('claim_payment') && unloggedPayment) {
      const amount = unloggedPayment.amount;
      if (unloggedPayment.confident === true && typeof amount === 'number' && Number.isFinite(amount) && amount > 0) {
        const claim = createPaymentClaim({
          customerId: customer.id,
          amount,
          eventKey: inboundEventKey ? `${inboundEventKey}:payment_claim` : undefined,
        });
        if (deliverConfiguredAlert) {
          const delivery = await deliverConfiguredAlert(
            'payment_claim',
            `payment_claim:${claim.event_key ?? `claim:${claim.id}`}`,
            customer.id,
            `Payment claim #${claim.id}: amount ${claim.amount}. Approval is required before any ledger credit.`,
          );
          if (!delivery.ok) {
            log.error('payment-claim alert remains pending', {
              customerId: customer.id,
              claimId: claim.id,
              alertId: delivery.alertId,
            });
          }
        }
        log.info('safety-net payment claim recorded at turn close', {
          customerId: customer.id,
          claimId: claim.id,
          amount,
        });
      } else if (typeof unloggedPayment.description === 'string' && unloggedPayment.description.trim() !== '') {
        await recordAndAlertHandoff(
          'unlogged_payment',
          `Possible unlogged payment needs Ahmed's confirmation: ${unloggedPayment.description.trim().slice(0, 400)}`,
        );
      }
    }
  } catch (err) {
    log.error('safety-net order/payment extraction failed', {
      customerId: customer.id,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
