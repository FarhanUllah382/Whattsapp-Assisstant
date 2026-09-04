// ═══════════════════════════════════════════════════════════════════════════
// THE HEART OF THE SYSTEM.
//
// This is the small cousin of `executarTurnoDoAgente` in the big reference
// file. Same three-part ritual, same "no state survives between calls to
// this function" guarantee (everything lives in local variables here, not
// in a shared/global object) — just without the 15 guardrail layers.
//
//   1. OPEN   — load customer, recent messages, last checkpoint
//   2. LOOP   — let the AI call tools until it's done, incl. send_message
//   3. CLOSE  — ask the AI to summarize the turn, save as the new checkpoint
// ═══════════════════════════════════════════════════════════════════════════

import { createHash } from 'node:crypto';

import { db } from './db';
import { checkDiscountRule } from './guardrails/discount-rules';
import { detectHumanPromise } from './guardrails/human-promise';
import { PACING_DEFAULTS } from './guardrails/pacing/defaults';
import { dayStartInTz, decidePacing, type PacingState } from './guardrails/pacing/engine';
import { SPINNING_DEFAULTS } from './guardrails/spinning/defaults';
import { decideSpinning, hashNormalized, normalizeCopy, type RecentCopy } from './guardrails/spinning/engine';
import { callModel, type ModelMessage } from './llm';
import { createLogger } from './obs/logger';
import { baseTools } from './tools';
import type { Customer, ToolDef } from './types';

const log = createLogger();

const MAX_TOOL_STEPS = 6; // hard ceiling so a confused AI can't loop forever

// How long a "sent" ledger entry blocks a repeat send. Long enough to cover
// a crash-and-retry (a provider redelivering a webhook happens in seconds),
// short enough that a customer genuinely repeating themselves next week
// still gets a reply instead of being silently swallowed forever.
const SEND_RETRY_WINDOW_MS = 5 * 60 * 1000;

// Sent exactly once per customer, prepended to their first-ever reply.
const DISCLOSURE_TEXT =
  "Just so you know — I'm a virtual assistant helping out with Ahmed's shop. Happy to help!";

// How recently notify_owner must have been called for this customer for a
// "someone will follow up" reply to be allowed to send — long enough to
// cover the rest of the same turn (notify_owner and send_message are both
// tool calls within one runTurn()), short enough that a handoff from a much
// earlier, unrelated conversation doesn't retroactively excuse a brand-new
// empty reassurance. Same idiom as SEND_RETRY_WINDOW_MS above.
const HANDOFF_WINDOW_MS = 5 * 60 * 1000;

