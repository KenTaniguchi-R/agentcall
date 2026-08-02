// A deliberately small, deterministic lexical ranker. It runs entirely on the
// caller's machine — the query text never reaches the relay — and its output
// is consumed by an LLM, which does the final semantic pick. That division is
// why this does not need embeddings: the expensive judgment already has a
// model attached, so this only has to be a good, honest prefilter.

export type SearchField = "keywords" | "name" | "description";

// Weighted highest first. `examples` are absent because the roster bundle
// does not carry them (see BundleTask in packages/shared/src/roster.ts).
const WEIGHTS: Record<SearchField, number> = { keywords: 3, name: 2, description: 1 };
const FIELDS: SearchField[] = ["keywords", "name", "description"];

// Small and closed on purpose. Every entry is a word that carries no topical
// signal in a question; adding domain words here would silently suppress real
// matches, so this list should stay boring.
const STOPWORDS = new Set([
  "a", "about", "an", "and", "any", "are", "as", "at", "be", "but", "by", "can", "did", "do",
  "does", "for", "from", "get", "has", "have", "how", "i", "if", "in", "is", "it", "its", "me",
  "my", "of", "on", "or", "our", "should", "so", "than", "that", "the", "their", "them", "then",
  "there", "these", "they", "this", "to", "up", "us", "was", "we", "were", "what", "when",
  "where", "which", "who", "why", "will", "with", "would", "you", "your",
]);

export function tokenize(text: string): string[] {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length > 0 && !STOPWORDS.has(t));
}

export interface SearchEntry {
  roster: string;
  handle: string;
  address: string;
  task: string;
  name: string;
  description: string;
  keywords: string[];
  // True when this member had more tasks than the bundle indexes. Carried so
  // the renderer can say so — the bundle never truncates silently.
  truncated?: boolean;
}

export interface Match {
  term: string;
  fields: SearchField[];
}

export interface SearchResult extends SearchEntry {
  score: number;
  matched: Match[];
}

export const DEFAULT_SEARCH_LIMIT = 5;

// Plain codepoint comparison rather than localeCompare: tie-break order must
// be identical on every machine, and localeCompare is locale-dependent.
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

export function rank(query: string, entries: SearchEntry[], limit = DEFAULT_SEARCH_LIMIT): SearchResult[] {
  // Deduped, so repeating a word in the question cannot skew the ranking.
  const terms = [...new Set(tokenize(query))];
  if (terms.length === 0) return [];

  const scored: SearchResult[] = [];
  for (const e of entries) {
    const tokens: Record<SearchField, Set<string>> = {
      keywords: new Set(e.keywords.flatMap(tokenize)),
      name: new Set(tokenize(e.name)),
      description: new Set(tokenize(e.description)),
    };
    let score = 0;
    const matched: Match[] = [];
    for (const term of terms) {
      // Presence per field, never count: a card cannot climb by repeating a
      // term. Accumulating the same term across fields IS intended — a word
      // in both the keywords and the description is corroborating evidence.
      const fields = FIELDS.filter((f) => tokens[f].has(term));
      if (fields.length === 0) continue;
      for (const f of fields) score += WEIGHTS[f];
      matched.push({ term, fields });
    }
    if (score > 0) scored.push({ ...e, score, matched });
  }

  scored.sort(
    (a, b) => b.score - a.score || cmp(a.handle, b.handle) || cmp(a.task, b.task),
  );
  return scored.slice(0, limit);
}
