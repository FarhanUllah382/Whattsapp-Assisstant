import { detectHumanPromise } from './guardrails/human-promise';
import type { ToolContext, ToolDef } from './types';

export type HandoffAlertStatus = 'none' | 'pending' | 'sent';

export interface HandoffFacts {
  recorded: boolean;
  alertStatus: HandoffAlertStatus;
}

const MEDIA_WORD = String.raw`(?:screenshot|screen\s*shot|image|photo|picture|file|attachment|media)`;
const HUMAN_TARGET = String.raw`(?:ahmed(?:\s*(?:sahab|bhai))?|owner|boss|malik|manager|team|staff)`;

const MEDIA_TRANSFER_CLAIM = new RegExp(
  String.raw`(?:\b(?:sent|send|forwarded?|shared?|attached?|bhej\w*|pohcha\w*)\b[^.!?\n]{0,80}\b${MEDIA_WORD}\b|` +
    String.raw`\b${MEDIA_WORD}\b[^.!?\n]{0,80}\b(?:sent|send|forwarded?|shared?|attached?|bhej\w*|pohcha\w*)\b)`,
  'i',
);

const HUMAN_ACTION_CLAIM = new RegExp(
  String.raw`\b${HUMAN_TARGET}\b[^.!?\n]{0,60}` +
    String.raw`\b(?:viewed?|saw|seen|read|checked?|checking|reviewed?|verified?|approved?|replied?|responded?|` +
    String.raw`will\s+(?:check|verify|review|reply|respond|call|contact|get\s*back)|` +
    String.raw`(?:check|verify|review|reply|respond|call|contact)\w*\s+(?:karen?g[ae]|karega|karain))\b`,
  'i',
);

const HANDOFF_FACT_CLAIM = new RegExp(
  String.raw`(?:\b(?:notified?|told|alerted?|sent|forwarded?|escalated?|recorded|bhej\w*|pohcha\w*)\b` +
    String.raw`[^.!?\n]{0,70}\b${HUMAN_TARGET}\b|` +
    String.raw`\b${HUMAN_TARGET}\b[^.!?\n]{0,70}` +
    String.raw`\b(?:notified?|told|alerted?|sent|forwarded?|escalated?|recorded|bhej\w*|pohcha\w*)\b)`,
  'i',
);

export function buildHandoffStatusMessage(facts: HandoffFacts): string | null {
  if (!facts.recorded) return null;
  if (facts.alertStatus === 'sent') {
    return (
      "Your request has been recorded, and an alert was sent to Ahmed's WhatsApp. " +
      'I cannot confirm that he has viewed it yet.'
    );
  }
  if (facts.alertStatus === 'pending') {
    return (
      'Your request has been recorded for Ahmed, but the WhatsApp alert is still pending delivery. ' +
      'I cannot confirm that he has viewed it.'
    );
  }
  return (
    'Your request has been recorded for Ahmed. ' +
    'I cannot confirm that a WhatsApp alert was delivered or viewed.'
  );
}

/**
 * The normal model-authored send path may not narrate handoff state. That
 * wording comes only from buildHandoffStatusMessage(), which reflects facts
 * captured from the current notify_owner result.
 */
export function checkHandoffClaimReply(
  body: string,
  authorizedBody?: string,
): { ok: true } | { ok: false; error: string } {
  if (authorizedBody !== undefined && body === authorizedBody) return { ok: true };
  if (MEDIA_TRANSFER_CLAIM.test(body)) {
    return {
      ok: false,
      error:
        'Do not claim a screenshot, image, file, or attachment was forwarded. Media forwarding is not implemented.',
    };
  }
  if (HUMAN_ACTION_CLAIM.test(body)) {
    return {
      ok: false,
      error:
        'Do not claim Ahmed viewed, checked, verified, approved, replied, or will definitely contact the customer. The system cannot prove those human actions.',
    };
  }
  if (HANDOFF_FACT_CLAIM.test(body) || detectHumanPromise(body)) {
    return {
      ok: false,
      error:
        'Do not describe a handoff in send_message. Call notify_owner, then use send_handoff_status so the customer receives the exact verified state.',
    };
  }
  return { ok: true };
}

type AuthorizedSender = (body: string, ctx: ToolContext) => Promise<unknown> | unknown;

export function createSendHandoffStatusTool(
  getFacts: () => HandoffFacts,
  sendAuthorized: AuthorizedSender,
): ToolDef {
  return {
    name: 'send_handoff_status',
    description:
      'Send the exact verified status of the current owner handoff. Call only after notify_owner. ' +
      'This never claims media was forwarded or that Ahmed viewed, checked, or completed anything.',
    input_schema: { type: 'object', properties: {} },
    execute: async (_input, ctx) => {
      const facts = getFacts();
      const body = buildHandoffStatusMessage(facts);
      if (!body) {
        return { ok: false, error: 'No owner handoff was recorded in this turn. Call notify_owner first.' };
      }
      return sendAuthorized(body, ctx);
    },
  };
}
