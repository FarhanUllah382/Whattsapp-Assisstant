// ═══════════════════════════════════════════════════════════════════════════
// Version 3.1 — THE OWNER TURN. A genuinely separate turn kind for Ahmed
// himself, routed here only after `isOwnerPhone()` (owner.ts) confirms the
// sender — never entered by a customer message, no matter how it's phrased.
// Deliberately minimal ("the owner-turn kind itself, full stop" — 3.1's own
// stated scope): no tools yet (3.2 adds the real analytics tools:
// sales_today, unpaid_customers, top_selling_product, pending_followups),
// no checkpoint/notes memory, no discount/human-promise/spinning guardrails
// — none of those are customer-conversation concepts, so none apply here.
//
// What it DOES reuse, deliberately, not by oversight: `withSendLock` +
// `decidePacing` against the SAME shared `messages` history. Anti-ban
// pacing protects the one shared *number* in aggregate, not any one
// conversation — a message to Ahmed is still an outbound send from that
// same number, so skipping pacing here would quietly reopen exactly the
// regression Version 1's own "no possibility of the number getting banned"
// guarantee was built to close. Ahmed's own identity still gets a row in
// `customers` (via the same `getOrCreateCustomer`) purely so this turn's
// sends land in the same global `messages` log pacing reads from — that
// table has always really meant "any phone number that has texted this
// number," customer or owner; which turn KIND runs is decided by
// `isOwnerPhone()` in server.ts, never by whether a `customers` row exists.
//
// The owner path still has no send-ledger idempotency (1.1): a crash between
// send and the pacing-state write could in theory duplicate or drop an owner
// reply. The separate silent-text case is covered below: if the model returns
// its final answer as ordinary text instead of calling send_message, that text
// is sent through the same paced owner-send tool before the turn can finish.
// ═══════════════════════════════════════════════════════════════════════════

import { createHash } from 'node:crypto';

import { db } from '../db';
import { callModel, type ModelMessage } from '../llm';
import { createLogger } from '../obs/logger';
import { traceCustomer, traceToolCall, traceTurnOutcome, withTurnTrace } from '../obs/trace';
import { outboundDeliveryIssuesTool } from '../outbound-delivery';
import { handleOwnerFulfilmentCommand } from '../fulfilment-commands'; // FULFILMENT-COMMANDS
import { handleOwnerPaymentCommand } from '../payment-resolution';
import { sanitizeMemoryText } from '../privacy';
import { serializeUntrustedData, wrapToolResult } from '../untrusted-data';
import { ownerTools } from '../tools';
import { makeOwnerSendTool } from './owner-send';
import { OWNER_SYSTEM_PROMPT } from './prompts';
import { getOrCreateCustomer, MAX_TOOL_STEPS, recordInboundMessageOnce, type SendTextOperation } from './shared';

const log = createLogger();

/**
 * The public entry point for a message already confirmed to be from Ahmed's
 * own number — server.ts is responsible for that check (`isOwnerPhone`)
 * before ever calling this, never this function itself.
 */
export async function runOwnerTurn(
  phone: string,
  incomingText: string,
  sendToOwner: SendTextOperation,
  modelCaller: typeof callModel = callModel,
  inboundEventKey?: string,
): Promise<void> {
  return withTurnTrace({ turnKind: 'owner' }, () =>
    runOwnerTurnTraced(phone, incomingText, sendToOwner, modelCaller, inboundEventKey));
}

