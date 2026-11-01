import path from 'node:path';
import { verifyDatabaseBackup } from '../src/database-backup';

const requested = process.argv[2];
if (!requested) throw new Error('Usage: npm run backup:verify -- <path-to-backup.db>');
const backupPath = path.resolve(requested);
console.log(JSON.stringify({ backup: backupPath, ...verifyDatabaseBackup(backupPath) }, null, 2));
