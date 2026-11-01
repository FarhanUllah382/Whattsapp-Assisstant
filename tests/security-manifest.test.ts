import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { allTestTargets, securityTestTargets } from '../scripts/test-manifest';

const requiredSecurityAreas = [
  'test database isolation',
  'order state authorization',
  'server pricing and payment integrity',
  'webhook authenticity and tamper rejection',
  'owner handoff truthfulness',
  'customer and order identity isolation',
  'PII minimization and log redaction',
  'PII extraction resistance',
  'inventory confidentiality',
  'approved product media authorization',
  'refund ownership and authorization',
  'grounded product and policy answers',
  'inbound abuse limits',
  'AI cost limits',
  'durable queue and restart recovery',
  'multi-turn adversarial state resistance',
  'sensitive action truthfulness',
  'adversarial input and query safety',
  'indirect prompt injection and output disclosure',
  'outbound idempotency and uncertain delivery',
  'health monitoring and verified recovery backups',
] as const;

test('the security regression manifest is unique, complete, and points to real files', () => {
  const files = allTestTargets.map((target) => target.file);
  assert.equal(new Set(files).size, files.length, 'Every test file must appear only once.');
  assert.ok(files.includes('tests/security-manifest.test.ts'));

  for (const target of allTestTargets) {
    assert.ok(target.securityAreas.length > 0, `${target.file} must declare its security coverage.`);
    assert.ok(
      fs.existsSync(path.resolve(__dirname, '..', target.file)),
      `${target.file} must exist.`,
    );
  }

  const coveredAreas = new Set(securityTestTargets.flatMap((target) => target.securityAreas));
  for (const area of requiredSecurityAreas) {
    assert.ok(coveredAreas.has(area), `Missing permanent security area: ${area}`);
  }
});
