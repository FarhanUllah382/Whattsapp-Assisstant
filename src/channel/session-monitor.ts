// Tracks whether the WhatsApp session is usable, so the durable inbound queue
// can pause AI work while it is down (FIX6, live incident 2 Nov: the WAHA
// session was FAILED, jobs still ran Gemini and were marked completed while
// every send got HTTP 422).
//
// The monitor owns only outage bookkeeping: when the outage started, how many
// inbound jobs were held, a one-time log for long outages, and one recovery
// summary for the owner. The status itself comes from an injected source (the
// channel adapter's cached getSessionStatus in production, a stub in tests).
import { createLogger } from '../obs/logger';
import type { ChannelSessionStatus } from './types';

const log = createLogger();

export const WHATSAPP_LONG_OUTAGE_MS = 2 * 60_000;

export interface OutageSummary {
  downSince: Date;
  recoveredAt: Date;
  heldMessages: number;
  /** Owner-facing text; contains no customer data. */
  message: string;
}

export interface ChannelSessionSnapshot {
  /** null until the first check has run. */
  working: boolean | null;
  status: string;
  downSince?: string;
  downForSeconds?: number;
  heldMessages: number;
  reason?: 'whatsapp_session_not_working';
}

export interface ChannelSessionMonitorOptions {
  source: () => Promise<ChannelSessionStatus>;
  longOutageMs?: number;
  now?: () => Date;
  timezone?: string;
  onLongOutage?: (downSince: Date) => void;
  /** Called after every check with the current outage length (0 when working); drives wa_whatsapp_down_seconds. */
  onDownSeconds?: (seconds: number) => void;
  onRecovered?: (summary: OutageSummary) => void;
}

function formatLocal(date: Date, timezone: string): string {
  try {
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone,
      day: '2-digit',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(date);
  } catch {
    return date.toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
  }
}

function safeErrorText(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw.replace(/\d{6,}/g, '[redacted]').slice(0, 200);
}

export class ChannelSessionMonitor {
  private readonly longOutageMs: number;
  private readonly now: () => Date;
  private readonly timezone: string;
  private last: ChannelSessionStatus | undefined;
  private downSince: Date | undefined;
  private longOutageLogged = false;
  private held = new Set<number>();

  constructor(private readonly options: ChannelSessionMonitorOptions) {
    this.longOutageMs = options.longOutageMs ?? WHATSAPP_LONG_OUTAGE_MS;
    this.now = options.now ?? (() => new Date());
    this.timezone = options.timezone ?? 'Asia/Karachi';
  }

  /**
   * Reads the (adapter-cached) session status and updates outage state.
   * Never throws: a failing status check is UNKNOWN, which counts as down.
   */
  async check(): Promise<ChannelSessionStatus> {
    let status: ChannelSessionStatus;
    try {
      status = await this.options.source();
    } catch (error) {
      status = {
        status: 'UNKNOWN',
        working: false,
        checkedAt: this.now(),
        error: safeErrorText(error),
      };
      log.warn('whatsapp session status check failed; treating as unknown', {
        error: status.error,
      });
    }
    this.observe(status);
    try {
      this.options.onDownSeconds?.(this.downSince
        ? Math.max(0, Math.round((this.now().getTime() - this.downSince.getTime()) / 1_000))
        : 0);
    } catch {
      // Metrics bookkeeping only.
    }
    return status;
  }

  /** Counts a distinct inbound job held back during the current outage. */
  recordHeld(jobId: number): void {
    if (!this.downSince) {
      // A mid-turn send discovered the outage before the next status check.
      this.downSince = this.now();
    }
    this.held.add(jobId);
  }

  snapshot(): ChannelSessionSnapshot {
    const now = this.now();
    const working = this.last ? this.last.working && !this.downSince : null;
    return {
      working,
      status: this.last?.status ?? 'UNCHECKED',
      ...(this.downSince
        ? {
            downSince: this.downSince.toISOString(),
            downForSeconds: Math.max(0, Math.round((now.getTime() - this.downSince.getTime()) / 1_000)),
            reason: 'whatsapp_session_not_working' as const,
          }
        : {}),
      heldMessages: this.held.size,
    };
  }

  private observe(status: ChannelSessionStatus): void {
    this.last = status;
    const now = this.now();
    if (!status.working) {
      if (!this.downSince) {
        this.downSince = now;
        log.warn('whatsapp session not working; pausing AI work', { sessionStatus: status.status });
      }
      if (!this.longOutageLogged && now.getTime() - this.downSince.getTime() > this.longOutageMs) {
        this.longOutageLogged = true;
        log.error('whatsapp session down for more than 2 minutes', {
          sessionStatus: status.status,
          downSince: this.downSince.toISOString(),
          heldMessages: this.held.size,
        });
        this.options.onLongOutage?.(this.downSince);
      }
      return;
    }

    if (!this.downSince) return;
    const downSince = this.downSince;
    const heldMessages = this.held.size;
    const wasLong = this.longOutageLogged || now.getTime() - downSince.getTime() > this.longOutageMs;
    this.downSince = undefined;
    this.longOutageLogged = false;
    this.held = new Set();
    log.info('whatsapp session recovered', {
      downSince: downSince.toISOString(),
      downForSeconds: Math.round((now.getTime() - downSince.getTime()) / 1_000),
      heldMessages,
    });
    if (!wasLong) return;
    const noun = heldMessages === 1 ? 'message was' : 'messages were';
    const message =
      `WhatsApp was disconnected from ${formatLocal(downSince, this.timezone)} to ` +
      `${formatLocal(now, this.timezone)}; ${heldMessages} ${noun} held and are now being answered.`;
    this.options.onRecovered?.({ downSince, recoveredAt: now, heldMessages, message });
  }
}
