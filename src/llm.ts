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

import type { ToolDef } from './types';

// Provider swapped to Gemini for local WAHA end-to-end testing (2026-09-02) —
// swap back to Anthropic before Version 1 is considered done. The exported
// shape (ModelMessage/CallModelResult, both Anthropic-flavored: content
// blocks + stop_reason) is unchanged, so agent.ts didn't need any edits —
// this function still does 100% of the translation on both sides, per the
// single-seam rule above.
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const MODEL = 'gemini-2.5-flash';

export interface ModelMessage {
  role: 'user' | 'assistant';
  content: string | unknown[]; // string for plain text, array for tool_use/tool_result blocks
}

export interface CallModelResult {
  // Anthropic's response content blocks: mix of {type:'text',...} and {type:'tool_use',...}
  content: any[];
  stop_reason: string;
}

function toGeminiParts(content: string | unknown[]): any[] {
  if (typeof content === 'string') return [{ text: content }];
  return (content as any[]).map((block) => {
    if (block.type === 'text') return { text: block.text };
    if (block.type === 'tool_use') {
      return { functionCall: { name: block.name, args: block.input ?? {} } };
    }
    if (block.type === 'tool_result') {
      const name = String(block.tool_use_id).split('::')[0];
      let response: unknown;
      try {
        response = JSON.parse(block.content);
      } catch {
        response = { result: block.content };
      }
      return { functionResponse: { name, response } };
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
  if (!GEMINI_API_KEY) {
    throw new Error('GEMINI_API_KEY not set — export it before running the server.');
  }

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

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${GEMINI_API_KEY}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    },
  );

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`LLM call failed (${response.status}): ${text.slice(0, 300)}`);
  }

  const data = (await response.json()) as any;
  const parts: any[] = data.candidates?.[0]?.content?.parts ?? [];

  const content = parts.map((p, i) => {
    if (p.functionCall) {
      return { type: 'tool_use', id: `${p.functionCall.name}::${i}`, name: p.functionCall.name, input: p.functionCall.args ?? {} };
    }
    return { type: 'text', text: p.text ?? '' };
  });

  return {
    content,
    stop_reason: content.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end_turn',
  };
}
