// WAHA (https://waha.devlike.pro) implementation of ChannelAdapter. This is
// the ONLY file in the project that knows WAHA's REST shape, session concept,
// or WhatsApp chatId format — server.ts talks to it only through the
// ChannelAdapter interface, and agent.ts/tools.ts don't import this file at
// all.
import type { ChannelAdapter } from './types';

const WAHA_BASE_URL = process.env.WAHA_BASE_URL ?? 'http://localhost:3001';
const WAHA_SESSION = process.env.WAHA_SESSION ?? 'default';
// Only set if the WAHA instance was started with WHATSAPP_API_KEY / API-key
// auth enabled — WAHA accepts requests without it otherwise.
const WAHA_API_KEY = process.env.WAHA_API_KEY;

/** WAHA/whatsapp-web.js address individual chats as "<digits>@c.us". */
function chatIdFor(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  return `${digits}@c.us`;
}

function phoneFromChatId(chatId: string): string {
  return chatId.split('@')[0].replace(/\D/g, '');
}

export interface WahaAdapterConfig {
  baseUrl?: string;
  session?: string;
  apiKey?: string;
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

  constructor(config?: WahaAdapterConfig) {
    this.baseUrl = config?.baseUrl ?? WAHA_BASE_URL;
    this.session = config?.session ?? WAHA_SESSION;
    this.apiKey = config?.apiKey ?? WAHA_API_KEY;
  }

  private async fetch(path: string, init: RequestInit = {}): Promise<Response> {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      ...(init.headers as Record<string, string> | undefined),
    };
    if (this.apiKey) headers['X-Api-Key'] = this.apiKey;
    return fetch(`${this.baseUrl}${path}`, { ...init, headers });
  }

  async sendText(phone: string, text: string): Promise<void> {
    const response = await this.fetch('/api/sendText', {
      method: 'POST',
      body: JSON.stringify({ session: this.session, chatId: chatIdFor(phone), text }),
    });
    if (!response.ok) {
      const detail = await response.text();
      throw new Error(`WAHA send failed (${response.status}): ${detail.slice(0, 300)}`);
    }
  }

  parseInboundWebhook(payload: unknown): { phone: string; text: string; messageId?: string } | null {
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

    return messageId ? { phone, text: m.body, messageId } : { phone, text: m.body };
  }
}

export const wahaAdapter: ChannelAdapter = new WahaAdapter();
