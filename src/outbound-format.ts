// One normalisation for every customer send_message body, applied before
// any guard, idempotency hash, spinning check or stored transcript sees it,
// so all of them see exactly the text the customer receives.
//
// Live evidence (2026-11-01/02): replies contained literal "\n\n" (the model
// escaped its own newlines) and emojis.
//
// - literal "\n" / "\r\n" escape sequences become real newlines;
// - every default-ignorable / format character (zero-width space, soft
//   hyphen, LRM/RLM, bidi controls, invisible operators, CGJ, variation
//   selectors, tags, BOM, ...) is removed, so a guard cannot be dodged with
//   "Jazz​Cash"; a ZWJ / VS16 inside an allowed emoji sequence is kept;
// - at most 2 consecutive newlines (one blank line), spaces trimmed at line
//   starts/ends and runs of spaces collapsed;
// - emojis are stripped unless ALLOW_EMOJI=true (exactly; anything else,
//   including unset, strips).

// Pictographs plus the joiners/modifiers that build composite emojis
// (variation selector, ZWJ, skin tones, regional-indicator flags, keycaps).
// ©, ® and ™ are Extended_Pictographic in Unicode but are ordinary text
// symbols without a variation selector ("Nike® shoes"), so they are kept.
// Each run becomes ONE space (never glues words: "you😊Kya" -> "you Kya");
// the whitespace pass below collapses and trims the spaces.
const EMOJI_RUN =
  /(?:(?![©®™])[\p{Extended_Pictographic}\u{1F1E6}-\u{1F1FF}\u{1F3FB}-\u{1F3FF}\u{FE0F}\u{20E3}\u{200D}]|[©®™]\u{FE0F})+/gu;

// Fix round 2: every default-ignorable code point and format (Cf) character
// is invisible on the wire and can split a guarded word ("Jazz<U+00AD>Cash",
// LRM, invisible separator, CGJ, variation selectors, tags, bidi controls).
// All are removed, except ZWJ (U+200D) and VS16 (U+FE0F) inside an allowed
// emoji sequence (ALLOW_EMOJI=true); when emojis are stripped they go too.
const INVISIBLE = /[\p{Default_Ignorable_Code_Point}\p{Cf}]/gu;
// An allowed emoji sequence: pictograph (+ VS16 / skin tone / keycap) joined by ZWJ.
const EMOJI_SEQUENCE =
  /\p{Extended_Pictographic}(?:\u{FE0F}|[\u{1F3FB}-\u{1F3FF}]|\u{20E3})*(?:\u{200D}\p{Extended_Pictographic}(?:\u{FE0F}|[\u{1F3FB}-\u{1F3FF}]|\u{20E3})*)*|[0-9#*]\u{FE0F}?\u{20E3}/gu;
const PROTECTED_JOINERS = /[\u{200D}\u{FE0F}]/u;

function stripInvisible(text: string): string {
  // Keep ZWJ/VS16 only within emoji sequences; strip everything else invisible.
  let out = '';
  let last = 0;
  for (const match of text.matchAll(EMOJI_SEQUENCE)) {
    const index = match.index ?? 0;
    out += text.slice(last, index).replace(INVISIBLE, '');
    out += PROTECTED_JOINERS.test(match[0])
      ? match[0].replace(/[\p{Default_Ignorable_Code_Point}\p{Cf}]/gu, (ch) => (PROTECTED_JOINERS.test(ch) ? ch : ''))
      : match[0];
    last = index + match[0].length;
  }
  return out + text.slice(last).replace(INVISIBLE, '');
}

export function emojisAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.ALLOW_EMOJI?.trim().toLowerCase() === 'true';
}

