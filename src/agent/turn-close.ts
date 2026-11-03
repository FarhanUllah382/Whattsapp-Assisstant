// CLOSE step of the customer turn: forced checkpoint summary + durable notes
// extraction, then the Version 2.3 order/payment safety net. Split out of
// runTurn (agent.ts) unchanged; runTurn passes its turn-local state in.

import type { DeliverOwnerAlertResult, OwnerAlertKind } from '../alerts';
import { db } from '../db';
import { callModel, type ModelMessage } from '../llm';
import { createLogger } from '../obs/logger';
import { createPaymentClaim, PaymentClaimNotNeededError } from '../payments';
import { sanitizeMemoryText } from '../privacy';
import { confirmPendingOrderDraft, getPendingOrderDraft, isExplicitOrderConfirmation } from '../tools';
import type { Customer, ToolContext } from '../types';
import { CLOSE_SYSTEM_PROMPT } from './prompts';

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
  /** A customer-visible reply was delivered by the LOOP (not the fallback). */
  replied?: boolean;
  incomingText: string;
  inboundEventKey: string | undefined;
  toolContext: ToolContext;
  deliverConfiguredAlert: DeliverConfiguredAlert | undefined;
  recordAndAlertHandoff: (kind: OwnerAlertKind, reason: string) => Promise<void>;
}

// ── FIX5 (cost): when the CLOSE model call may be skipped ────────────────
//
// The CLOSE call re-sends the whole turn to the model only to (a) refresh the
// checkpoint summary, (b) extract durable notes and (c) report an
// unlogged order/payment. It is skipped only when ALL of these hold, so
// (c) can never be lost for a turn that could contain an order or payment:
//   1. a checkpoint already exists (a new customer always gets one);
//   2. the LOOP delivered a reply itself (no fallback / reply failure);
//   3. every tool called this turn is a read-only lookup or the plain reply
//      (an allowlist: any other or future tool forces the call);
//   4. the inbound text has no order / payment / address / name / phone /
//      preference / complaint signal (CLOSE_SIGNAL_PATTERNS);
//   5. fewer than CHECKPOINT_EVERY_N_TURNS inbound messages arrived since the
//      checkpoint was last written, so the summary is refreshed at least every
//      N turns — and N stays below the turn's raw history window, so the
//      skipped turns are still in front of the model when it next runs.
// The deterministic explicit-confirmation recovery below never needed the
// model and runs on every turn regardless.

const CLOSE_SKIPPABLE_TOOLS: ReadonlySet<string> = new Set([
  'send_message',
  'check_stock',
  'search_catalog',
  'show_product_images',
  'get_customer_note',
]);

// Case-insensitive; deliberately broad (a false positive only costs one call).
export const CLOSE_SIGNAL_PATTERNS: readonly RegExp[] = [
  // orders / buying intent / cancellation / delivery
  /\b(order|orders|book|booking|confirm|buy|purchase|khareed\w*|chahiye|chahye|chaiye|chahie|lena|lelo|le\s+lo|bhej\w*|send\s+me|deliver\w*|cancel\w*|ship\w*|qty|quantity)\b/i,
  // payments / money owed / proof
  /\b(pay|paid|payment\w*|paisa|paise|pese|rupay\w*|rupee\w*|rs\.?|pkr|amount|transfer\w*|jazz\s*cash|jazzcash|easy\s*paisa|easypaisa|bank|iban|account|a\/c|cod|cash|screenshot|receipt|transaction|trx|tid|owe|udhaar|udhar|baqaya|balance|refund\w*|wapas)\b/i,
  // name / contact / address
  /\b(name|naam|address|addr|ghar|house|flat|street|gali|mohalla|sector|block|phase|colony|town|city|shehar|postal|zip|landmark|phone|mobile|number|contact|whatsapp|email)\b/i,
  /(\+?92|\b0)3\d{2}[\s-]?\d{7}\b/,
  /\d{7,}/,
  /@/,
  // durable preferences / promises / complaints
  /\b(prefer\w*|pasand|remember|yaad|always|hamesha|usually|aksar|mera\s+size|my\s+size|promise|wada|waada|complain\w*|shikayat|wrong|damaged|kharab|late)\b/i,
  // handoff / complaint signals (verifier 2026-11-02): missing or damaged
  // items and asking for Ahmed must always reach the CLOSE safety net
  /\b(missing|kam\s+(?:hai|hain|tha|thi|the|aya|aaya|ayi|aayi|mila|mili)|kum\s+hai|nahi\s+(?:mila|mili|aya|aaya|ayi|aayi)|damage\w*|broken|toota|tuta|phata|wrong\s+item|ghalat|galat|defective|replace\w*|owner|ahmed|malik|manager)\b/i,
];

