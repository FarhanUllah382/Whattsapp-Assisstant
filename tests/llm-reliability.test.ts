// Deterministic reliability checks for the two outbound network seams:
// Gemini (src/llm.ts) and WAHA sends (src/channel/waha.ts). Global fetch is
// replaced in every test — nothing here touches the network.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ChannelSendError } from '../src/channel/types';
import {
  readWahaSendTimeoutMs,
  WAHA_SEND_TIMEOUT_DEFAULT_MS,
  WahaAdapter,
} from '../src/channel/waha';
import { db } from '../src/db';
import { callModel, GEMINI_DEFAULTS, readGeminiConfig } from '../src/llm';
import {
  beginOutboundAttempt,
  inspectOutboundAttempt,
  markOutboundFailure,
} from '../src/outbound-delivery';

const TEST_KEY = 'TEST-GEMINI-KEY-do-not-leak-1234567890';

type FetchArgs = { url: string; init: RequestInit | undefined };

/** A fetch that never answers on its own; it only rejects when its signal aborts. */
function hangingFetch(calls: FetchArgs[]): typeof fetch {
  return ((input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      // AbortSignal.timeout uses an unref'd timer. A real fetch holds a socket
      // that keeps the process alive; this mock does not, so hold a ref'd
      // keep-alive handle (capped) until the signal fires.
      const keepAlive = setTimeout(() => reject(new Error('mock fetch: no abort signal fired')), 5_000);
      if (!signal) return;
      const abort = () => {
        clearTimeout(keepAlive);
        reject(signal.reason);
      };
      if (signal.aborted) abort();
      else signal.addEventListener('abort', abort, { once: true });
    });
  }) as typeof fetch;
}

function withEnv(values: Record<string, string | undefined>): () => void {
  const previous: Record<string, string | undefined> = {};
  for (const [name, value] of Object.entries(values)) {
    previous[name] = process.env[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  return () => {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  };
}

function latestAiCall(): { model: string; status: string } | undefined {
  return db.prepare(`
    select model, status from ai_model_calls order by rowid desc limit 1
  `).get() as { model: string; status: string } | undefined;
}

test('invalid or missing Gemini configuration falls back to finite safe defaults', () => {
  assert.deepEqual(readGeminiConfig({}), {
    apiKey: undefined,
    model: GEMINI_DEFAULTS.model,
    timeoutMs: GEMINI_DEFAULTS.timeoutMs,
  });
  for (const bad of ['', '0', '-5', 'abc', '1.5', 'Infinity', '99999999999', '30s']) {
    assert.equal(readGeminiConfig({ GEMINI_TIMEOUT_MS: bad }).timeoutMs, GEMINI_DEFAULTS.timeoutMs, bad);
  }
  assert.equal(readGeminiConfig({ GEMINI_TIMEOUT_MS: '45000' }).timeoutMs, 45_000);
  for (const bad of ['', '   ', '../../evil', 'model?key=x', 'gemini flash', 'a/b', 'x#y', 'm:generate']) {
    assert.equal(readGeminiConfig({ GEMINI_MODEL: bad }).model, GEMINI_DEFAULTS.model, bad);
  }
  assert.equal(readGeminiConfig({ GEMINI_MODEL: 'gemini-2.5-flash' }).model, 'gemini-2.5-flash');
});

test('Gemini API key travels only in the x-goog-api-key header, never in the URL', async () => {
  const restoreEnv = withEnv({
    GEMINI_API_KEY: TEST_KEY,
    GEMINI_MODEL: 'gemini-test-model',
    GEMINI_TIMEOUT_MS: undefined,
  });
  const originalFetch = globalThis.fetch;
  const calls: FetchArgs[] = [];
  try {
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      return new Response(JSON.stringify({
        candidates: [{ content: { parts: [{ text: 'hello' }] } }],
        usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 2, totalTokenCount: 5 },
      }), { status: 200 });
    }) as typeof fetch;
    const result = await callModel('system', [{ role: 'user', content: 'hi' }], []);
    assert.deepEqual(result.content, [{ type: 'text', text: 'hello' }]);

    assert.equal(calls.length, 1);
    const { url, init } = calls[0];
    assert.ok(!url.includes(TEST_KEY), 'API key must not appear in the URL');
    assert.ok(!url.includes('key='), 'no key query parameter');
    assert.ok(url.includes('/models/gemini-test-model:generateContent'));
    const headers = init?.headers as Record<string, string>;
    assert.equal(headers['x-goog-api-key'], TEST_KEY);
    assert.ok(init?.signal instanceof AbortSignal, 'every Gemini call carries a timeout signal');
    assert.deepEqual(latestAiCall(), { model: 'gemini-test-model', status: 'succeeded' });

    // A provider error body that echoes the key must not carry it into the thrown error.
    globalThis.fetch = (async () =>
      new Response(`invalid key ${TEST_KEY}`, { status: 403 })) as unknown as typeof fetch;
    await assert.rejects(
      callModel('system', [{ role: 'user', content: 'hi' }], []),
      (error: unknown) =>
        error instanceof Error &&
        error.message.includes('403') &&
        !error.message.includes(TEST_KEY),
    );
    assert.equal(latestAiCall()?.status, 'failed');
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnv();
  }
});

