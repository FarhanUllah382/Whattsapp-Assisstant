export type TestTarget = {
  file: string;
  securityAreas: readonly string[];
  includeInSecurityRegression: boolean;
};

export const allTestTargets: readonly TestTarget[] = [
  {
    file: 'tests/test-isolation.test.ts',
    securityAreas: ['test database isolation'],
    includeInSecurityRegression: true,
  },
  {
    file: 'tests/security-manifest.test.ts',
    securityAreas: ['security regression coverage'],
    includeInSecurityRegression: true,
  },
  {
    file: 'tests/index.ts',
    securityAreas: [
      'order state authorization',
      'server pricing and payment integrity',
      'webhook replay protection',
      'explicit order confirmation',
      'consent enforcement',
    ],
    includeInSecurityRegression: true,
  },
  {
    file: 'tests/pacing-activation.test.ts',
    securityAreas: ['consent and anti-ban pacing'],
    includeInSecurityRegression: true,
  },
  {
    file: 'tests/alerts.test.ts',
    securityAreas: ['owner alert durability'],
    includeInSecurityRegression: true,
  },
  {
    file: 'tests/owner-alert-flood.test.ts',
    securityAreas: ['owner alert flood protection'],
    includeInSecurityRegression: true,
  },
  {
    file: 'tests/busy-reply.test.ts',
    securityAreas: ['abuse cooldown response'],
    includeInSecurityRegression: true,
  },
  {
    file: 'tests/webhook-auth.test.ts',
    securityAreas: ['webhook authenticity and tamper rejection'],
    includeInSecurityRegression: true,
  },
  {
    file: 'tests/payment-instructions.test.ts',
    securityAreas: ['payment destination authorization'],
    includeInSecurityRegression: true,
  },
  {
    file: 'tests/payment-claims.test.ts',
    securityAreas: [
      'payment claim necessity and duplicate prevention',
      'unconfigured payment method disclosure',
    ],
    includeInSecurityRegression: true,
  },
  {
    file: 'tests/payment-resolution.test.ts',
    securityAreas: ['reference-bound deterministic payment resolution and reversal'],
    includeInSecurityRegression: true,
  },
  {
    file: 'tests/handoff-claims.test.ts',
    securityAreas: ['owner handoff truthfulness'],
    includeInSecurityRegression: true,
  },
  {
    file: 'tests/order-access.test.ts',
    securityAreas: ['customer and order identity isolation'],
    includeInSecurityRegression: true,
  },
  {
    file: 'tests/privacy.test.ts',
    securityAreas: ['PII minimization and log redaction'],
    includeInSecurityRegression: true,
  },
  {
    file: 'tests/pii-extraction.test.ts',
    securityAreas: ['PII extraction resistance'],
    includeInSecurityRegression: true,
  },
  {
    file: 'tests/inventory-visibility.test.ts',
    securityAreas: ['inventory confidentiality'],
    includeInSecurityRegression: true,
  },
  {
    file: 'tests/product-media.test.ts',
    securityAreas: ['approved product media authorization'],
    includeInSecurityRegression: true,
  },
  {
    file: 'tests/fulfilment-commands.test.ts',
    securityAreas: ['order state authorization', 'owner-only deterministic fulfilment commands'],
    includeInSecurityRegression: true,
  },
  {
    file: 'tests/refunds.test.ts',
    securityAreas: ['refund ownership and authorization'],
    includeInSecurityRegression: true,
  },
  {
    file: 'tests/business-grounding.test.ts',
    securityAreas: ['grounded product and policy answers'],
    includeInSecurityRegression: true,
  },
  {
    file: 'tests/abuse-control.test.ts',
    securityAreas: ['inbound abuse limits'],
    includeInSecurityRegression: true,
  },
  {
    file: 'tests/ai-budget.test.ts',
    securityAreas: ['AI cost limits'],
    includeInSecurityRegression: true,
  },
  {
    file: 'tests/inbound-jobs.test.ts',
    securityAreas: ['durable queue and restart recovery'],
    includeInSecurityRegression: true,
  },
  {
    file: 'tests/multi-turn-adversarial.test.ts',
    securityAreas: ['multi-turn adversarial state resistance'],
    includeInSecurityRegression: true,
  },
  {
    file: 'tests/sensitive-action-wording.test.ts',
    securityAreas: ['sensitive action truthfulness'],
    includeInSecurityRegression: true,
  },
  {
    file: 'tests/adversarial-inputs.test.ts',
    securityAreas: ['adversarial input and query safety'],
    includeInSecurityRegression: true,
  },
  {
    file: 'tests/indirect-injection.test.ts',
    securityAreas: ['indirect prompt injection and output disclosure'],
    includeInSecurityRegression: true,
  },
  {
    file: 'tests/outbound-delivery.test.ts',
    securityAreas: ['outbound idempotency and uncertain delivery'],
    includeInSecurityRegression: true,
  },
  {
    file: 'tests/whatsapp-down.test.ts',
    securityAreas: ['WhatsApp session outage deferral and owner-alert retry cap'],
    includeInSecurityRegression: true,
  },
  {
    file: 'tests/llm-reliability.test.ts',
    securityAreas: [
      'provider timeouts and API key confidentiality',
      'outbound idempotency and uncertain delivery',
    ],
    includeInSecurityRegression: true,
  },
  {
    file: 'tests/silent-reply.test.ts',
    securityAreas: [
      'no silent customer no-reply',
      'inventory count privacy',
    ],
    includeInSecurityRegression: true,
  },
  {
    file: 'tests/wording-language.test.ts',
    securityAreas: [
      'owner handoff truthfulness',
      'customer language and outbound formatting',
      'discount policy before handoff',
    ],
    includeInSecurityRegression: true,
  },
  {
    file: 'tests/operations.test.ts',
    securityAreas: ['health monitoring and verified recovery backups'],
    includeInSecurityRegression: true,
  },
  {
    file: 'tests/observability.test.ts',
    securityAreas: [
      'observability metrics access fails closed',
      'trace and metric PII exclusion',
    ],
    includeInSecurityRegression: true,
  },
  {
    file: 'tests/live-verify.test.ts',
    securityAreas: ['read-only live acceptance verification and evidence redaction'],
    includeInSecurityRegression: true,
  },
  {
    file: 'tests/order-drafts.test.ts',
    securityAreas: [
      'order draft expiry and supersede lifecycle',
      'deterministic order summary integrity',
      'explicit order confirmation',
    ],
    includeInSecurityRegression: true,
  },
  {
    file: 'tests/turn-cost.test.ts',
    securityAreas: [
      'model call and prompt token budget per customer turn',
      'order and payment safety net retained under cost gating',
    ],
    includeInSecurityRegression: true,
  },
  {
    file: 'tests/verifier-fixes.test.ts',
    securityAreas: [
      'planned handoff survives a holding reply',
      'complaint handoff not mistaken for a discount question',
      'payment claim duplicate and COD safety-net rules',
      'outbound text normalisation (emoji, zero-width)',
      'bounded channel-outage deferral and low-cardinality metrics',
    ],
    includeInSecurityRegression: true,
  },
  {
    file: 'tests/fix-round-2.test.ts',
    securityAreas: [
      'holding-only replies vetoed so the one visible reply is complete',
      'discount intent vs complaint handoff',
      'one payment told several ways makes one pending claim',
      'invisible format characters cannot dodge reply guards',
      'pacing-held replies alert as no_reply',
    ],
    includeInSecurityRegression: true,
  },
];

export const securityTestTargets = allTestTargets.filter(
  (target) => target.includeInSecurityRegression,
);
