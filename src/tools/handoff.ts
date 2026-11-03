// Owner handoff: the durable handoff_ledger record and the notify_owner
// tool (with optional injected WhatsApp alert delivery). Split out of tools.ts.

import { db } from '../db';
import { MAX_DISCOUNT_PERCENT_WITHOUT_CONFIRMATION } from '../guardrails/discount-rules';
import { createLogger } from '../obs/logger';
import { sanitizeMemoryText } from '../privacy';
import type { ToolDef } from '../types';

const log = createLogger();

// Shared between notify_owner's own execute() and the Version 2.3 safety
// net in agent.ts's CLOSE step (flagging a possible order/payment the model
// wasn't confident enough to auto-log). This remains the durable handoff
// audit row and visible log marker. Version 3.3 adds WhatsApp delivery on top
// through createNotifyOwnerTool's injected callback; it does not replace or
// weaken this original record.
export function recordHandoff(customerId: number, reason: string): number {
  const safeReason = sanitizeMemoryText(reason).slice(0, 2000);
  const result = db.prepare('insert into handoff_ledger (customer_id, reason) values (?, ?)').run(customerId, safeReason);
  log.warn('NEEDS AHMED', { customerId, reasonLength: safeReason.length });
  return Number(result.lastInsertRowid);
}

// ── Over-eager discount handoff (FIX4, live 2026-11-02) ─────────────────
// "Koi discount hn iss pa ?" — a plain question — was handed straight to
// Ahmed. Policy (catalog.md "Discounts", discount-rules.ts): no discount is
// guaranteed, and anything at or above 5% needs Ahmed's approval. A plain
// question must first get that policy answer; a handoff is for a customer
// who insists (asks again, pushes, asks for the owner) or names 5% or more.

// Verifier finding (2026-11-02): the old word list (kam, less, off, sale)
// read "Mere parcel mein ek item kam hai" — a missing-item complaint — as a
// discount question and refused the handoff. Discount intent is judged ONLY
// from the customer's own inbound text.
// Fix round 2: that fix then missed "kuch kam ho jayega?", "kam kar do bhai",
// "sasta kar do", "is it on sale?", "koi offer hai?". Discount intent is now:
// discount words OR price-reduction phrasing, UNLESS a complaint signal
// (missing / short / damaged / wrong item, refund, return, complaint) is
// present — a complaint never counts as a discount question.
const DISCOUNT_TERM =
  /\b(?:discount\w*|disc|rebate|concession\w*|riayat|riyayat|riaayat|rayat|chhoot|chhot|chhut)\b|%|\b\d{1,3}\s*(?:percent|per\s*cent|fisad)\b/i;
const PRICE_WORD = /\b(?:price\w*|qeemat|qimat|keemat|kimat|rate|rates|daam|dam)\b/i;
// Price-reduction verbs that need a price word ("price lower karo").
const PRICE_REDUCTION_WITH_PRICE_WORD =
  /\b(?:kam|kum)\s*(?:kar|kr)\w*\b|\b(?:lower|reduce|less|cheaper)\b/i;
// Price-reduction phrasing that is a discount ask on its own.
const PRICE_REDUCTION_PHRASE = new RegExp(
  [
    String.raw`\b(?:kam|kum)\s*(?:kar\s*(?:do|dein|den|dena|diye|dijiye|de|o)|kardo|kardein|kardain|krdo|kr\s*do|ho\s*(?:jayega|jaye|jayegi|jaega|jaegi|sakta|sakti|skta|skti))\b`,
    String.raw`\b(?:sasta|sasti|saste|sastaa)\s*(?:kar|kr)\w*\b`,
    String.raw`\b(?:on\s+sale|(?<!\bfor\s)sale|offers?|deals?)\b`, // not "for sale"
    String.raw`\b(?:best|last|final|lowest|kam\s+se\s+kam)\s+(?:price|rate|qeemat|keemat)\b`,
  ].join('|'),
  'i',
);
// Complaint signals that rule out discount intent (not "owner/Ahmed": a
// customer may ask Ahmed for a discount).
const DISCOUNT_EXCLUDING_COMPLAINT =
  /\b(?:missing|(?:kam|kum)\s+(?:hai|hain|tha|thi|the|aya|aaya|ayi|aayi|mila|mili)|nahi\s+(?:mila|mili|aya|aaya|ayi|aayi)|not\s+(?:received|delivered)|damaged?|broken|toota|tuta|tooti|tuti|phata|phati|kharab|wrong|ghalat|galat|defective|refund\w*|wapas|return\w*|replace\w*|complain\w*|shikayat)\b/i;
const COMPLAINT_SIGNAL =
  /\b(?:missing|kam\s+(?:hai|hain|tha|thi|the|aya|aaya|ayi|aayi|mila|mili)|kum\s+(?:hai|hain|tha|thi)|nahi\s+(?:mila|mili|aya|aaya|ayi|aayi)|not\s+(?:received|delivered)|damaged?|broken|toota|tuta|tooti|phata|phati|kharab|wrong|ghalat|galat|defective|refund\w*|wapas|return\w*|replace\w*|complain\w*|shikayat|owner|ahmed|malik)\b/i;

/** True when the customer's own text asks for a discount / lower price (and is not a complaint). */
export function isDiscountRequest(text: string): boolean {
  if (DISCOUNT_EXCLUDING_COMPLAINT.test(text)) return false;
  if (DISCOUNT_TERM.test(text) || PRICE_REDUCTION_PHRASE.test(text)) return true;
  // "lower / kam karo" style only counts with a price word ("price kam karo").
  return PRICE_WORD.test(text) && PRICE_REDUCTION_WITH_PRICE_WORD.test(text);
}

