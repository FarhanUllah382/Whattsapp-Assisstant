// Detects when an outgoing message promises Ahmed/a human will personally
// follow up — e.g. "I'll check with Ahmed and confirm", "malik se pooch ke
// batata hoon", "owner will call you back". Same shape as the DeskcommCRM
// detector this was adapted from (EXTRACTED-FOR-AHMED/guardrails/human-
// promise.ts): regex-only, no LLM, deliberately conservative — on doubt
// between missing a real promise and a false positive, it favors catching
// the promise, because agent.ts refuses to send a caught one unless a real
// handoff was actually logged (see hasRecentHandoff there).
//
// Rewritten for this project (2026-09-02), not moved verbatim: the original
// patterns were Portuguese-only (a documented content flag in
// EXTRACTED-FOR-AHMED/MANIFEST.md). Ahmed's customers write in English and
// Roman Urdu/Hindi-English, per his own spec examples, so this version
// targets that mix instead. The original file stays staged as-is — only the
// detector *shape* was reused, same treatment as channel-adapter.ts got.
//
// Calibrated by hand against plausible phrasing, NOT against real customer
// transcripts — none exist yet, the WhatsApp connection isn't live-verified
// (see PROJECT-TRACKER-FINAL.md 1.3). Revisit once real conversations are
// available, the same way the original file was refined over several waves.

const TARGET =
  '(?:ahmed(?:\\s*(?:sahab|bhai))?|owner|boss|malik|manager|the\\s*team|our\\s*team|staff|shop\\s*(?:wale|walo)?|store)';

// Short gap that doesn't cross a sentence boundary — prevents matching a
// verb from one sentence against a target from an unrelated one.
function gap(n: number): string {
  return `[^.!?\\n]{0,${n}}?`;
}

const PATTERNS: readonly RegExp[] = [
  // "forward/escalate/pass/check/confirm/ask/verify (this) to/with Ahmed/owner/team"
  new RegExp(
    `\\b(?:forward|escalat|pass|check|confirm|ask|verify|consult)\\w*${gap(20)}\\b(?:to|with)\\b${gap(10)}\\b${TARGET}\\b`,
    'i',
  ),
  // Roman Urdu: "ahmed/malik/owner se pooch ke", "team se confirm kar ke"
  new RegExp(`\\b${TARGET}\\b${gap(10)}\\bse\\b${gap(15)}\\b(?:pooch|puch|check|confirm)\\w*`, 'i'),
  // "Ahmed/owner/team will confirm/check/call/reply/get back/verify/approve"
  new RegExp(
    `\\b${TARGET}\\b${gap(20)}\\b(?:will|would)\\b${gap(15)}` +
      `(?:confirm|check|call|reply|respond|let\\s*you\\s*know|get\\s*back|verify|approve)\\w*`,
    'i',
  ),
  // Roman Urdu: "ahmed/malik/team batayenge/batayega/karenge/karega/bolega"
  new RegExp(`\\b${TARGET}\\b${gap(20)}\\b(?:batayen?g[ae]|karen?g[ae]|bolen?g[ae])\\b`, 'i'),
  // "I'll / we'll check with/ask/tell Ahmed/owner/team"
  new RegExp(`\\b(?:i'?ll|we'?ll|i\\s*will|we\\s*will)\\b${gap(15)}\\b${TARGET}\\b`, 'i'),
];

/** True if the text promises a human (Ahmed/owner/team/staff) will personally follow up. */
export function detectHumanPromise(body: string): boolean {
  if (body.trim() === '') return false;
  return PATTERNS.some((re) => re.test(body));
}
