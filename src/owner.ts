// Version 3.1: sender-identity check for Ahmed himself, as distinct from
// any customer. Modeled on the restricted-turn-kind CONCEPT proven by
// DeskcommCRM's operator-turn.ts (a turn kind with restricted permissions)
// — not the Operator/Conversador dual-agent-role SPLIT itself, which is a
// permanent exclusion (CLAUDE.md §6). operator-turn.ts didn't qualify for
// extraction anyway (DB-coupled); this is a from-scratch reimplementation
// of just the "is this sender special, and if so route differently" idea.

// Fail-closed by design: if AHMED_OWNER_PHONE isn't configured, NO phone
// number is ever recognized as the owner — matches this project's existing
// fail-closed convention elsewhere (e.g. warmupCapFor in pacing/engine.ts
// treats an unknown number's age as 0, the most conservative step, never
// "no cap"). An unconfigured owner number must never accidentally let every
// message start behaving like it came from Ahmed. Read once at module load,
// same idiom as PACING_DEFAULTS (pacing/defaults.ts) — real callers (server.ts)
// never pass the second argument below, only tests do.
export const AHMED_OWNER_PHONE = process.env.AHMED_OWNER_PHONE;

// Same normalization WAHA's own adapter already applies to every inbound
// phone (src/channel/waha.ts's phoneFromChatId: digits only, no "+", no
// spaces) — comparing on the same normalized shape so a "+" or formatting
// difference in how the env var happens to be set doesn't silently break
// recognition.
function normalizePhone(phone: string): string {
  return phone.replace(/\D/g, '');
}

/**
 * True only if `phone` (already the digits-only shape every channel adapter
 * produces) is Ahmed's own configured number. `ownerPhone` defaults to the
 * real env-sourced constant — only tests override it, to check both the
 * "configured" and "unconfigured" (fail-closed) cases without env-var
 * gymnastics or module-cache concerns.
 */
export function isOwnerPhone(phone: string, ownerPhone: string | undefined = AHMED_OWNER_PHONE): boolean {
  if (!ownerPhone) return false;
  const normalizedOwner = normalizePhone(ownerPhone);
  if (normalizedOwner === '') return false;
  return normalizePhone(phone) === normalizedOwner;
}
