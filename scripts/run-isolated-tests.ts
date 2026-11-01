import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { allTestTargets, securityTestTargets, type TestTarget } from './test-manifest';

const projectRoot = path.resolve(__dirname, '..');
const productionDatabaseFiles = [
  path.join(projectRoot, 'ahmed.db'),
  path.join(projectRoot, 'ahmed.db-wal'),
  path.join(projectRoot, 'ahmed.db-shm'),
];

const requestedArguments = process.argv.slice(2);
const securityMode = requestedArguments[0] === '--security';
const requestedTestFiles = securityMode ? requestedArguments.slice(1) : requestedArguments;
const selectedTargets: readonly TestTarget[] = securityMode
  ? securityTestTargets
  : requestedTestFiles.length > 0
    ? requestedTestFiles.map((file) => ({
        file,
        securityAreas: ['custom isolated verification'],
        includeInSecurityRegression: false,
      }))
    : allTestTargets;
const suiteName = securityMode ? 'security-regression' : 'isolated-db';

type FileFingerprint = { exists: boolean; sha256?: string; size?: number };

function fingerprint(filePath: string): FileFingerprint {
  if (!fs.existsSync(filePath)) return { exists: false };
  const bytes = fs.readFileSync(filePath);
  return {
    exists: true,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    size: bytes.length,
  };
}

function productionSnapshot(): Record<string, FileFingerprint> {
  return Object.fromEntries(
    productionDatabaseFiles.map((filePath) => [path.basename(filePath), fingerprint(filePath)]),
  );
}

function sameSnapshot(
  before: Record<string, FileFingerprint>,
  after: Record<string, FileFingerprint>,
): boolean {
  return JSON.stringify(before) === JSON.stringify(after);
}

const before = productionSnapshot();
const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ahmed-isolated-tests-'));
const failures: string[] = [];

try {
  for (const [index, target] of selectedTargets.entries()) {
    const relativeTestPath = target.file;
    const absoluteTestPath = path.resolve(projectRoot, relativeTestPath);
    if (!absoluteTestPath.startsWith(`${projectRoot}${path.sep}`) || !fs.existsSync(absoluteTestPath)) {
      process.stderr.write(`Refusing invalid test path: ${relativeTestPath}\n`);
      failures.push(relativeTestPath);
      continue;
    }
    const testDirectory = path.join(temporaryRoot, `${String(index + 1).padStart(2, '0')}`);
    fs.mkdirSync(testDirectory, { recursive: true });
    const testDatabasePath = path.join(testDirectory, 'test.db');

    process.stdout.write(`\n[${suiteName}] ${relativeTestPath}\n`);
    process.stdout.write(`  coverage: ${target.securityAreas.join('; ')}\n`);
    const result = spawnSync(
      process.execPath,
      ['--import', 'tsx', absoluteTestPath],
      {
        cwd: projectRoot,
        env: {
          ...process.env,
          NODE_ENV: 'test',
          AHMED_TEST_DATABASE_PATH: testDatabasePath,
        },
        stdio: 'inherit',
      },
    );

    if (result.error) {
      process.stderr.write(`${relativeTestPath}: ${result.error.message}\n`);
      failures.push(relativeTestPath);
    } else if (result.status !== 0) {
      failures.push(relativeTestPath);
    }
  }
} finally {
  fs.rmSync(temporaryRoot, { recursive: true, force: true });
}

const after = productionSnapshot();
if (!sameSnapshot(before, after)) {
  process.stderr.write('\nProduction database fingerprint changed during the isolated test run.\n');
  failures.push('production-database-immutability');
} else {
  process.stdout.write(`\n[${suiteName}] ahmed.db and sidecar fingerprints are unchanged.\n`);
}

if (failures.length > 0) {
  process.stderr.write(`\nFailed isolated checks: ${failures.join(', ')}\n`);
  process.exitCode = 1;
} else {
  const coveredAreas = new Set(selectedTargets.flatMap((target) => target.securityAreas));
  process.stdout.write(
    `\nAll ${selectedTargets.length} ${suiteName} test files passed across ${coveredAreas.size} declared areas.\n`,
  );
}
