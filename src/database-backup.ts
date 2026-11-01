import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

import { db } from './db';

export interface BackupConfig {
  enabled: boolean;
  directory: string;
  intervalHours: number;
  retentionCount: number;
}

function boundedInteger(value: string | undefined, fallback: number, min: number, max: number): number {
  if (!value || !/^\d+$/.test(value.trim())) return fallback;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}

export function readBackupConfig(env: NodeJS.ProcessEnv = process.env): BackupConfig {
  return {
    enabled: env.DATABASE_BACKUP_ENABLED?.trim().toLowerCase() !== 'false',
    directory: path.resolve(env.DATABASE_BACKUP_DIRECTORY?.trim() || path.join('backups', 'operations')),
    intervalHours: boundedInteger(env.DATABASE_BACKUP_INTERVAL_HOURS, 24, 1, 168),
    retentionCount: boundedInteger(env.DATABASE_BACKUP_RETENTION_COUNT, 14, 2, 365),
  };
}

function backupName(now: Date): string {
  return `ahmed-backup-${now.toISOString().replace(/[:.]/g, '-')}.db`;
}

function verifySafeBackupDirectory(directory: string): void {
  const resolved = path.resolve(directory);
  const root = path.parse(resolved).root;
  if (resolved === root || resolved === path.resolve('.')) {
    throw new Error('Backup directory must be a dedicated subdirectory, not a filesystem or workspace root.');
  }
}

export function verifyDatabaseBackup(filePath: string): {
  integrity: 'ok';
  foreignKeyViolations: number;
  sizeBytes: number;
  sha256: string;
} {
  const resolved = path.resolve(filePath);
  const backup = new Database(resolved, { readonly: true, fileMustExist: true });
  try {
    const integrityRows = backup.pragma('integrity_check') as Array<{ integrity_check: string }>;
    if (integrityRows.length !== 1 || integrityRows[0].integrity_check !== 'ok') {
      throw new Error('Backup failed SQLite integrity_check.');
    }
    const foreignKeyViolations = (backup.pragma('foreign_key_check') as unknown[]).length;
    if (foreignKeyViolations > 0) throw new Error('Backup contains foreign-key violations.');
  } finally {
    backup.close();
  }
  const bytes = fs.readFileSync(resolved);
  return {
    integrity: 'ok',
    foreignKeyViolations: 0,
    sizeBytes: bytes.byteLength,
    sha256: createHash('sha256').update(bytes).digest('hex').toUpperCase(),
  };
}

export async function createVerifiedBackup(
  config: BackupConfig = readBackupConfig(),
  now = new Date(),
): Promise<{ path: string; removed: string[]; verification: ReturnType<typeof verifyDatabaseBackup> }> {
  if (!config.enabled) throw new Error('Database backups are disabled by configuration.');
  verifySafeBackupDirectory(config.directory);
  fs.mkdirSync(config.directory, { recursive: true });
  const destination = path.join(config.directory, backupName(now));
  await db.backup(destination);
  const verification = verifyDatabaseBackup(destination);

  const candidates = fs.readdirSync(config.directory)
    .filter((name) => /^ahmed-backup-\d{4}-\d{2}-\d{2}T.*\.db$/.test(name))
    .map((name) => ({ name, path: path.resolve(config.directory, name) }))
    .filter((entry) => path.dirname(entry.path) === path.resolve(config.directory))
    .sort((a, b) => b.name.localeCompare(a.name));
  const removed: string[] = [];
  for (const old of candidates.slice(config.retentionCount)) {
    fs.unlinkSync(old.path);
    removed.push(old.name);
  }
  return { path: destination, removed, verification };
}
