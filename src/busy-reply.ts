export interface BusyReplyConfig {
  cooldownMinutes: number;
}

export const BUSY_REPLY_DEFAULTS: BusyReplyConfig = {
  cooldownMinutes: 10,
};

export const TEMPORARILY_BUSY_REPLY =
  "Sorry, we're receiving many messages right now. Please try again in a few minutes.\n\n" +
  'Maazrat, abhi messages zyada hain. Kuch minutes baad dobara message karein.';

export const AI_BUDGET_DEFERRED_REPLY =
  'Your message is saved and has not been lost. Today’s automated-assistant capacity is finished. ' +
  'It will retry automatically after 12:00 AM Pakistan time, usually within the following hour. Please do not resend it.\n\n' +
  'Aapka message save hai aur lost nahi hua. Aaj ki automated-assistant capacity khatam ho gayi hai. ' +
  'Pakistan time raat 12 baje ke baad system khud dobara try karega, aam tor par aglay ek ghantay mein. Please message dobara na bhejein.';

function boundedInteger(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  if (value === undefined || value.trim() === '') return fallback;
  if (!/^\d+$/.test(value.trim())) return fallback;
  const parsed = Number(value.trim());
  return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum
    ? parsed
    : fallback;
}

/** Invalid configuration stays finite and cannot disable repeat suppression. */
export function readBusyReplyConfig(
  env: NodeJS.ProcessEnv = process.env,
): BusyReplyConfig {
  return {
    cooldownMinutes: boundedInteger(
      env.BUSY_REPLY_COOLDOWN_MINUTES,
      BUSY_REPLY_DEFAULTS.cooldownMinutes,
      1,
      1_440,
    ),
  };
}
