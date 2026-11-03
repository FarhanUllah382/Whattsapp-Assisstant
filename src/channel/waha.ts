// WAHA (https://waha.devlike.pro) implementation of ChannelAdapter. This is
// the ONLY file in the project that knows WAHA's REST shape, session concept,
// or WhatsApp chatId format — server.ts talks to it only through the
// ChannelAdapter interface, and agent.ts/tools.ts don't import this file at
// all.
import {
  ChannelSendError,
  type ChannelAdapter,
  type ChannelHealth,
  type ChannelImageMessage,
  type ChannelSendReceipt,
  type ChannelSessionStatus,
  type InboundMessage,
} from './types';

const WAHA_BASE_URL = process.env.WAHA_BASE_URL ?? 'http://localhost:3001';
const WAHA_SESSION = process.env.WAHA_SESSION ?? 'default';
// Only set if the WAHA instance was started with WHATSAPP_API_KEY / API-key
// auth enabled — WAHA accepts requests without it otherwise.
const WAHA_API_KEY = process.env.WAHA_API_KEY;

export const WAHA_SEND_TIMEOUT_DEFAULT_MS = 15_000;
const WAHA_SEND_TIMEOUT_MAX_MS = 300_000;

/**
 * Finite outbound send timeout. Missing, malformed, zero or oversized values
 * use the default — never an unlimited wait that would hold the send lock.
 */
export function readWahaSendTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.WAHA_SEND_TIMEOUT_MS?.trim() ?? '';
  const parsed = /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
  return Number.isSafeInteger(parsed) && parsed > 0 && parsed <= WAHA_SEND_TIMEOUT_MAX_MS
    ? parsed
    : WAHA_SEND_TIMEOUT_DEFAULT_MS;
}

/** WAHA/whatsapp-web.js address individual chats as "<digits>@c.us". */
function chatIdFor(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  return `${digits}@c.us`;
}

function isTimeout(error: unknown): boolean {
  return error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
}

/** Node's fetch reports a refused TCP connect as TypeError('fetch failed') with a cause code. */
function isConnectionRefused(error: unknown): boolean {
  const cause = (error as { cause?: { code?: unknown } } | undefined)?.cause;
  return cause?.code === 'ECONNREFUSED';
}

/**
 * WAHA answers 422 "Session status is not as expected" when the WhatsApp
 * session is FAILED / STARTING / SCAN_QR_CODE / STOPPED. The request never
 * reached WhatsApp, so it is a retryable channel outage, not a rejection of
 * this message.
 */
function isSessionUnavailableResponse(status: number, body: string): boolean {
  // Only WAHA's own session-state message. Any other 422 that merely mentions
  // "session" (bad chatId, bad payload) is a real rejection: classifying it as
  // an outage would rerun the whole turn every minute forever (verifier
  // finding, 2026-11-02).
  return status === 422 && /session\s+status\s+is\s+not\s+as\s+expected/i.test(body);
}

export const WAHA_SESSION_STATUS_CACHE_MS = 10_000;
export const WAHA_SESSION_STATUS_TIMEOUT_MS = 3_000;

function phoneFromChatId(chatId: string): string {
  return chatId.split('@')[0].replace(/\D/g, '');
}

export interface WahaAdapterConfig {
  baseUrl?: string;
  session?: string;
  apiKey?: string;
  /** Outbound send timeout; invalid values fall back to WAHA_SEND_TIMEOUT_MS / the default. */
  sendTimeoutMs?: number;
  /** Clock for the session-status cache (tests). */
  now?: () => number;
}

/**
 * Object-Oriented Channel Adapter implementing the provider-agnostic ChannelAdapter interface.
 * Encapsulates WAHA REST communication, session routing, and inbound WhatsApp webhook normalization.
 */
export class WahaAdapter implements ChannelAdapter {
  readonly channel: string = 'waha';
  private readonly baseUrl: string;
  private readonly session: string;
  private readonly apiKey?: string;
  private readonly sendTimeoutMs: number;
  private readonly now: () => number;
  private sessionStatusCache: { value: ChannelSessionStatus; expiresAt: number } | undefined;
  private sessionStatusInFlight: Promise<ChannelSessionStatus> | undefined;

  constructor(config?: WahaAdapterConfig) {
    this.now = config?.now ?? Date.now;
    this.baseUrl = config?.baseUrl ?? WAHA_BASE_URL;
    this.session = config?.session ?? WAHA_SESSION;
    this.apiKey = config?.apiKey ?? WAHA_API_KEY;
    const configured = config?.sendTimeoutMs;
    this.sendTimeoutMs =
      configured !== undefined && Number.isSafeInteger(configured) && configured > 0 &&
        configured <= WAHA_SEND_TIMEOUT_MAX_MS
        ? configured
        : readWahaSendTimeoutMs();
  }