export function hasCloseSignal(text: string): boolean {
  return CLOSE_SIGNAL_PATTERNS.some((pattern) => pattern.test(text));
}

export const CHECKPOINT_EVERY_N_TURNS_DEFAULT = 4;

/** Fail-safe parse: 1..10 (1 = run CLOSE on every turn, the pre-FIX5 behaviour). */
export function readCheckpointEveryNTurns(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.CHECKPOINT_EVERY_N_TURNS?.trim() ?? '';
  if (!/^\d+$/.test(raw)) return CHECKPOINT_EVERY_N_TURNS_DEFAULT;
  const value = Number(raw);
  return value >= 1 && value <= 10 ? value : CHECKPOINT_EVERY_N_TURNS_DEFAULT;
}

export interface CloseModelDecision {
  run: boolean;
  reason: string;
}

export function decideCloseModelCall(input: {
  customerId: number;
  hasCheckpoint: boolean;
  replied: boolean;
  toolsCalledThisTurn: ReadonlySet<string>;
  incomingText: string;
}): CloseModelDecision {
  if (!input.hasCheckpoint) return { run: true, reason: 'no_checkpoint' };
  if (!input.replied) return { run: true, reason: 'no_reply' };
  for (const tool of input.toolsCalledThisTurn) {
    if (!CLOSE_SKIPPABLE_TOOLS.has(tool)) return { run: true, reason: `tool:${tool}` };
  }
  if (hasCloseSignal(input.incomingText)) return { run: true, reason: 'inbound_signal' };
  const every = readCheckpointEveryNTurns();
  if (every <= 1) return { run: true, reason: 'every_turn' };
  const row = db.prepare(`
    select count(*) as n from messages
     where customer_id = ? and direction = 'inbound'
       and created_at > coalesce((select updated_at from checkpoints where customer_id = ?), '')
  `).get(input.customerId, input.customerId) as { n: number };
  if (row.n >= every) return { run: true, reason: 'periodic' };
  return { run: false, reason: 'skipped' };
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

  const decision = decideCloseModelCall({
    customerId: customer.id,
    hasCheckpoint: checkpoint !== undefined,
    replied: input.replied ?? false,
    toolsCalledThisTurn,
    incomingText,
  });
  if (decision.run) {
    await closeWithModel(input);
  } else {
    log.info('close summary call skipped for a read-only turn', { customerId: customer.id });
    await runDeterministicSafetyNet(input);
  }
}

/** The explicit-confirmation recovery, which never depends on the model. */
async function runDeterministicSafetyNet(input: CloseCustomerTurnInput): Promise<boolean> {
  const { customer, toolsCalledThisTurn, incomingText, toolContext, recordAndAlertHandoff } = input;
  let recoveredConfirmation = false;
  try {
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
  } catch (err) {
    log.error('safety-net order/payment extraction failed', {
      customerId: customer.id,
      error: err instanceof Error ? err.message : String(err),
    });
  }
  return recoveredConfirmation;
}

async function closeWithModel(input: CloseCustomerTurnInput): Promise<void> {
  const {
    customer,
    checkpoint,
    messages,
    toolsCalledThisTurn,
    inboundEventKey,
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
  const closing = await callModel(CLOSE_SYSTEM_PROMPT, messages, []); // no tools — just want text
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
  const recoveredConfirmation = await runDeterministicSafetyNet(input);
  try {
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
        let claim: ReturnType<typeof createPaymentClaim>;
        try {
          claim = createPaymentClaim({
            customerId: customer.id,
            amount,
            eventKey: inboundEventKey ? `${inboundEventKey}:payment_claim` : undefined,
            // Same undelivered-COD rule as claim_payment (verifier 2026-11-02).
            inferMethodFromOrders: true,
          });
        } catch (error) {
          if (!(error instanceof PaymentClaimNotNeededError)) throw error;
          log.info('safety-net payment claim not recorded: only undelivered COD orders', {
            customerId: customer.id,
          });
          return;
        }
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