function hasRecentHandoff(customerId: number): boolean {
  const row = db
    .prepare('select created_at from handoff_ledger where customer_id = ? order by id desc limit 1')
    .get(customerId) as { created_at: string } | undefined;
  if (!row) return false;
  const loggedAt = new Date(row.created_at.replace(' ', 'T') + 'Z').getTime();
  return Date.now() - loggedAt < HANDOFF_WINDOW_MS;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Pacing and spinning are both about protecting Ahmed's ONE sending number in
// aggregate, not any single customer's thread — so both look at sends across
// ALL customers, not just the one this turn is talking to.

function getPacingState(timezone: string): PacingState {
  const last = db
    .prepare("select created_at from messages where direction = 'outbound' order by id desc limit 1")
    .get() as { created_at: string } | undefined;
  const lastSentAt = last ? new Date(last.created_at.replace(' ', 'T') + 'Z') : null;

  const todayStart = dayStartInTz(new Date(), timezone);
  const todayStartSql = todayStart.toISOString().slice(0, 19).replace('T', ' ');
  const sentToday = (
    db
      .prepare("select count(*) as c from messages where direction = 'outbound' and created_at >= ?")
      .get(todayStartSql) as { c: number }
  ).c;

  // No real WhatsApp connection yet (that's separate follow-up work), so there's
  // no genuine "number activation date" to read — treat it as unknown, which
  // the engine itself already treats as the most conservative warm-up step.
  return { lastSentAt, sentToday, numberActivatedAt: null };
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

const SYSTEM_PROMPT = `You are Ahmed's WhatsApp sales assistant, for his clothing business.
Reply naturally in whatever language/style the customer writes in (often Roman Urdu/English mix).
Always use the send_message tool to actually reply — your plain text is never seen by the customer.
Use check_stock before promising anything is available. Use record_order only once the customer
has clearly confirmed product, size, color and quantity. Be concise, friendly, and never invent
prices or stock numbers — check first.
Never offer a discount of 5% or more on your own — that needs Ahmed's confirmation first. If a
customer asks for a bigger discount, or asks anything else you genuinely can't resolve yourself,
call notify_owner before replying, and only then tell the customer you'll confirm with Ahmed.
Never tell a customer "someone will get back to you" unless you've actually called notify_owner
first — it won't send otherwise.
For general questions (what you sell, return policy, delivery info, etc — not live stock or
exact prices), use search_catalog. If it returns found:false, never invent an answer — tell the
customer you'll confirm and get back to them.`;

/**
 * Runs when the AI decides to reply. This is the ONLY way a message reaches the
 * customer. `turnKey` identifies the inbound message that triggered this turn
 * (see runTurn) — combined with the reply body, it's what makes a retried turn
 * that regenerates the same reply collide with its own prior send attempt.
 */
function makeSendMessageTool(
  sendToCustomer: (text: string) => Promise<void>,
  turnKey: string,
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

      const sendId = createHash('sha256').update(`${turnKey}:${body}`).digest('hex');

      try {
        const existing = db
          .prepare('select status, created_at from send_ledger where id = ?')
          .get(sendId) as { status: string; created_at: string } | undefined;

        if (existing?.status === 'sent') {
          const sentAt = new Date(existing.created_at.replace(' ', 'T') + 'Z').getTime();
          if (Date.now() - sentAt < SEND_RETRY_WINDOW_MS) {
            return { ok: true, status: 'already_sent' };
          }
        }

        // Pacing: is Ahmed's number allowed to send right now? Outside the
        // sending window or over a daily cap, we don't send at all — there's no
        // real job queue yet to defer to, and literally sleeping for hours would
        // hang this request. Only the short throttle/jitter gap (at most a couple
        // seconds by default) is worth actually blocking on.
        const pacingDecision = decidePacing({
          now: new Date(),
          knobs: PACING_DEFAULTS,
          state: getPacingState(PACING_DEFAULTS.timezone),
          crmDailyLimit: null,
        });
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
        const spinningDecision = decideSpinning({
          candidate: body,
          window: getRecentOutboundWindow(SPINNING_DEFAULTS.windowSize),
          knobs: SPINNING_DEFAULTS,
        });
        if (!spinningDecision.allow) {
          return { ok: false, error: spinningDecision.reason };
        }

        // Unauthorized-discount guardrail: block before it ever reaches the
        // customer. A teaching-text reason, same as every other guardrail
        // here, so the model can reformulate instead of the turn crashing.
        const discountCheck = checkDiscountRule(body);
        if (!discountCheck.ok) {
          return { ok: false, error: discountCheck.reason };
        }

        // Human-promise guardrail: "someone will follow up" is only allowed
        // alongside/after an actual handoff — never as an empty reassurance
        // the model invents on its own to end the conversation politely.
        if (detectHumanPromise(body) && !hasRecentHandoff(ctx.customerId)) {
          return {
            ok: false,
            error:
              'This message promises a human (Ahmed/the team) will follow up, but no handoff ' +
              'was recorded for this customer. Call notify_owner first if this genuinely needs ' +
              'Ahmed, or rephrase without promising a human follow-up.',
          };
        }

        // One-time "I'm a virtual assistant" disclosure on this customer's
        // first-ever reply. Prepended only to what's actually sent over the
        // wire — the stored transcript keeps the model's own undecorated text.
        const customerRow = db
          .prepare('select disclosure_sent_at from customers where id = ?')
          .get(ctx.customerId) as { disclosure_sent_at: string | null } | undefined;
        const needsDisclosure = !customerRow?.disclosure_sent_at;
        const outgoingBody = needsDisclosure ? `${DISCLOSURE_TEXT}\n\n${body}` : body;

        db.prepare(
          `insert into send_ledger (id, customer_id, status, created_at)
           values (?, ?, 'pending', datetime('now'))
           on conflict(id) do update set status = 'pending', created_at = datetime('now')`,
        ).run(sendId, ctx.customerId);

        await sendToCustomer(outgoingBody);

        db.prepare(`update send_ledger set status = 'sent' where id = ?`).run(sendId);
        db.prepare(
          'insert into messages (customer_id, direction, body) values (?, ?, ?)',
        ).run(ctx.customerId, 'outbound', body);
        if (needsDisclosure) {
          db.prepare("update customers set disclosure_sent_at = datetime('now') where id = ?").run(
            ctx.customerId,
          );
        }

        return { ok: true };
      } catch (err) {
        // The model only ever sees the teaching-text error below (never a
        // thrown exception, per this file's own rule) — but a swallowed send
        // failure with no trace anywhere is a real operational blind spot, so
        // log the actual cause here even though the tool contract stays the same.
        log.error('send_message failed', {
          customerId: ctx.customerId,
          error: err instanceof Error ? err.message : String(err),
        });
        return { ok: false, error: 'Could not send the message — please try again.' };
      }
    },
  };
}

