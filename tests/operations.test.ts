import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import type { ChannelAdapter } from '../src/channel/types';
import { WahaAdapter } from '../src/channel/waha';
import {
  createVerifiedBackup,
  readBackupConfig,
  verifyDatabaseBackup,
} from '../src/database-backup';
import { db } from '../src/db';
import {
  livenessPayload,
  operationsAccessAllowed,
  readOperationalMetrics,
  readinessPayload,
} from '../src/operations';

function fakeChannel(ok: boolean): ChannelAdapter {
  return {
    channel: 'test',
    sendText: async () => ({}),
    sendImage: async () => ({}),
    healthCheck: async () => ({ ok, status: ok ? 'WORKING' : 'STOPPED' }),
    parseInboundWebhook: () => null,
  };
}

test('operations access fails closed and compares the full configured key', () => {
  const key = '123456789012345678901234';
  assert.equal(operationsAccessAllowed(undefined, undefined), false);
  assert.equal(operationsAccessAllowed(key, 'short'), false);
  assert.equal(operationsAccessAllowed(`${key}x`, key), false);
  assert.equal(operationsAccessAllowed(`${key.slice(0, -1)}x`, key), false);
  assert.equal(operationsAccessAllowed(key, key), true);
});

test('liveness and readiness expose minimal operational state', async () => {
  const live = livenessPayload(new Date('2026-10-04T10:00:00.000Z'));
  assert.equal(live.status, 'ok');
  assert.equal(live.service, 'ahmed-whatsapp-assistant');
  assert.equal(Object.hasOwn(live, 'phone'), false);

  const ready = await readinessPayload(fakeChannel(true), { active: 1, workers: 4 });
  assert.equal(ready.ready, true);
  assert.equal(ready.payload.status, 'ready');
  assert.equal(ready.payload.whatsapp, 'WORKING');

  const stopped = await readinessPayload(fakeChannel(false), { active: 0, workers: 4 });
  assert.equal(stopped.ready, false);
  assert.equal(stopped.payload.status, 'not_ready');
  assert.equal(stopped.payload.whatsapp, 'STOPPED');
});

test('operational metrics contain counts but no customer text or phone', () => {
  const metrics = readOperationalMetrics({ active: 2, workers: 4 });
  const serialized = JSON.stringify(metrics);
  assert.equal((metrics.queue as any).active_workers, 2);
  assert.equal((metrics.queue as any).worker_limit, 4);
  assert.equal(serialized.includes('body'), false);
  assert.equal(serialized.includes('phone'), false);
});

test('WAHA readiness reports only the session status', async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response(JSON.stringify({
      name: 'default',
      status: 'WORKING',
      me: { id: '923001234567@c.us', pushName: 'Private Name' },
    }), { status: 200 });
    const adapter = new WahaAdapter({ baseUrl: 'http://test.invalid', session: 'default' });
    assert.deepEqual(await adapter.healthCheck(), { ok: true, status: 'WORKING' });

    globalThis.fetch = async () => new Response('unavailable', { status: 503 });
    assert.deepEqual(await adapter.healthCheck(), { ok: false, status: 'http_503' });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('backup configuration is finite and conservative', () => {
  const config = readBackupConfig({
    DATABASE_BACKUP_ENABLED: 'true',
    DATABASE_BACKUP_DIRECTORY: 'backups/test-operations',
    DATABASE_BACKUP_INTERVAL_HOURS: '0',
    DATABASE_BACKUP_RETENTION_COUNT: '999999',
  });
  assert.equal(config.enabled, true);
  assert.equal(config.intervalHours, 24);
  assert.equal(config.retentionCount, 14);
  assert.equal(path.isAbsolute(config.directory), true);
});

test('online backups are restorable, integrity-checked, hashed, and retained safely', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ahmed-backup-test-'));
  try {
    const config = { enabled: true, directory: tempRoot, intervalHours: 24, retentionCount: 2 };
    const first = await createVerifiedBackup(config, new Date('2026-10-01T00:00:00.000Z'));
    const second = await createVerifiedBackup(config, new Date('2026-10-02T00:00:00.000Z'));
    const third = await createVerifiedBackup(config, new Date('2026-10-03T00:00:00.000Z'));

    assert.equal(first.verification.integrity, 'ok');
    assert.equal(second.verification.foreignKeyViolations, 0);
    assert.match(third.verification.sha256, /^[A-F0-9]{64}$/);
    assert.ok(third.verification.sizeBytes > 0);
    assert.deepEqual(verifyDatabaseBackup(third.path), third.verification);
    assert.equal(fs.existsSync(first.path), false);
    assert.equal(fs.existsSync(second.path), true);
    assert.equal(fs.existsSync(third.path), true);
    assert.deepEqual(third.removed, [path.basename(first.path)]);
  } finally {
    const resolved = path.resolve(tempRoot);
    if (resolved.startsWith(path.resolve(os.tmpdir()))) {
      fs.rmSync(resolved, { recursive: true, force: true });
    }
  }
});

test('backup path safety rejects filesystem and workspace roots', async () => {
  await assert.rejects(createVerifiedBackup({
    enabled: true,
    directory: path.parse(path.resolve('.')).root,
    intervalHours: 24,
    retentionCount: 14,
  }), /dedicated subdirectory/i);
  await assert.rejects(createVerifiedBackup({
    enabled: true,
    directory: path.resolve('.'),
    intervalHours: 24,
    retentionCount: 14,
  }), /dedicated subdirectory/i);
});
