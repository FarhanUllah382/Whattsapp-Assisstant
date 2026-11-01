// ═══════════════════════════════════════════════════════════════════════════
// The AI's menu of actions. Compare to `AGENT_TOOL_DEFS` in the big reference
// file (11 tools, MCP catalog, per-turn conditional wiring). We start with 5.
//
// Rule borrowed from the big system, worth keeping forever: the AI's raw text
// is NEVER what reaches the customer. The only way it can speak is by calling
// `send_message`. This one rule is what makes "log everything, guard every
// message" possible later — there's exactly one choke point.
// ═══════════════════════════════════════════════════════════════════════════
//
// Public barrel: the tool implementations live in src/tools/ (one module per
// domain); this file re-exports every symbol it has always exported and
// assembles baseTools / ownerTools in their fixed order.

import { getMyOrderStatus } from './order-access';
import { claimPayment, pendingPaymentClaims } from './payments';
import {
  getMyRefundStatus,
  pendingRefundRequests,
  requestRefund,
  resolveRefundRequest,
} from './refunds';
import { paymentOptions } from './payment-instructions';
import type { ToolDef } from './types';
import { checkStock, searchCatalog } from './tools/catalog-stock';
import { getCustomerBalance, getCustomerNote } from './tools/customer-memory';
import { createNotifyOwnerTool, notifyOwner, recordHandoff } from './tools/handoff';
import { getPendingOrderDraft, isExplicitOrderConfirmation } from './tools/order-drafts';
import {
  insertValidatedOrder,
  validateOrderItems,
  type FulfillmentDetails,
  type ServerPricedOrderItem,
  type ValidateOrderItemsResult,
} from './tools/order-validation';
import { confirmOrder, confirmPendingOrderDraft, prepareOrder, updateOrderStatus } from './tools/orders';
import {
  inventoryOverviewTool,
  pendingFollowupsTool,
  salesToday,
  topSellingProductTool,
  unpaidCustomersTool,
} from './tools/owner-analytics';

export {
  inventoryOverviewTool,
  checkStock,
  getCustomerBalance,
  getCustomerNote,
  validateOrderItems,
  insertValidatedOrder,
  getPendingOrderDraft,
  isExplicitOrderConfirmation,
  prepareOrder,
  confirmPendingOrderDraft,
  confirmOrder,
  updateOrderStatus,
  searchCatalog,
  recordHandoff,
  createNotifyOwnerTool,
  notifyOwner,
  salesToday,
  unpaidCustomersTool,
  topSellingProductTool,
  pendingFollowupsTool,
};
export type { ServerPricedOrderItem, FulfillmentDetails, ValidateOrderItemsResult };

// `send_message` is deliberately NOT here — it's wired up in agent.ts
// because it needs access to the actual WhatsApp-sending function, which
// server.ts owns. Everything else is a pure database tool; this one has a
// side effect that leaves the system, so it's treated specially — same
// distinction the big file draws with `READ_ONLY_TOOLS`.

export const baseTools: ToolDef[] = [
  checkStock,
  getCustomerBalance,
  getCustomerNote,
  getMyOrderStatus,
  prepareOrder,
  confirmOrder,
  updateOrderStatus,
  claimPayment,
  requestRefund,
  getMyRefundStatus,
  notifyOwner,
  paymentOptions,
  searchCatalog,
];

// ═══════════════════════════════════════════════════════════════════════════
// Version 3.2 — Ahmed's own analytics tools. Only reachable from
// runOwnerTurn() (agent.ts), never baseTools — a customer can never see
// these regardless of what they ask, because routing to this tool list at
// all requires isOwnerPhone() to have already said yes (owner.ts).
// Deliberately a small, FIXED, explicitly-named set of safe report
// functions — never a freely-written SQL query handed to the model, which
// is exactly the risk naming each one avoids.
// ═══════════════════════════════════════════════════════════════════════════

export const ownerTools: ToolDef[] = [
  inventoryOverviewTool,
  salesToday,
  unpaidCustomersTool,
  topSellingProductTool,
  pendingFollowupsTool,
  pendingPaymentClaims,
  pendingRefundRequests,
  resolveRefundRequest,
];
