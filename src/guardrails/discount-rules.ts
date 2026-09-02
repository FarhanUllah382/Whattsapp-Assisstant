// Simple, explicit discount rule check — no LLM, deterministic regex, same
// conservative-by-design shape as human-promise.ts. The threshold below is
// NOT invented: Ahmed confirmed it directly (2026-09-02, see
// PROJECT-TRACKER-FINAL.md 1.4) — discounts at or above 5% require his
// confirmation before being offered; anything below 5% the bot can mention
// freely. If the real rule ever changes, update the constant, don't
// reinterpret it.

export const MAX_DISCOUNT_PERCENT_WITHOUT_CONFIRMATION = 5;

// Short gap that doesn't cross a sentence boundary — same discipline as
// human-promise.ts's `gap()` — avoids matching a stray percentage from one
// sentence against a discount word from an unrelated one (e.g. "80% cotton.
// We do 3% off for bulk orders" shouldn't let "80%" pair with "off").
function gap(n: number): string {
  return `[^.!?\\n]{0,${n}}?`;
}

const DISCOUNT_WORD = '(?:off|discount|sale|deal|rebate|reduction|kam|sasta|chhoot|chhut)';

// Number can come before or after the discount word: "10% off", "off ...
// 10%", "10% discount", "discount ... 10%", "10% kam", "10% chhoot".
const PATTERNS: readonly RegExp[] = [
  new RegExp(`\\b(\\d{1,3})\\s*%${gap(15)}\\b${DISCOUNT_WORD}\\b`, 'i'),
  new RegExp(`\\b${DISCOUNT_WORD}\\b${gap(15)}\\b(\\d{1,3})\\s*%`, 'i'),
];

export interface DiscountCheckResult {
  ok: boolean;
  percent?: number;
  reason?: string;
}

/** Blocks (ok:false) if the text offers a discount at/above the confirmed threshold. */
export function checkDiscountRule(body: string): DiscountCheckResult {
  for (const re of PATTERNS) {
    const match = re.exec(body);
    if (!match) continue;
    const percent = Number(match[1]);
    if (Number.isFinite(percent) && percent >= MAX_DISCOUNT_PERCENT_WITHOUT_CONFIRMATION) {
      return {
        ok: false,
        percent,
        reason:
          `You offered a ${percent}% discount, which is at or above Ahmed's ` +
          `${MAX_DISCOUNT_PERCENT_WITHOUT_CONFIRMATION}% confirmation threshold. Do not send this — ` +
          `either drop the discount, or tell the customer you'll confirm with Ahmed first ` +
          '(and actually call notify_owner if you do).',
      };
    }
  }
  return { ok: true };
}
