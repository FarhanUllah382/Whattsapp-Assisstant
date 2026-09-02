// The shapes that flow through the system. Kept intentionally small —
// the big reference system has ~15 of these; you need about 4.

export interface Customer {
  id: number;
  phone: string;
  name: string | null;
  balance_owed: number;
}

export interface StoredMessage {
  id: number;
  customer_id: number;
  direction: 'inbound' | 'outbound';
  body: string;
  created_at: string;
}

export interface Checkpoint {
  customer_id: number;
  summary: string;
  updated_at: string;
}

// A "tool" the AI can call. Mirrors the shape of Anthropic's tool-use API
// almost exactly, plus our own `execute` so the tool is self-contained.
export interface ToolDef {
  name: string;
  description: string;
  input_schema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
  // Runs the tool against our database and returns whatever the AI should see.
  execute: (input: any, ctx: { customerId: number }) => Promise<unknown> | unknown;
}
