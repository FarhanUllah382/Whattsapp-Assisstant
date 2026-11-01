// ═══════════════════════════════════════════════════════════════════════════
// THE ONE PLACE THIS WHOLE PROJECT TALKS TO THE AI.
//
// In the big reference system, `run-model-call.ts` is this same idea, except
// it also: resolves per-org credentials, checks a monthly spending budget,
// swaps between providers, and logs cost into a database table. We don't
// need any of that yet — Ahmed has one API key and one business.
//
// The one thing worth keeping from that file's philosophy: EVERY call to the
// AI, anywhere in this project, should go through this function. If you ever
// need to add budget limits, logging, or a different AI provider, you change
// it here once instead of hunting through the codebase.
// ═══════════════════════════════════════════════════════════════════════════

import { finishAiModelCall, reserveAiModelCall } from './ai-budget';
import type { ToolDef } from './types';

// Provider swapped to Gemini for local WAHA end-to-end testing (2026-09-02) —
// swap back to Anthropic before Version 1 is considered done. The exported
// shape (ModelMessage/CallModelResult, both Anthropic-flavored: content
// blocks + stop_reason) is unchanged, so agent.ts didn't need any edits —
// this function still does 100% of the translation on both sides, per the
// single-seam rule above.
//
// Configuration is read at call time (not module load) so tests and operators
// get the same validated values. Every value fails closed to a finite default:
// a missing or malformed timeout never means "wait forever", and a malformed
// model name never reaches the request URL.
//
// Default model: switched from gemini-2.5-flash (2026-09-04) — its
// 20-requests/day free-tier quota is exhausted (real traffic + our own
// testing burned through it, and the cap is per-model, not per-key, so
// swapping keys under the same GCP project didn't help).
// gemini-flash-lite-latest is a separate model with its own quota bucket,
// confirmed working incl. function/tool calling. Override with GEMINI_MODEL.
export const GEMINI_DEFAULTS = Object.freeze({
  model: 'gemini-flash-lite-latest',
  timeoutMs: 30_000,
});
const GEMINI_MAX_TIMEOUT_MS = 600_000;
const SAFE_MODEL_NAME = /^[a-z0-9.\-]+$/i;

export interface GeminiConfig {
  apiKey: string | undefined;
  model: string;
  timeoutMs: number;
}

export function readGeminiConfig(env: NodeJS.ProcessEnv = process.env): GeminiConfig {
  const rawModel = env.GEMINI_MODEL?.trim() ?? '';
  const model = rawModel !== '' && rawModel.length <= 100 && SAFE_MODEL_NAME.test(rawModel)
    ? rawModel
    : GEMINI_DEFAULTS.model;
  const rawTimeout = env.GEMINI_TIMEOUT_MS?.trim() ?? '';
  const parsedTimeout = /^\d+$/.test(rawTimeout) ? Number(rawTimeout) : Number.NaN;
  const timeoutMs = Number.isSafeInteger(parsedTimeout) &&
    parsedTimeout > 0 &&
    parsedTimeout <= GEMINI_MAX_TIMEOUT_MS
    ? parsedTimeout
    : GEMINI_DEFAULTS.timeoutMs;
  const apiKey = env.GEMINI_API_KEY?.trim() || undefined;
  return { apiKey, model, timeoutMs };
}

/** Removes the API key from provider/runtime text before it can reach an error or log. */
function redactKey(text: string, apiKey: string): string {
  return text.split(apiKey).join('[redacted]');
}

function isAbortTimeout(error: unknown): boolean {
  return error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
}

export interface ModelMessage {
  role: 'user' | 'assistant';
  content: string | unknown[]; // string for plain text, array for tool_use/tool_result blocks
}

export interface CallModelResult {
  // Anthropic's response content blocks: mix of {type:'text',...} and {type:'tool_use',...}
  content: any[];
  stop_reason: string;
}

export function normalizeGeminiFunctionResponse(response: unknown): Record<string, unknown> {
  if (typeof response === 'object' && response !== null && !Array.isArray(response)) {
    return response as Record<string, unknown>;
  }
  return { result: response };
}

