// Owner handoff: the durable handoff_ledger record and the notify_owner
// tool (with optional injected WhatsApp alert delivery). Split out of tools.ts.

import { db } from '../db';
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
