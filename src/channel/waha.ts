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

async function wahaFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    ...(init.headers as Record<string, string> | undefined),
  };
  if (WAHA_API_KEY) headers['X-Api-Key'] = WAHA_API_KEY;
  return fetch(`${WAHA_BASE_URL}${path}`, { ...init, headers });
}

export const wahaAdapter: ChannelAdapter = {
  channel: 'waha',

  async sendText(phone, text) {
    const response = await wahaFetch('/api/sendText', {
      method: 'POST',
      body: JSON.stringify({ session: WAHA_SESSION, chatId: chatIdFor(phone), text }),
    });
    if (!response.ok) {
      const detail = await response.text();
      throw new Error(`WAHA send failed (${response.status}): ${detail.slice(0, 300)}`);
    }
  },

  parseInboundWebhook(payload) {
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
    const remoteJidAlt = (m._data as Record<string, unknown> | undefined)?.key as
      | Record<string, unknown>
      | undefined;
    const realJid =
      m.from.endsWith('@lid') && typeof remoteJidAlt?.remoteJidAlt === 'string'
        ? (remoteJidAlt.remoteJidAlt as string)
        : m.from;

    return { phone: phoneFromChatId(realJid), text: m.body };
  },
};
