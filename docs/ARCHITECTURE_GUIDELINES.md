# Architecture Guidelines & Engineering Standards

This document defines the architectural principles, domain boundaries, and coding standards for the single-tenant WhatsApp sales assistant and business operational intelligence engine.

---

## 1. Project Domain & Scope

A WhatsApp-based AI sales assistant and operational partner for **one single-owner retail shop** ("Ahmed," who sells clothing in Pakistan). It replies to customers instantly in natural Roman Urdu and English, remembers customer context across sessions, maintains an audit-grade double-entry ledger of orders and payments, and provides real-time private business analytics to the owner over WhatsApp.

It is **not** a generic multi-tenant CRM, not built for large enterprise teams, and not modeled on complex B2B sales funnels. There is exactly one business, one WhatsApp number, one owner, and no staff. Every architectural decision is evaluated against this reality.

---

## 2. Core Architectural Conventions

These conventions apply to every module across the codebase:

1. **Single AI Seam (`src/llm.ts`)**:
   Every AI model call goes strictly through one provider function (`callModel`). Never call an AI SDK or a raw fetch endpoint from business logic or tools. This makes swapping providers, monitoring costs, or changing models a single-file change.

2. **Tool-Gated Outbound Communications**:
   Sending a message to a customer is always a deliberate, gated tool call (`send_message`)—never a side effect of raw model text. The model's plain-text output is discarded; only an explicit tool invocation reaches the customer.

3. **Strict Server-Side Validation**:
   Tool input is validated strictly on the server side, even though the JSON schemas exposed to the model can be flexible. Validate shape, type, ranges, and existence before touching the database or business logic.

4. **Teaching-Text Errors (Self-Healing Mid-Turn)**:
   A failed tool call returns structured, model-readable text, never a thrown exception that crashes the turn.
   Format: `{ ok: false, error: "short, plain-language, actionable sentence" }`.
   This allows the LLM to read the failure reason and self-correct within the turn.

5. **Double-Entry Financial Ledger (Dynamic Balance Derivation)**:
   A customer's balance is never stored as a mutable single number that could drift out of sync. Balances are derived dynamically by summing the `ledger` table ($\sum\text{debits} - \sum\text{credits}$).

6. **Forward-Only Finite State Machine (FSM)**:
   Orders only move forward (`placed → confirmed → paid → shipped → delivered`), with cancellations permitted only before shipping. Invalid transitions are rejected with teaching-text guidance.

7. **Anti-Ban Concurrency Serialization (`withSendLock`)**:
   All outbound dispatches pass through an in-process promise-chain mutex ensuring that throttle gaps, daily caps, and warm-up curves are strictly enforced under concurrent load.

8. **Fail-Closed Security**:
   Owner authentication (`src/owner.ts`) is strictly fail-closed. If `AHMED_OWNER_PHONE` is not explicitly configured, owner mode is completely locked down.

9. **Structured Logging**:
   No raw `console.log` in production code. Use the structured logger (`src/obs/logger.ts`) for traceable, greppable operational telemetry.

10. **Strict TypeScript**:
    Strict mode is permanently enabled (`tsconfig.json`). Relative imports with no file extensions (`from './tools'`).

---

## 3. Permanent Exclusions (Deliberate Architectural Decisions)

These are standing architectural decisions, not deferred work. They solve enterprise multi-tenant problems that this single-owner project intentionally avoids:

* **Multi-tenancy / Organization Scoping**: Zero `organization_id` columns. The whole database belongs to one merchant.
* **B2B Sales Funnel Vocabularies**: Permanently excluded. Uses retail order lifecycle (`placed → confirmed → paid → shipped → delivered`) instead of enterprise funnel stages (`lead → qualifying → opportunity → won/lost`).
* **Role-Based Access Control & Rotating Queues**: "Handoff to human" always routes directly to Ahmed's WhatsApp number.
* **Dual-Agent Split (Operator/Conversador)**: Single unified agent with caller-ID segregation for owner vs. customer turns.
* **Speculative Complexity**: Infrastructure is built strictly in response to verified commercial requirements.

---

## 4. Object-Oriented Domain Models & Abstractions

While the runtime engine is asynchronous and event-driven, core domain entities and infrastructure gateways follow disciplined Object-Oriented Programming (OOP) patterns:

1. **`OrderStateMachine` (`src/orders.ts`)**:
   - **Encapsulation**: Private state fields (`_status`, `_orderId`, `_history`), controlled access via getters, and strict transition methods.
   - **Invariant Enforcement**: Rejects invalid state transitions and out-of-order mutations before database writes occur.
   - **Audit Trail**: Maintains an immutable in-memory log of every transition event (`{ from, to, timestamp }`).

2. **`LedgerAccount` (`src/ledger.ts`)**:
   - **Domain Modeling**: Encapsulates double-entry bookkeeping rules for individual customer accounts.
   - **Invariant Enforcement**: Requires strictly positive debit/credit amounts; disallows mutable balance overrides.
   - **Dynamic Derivation**: Computes customer balances on-the-fly from the underlying immutable transaction stream.

3. **`WahaAdapter implements ChannelAdapter` (`src/channel/waha.ts`)**:
   - **Polymorphism & Abstraction**: Implements the provider-agnostic `ChannelAdapter` interface (`sendText`, `parseInboundWebhook`).
   - **Dependency Injection**: Constructor accepts custom configuration options (`baseUrl`, `session`, `apiKey`), making testing, local mocking, and multi-gateway deployment straightforward.