test('a Gemini timeout aborts the call, is recorded as a failed AI call, and throws normally', async () => {
  const restoreEnv = withEnv({
    GEMINI_API_KEY: TEST_KEY,
    GEMINI_MODEL: undefined,
    GEMINI_TIMEOUT_MS: '25',
  });
  const originalFetch = globalThis.fetch;
  const calls: FetchArgs[] = [];
  try {
    globalThis.fetch = hangingFetch(calls);
    const before = (db.prepare('select count(*) n from ai_model_calls').get() as { n: number }).n;
    const started = Date.now();
    await assert.rejects(
      callModel('system', [{ role: 'user', content: 'hi' }], []),
      (error: unknown) =>
        error instanceof Error &&
        /timed out after 25ms/.test(error.message) &&
        !error.message.includes(TEST_KEY),
    );
    assert.ok(Date.now() - started < 5_000, 'the timeout must fire promptly');
    assert.equal(calls.length, 1);
    const after = (db.prepare('select count(*) n from ai_model_calls').get() as { n: number }).n;
    assert.equal(after, before + 1, 'a timed-out call still consumes one budget reservation');
    assert.deepEqual(latestAiCall(), { model: GEMINI_DEFAULTS.model, status: 'failed' });
    assert.equal(
      (db.prepare(`select count(*) n from ai_model_calls where status = 'reserved'`).get() as { n: number }).n,
      0,
      'no reservation is left dangling',
    );
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnv();
  }
});

test('invalid WAHA send timeout values fall back to the finite default', () => {
  assert.equal(readWahaSendTimeoutMs({}), WAHA_SEND_TIMEOUT_DEFAULT_MS);
  for (const bad of ['', '0', '-1', 'never', '1e3', '99999999999']) {
    assert.equal(readWahaSendTimeoutMs({ WAHA_SEND_TIMEOUT_MS: bad }), WAHA_SEND_TIMEOUT_DEFAULT_MS, bad);
  }
  assert.equal(readWahaSendTimeoutMs({ WAHA_SEND_TIMEOUT_MS: '5000' }), 5_000);
});

test('a timed-out WAHA send is delivery-uncertain and is never retried into a duplicate', async () => {
  const originalFetch = globalThis.fetch;
  const calls: FetchArgs[] = [];
  db.exec('begin');
  try {
    globalThis.fetch = hangingFetch(calls);
    const adapter = new WahaAdapter({
      baseUrl: 'http://test.invalid',
      session: 'test',
      sendTimeoutMs: 25,
    });

    const customerId = Number(db.prepare('insert into customers (phone) values (?)')
      .run(`waha-timeout-${Date.now()}`).lastInsertRowid);
    const attempt = {
      id: `waha-timeout-attempt-${Date.now()}`,
      customerId,
      recipientKind: 'customer' as const,
      eventKey: `event:waha-timeout-${Date.now()}`,
      bodyHash: 'body:waha-timeout',
    };
    assert.equal(beginOutboundAttempt(attempt), 'send');

    let thrown: unknown;
    try {
      await adapter.sendText('923001234567', 'hello');
    } catch (error) {
      thrown = error;
    }
    assert.ok(thrown instanceof ChannelSendError, 'timeout surfaces as a ChannelSendError');
    assert.equal(thrown.deliveryUncertain, true, 'a timeout is uncertain, not a clean failure');
    assert.match(thrown.message, /timed out after 25ms/);
    assert.equal(calls.length, 1);
    assert.ok(calls[0].init?.signal instanceof AbortSignal, 'outbound sends carry a timeout signal');

    assert.equal(markOutboundFailure(attempt.id, thrown), 'uncertain');
    assert.equal(inspectOutboundAttempt(attempt.id), 'uncertain');
    // A retry of the same attempt or a rephrased reply to the same event is refused.
    assert.equal(beginOutboundAttempt(attempt), 'uncertain');
    assert.equal(beginOutboundAttempt({ ...attempt, id: `${attempt.id}-rephrased` }), 'uncertain');
    const row = db.prepare('select status, attempt_count, last_error_code from send_ledger where id = ?')
      .get(attempt.id);
    assert.deepEqual(row, {
      status: 'uncertain',
      attempt_count: 1,
      last_error_code: 'delivery_outcome_unknown',
    });
    assert.equal(calls.length, 1, 'no second network send was made');

    // Invalid constructor timeouts still produce a finite signal (default path).
    calls.length = 0;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      return new Response(JSON.stringify({ id: 'WAHA-OK' }), { status: 200 });
    }) as typeof fetch;
    const fallback = new WahaAdapter({ baseUrl: 'http://test.invalid', session: 'test', sendTimeoutMs: -1 });
    assert.deepEqual(await fallback.sendText('923001234567', 'hi'), { providerMessageId: 'WAHA-OK' });
    assert.ok(calls[0].init?.signal instanceof AbortSignal);
  } finally {
    db.exec('rollback');
    globalThis.fetch = originalFetch;
  }
});