  private async fetch(path: string, init: RequestInit = {}): Promise<Response> {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      ...(init.headers as Record<string, string> | undefined),
    };
    if (this.apiKey) headers['X-Api-Key'] = this.apiKey;
    return fetch(`${this.baseUrl}${path}`, { ...init, headers });
  }

  async sendText(phone: string, text: string): Promise<ChannelSendReceipt> {
    return this.send('/api/sendText', {
      session: this.session,
      chatId: chatIdFor(phone),
      text,
    });
  }

  async sendImage(phone: string, image: ChannelImageMessage): Promise<ChannelSendReceipt> {
    return this.send('/api/sendImage', {
      session: this.session,
      chatId: chatIdFor(phone),
      file: {
        mimetype: image.mimetype,
        filename: image.filename,
        data: image.data,
      },
      caption: image.caption,
    });
  }

  private async send(path: string, body: Record<string, unknown>): Promise<ChannelSendReceipt> {
    // A timed-out send is an UNCERTAIN delivery: WAHA may already have handed
    // the message to WhatsApp. It therefore takes the same path as any other
    // network error — ChannelSendError(deliveryUncertain=true) — which
    // markOutboundFailure records as 'uncertain', so it is never auto-retried
    // into a duplicate message.
    let response: Response;
    try {
      response = await this.fetch(path, {
        method: 'POST',
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.sendTimeoutMs),
      });
    } catch (error) {
      if (!isTimeout(error) && isConnectionRefused(error)) {
        // No TCP connection was established, so nothing reached WAHA.
        this.invalidateSessionStatus();
        throw new ChannelSendError('WAHA gateway refused the connection.', false, 'channel_unavailable');
      }
      throw new ChannelSendError(
        isTimeout(error)
          ? `WAHA send timed out after ${this.sendTimeoutMs}ms; delivery outcome unknown.`
          : error instanceof Error ? error.message : 'WAHA send failed before a response.',
        true,
      );
    }
    let responseText: string;
    try {
      responseText = await response.text();
    } catch (error) {
      // Headers arrived but the body did not (e.g. timeout mid-body). A non-OK
      // status is still a definitive rejection; an OK status means the
      // provider accepted it, so the outcome is at worst uncertain.
      if (!response.ok) {
        throw new ChannelSendError(`WAHA send rejected (${response.status}).`, false);
      }
      throw new ChannelSendError(
        isTimeout(error)
          ? `WAHA send timed out after ${this.sendTimeoutMs}ms while reading the response; delivery outcome unknown.`
          : 'WAHA send response could not be read; delivery outcome unknown.',
        true,
      );
    }
    if (!response.ok) {
      if (isSessionUnavailableResponse(response.status, responseText)) {
        this.invalidateSessionStatus();
        throw new ChannelSendError(
          `WAHA session unavailable (${response.status}): ${responseText.slice(0, 300)}`,
          false,
          'channel_unavailable',
        );
      }
      throw new ChannelSendError(
        `WAHA send rejected (${response.status}): ${responseText.slice(0, 300)}`,
        false,
      );
    }
    let payload: any = null;
    try {
      payload = responseText ? JSON.parse(responseText) : null;
    } catch {
      // A successful HTTP response still proves provider acceptance even when
      // an older/custom WAHA build returns a non-JSON body.
    }
    const providerMessageId = [
      payload?.id,
      payload?.key?.id,
      payload?._data?.id?._serialized,
    ].find((value) => typeof value === 'string' && value.trim() !== '');
    return providerMessageId ? { providerMessageId } : {};
  }

  async healthCheck(): Promise<ChannelHealth> {
    try {
      const response = await this.fetch(`/api/sessions/${encodeURIComponent(this.session)}`, {
        method: 'GET',
        signal: AbortSignal.timeout(3_000),
      });
      if (!response.ok) return { ok: false, status: `http_${response.status}` };
      const payload = await response.json() as { status?: unknown };
      const status = typeof payload.status === 'string' ? payload.status : 'UNKNOWN';
      return { ok: status === 'WORKING', status };
    } catch {
      return { ok: false, status: 'unreachable' };
    }
  }

  /** Forces the next getSessionStatus() to ask WAHA again. */
  invalidateSessionStatus(): void {
    this.sessionStatusCache = undefined;
  }

  /**
   * GET /api/sessions/{session}, cached for 10 s and bounded by a 3 s
   * timeout. Never throws: an HTTP error, timeout or bad body reports
   * UNKNOWN (not working), which callers treat as "WhatsApp is down".
   */
  async getSessionStatus(): Promise<ChannelSessionStatus> {
    const cached = this.sessionStatusCache;
    if (cached && this.now() < cached.expiresAt) return cached.value;
    if (this.sessionStatusInFlight) return this.sessionStatusInFlight;
    this.sessionStatusInFlight = this.fetchSessionStatus()
      .then((value) => {
        this.sessionStatusCache = { value, expiresAt: this.now() + WAHA_SESSION_STATUS_CACHE_MS };
        return value;
      })
      .finally(() => {
        this.sessionStatusInFlight = undefined;
      });
    return this.sessionStatusInFlight;
  }

  private async fetchSessionStatus(): Promise<ChannelSessionStatus> {
    const checkedAt = new Date(this.now());
    try {
      const response = await this.fetch(`/api/sessions/${encodeURIComponent(this.session)}`, {
        method: 'GET',
        signal: AbortSignal.timeout(WAHA_SESSION_STATUS_TIMEOUT_MS),
      });
      if (!response.ok) {
        return { status: 'UNKNOWN', working: false, checkedAt, error: `http_${response.status}` };
      }
      const payload = await response.json() as { status?: unknown };
      const status = typeof payload?.status === 'string' ? payload.status : 'UNKNOWN';
      return { status, working: status === 'WORKING', checkedAt };
    } catch (error) {
      return {
        status: 'UNKNOWN',
        working: false,
        checkedAt,
        error: isTimeout(error) ? 'timeout' : 'unreachable',
      };
    }
  }

  parseInboundWebhook(payload: unknown): InboundMessage | null {
    if (typeof payload !== 'object' || payload === null) return null;
    const event = (payload as Record<string, unknown>).event;
    if (event !== 'message') return null; // ignore session.status, message.ack, etc.

    const msg = (payload as Record<string, unknown>).payload;
    if (typeof msg !== 'object' || msg === null) return null;
    const m = msg as Record<string, unknown>;

    if (m.fromMe === true) return null; // our own outbound message, echoed back
    if (typeof m.from !== 'string' || typeof m.body !== 'string') return null;
    if (m.from.endsWith('@g.us')) return null; // group chat — out of scope
    if (m.body.trim() === '') return null; // media/sticker with no caption — nothing to react to yet

    // WhatsApp's privacy-ID system addresses some contacts as "<pseudo-id>@lid"
    // instead of their real phone-number JID. Treating that pseudo-id as a phone
    // number produces a bogus chatId that silently fails to send (caught by
    // send_message's try/catch, never surfacing as a visible error) — WAHA
    // resolves the real phone-number JID separately, so use that instead.
    const rawData = m._data as Record<string, unknown> | undefined;
    const remoteJidAlt = rawData?.key as
      | Record<string, unknown>
      | undefined;
    const isLid = m.from.endsWith('@lid');
    if (isLid && typeof remoteJidAlt?.remoteJidAlt !== 'string') {
      return null; // a privacy id without its real phone JID is not safe to reply to
    }
    const realJid = isLid ? (remoteJidAlt?.remoteJidAlt as string) : m.from;

    // The group check above only looked at the ORIGINAL `from` — but a LID
    // resolves to whatever `remoteJidAlt` says, which can itself be a group
    // JID (found live, 2026-09-05: a burst of buffered group messages on
    // reconnect produced "turn starting" events with group ids as the
    // "phone"). Re-check the JID we're actually about to use.
    if (realJid.endsWith('@g.us')) return null;

    // Reject every non-personal WhatsApp surface, not just groups. A live
    // reconnect on 2026-09-14 delivered a newsletter/community message from
    // a 120363... identifier; because the old parser accepted any suffix, it
    // stripped that identifier into a fake customer phone and sent a reply.
    // Fail closed: WAHA personal chats use @c.us, while NOWEB may expose the
    // resolved phone-number JID as @s.whatsapp.net.
    if (!realJid.endsWith('@c.us') && !realJid.endsWith('@s.whatsapp.net')) {
      return null;
    }

    const phone = phoneFromChatId(realJid);
    if (phone === '') return null; // unresolvable/malformed identifier — nothing safe to reply to

    const rawMessageId = rawData?.id as Record<string, unknown> | undefined;
    const messageId =
      typeof m.id === 'string'
        ? m.id
        : typeof rawMessageId?._serialized === 'string'
          ? rawMessageId._serialized
          : undefined;

    // WAHA documents payload.timestamp as Unix seconds (sometimes with a
    // fractional part). Keep the provider's original event time: the HTTP
    // receipt time cannot distinguish a fresh message from retained history
    // replayed during a WAHA reconnect.
    const rawTimestamp = m.timestamp;
    const timestampSeconds =
      typeof rawTimestamp === 'number'
        ? rawTimestamp
        : typeof rawTimestamp === 'string' && rawTimestamp.trim() !== ''
          ? Number(rawTimestamp)
          : Number.NaN;
    const occurredAt = Number.isFinite(timestampSeconds) && timestampSeconds > 0
      ? new Date(timestampSeconds * 1000)
      : undefined;
    const validOccurredAt = occurredAt && !Number.isNaN(occurredAt.getTime()) ? occurredAt : undefined;

    return {
      phone,
      text: m.body,
      ...(messageId ? { messageId } : {}),
      ...(validOccurredAt ? { occurredAt: validOccurredAt } : {}),
    };
  }
}

export const wahaAdapter: ChannelAdapter = new WahaAdapter();
