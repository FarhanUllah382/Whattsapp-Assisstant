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
export interface InboundMessage {
  phone: string;
  text: string;
  /** Stable provider id used to make webhook delivery idempotent. */
  messageId?: string;
  /** Original provider event time, not the time our HTTP server received it. */
  occurredAt?: Date;
}

export interface ChannelSendReceipt {
  /** Provider id returned after acceptance, when the configured engine exposes it. */
  providerMessageId?: string;
}

export interface ChannelImageMessage {
  /** Base64-encoded approved image bytes. Never an arbitrary model/customer URL. */
  data: string;
  mimetype: 'image/png' | 'image/jpeg';
  filename: string;
  caption: string;
}

export interface ChannelHealth {
  ok: boolean;
  status: string;
}

/**
 * Provider session state as reported by the gateway (WAHA: WORKING, FAILED,
 * STARTING, SCAN_QR_CODE, STOPPED). `UNKNOWN` means the status check itself
 * failed or timed out — callers must treat that as "not working" (fail safe).
 */
export interface ChannelSessionStatus {
  status: string;
  /** True only for a positively confirmed working session. */
  working: boolean;
  checkedAt: Date;
  /** Sanitized reason when the status check itself failed. */
  error?: string;
}

/**
 * - `channel_unavailable`: the gateway refused because the WhatsApp session is
 *   not working (WAHA 422 "Session status is not as expected") or the gateway
 *   could not be reached at all (connection refused). Nothing was handed to
 *   WhatsApp, so the send may be retried safely once the session is back.
 * - `provider_rejected`: any other definitive rejection.
 * - `delivery_unknown`: timeout / network error after the request may have
 *   left — never auto-resent.
 */
export type ChannelSendErrorCode = 'channel_unavailable' | 'provider_rejected' | 'delivery_unknown';

export class ChannelSendError extends Error {
  readonly code: ChannelSendErrorCode;

  constructor(
    message: string,
    /** False only when the provider definitively rejected the request before acceptance. */
    readonly deliveryUncertain: boolean,
    code?: ChannelSendErrorCode,
  ) {
    super(message);
    this.name = 'ChannelSendError';
    this.code = deliveryUncertain
      ? 'delivery_unknown'
      : code ?? 'provider_rejected';
  }
}

export function isChannelUnavailableError(error: unknown): boolean {
  return error instanceof ChannelSendError && error.code === 'channel_unavailable';
}

export interface ChannelAdapter {
  /** Stable id for logs/telemetry, e.g. 'waha'. */
  readonly channel: string;
  /** Sends one text message to a customer. Throws on failure — the caller
   * (send_message's execute()) already wraps every send in try/catch. */
  sendText(phone: string, text: string): Promise<ChannelSendReceipt>;
  /** Sends one approved catalog image with its server-built caption. */
  sendImage(phone: string, image: ChannelImageMessage): Promise<ChannelSendReceipt>;
  /** Minimal provider/session readiness without exposing account details. */
  healthCheck(): Promise<ChannelHealth>;
  /**
   * Cached (≤ 10 s), timeout-guarded session status used to pause AI work
   * while WhatsApp is down. Never throws: a failed check reports UNKNOWN.
   * Optional so lightweight test doubles need not implement it; callers fall
   * back to healthCheck().
   */
  getSessionStatus?(): Promise<ChannelSessionStatus>;
  /**
   * Turns one raw inbound webhook payload into {phone, text}, or null if
   * this event isn't a customer text message worth reacting to (a status
   * update, our own outbound echoed back, a group chat, media with no
   * caption, etc.) — the caller acknowledges those with 200 and does
   * nothing, rather than treating "not a message" as an error.
   */
  parseInboundWebhook(payload: unknown): InboundMessage | null;
}
