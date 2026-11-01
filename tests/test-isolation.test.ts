import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import { databasePath, db } from '../src/db';

test('the automated suite uses a temporary database instead of ahmed.db', () => {
  const configuredPath = process.env.AHMED_TEST_DATABASE_PATH;
  assert.ok(configuredPath, 'The isolated test runner must supply AHMED_TEST_DATABASE_PATH.');
  assert.equal(process.env.NODE_ENV, 'test');
  assert.equal(databasePath, path.resolve(configuredPath));
  assert.equal(path.resolve(db.name), path.resolve(configuredPath));
  assert.notEqual(databasePath, path.resolve(__dirname, '..', 'ahmed.db'));
});