export function normalizeOutgoingBody(body: string, env: NodeJS.ProcessEnv = process.env): string {
  let text = body.replace(/\\r\\n|\\n|\\r/g, '\n').replace(/\r\n?/g, '\n');
  // Invisible characters first (ZWJ/VS16 survive only inside emoji
  // sequences), then — unless allowed — each emoji run, with its joiners,
  // becomes one space.
  text = stripInvisible(text);
  if (!emojisAllowed(env)) {
    text = text.replace(EMOJI_RUN, ' ');
  }
  return text
    .split('\n')
    .map((line) => line.replace(/[ \t]{2,}/g, ' ').replace(/^[ \t]+|[ \t]+$/g, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ── Holding messages (re-verifier finding, fix round 2, 2026-11-02) ──────
// "Ek minute, main dekhta hoon" promises a follow-up, but one inbound event
// may produce only ONE visible reply (send_ledger), so the real answer after
// it would be dropped as already_sent. The send guard `holding_message`
// therefore vetoes a body that is ONLY a holding/stalling message, so the
// model calls its tools first and sends one complete reply.
//
// A body is holding-only when it is short (≤ 12 words), contains a holding
// phrase, carries no substantive content (price / Rs / number, availability
// words, a question back to the customer), and nothing but filler words is
// left once the holding phrases are removed. "thoda wait karein, rider raste
// mein hai", "Please wait 2-3 din", "Hum dekhte hain" and "I will check with
// Ahmed" are therefore not holding-only.
const HOLDING_PHRASES: readonly RegExp[] = [
  /\b(?:ek|aik|1|one|just\s+a|give\s+me\s+a|wait\s+a)\s*(?:minute|min|mint|second|sec|lamha|lamhe|moment|moments)\b/giu,
  // first-person singular "I'm checking / I'll see" (hoon = I), not "hum dekhte hain"
  /\b(?:check|pata|maloom|confirm|dekh)\s*(?:kar|kr)?\s*(?:ke|kay|ky)?\s*(?:ta|ti|raha|rahi|rha|rhi|bata(?:ta|ti))?\s*(?:hoon|hun|hu|hon)\b/giu,
  /\b(?:dekht[aie]|dekh\s+rah[aie]|check\s+(?:kar|kr)(?:ta|ti)|pata\s+(?:kar|kr)(?:ta|ti)|maloom\s+(?:kar|kr)(?:ta|ti))\s*(?:hoon|hun|hu|hon)\b/giu,
  /\blet\s+me\s+(?:check|see|look|find|confirm|verify)\b/giu,
  /\b(?:hold\s+on|bear\s+with\s+me|please\s+wait(?:\s+while\s+i\s+(?:check|look|confirm|verify))?|checking(?:\s+(?:now|it|that|this|for\s+you))?)\b/giu,
  /\b(?:thora|thoda|zara|zra)\s+(?:wait|intezar|intizar|sabar|sabr)\b/giu,
  /\b(?:wait|intezar|intizar|ruk(?:ein|en|iye|o)?)\s*(?:karein|karen|kariye|kijiye|krein|kren|kro|karo)?\b/giu,
];
const HOLDING_FILLER = new Set([
  'a', 'an', 'the', 'and', 'aur', 'i', 'im', 'main', 'mein', 'mai', 'me', 'my', 'mera', 'meri',
  'you', 'your', 'yours', 'aap', 'ap', 'apka', 'aapka', 'apki', 'aapki', 'apke', 'aapke', 'ke', 'ka', 'ki', 'ko',
  'liye', 'liya', 'lie', 'for', 'that', 'this', 'it', 'its', 'is', 'yeh', 'ye', 'woh', 'wo', 'please', 'plz',
  'pls', 'ji', 'jee', 'sir', 'madam', 'maam', 'bhai', 'sahab', 'ok', 'okay', 'theek', 'thik', 'abhi', 'now',
  'just', 'zara', 'zra', 'thora', 'thoda', 'quickly', 'quick', 'jaldi', 'right', 'away', 'sure', 'haan',
  'han', 'order', 'status', 'stock', 'details', 'detail', 'availability', 'info', 'information', 'sab',
  'kuch', 'shukriya', 'thanks', 'thank', 'sorry', 'check', 'checking', 'karta', 'karti', 'kar', 'kr',
  'hoon', 'hun', 'hu', 'dekhta', 'dekhti', 'confirm', 'verify', 'look', 'into', 'on', 'with', 'while',
  'will', 'ill', 'let', 'wait', 'moment', 'minute', 'second', 'karein', 'karen', 'kariye', 'kijiye',
  'krein', 'kren', 'karo', 'kro',
]);
const HOLDING_SUBSTANCE =
  /\?|\d|\b(?:rs|pkr|rupees?|rupay|rupaye|price|qeemat|available|availability\s+hai|stock\s+mein|in\s+stock|out\s+of\s+stock|nahi\s+hai|nahin\s+hai|khatam|hai\s+ji|haan\s+ji|ji\s+haan)\b/iu;
const MAX_HOLDING_WORDS = 12;

/** True when the body is ONLY a holding / stalling message with no substance. */
export function isHoldingOnlyMessage(body: string): boolean {
  const words = body.match(/[\p{L}\p{N}']+/gu) ?? [];
  if (words.length === 0 || words.length > MAX_HOLDING_WORDS) return false;
  if (HOLDING_SUBSTANCE.test(body)) return false;
  let rest = body;
  let matched = false;
  for (const pattern of HOLDING_PHRASES) {
    rest = rest.replace(pattern, (m) => {
      if (m.trim() !== '') matched = true;
      return ' ';
    });
  }
  if (!matched) return false;
  const remaining = (rest.toLowerCase().match(/[\p{L}\p{N}']+/gu) ?? [])
    .map((w) => w.replace(/'/g, ''))
    .filter((w) => !HOLDING_FILLER.has(w));
  return remaining.length === 0;
}
