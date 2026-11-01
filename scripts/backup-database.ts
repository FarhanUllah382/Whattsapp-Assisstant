import { createVerifiedBackup, readBackupConfig } from '../src/database-backup';

async function main(): Promise<void> {
  const result = await createVerifiedBackup(readBackupConfig());
  console.log(JSON.stringify({
    backup: result.path,
    integrity: result.verification.integrity,
    foreign_key_violations: result.verification.foreignKeyViolations,
    size_bytes: result.verification.sizeBytes,
    sha256: result.verification.sha256,
    old_backups_removed: result.removed,
  }, null, 2));
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
