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
//
// Public barrel: the implementation lives in src/agent/ —
//   shared.ts          send lock, timestamps, inbound recording, pacing state
//   prompts.ts         customer + owner system prompts
//   send-guards.ts     guarded customer send_message + customer-send checks
//   customer-sends.ts  product images, consent confirmation, busy reply
//   owner-send.ts      paced owner send tool, owner alerts retry
//   customer-turn.ts   runTurn OPEN + LOOP + silent-no-reply guard
//   turn-close.ts      runTurn CLOSE + safety net
//   owner-turn.ts      runOwnerTurn
// Every symbol agent.ts has always exported is re-exported here unchanged.

export { recordInboundMessageOnce } from './agent/shared';
export { checkAutomatedCustomerSendAllowed, checkOrderConfirmationReply } from './agent/send-guards';
export { sendConsentConfirmation, sendTemporaryBusyReply } from './agent/customer-sends';
export { runTurn } from './agent/customer-turn';
export { retryOwnerAlerts } from './agent/owner-send';
export { runOwnerTurn } from './agent/owner-turn';
