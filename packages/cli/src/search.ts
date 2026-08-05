// A deliberately small, deterministic lexical ranker. It runs entirely on the
// caller's machine — the query text never reaches the relay — and its output
// is consumed by an LLM, which does the final semantic pick. That division is
// why this does not need embeddings: the expensive judgment already has a
// model attached, so this only has to be a good, honest prefilter.
//
// This file must stay free of I/O — no fetch, no file read, no clock. That is
// what makes "the query never leaves your machine" true rather than aspirational;
// all network lives in searchRefresh.ts/api.ts instead.

import { formatAddress } from "@benree/agentcall-shared";
import type { BundleEntryType } from "@benree/agentcall-shared";

type SearchField = "keywords" | "name" | "description";

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

interface SearchResult extends SearchEntry {
  score: number;
  matched: Match[];
}

export const DEFAULT_SEARCH_LIMIT = 5;

// A result must clear this to be shown. With weights keywords:3, name:2,
// description:1, that means a curated hit (a keyword, or the task name)
// qualifies on its own, and two corroborating description terms qualify —
// but a SINGLE incidental word in prose does not.
//
// This exists because of a real over-firing case: a colleague whose CI task
// description merely mentioned "deploy" and "test" was routed for the
// queries "deploy the worker to production" and "fix the failing test",
// neither of which they can help with. One low-weight term in prose is not
// evidence, and a tool that answers those gets muted.
export const MIN_SCORE = 2;

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
    if (score >= MIN_SCORE) scored.push({ ...e, score, matched });
  }

  scored.sort(
    (a, b) => b.score - a.score || cmp(a.handle, b.handle) || cmp(a.task, b.task),
  );
  return scored.slice(0, limit);
}

// Callee-authored text lands on a caller's terminal, which is
// escape-injection surface — ESC/CSI sequences can clear the screen, retitle
// the window, or paint fake output over a real error. Same reasoning as
// MAX_DETAIL_LENGTH/sanitizeDetail in packages/shared/src/protocol.ts, and
// the same fix: control characters become a space rather than being
// dropped, so a stripped newline — a legitimate character in
// BundleTask.description — doesn't run two sentences together (e.g.
// "auth.\nAlso covers payroll." must not collapse into "auth.Also..."). A
// run of consecutive control characters (e.g. "\r\n") collapses to one
// space rather than two.
//
// Applied at RENDER time, not at parse time, so the cache stays faithful to
// what the relay actually served and matching runs on the real text.
export function sanitize(text: string, max = 200): string {
  const stripped = text.replace(/[\p{Cc}\p{Cf}]/gu, " ").replace(/ {2,}/g, " ");
  return stripped.length > max ? stripped.slice(0, max) : stripped;
}

export function toEntries(roster: string, org: string, entries: BundleEntryType[]): SearchEntry[] {
  return entries.flatMap((e) =>
    e.tasks.map((t) => ({
      roster,
      handle: e.handle,
      address: formatAddress(org, e.handle),
      task: t.id,
      name: t.name,
      description: t.description,
      keywords: t.keywords,
      truncated: e.truncated,
    })),
  );
}

export interface RosterStatus {
  name: string;
  ageSeconds: number;
  stale: boolean;
}

export function renderResults(results: SearchResult[], rosters: RosterStatus[]): string {
  const lines: string[] = [];
  for (const r of rosters) {
    if (r.stale) {
      lines.push(`warning: roster "${r.name}" is ${Math.round(r.ageSeconds / 60)}m stale (relay unreachable)`);
    }
  }
  if (results.length === 0) {
    // No fallback list, ever. A tool that guesses when it does not know gets
    // muted, and a muted tool finds nobody.
    lines.push(`no match in ${rosters.map((r) => `"${r.name}"`).join(", ") || "any roster"}`);
    return lines.join("\n");
  }
  // Disambiguate by roster only when more than one is in scope. With no
  // --roster, every joined roster merges into ONE ranking (scores are
  // absolute and comparable across rosters), and every address is
  // handle@<same relay> — this is the only way to tell which roster a
  // suggested colleague came from. The common single-roster case would
  // otherwise carry a redundant "[acme]" on every line.
  const showRoster = rosters.length > 1;
  for (const r of results) {
    lines.push(`${showRoster ? `[${r.roster}] ` : ""}${r.address}  ${sanitize(r.task, 64)}`);
    lines.push(`  ${sanitize(r.description, 200)}`);
    lines.push(
      `  matched: ${r.matched.map((m) => `${sanitize(m.term, 40)} (${m.fields.join(", ")})`).join(" · ")}`,
    );
    lines.push(`  agentcall call ${r.address} --task ${sanitize(r.task, 64)} "<message>"`);
    // No silent truncation: if the bundle dropped tasks for this member, say
    // so and point at the command that shows the full card.
    if (r.truncated) {
      lines.push(`  (more tasks not indexed — see: agentcall card ${r.address})`);
    }
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}

// True when the search ran against at least one joined roster but every
// single one failed to refresh (cold cache + unreachable relay, etc.) — the
// "no match" that follows is not a genuine no-results run, and a caller
// gating on exit code needs to be able to tell the difference. Partial
// failure (some rosters refreshed, some didn't) is deliberately NOT this
// case: real results reached the user, and the per-roster stale warnings in
// renderResults already say what happened — that stays exit 0.
export function allRostersFailed(membershipCount: number, succeededCount: number): boolean {
  return membershipCount > 0 && succeededCount === 0;
}
