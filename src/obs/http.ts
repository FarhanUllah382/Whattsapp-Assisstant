// HTTP surface for observability: GET /metrics (Prometheus text format) and
// GET /operations/traces[/:id] (JSON for Grafana's Infinity table panels).
//
// Auth: `Authorization: Bearer <OPERATIONS_API_KEY>`, compared in constant
// time by operationsAccessAllowed — which fails closed when the key is missing
// or shorter than 24 characters. Nothing here is reachable without it.

import type express from 'express';

import { budgetDayKey, readAiBudgetConfig } from '../ai-budget';
import { db } from '../db';
import { operationsAccessAllowed } from '../operations';
import { createLogger } from './logger';
import {
  getWhatsappSessionUp,
  METRIC,
  renderPrometheus,
  setGauge,
  setWhatsappSessionUp,
} from './metrics';
import { pruneTraces, readRecentTraces, readTraceRetentionDays, readTraceWithEvents } from './trace';

const log = createLogger();
const SESSION_REFRESH_MS = 10_000;
const QUEUE_STATUSES = ['pending', 'processing', 'completed', 'failed'] as const;

export function bearerToken(header: unknown): string | undefined {
  if (typeof header !== 'string') return undefined;
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header);
  return match ? match[1] : undefined;
}

export function observabilityAccessAllowed(
  authorization: unknown,
  configured = process.env.OPERATIONS_API_KEY,
): boolean {
  return operationsAccessAllowed(bearerToken(authorization), configured);
}

/** Point-in-time gauges read from SQLite at scrape time. Never throws. */
export function refreshDatabaseGauges(now = new Date()): void {
  try {
    const rows = db.prepare('select status, count(*) as count from inbound_jobs group by status').all() as Array<{
      status: string;
      count: number;
    }>;
    for (const status of QUEUE_STATUSES) {
      setGauge(METRIC.queueJobs, rows.find((row) => row.status === status)?.count ?? 0, { status });
    }
    const pendingAlerts = db.prepare("select count(*) as count from owner_alerts where status = 'pending'").get() as {
      count: number;
    };
    setGauge(METRIC.ownerAlertsPending, pendingAlerts.count);
    const config = readAiBudgetConfig();
    const usage = db.prepare(`
      select count(*) as calls, coalesce(sum(total_tokens), 0) as tokens
        from ai_model_calls where day_key = ?
    `).get(budgetDayKey(now, config.timezone)) as { calls: number; tokens: number };
    setGauge(
      METRIC.aiBudgetUsed,
      Math.max(usage.calls / config.dailyCallLimit, usage.tokens / config.dailyTokenLimit),
    );
  } catch (error) {
    log.warn('metrics database gauges unavailable', { error: error instanceof Error ? error.name : 'error' });
  }
}

export interface ObservabilityDeps {
  /** Optional live WhatsApp session probe; cached for 10 s between scrapes. */
  sessionProbe?: () => Promise<{ ok: boolean }>;
}

/**
 * Mounts the routes and starts trace retention (on startup, then daily).
 * Returns a stop function for tests.
 */
export function installObservability(app: express.Express, deps: ObservabilityDeps = {}): () => void {
  let lastProbeMs = 0;
  let probeRunning: Promise<void> | null = null;
  const refreshSession = async (): Promise<void> => {
    if (!deps.sessionProbe) return;
    if (Date.now() - lastProbeMs < SESSION_REFRESH_MS && getWhatsappSessionUp() !== null) return;
    if (!probeRunning) {
      probeRunning = deps.sessionProbe()
        .then((health) => setWhatsappSessionUp(health.ok))
        .catch(() => setWhatsappSessionUp(false))
        .finally(() => {
          lastProbeMs = Date.now();
          probeRunning = null;
        });
    }
    await probeRunning;
  };

  app.get('/metrics', async (req, res) => {
    if (!observabilityAccessAllowed(req.headers.authorization)) {
      res.sendStatus(401);
      return;
    }
    await refreshSession();
    refreshDatabaseGauges();
    res.status(200).type('text/plain; version=0.0.4; charset=utf-8').send(renderPrometheus());
  });

  app.get('/operations/traces', (req, res) => {
    if (!observabilityAccessAllowed(req.headers.authorization)) {
      res.sendStatus(401);
      return;
    }
    res.status(200).json(readRecentTraces({ limit: req.query.limit, outcome: req.query.outcome }));
  });

  app.get('/operations/traces/:id', (req, res) => {
    if (!observabilityAccessAllowed(req.headers.authorization)) {
      res.sendStatus(401);
      return;
    }
    const found = readTraceWithEvents(req.params.id);
    if (!found) {
      res.sendStatus(404);
      return;
    }
    res.status(200).json(found);
  });

  const prune = (): void => {
    const removed = pruneTraces(readTraceRetentionDays());
    if (removed > 0) log.info('old message traces pruned', { removed, retentionDays: readTraceRetentionDays() });
  };
  prune();
  const timer = setInterval(prune, 24 * 60 * 60_000);
  timer.unref();
  return () => clearInterval(timer);
}
