import assert from 'node:assert/strict';

import { PACING_DEFAULTS } from '../src/guardrails/pacing/defaults';
import { decideSharedPacing } from '../src/guardrails/pacing/configured';
import {
  numberAgeDaysInTz,
  parseActivationDateInTz,
  warmupCapFor,
} from '../src/guardrails/pacing/engine';

const timezone = 'Asia/Karachi';
const activatedAt = parseActivationDateInTz('2026-09-04', timezone);
assert.ok(activatedAt);
assert.equal(activatedAt.toISOString(), '2026-09-03T19:00:00.000Z');

const now = new Date('2026-09-15T12:00:00.000Z'); // 17:00 in Karachi
const ageDays = numberAgeDaysInTz(now, activatedAt, timezone);
assert.equal(ageDays, 11);
assert.equal(warmupCapFor(ageDays, PACING_DEFAULTS.warmupDailyCaps), 100);

assert.equal(parseActivationDateInTz(undefined, timezone), null);
assert.equal(parseActivationDateInTz('', timezone), null);
assert.equal(parseActivationDateInTz('2026-02-30', timezone), null);
assert.equal(parseActivationDateInTz('09/04/2026', timezone), null);
assert.equal(parseActivationDateInTz('2026-09-04', 'Not/A_Timezone'), null);

const conservative = decideSharedPacing(
  now,
  { lastSentAt: null, sentToday: 20, numberActivatedAt: null },
  () => 0,
);
assert.equal(conservative.allow, false);
if (conservative.allow) throw new Error('Expected the missing-date decision to fail closed.');
assert.equal(conservative.code, 'warmup_cap');
assert.match(conservative.reason, /20\/dia/);

const customerPathAtTwenty = decideSharedPacing(
  now,
  { lastSentAt: new Date(now.getTime() - 500), sentToday: 20, numberActivatedAt: activatedAt },
  () => 0,
);
assert.equal(customerPathAtTwenty.allow, true);
if (!customerPathAtTwenty.allow) throw new Error('Expected the verified 100/day stage to allow send 21.');
assert.equal(customerPathAtTwenty.waitMs, 700);

const stageCap = decideSharedPacing(
  now,
  { lastSentAt: null, sentToday: 100, numberActivatedAt: activatedAt },
  () => 0,
);
assert.equal(stageCap.allow, false);
if (stageCap.allow) throw new Error('Expected the 100/day stage cap to veto send 101.');
assert.equal(stageCap.code, 'warmup_cap');
assert.match(stageCap.reason, /100\/dia/);

process.stdout.write(
  '  ✔ Karachi activation parsing, fail-closed fallback, 100/day stage, and shared throttling\n',
);