function getOrCreateCustomer(phone: string): Customer {
  const existing = db.prepare('select * from customers where phone = ?').get(phone) as
    | Customer
    | undefined;
  if (existing) return existing;
  const result = db.prepare('insert into customers (phone) values (?)').run(phone);
  return db
    .prepare('select * from customers where id = ?')
    .get(result.lastInsertRowid) as Customer;
}

/**
 * The public entry point — this is what server.ts calls when a WhatsApp
 * message arrives. Compare to `runAgentTurn` in the big file: same job,
 * far fewer lines, because there's no queue, no multi-tenant scoping, and
 * no budget/guardrail machinery yet.
 */
export async function runTurn(
  phone: string,
  incomingText: string,
  sendToCustomer: (text: string) => Promise<void>,
): Promise<void> {
  const customer = getOrCreateCustomer(phone);

  // ── 1. OPEN — save the inbound message, load context ──────────────────
  db.prepare('insert into messages (customer_id, direction, body) values (?, ?, ?)').run(
    customer.id,
    'inbound',
    incomingText,
  );

  const recentMessages = db
    .prepare(
      'select direction, body from messages where customer_id = ? order by id desc limit 20',
    )
    .all(customer.id) as { direction: string; body: string }[];
  recentMessages.reverse(); // oldest first, for a natural transcript

  const checkpoint = db
    .prepare('select summary from checkpoints where customer_id = ?')
    .get(customer.id) as { summary: string } | undefined;

  // Durable facts (see `customer_notes`), separate from the rolling checkpoint
  // summary above. Only the cheap headline goes into every turn's context —
  // the model calls get_customer_note(note_id) if it needs the full body.
  const notes = db
    .prepare(
      'select id, headline from customer_notes where customer_id = ? and superseded_by is null order by id',
    )
    .all(customer.id) as { id: number; headline: string }[];

  const openingText = [
    `## What we remember about this customer so far`,
    checkpoint?.summary ?? 'Nothing yet — first conversation.',
    '',
    `## Known facts about this customer`,
    notes.length > 0
      ? notes.map((n) => `- [note #${n.id}] ${n.headline}`).join('\n')
      : 'None recorded yet.',
    '',
    `## Recent messages`,
    recentMessages.map((m) => `${m.direction}: ${m.body}`).join('\n'),
    '',
    `## New message just received`,
    incomingText,
  ].join('\n');

  // Deterministic per-turn key: same customer + same inbound text → same key,
  // so a retried runTurn() call (e.g. a redelivered webhook after a crash)
  // reuses it and its send_message call collides with the prior attempt.
  const turnKey = `${customer.id}:${incomingText}`;
  const tools = [...baseTools, makeSendMessageTool(sendToCustomer, turnKey)];

  // ── 2. LOOP — let the AI call tools, including send_message, until done ─
  const messages: ModelMessage[] = [{ role: 'user', content: openingText }];

  for (let step = 0; step < MAX_TOOL_STEPS; step++) {
    const result = await callModel(SYSTEM_PROMPT, messages, tools);
    messages.push({ role: 'assistant', content: result.content });

    const toolCalls = result.content.filter((b: any) => b.type === 'tool_use');
    if (toolCalls.length === 0) break; // model produced only text (ignored) — nothing left to do

    const toolResults = [];
    for (const call of toolCalls) {
      const tool = tools.find((t) => t.name === call.name);
      const output = tool
        ? await tool.execute(call.input, { customerId: customer.id })
        : { error: `unknown tool ${call.name}` };
      toolResults.push({
        type: 'tool_result',
        tool_use_id: call.id,
        content: JSON.stringify(output),
      });
    }
    messages.push({ role: 'user', content: toolResults });

    if (result.stop_reason !== 'tool_use') break;
  }

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
      '"Known facts" list you were shown or by the summary you just wrote. Most turns have none.\n\n' +
      'Reply with ONLY a JSON object, nothing else, in this exact shape:\n' +
      '{"summary": "...", "new_notes": [{"headline": "short phrase", "body": "fuller detail"}]}\n' +
      'Use an empty array for new_notes when there is nothing new.',
  });
  const closing = await callModel(SYSTEM_PROMPT, messages, []); // no tools — just want text
  const closingBlock = closing.content.find((b: any) => b.type === 'text');
  const closingText = closingBlock?.text?.trim() ?? '';

  let summary = checkpoint?.summary ?? '';
  let newNotes: { headline: string; body: string }[] = [];

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
  } catch {
    // Model didn't return valid JSON this turn — fall back to the old behavior
    // (treat the raw text as the summary) and skip notes rather than crash the
    // turn on malformed model output.
    if (closingText) summary = closingText;
  }

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
}