async function runOwnerTurnTraced(
  phone: string,
  incomingText: string,
  sendToOwner: SendTextOperation,
  modelCaller: typeof callModel,
  inboundEventKey: string | undefined,
): Promise<void> {
  const owner = getOrCreateCustomer(phone);
  traceCustomer(owner.id);
  const recentOwnerMessages = (db.prepare(`
    select direction, body, created_at
      from messages
     where customer_id = ?
     order by id desc limit 12
  `).all(owner.id) as Array<{ direction: string; body: string; created_at: string }>).reverse()
    .map((message) => ({ ...message, body: sanitizeMemoryText(message.body) }));
  recordInboundMessageOnce(owner.id, incomingText, inboundEventKey);

  const ownerTurnKey = inboundEventKey ?? `${owner.id}:${incomingText}`;
  // >>> FULFILMENT-COMMANDS: exact two-step SHIP/DELIVER ORDER (src/fulfilment-commands.ts), before the model.
  const fulfilmentCommand = await handleOwnerFulfilmentCommand(incomingText, {
    ownerCustomerId: owner.id,
    eventKey: inboundEventKey ?? `owner-local:${createHash('sha256').update(ownerTurnKey).digest('hex')}`,
  });
  if (fulfilmentCommand) {
    const sent = await makeOwnerSendTool(sendToOwner, ownerTurnKey, Boolean(inboundEventKey))
      .execute({ body: fulfilmentCommand.response }, { customerId: owner.id, idempotencyKey: inboundEventKey }) as { ok?: boolean; error?: string };
    traceTurnOutcome(sent.ok ? 'replied' : 'no_reply');
    if (!sent.ok) log.error('deterministic owner fulfilment response failed to send', { customerId: owner.id, mutation: fulfilmentCommand.mutation, error: sent.error });
    return;
  }
  // <<< FULFILMENT-COMMANDS
  const paymentCommand = handleOwnerPaymentCommand({
    ownerCustomerId: owner.id,
    text: incomingText,
    eventKey: inboundEventKey ?? `owner-local:${createHash('sha256').update(ownerTurnKey).digest('hex')}`,
  });
  if (paymentCommand.handled) {
    const result = await makeOwnerSendTool(
      sendToOwner,
      ownerTurnKey,
      Boolean(inboundEventKey),
    ).execute(
      { body: paymentCommand.response ?? 'Nothing was changed.' },
      { customerId: owner.id, idempotencyKey: inboundEventKey },
    ) as { ok?: boolean; error?: string };
    traceTurnOutcome(result.ok ? 'replied' : 'no_reply');
    if (!result.ok) {
      log.error('deterministic owner payment response failed to send', {
        customerId: owner.id,
        mutation: paymentCommand.mutation,
        error: result.error,
      });
    }
    return;
  }
  const tools = [
    ...ownerTools,
    outboundDeliveryIssuesTool,
    makeOwnerSendTool(sendToOwner, ownerTurnKey, Boolean(inboundEventKey)),
  ];
  const messages: ModelMessage[] = [{
    role: 'user',
    content: [
      serializeUntrustedData('owner_conversation_history', recentOwnerMessages),
      serializeUntrustedData('customer_request', { text: incomingText }, 'customer_request'),
    ].join('\n\n'),
  }];
  let lastAssistantText = '';
  let sendMessageWasCalled = false;
  let sendMessageSucceeded = false;

  for (let step = 0; step < MAX_TOOL_STEPS; step++) {
    const result = await modelCaller(OWNER_SYSTEM_PROMPT, messages, tools);
    messages.push({ role: 'assistant', content: result.content });

    const textBlocks = result.content.filter((b: any) => b.type === 'text');
    if (textBlocks.length > 0) {
      lastAssistantText = textBlocks.map((b: any) => b.text).join('\n').trim();
    }

    const toolCalls = result.content.filter((b: any) => b.type === 'tool_use');
    if (toolCalls.length === 0) break; // model produced only text — nothing left to do, same discard rule as the customer turn

    const toolResults = [];
    for (const call of toolCalls) {
      if (call.name === 'send_message') sendMessageWasCalled = true;
      const tool = tools.find((t) => t.name === call.name);
      const output = tool
        ? await traceToolCall(call.name, () => tool.execute(call.input, { customerId: owner.id }))
        : { error: `unknown tool ${call.name}` };
      if (call.name === 'send_message' && (output as { ok?: boolean })?.ok) {
        sendMessageSucceeded = true;
      }
      toolResults.push({
        type: 'tool_result',
        tool_use_id: call.id,
        content: JSON.stringify(wrapToolResult(call.name, output)),
      });
    }
    messages.push({ role: 'user', content: toolResults });

    if (result.stop_reason !== 'tool_use') break;
  }

  // Gemini can correctly call an analytics tool and then return the final
  // human-readable answer as plain text. Plain text is not itself delivered
  // to WhatsApp, so without this guard the webhook returns 200 while Ahmed
  // receives nothing. Send that final text through the normal owner tool. If
  // the model explicitly tried send_message and it failed, do not retry here:
  // an uncertain provider outcome is durably retained and must not trigger a
  // second automatic copy.
  if (!sendMessageSucceeded && !sendMessageWasCalled) {
    const body = lastAssistantText || "Sorry, I couldn't prepare that report right now. Please try again.";
    const sendMessageTool = tools.find((t) => t.name === 'send_message')!;
    const fallbackResult = await sendMessageTool.execute({ body }, { customerId: owner.id });
    sendMessageSucceeded = Boolean((fallbackResult as { ok?: boolean })?.ok);
    if (!(fallbackResult as { ok?: boolean })?.ok) {
      log.error('owner fallback reply failed to send', {
        phone,
        customerId: owner.id,
        fallbackResult,
      });
    }
  }

  traceTurnOutcome(sendMessageSucceeded ? 'replied' : 'no_reply');
  log.info('owner turn completed', { phone });
}
