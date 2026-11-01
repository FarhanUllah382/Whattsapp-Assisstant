import { db } from './db';
import type { ChannelAdapter } from './channel/types';

const startedAt = new Date();

export interface WorkerSnapshot {
  active: number;
  workers: number;
}

function count(sql: string): number {
  return (db.prepare(sql).get() as { count: number }).count;
}

export function livenessPayload(now = new Date()): Record<string, unknown> {
  return {
    status: 'ok',
    service: 'ahmed-whatsapp-assistant',
    now: now.toISOString(),
    uptime_seconds: Math.max(0, Math.floor((now.getTime() - startedAt.getTime()) / 1_000)),
  };
}

export function readOperationalMetrics(worker: WorkerSnapshot): Record<string, unknown> {
  const oldestPending = db.prepare(`
    select created_at from inbound_jobs where status = 'pending' order by created_at limit 1
  `).get() as { created_at: string } | undefined;
  return {
    queue: {
      pending: count("select count(*) count from inbound_jobs where status = 'pending'"),
      processing: count("select count(*) count from inbound_jobs where status = 'processing'"),
      failed: count("select count(*) count from inbound_jobs where status = 'failed'"),
      active_workers: worker.active,
      worker_limit: worker.workers,
      oldest_pending_at: oldestPending?.created_at ?? null,
    },
    delivery: {
      uncertain: count("select count(*) count from send_ledger where status = 'uncertain'"),
      failed: count("select count(*) count from send_ledger where status = 'failed'"),
      pending_owner_alerts: count("select count(*) count from owner_alerts where status = 'pending'"),
    },
    process: {
      uptime_seconds: Math.floor(process.uptime()),
      rss_bytes: process.memoryUsage().rss,
      heap_used_bytes: process.memoryUsage().heapUsed,
    },
  };
}

export async function readinessPayload(
  channel: ChannelAdapter,
  worker: WorkerSnapshot,
): Promise<{ ready: boolean; payload: Record<string, unknown> }> {
  let databaseOk = false;
  try {
    databaseOk = (db.prepare('select 1 as ok').get() as { ok: number }).ok === 1;
  } catch {
    databaseOk = false;
  }
  const provider = await channel.healthCheck();
  const queue = readOperationalMetrics(worker).queue as Record<string, unknown>;
  const ready = databaseOk && provider.ok;
  return {
    ready,
    payload: {
      status: ready ? 'ready' : 'not_ready',
      database: databaseOk ? 'ok' : 'unavailable',
      whatsapp: provider.status,
      queue: {
        pending: queue.pending,
        processing: queue.processing,
        failed: queue.failed,
        active_workers: queue.active_workers,
        worker_limit: queue.worker_limit,
      },
    },
  };
}

export function operationsAccessAllowed(
  supplied: unknown,
  configured = process.env.OPERATIONS_API_KEY,
): boolean {
  if (!configured || configured.length < 24 || typeof supplied !== 'string') return false;
  if (supplied.length !== configured.length) return false;
  let difference = 0;
  for (let i = 0; i < configured.length; i += 1) {
    difference |= configured.charCodeAt(i) ^ supplied.charCodeAt(i);
  }
  return difference === 0;
}