function toGeminiParts(content: string | unknown[]): any[] {
  if (typeof content === 'string') return [{ text: content }];
  return (content as any[]).map((block) => {
    if (block.type === 'text') return { text: block.text };
    if (block.type === 'tool_use') {
      const part: Record<string, unknown> = { functionCall: { name: block.name, args: block.input ?? {} } };
      // gemini-flash-lite-latest requires the thoughtSignature it attached to a
      // functionCall to be echoed back on the next turn — omitting it fails with
      // "Function call is missing a thought_signature" (2026-09-04).
      if (block.thoughtSignature) part.thoughtSignature = block.thoughtSignature;
      return part;
    }
    if (block.type === 'tool_result') {
      const name = String(block.tool_use_id).split('::')[0];
      let response: unknown;
      try {
        response = JSON.parse(block.content);
      } catch {
        response = { result: block.content };
      }
      // Gemini's functionResponse.response is a protobuf Struct: the top
      // level must be an object. Several real tools legitimately return an
      // array (check_stock is the first live example), so wrap non-object
      // results without changing what the model can read.
      return { functionResponse: { name, response: normalizeGeminiFunctionResponse(response) } };
    }
    throw new Error(`unrecognized content block type: ${block.type}`);
  });
}

/**
 * One call to the model. No retries, no budget checks, no multi-provider
 * routing — deliberately bare. Add those later, IN THIS FILE ONLY, the day
 * you actually need them.
 */
export async function callModel(
  system: string,
  messages: ModelMessage[],
  tools: ToolDef[],
): Promise<CallModelResult> {
  const config = readGeminiConfig();
  const apiKey = config.apiKey;
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY not set — export it before running the server.');
  }

  const reservation = reserveAiModelCall({ model: config.model });

  const body: Record<string, unknown> = {
    system_instruction: { parts: [{ text: system }] },
    contents: messages.map((m) => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: toGeminiParts(m.content),
    })),
  };
  if (tools.length > 0) {
    body.tools = [
      {
        functionDeclarations: tools.map((t) => ({
          name: t.name,
          description: t.description,
          parameters: t.input_schema,
        })),
      },
    ];
  }

  let finished = false;
  try {
    // The key travels only in the x-goog-api-key header — never in the URL,
    // where proxies, access logs and error messages could capture it. The
    // abort signal bounds the whole exchange, including reading the body.
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(config.model)}:generateContent`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(config.timeoutMs),
      },
    );

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`LLM call failed (${response.status}): ${redactKey(text, apiKey).slice(0, 300)}`);
    }

    const data = (await response.json()) as any;
    const usage = data.usageMetadata ?? {};
    finishAiModelCall({
      id: reservation.id,
      status: 'succeeded',
      promptTokens: usage.promptTokenCount,
      outputTokens: usage.candidatesTokenCount,
      totalTokens: usage.totalTokenCount,
    });
    finished = true;
    const parts: any[] = data.candidates?.[0]?.content?.parts ?? [];

    const content = parts.map((p, i) => {
      if (p.functionCall) {
        return {
          type: 'tool_use',
          id: `${p.functionCall.name}::${i}`,
          name: p.functionCall.name,
          input: p.functionCall.args ?? {},
          thoughtSignature: p.thoughtSignature,
        };
      }
      return { type: 'text', text: p.text ?? '' };
    });

    return {
      content,
      stop_reason: content.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end_turn',
    };
  } catch (error) {
    // Timeouts, network errors and non-OK responses all close the reserved
    // call as a failure, exactly once — the allowance is still consumed.
    if (!finished) finishAiModelCall({ id: reservation.id, status: 'failed' });
    if (isAbortTimeout(error)) {
      throw new Error(
        `LLM call timed out after ${config.timeoutMs}ms — the provider did not answer in time; ` +
          'treat this turn as failed (raise GEMINI_TIMEOUT_MS only if this keeps happening).',
      );
    }
    if (error instanceof Error && error.message.includes(apiKey)) {
      throw new Error(redactKey(error.message, apiKey));
    }
    throw error;
  }
}
