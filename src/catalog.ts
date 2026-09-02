// Reads catalog.md and does simple keyword matching — no embeddings, no
// semantic search, on purpose (per this file's own scope: only build what's
// actually needed right now). Ahmed edits catalog.md directly; this module
// re-reads it on every search_catalog call, so there's no restart needed
// for a content change to take effect.
import fs from 'node:fs';
import path from 'node:path';

const CATALOG_PATH = path.join(__dirname, '..', 'catalog.md');

export interface CatalogSection {
  title: string;
  body: string;
}

// Grammatical filler only — domain words like "price"/"return"/"cost" are
// deliberately NOT in here, they're exactly what we want to match on.
const STOPWORDS = new Set([
  'the', 'is', 'are', 'you', 'your', 'what', 'do', 'does', 'have', 'has',
  'for', 'and', 'with', 'this', 'that', 'about', 'can', 'will', 'please',
  'how', 'much', 'of', 'to', 'in', 'on', 'a', 'an', 'i', 'we', 'us', 'it',
  'my', 'me', 'be', 'if', 'or', 'so', 'not',
]);

/** Splits the catalog into sections by `## ` headings. Text before the first heading is dropped. */
export function parseCatalog(text: string): CatalogSection[] {
  const sections: CatalogSection[] = [];
  const lines = text.split('\n');
  let current: CatalogSection | null = null;

  for (const line of lines) {
    const heading = /^##\s+(.+)/.exec(line);
    if (heading) {
      if (current) sections.push(current);
      current = { title: heading[1].trim(), body: '' };
    } else if (current) {
      current.body += line + '\n';
    }
  }
  if (current) sections.push(current);

  return sections.map((s) => ({ title: s.title, body: s.body.trim() }));
}

function keywordsOf(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 3 && !STOPWORDS.has(w));
}

// Title matches count for much more than body matches — a keyword that
// only shows up incidentally inside another section's body (e.g. "delivery"
// mentioned in passing inside the Return policy entry) shouldn't be able to
// outscore the section whose actual topic is "Delivery info".
const TITLE_MATCH_WEIGHT = 3;
const BODY_MATCH_WEIGHT = 1;

/** Returns the section whose title+body best matches the query's keywords, or null if none match at all. */
export function findBestMatch(sections: CatalogSection[], query: string): CatalogSection | null {
  const queryWords = keywordsOf(query);
  if (queryWords.length === 0) return null;

  let best: CatalogSection | null = null;
  let bestScore = 0;

  for (const section of sections) {
    const title = section.title.toLowerCase();
    const body = section.body.toLowerCase();
    const score = queryWords.reduce((n, w) => {
      if (title.includes(w)) return n + TITLE_MATCH_WEIGHT;
      if (body.includes(w)) return n + BODY_MATCH_WEIGHT;
      return n;
    }, 0);
    if (score > bestScore) {
      best = section;
      bestScore = score;
    }
  }

  return bestScore > 0 ? best : null;
}

export function loadCatalogSections(): CatalogSection[] {
  const text = fs.readFileSync(CATALOG_PATH, 'utf-8');
  return parseCatalog(text);
}
