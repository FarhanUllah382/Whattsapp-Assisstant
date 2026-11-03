// Which language a fixed server text should use, from the customer's latest
// message. Deliberately a simple word heuristic, no LLM: Roman Urdu function
// words vs English function words. Domain words customers use in both
// ("price", "order", "discount", "size") are not counted. When the signal is
// weak or ambiguous the answer is 'mixed', and callers send English + Roman
// Urdu together — the bilingual fallback that was already live.
//
// Live evidence (2026-11-02): "Koi discount hn iss pa ?" got an English-only
// handoff confirmation.

export type CustomerLanguage = 'en' | 'roman_ur' | 'mixed';

const ROMAN_URDU_WORDS: ReadonlySet<string> = new Set([
  'hai', 'hain', 'hn', 'hy', 'hay', 'kya', 'kia', 'koi', 'kuch', 'kuchh', 'iss', 'uss', 'isko', 'usko',
  'pa', 'pe', 'mein', 'mai', 'mujhe', 'mujhy', 'mjhe', 'mera', 'meri', 'mere', 'aap', 'ap', 'aapka',
  'apka', 'aapki', 'apki', 'aapko', 'apko', 'aapke', 'apke', 'tum', 'tumhara', 'nahi', 'nahin', 'nhi',
  'nai', 'kar', 'karo', 'karein', 'karen', 'karna', 'krna', 'kr', 'krdo', 'kardo', 'karunga', 'karungi',
  'chahiye', 'chahye', 'chaiye', 'chahta', 'chahti', 'kitna', 'kitne', 'kitni', 'ka', 'ki', 'ke', 'ko',
  'se', 'bhai', 'yaar', 'yar', 'theek', 'thik', 'acha', 'achha', 'accha', 'haan', 'han', 'ji', 'jee',
  'wala', 'wali', 'wale', 'kab', 'kaise', 'kese', 'kahan', 'kyun', 'kyu', 'abhi', 'dena', 'dein', 'dain',
  'do', 'bata', 'batao', 'btao', 'bataen', 'raha', 'rahi', 'rahe', 'tha', 'thi', 'hum', 'ham', 'bohat',
  'bahut', 'bht', 'sasta', 'mehnga', 'paisay', 'paise', 'rupay', 'wapas', 'jaldi', 'kal', 'aaj', 'agar',
  'lekin', 'magar', 'aur', 'sab', 'sirf', 'zara', 'hoga', 'hogi', 'milega', 'milegi', 'sakta', 'sakti',
  'dekho', 'dikhao', 'bhejo', 'bhej', 'lena', 'liye', 'liya', 'diya', 'diye', 'gaya', 'gayi', 'wo', 'woh',
  'yeh', 'ye', 'unka', 'inka', 'jo', 'toh', 'na', 'warna', 'thora', 'thoda', 'zyada', 'kam', 'kum',
  'shukriya', 'salam', 'assalam', 'walaikum', 'maine', 'apne', 'apna', 'apni', 'karao', 'baat',
]);

// 'do' is both; it is counted as Roman Urdu only ("discount do"), English
// questions carry enough other function words to win anyway.
const ENGLISH_WORDS: ReadonlySet<string> = new Set([
  'the', 'is', 'are', 'am', 'was', 'were', 'i', 'you', 'your', 'my', 'me', 'we', 'it', 'this', 'that',
  'there', 'any', 'does', 'have', 'has', 'had', 'can', 'could', 'would', 'will', 'please', 'what',
  'how', 'much', 'many', 'want', 'need', 'of', 'on', 'for', 'to', 'in', 'with', 'and', 'or', 'not',
  'yes', 'hello', 'hi', 'thanks', 'thank', 'an', 'get', 'when', 'where', 'why', 'which', 'u', 'it\'s',
  'i\'m', 'don\'t', 'did', 'be', 'from', 'at', 'about', 'still', 'already',
]);

const URDU_SCRIPT = /[؀-ۿ]/u;

export function detectCustomerLanguage(text: unknown): CustomerLanguage {
  if (typeof text !== 'string' || text.trim() === '') return 'mixed';
  // Urdu-script customers get the bilingual text (English + Roman Urdu) —
  // the safe "unsure" answer until an Urdu-script variant is approved.
  if (URDU_SCRIPT.test(text)) return 'mixed';
  const words = text.toLowerCase().match(/[a-z']+/g) ?? [];
  let romanUrdu = 0;
  let english = 0;
  for (const word of words) {
    if (ROMAN_URDU_WORDS.has(word)) romanUrdu += 1;
    else if (ENGLISH_WORDS.has(word)) english += 1;
  }
  if (romanUrdu >= 2 && romanUrdu > english) return 'roman_ur';
  if (english >= 2 && english > romanUrdu * 2) return 'en';
  return 'mixed';
}

/** Pick the variant for a language; 'mixed' sends English then Roman Urdu. */
export function localizedText(variants: { en: string; roman_ur: string }, language: CustomerLanguage): string {
  if (language === 'en') return variants.en;
  if (language === 'roman_ur') return variants.roman_ur;
  return `${variants.en}\n\n${variants.roman_ur}`;
}

/** All three renderings of a fixed text, for exact-text exemptions in guards. */
export function allLocalizedTexts(variants: { en: string; roman_ur: string }): string[] {
  return (['en', 'roman_ur', 'mixed'] as const).map((language) => localizedText(variants, language));
}