/** Missing / damaged / wrong item, refund, or asking for Ahmed: always a real handoff. */
export function hasComplaintSignal(text: string): boolean {
  return COMPLAINT_SIGNAL.test(text);
}

const PERCENT = /(\d{1,3})\s*(?:%|percent|per\s*cent|fisad)/gi;
const INSIST_MARKER = new RegExp(
  String.raw`\b(?:please|plz|pls|insist|must|need|zaroor|zarur|pakka|final|last\s+price|bigger|more|extra|` +
    String.raw`aur|zyada|ziyada|thora|thoda|again|phir|dobara|ahmed|owner|malik|manager|boss|baat\s+kara\w*|` +
    String.raw`warna|otherwise|nahi\s+to)\b`,
  'i',
);
const RECENT_DISCOUNT_ASK_WINDOW = "-24 hours";

export const PLAIN_DISCOUNT_QUESTION_ERROR =
  'Not handed off: this is a plain discount question, so answer the discount policy first. ' +
  'Reply with send_message in the customer\'s language: no discount is guaranteed, and any discount of ' +
  `${MAX_DISCOUNT_PERCENT_WITHOUT_CONFIRMATION}% or more needs Ahmed's approval; never invent or offer a discount amount. ` +
  'You may ask whether they would like you to request one from Ahmed. Call notify_owner for a discount only ' +
  `if the customer insists, asks again, or asks for ${MAX_DISCOUNT_PERCENT_WITHOUT_CONFIRMATION}% or more.`;

function asksAbovePolicy(text: string): boolean {
  for (const match of text.matchAll(PERCENT)) {
    if (Number(match[1]) >= MAX_DISCOUNT_PERCENT_WITHOUT_CONFIRMATION) return true;
  }
  return false;
}

/** True when the customer only asks whether a discount exists — no amount at/above policy, no pushing. */
export function isPlainDiscountQuestion(text: string): boolean {
  return isDiscountRequest(text) && !hasComplaintSignal(text) && !asksAbovePolicy(text) && !INSIST_MARKER.test(text);
}

function askedForDiscountBefore(customerId: number, currentText: string): boolean {
  const rows = db.prepare(`
    select body from messages
    where customer_id = ? and direction = 'inbound' and created_at >= datetime('now', ?)
    order by id desc limit 20
  `).all(customerId, RECENT_DISCOUNT_ASK_WINDOW) as { body: string }[];
  // The current message is normally already recorded (runTurn OPEN); skip it once.
  const earlier = rows.length > 0 && rows[0].body === currentText ? rows.slice(1) : rows;
  return earlier.some((row) => isDiscountRequest(row.body));
}

function isPrematureDiscountHandoff(reason: string, inboundText: string | undefined, customerId: number): boolean {
  if (typeof inboundText !== 'string') return false; // direct/local call: no customer message to judge
  // Judged from the customer's own words. The model-written reason can only
  // EXEMPT a handoff (a non-discount reason during a discount question, e.g.
  // a custom-size request); it is never evidence that blocks one.
  if (!isPlainDiscountQuestion(inboundText) || !isDiscountRequest(reason)) return false;
  try {
    return !askedForDiscountBefore(customerId, inboundText);
  } catch {
    return false; // never let this usability check block a real handoff
  }
}

type HandoffAlertDelivery = (input: {
  customerId: number;
  reason: string;
  eventKey: string;
}) => Promise<{ ok: boolean; status?: string; alertId?: number; error?: string }>;

export function createNotifyOwnerTool(deliverAlert?: HandoffAlertDelivery): ToolDef {
  return {
    name: 'notify_owner',
    description:
      "Hand this conversation off to Ahmed directly — use when you genuinely can't resolve " +
      'something yourself (a question outside what you know, a customer asking for a bigger ' +
      'discount than you can approve, anything needing his judgment). Always call this BEFORE ' +
      "telling the customer someone will follow up with them — that promise isn't allowed to " +
      'send otherwise.',
    input_schema: {
      type: 'object',
      properties: {
        reason: { type: 'string', description: "what Ahmed needs to look at, and why" },
      },
      required: ['reason'],
    },
    execute: async ({ reason }, ctx) => {
      if (typeof reason !== 'string' || reason.trim() === '') {
        return { ok: false, error: 'Please describe what Ahmed needs to look at.' };
      }
      if (isPrematureDiscountHandoff(reason, ctx.inboundText, ctx.customerId)) {
        return { ok: false, error: PLAIN_DISCOUNT_QUESTION_ERROR };
      }
      try {
        const cleanReason = sanitizeMemoryText(reason.trim()).slice(0, 2000);
        const handoffId = recordHandoff(ctx.customerId, cleanReason);
        if (!deliverAlert) return { ok: true, handoff_id: handoffId };

        const delivery = await deliverAlert({
          customerId: ctx.customerId,
          reason: cleanReason,
          eventKey: `customer_handoff:${ctx.idempotencyKey ?? `handoff:${handoffId}`}`,
        });
        return delivery.ok
          ? { ok: true, handoff_id: handoffId, alert_status: delivery.status, alert_id: delivery.alertId }
          : {
              ok: false,
              handoff_id: handoffId,
              alert_status: delivery.status,
              alert_id: delivery.alertId,
              error: delivery.error,
            };
      } catch {
        return { ok: false, error: 'Could not record the handoff — please try again.' };
      }
    },
  };
}

// The default remains useful for direct tool execution and fail-closed local
// environments. runTurn() replaces it with the delivery-enabled instance when
// a configured owner WhatsApp sender is available.
export const notifyOwner: ToolDef = createNotifyOwnerTool();
