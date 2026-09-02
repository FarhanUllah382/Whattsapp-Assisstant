// The provider-agnostic seam. agent.ts and tools.ts never import from here —
// runTurn() already only takes a phone string, an inbound text string, and a
// (text) => Promise<void> send callback, so this interface exists purely to
// keep server.ts's own wiring swappable (WAHA today, Cloud API/Twilio later),
// not because the rest of the app needs to know a provider exists.
//
// Deliberately smaller than EXTRACTED-FOR-AHMED/channel-adapter.ts: that
// version carries tenantId/leadId/jobId+seq idempotency keys, approved-
// template rendering, session health mirrored from a separate watchdog, and
// per-message cost tracking — real requirements for DeskcommCRM's
// multi-tenant, queued architecture, none of them for one shop with no
// queue and no billing (see CLAUDE.md §6). What's kept is the part that
// actually applies here: a named channel, "send text to this phone," and
// "turn a raw webhook payload into (phone, text), or nothing."
export interface ChannelAdapter {
  /** Stable id for logs/telemetry, e.g. 'waha'. */
  readonly channel: string;
  /** Sends one text message to a customer. Throws on failure — the caller
   * (send_message's execute()) already wraps every send in try/catch. */
  sendText(phone: string, text: string): Promise<void>;
  /**
   * Turns one raw inbound webhook payload into {phone, text}, or null if
   * this event isn't a customer text message worth reacting to (a status
   * update, our own outbound echoed back, a group chat, media with no
   * caption, etc.) — the caller acknowledges those with 200 and does
   * nothing, rather than treating "not a message" as an error.
   */
  parseInboundWebhook(payload: unknown): { phone: string; text: string } | null;
}
