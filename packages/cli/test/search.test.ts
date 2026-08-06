import { describe, expect, it } from "vitest";
import { allRostersFailed, rank, renderResults, sanitize, tokenize, toEntries, type SearchEntry } from "../src/search.js";

const entry = (over: Partial<SearchEntry>): SearchEntry => ({
  roster: "acme", handle: "tanaka", address: "@acme/tanaka", task: "adr",
  name: "ADR history", description: "Why past decisions were made.", keywords: [], ...over,
});

describe("tokenize", () => {
  it("splits hyphens, so a hyphenated task id matches its parts", () => {
    expect(tokenize("architecture-history")).toEqual(["architecture", "history"]);
  });
  it("lowercases and drops punctuation", () => {
    // "why", "did", and "we" are all stopwords; "auth" is the only term
    // carrying topical signal, and it survives lowercased.
    expect(tokenize("Why DID we AUTH?!")).toEqual(["auth"]);
  });
  it("NFKC-normalizes full-width input", () => {
    expect(tokenize("ＡＵＴＨ")).toEqual(["auth"]);
  });
  it("returns nothing for a query that is only stopwords", () => {
    expect(tokenize("the and of for")).toEqual([]);
  });
});

describe("rank", () => {
  it("finds a colleague by a keyword", () => {
    const results = rank("auth migration", [entry({ keywords: ["auth", "migration"] })]);
    expect(results).toHaveLength(1);
    expect(results[0]!.handle).toBe("tanaka");
  });

  // Proves matching runs against the cache CONTENTS, not a hardcoded list.
  // A wholly invented colleague with a nonsense term must route.
  it("routes a fictitious colleague with an invented term", () => {
    const results = rank("zzzcustomtoolkit please", [
      entry({ handle: "nobody", address: "@acme/nobody", task: "invented",
              name: "Invented", description: "d", keywords: ["zzzcustomtoolkit"] }),
    ]);
    expect(results[0]!.handle).toBe("nobody");
  });

  it("weights keywords above name above description", () => {
    // Handles are deliberately anti-correlated with field priority
    // (z=keywords, m=name, a=description): the expected order is z, m, a,
    // which the handle tie-break alone could never produce. If it passed
    // with alphabetically-correlated handles instead, a weight collapse to
    // {keywords:1, name:1, description:1} would slip through unnoticed —
    // the tie-break would still sort a, b, c into the right order.
    //
    // Two query terms, not one: MIN_SCORE (2) filters out a lone
    // description hit (weight 1) entirely, so a single-term "payroll"
    // query can no longer put a description-only entry in the results at
    // all. Matching both "payroll" and "salary" within one field lets each
    // entry clear the floor via legitimate corroboration (distinct terms,
    // not repetition of one) while keeping the field-isolation design: each
    // entry still matches both terms in exactly one field, so the strict
    // 6 > 4 > 2 ordering still comes from WEIGHTS alone.
    const results = rank("payroll salary", [
      entry({ handle: "a", task: "in-description", description: "Handles payroll and salary.", name: "N" }),
      entry({ handle: "z", task: "in-keywords", keywords: ["payroll", "salary"], name: "N", description: "D" }),
      entry({ handle: "m", task: "in-name", name: "Payroll Salary", description: "D" }),
    ]);
    expect(results.map((r) => r.task)).toEqual(["in-keywords", "in-name", "in-description"]);
  });

  it("scores presence, not count — repetition cannot buy rank", () => {
    // Two query terms, not one: a lone-term "payroll" query would dedupe
    // spammy's repeated description to a single hit, which MIN_SCORE (2)
    // filters out before ranking even begins — so spammy would never enter
    // the results at all, and "honest first" would pass without spammy's
    // repetition ever being compared against anything. With both terms in
    // spammy's description, presence-not-count gives it score 2 (one point
    // per distinct term, however many times each repeats) against honest's
    // single-keyword score 3 — a real comparison, not an absence.
    const spammy = entry({ handle: "spam", task: "spam", description: "payroll salary ".repeat(50), name: "N" });
    const honest = entry({ handle: "honest", task: "honest", keywords: ["payroll"], name: "N", description: "D" });
    const results = rank("payroll salary", [spammy, honest]);
    // The length assertion is what keeps this test honest: if spammy failed
    // to clear MIN_SCORE it would silently vanish from the array rather than
    // simply losing the comparison, and `results[0]` alone would not catch that.
    expect(results).toHaveLength(2);
    expect(results[0]!.handle).toBe("honest");
  });

  it("accumulates a term across fields", () => {
    const both = rank("payroll", [entry({ keywords: ["payroll"], name: "Payroll", description: "D" })])[0]!;
    expect(both.score).toBe(5);                                   // keywords 3 + name 2
    expect(both.matched[0]!.fields).toEqual(["keywords", "name"]);
  });

  it("breaks ties by handle then task id, deterministically", () => {
    const results = rank("payroll", [
      entry({ handle: "zoe", task: "b", keywords: ["payroll"] }),
      entry({ handle: "amy", task: "b", keywords: ["payroll"] }),
      entry({ handle: "amy", task: "a", keywords: ["payroll"] }),
    ]);
    expect(results.map((r) => `${r.handle}/${r.task}`)).toEqual(["amy/a", "amy/b", "zoe/b"]);
  });

  it("honors the limit, defaulting to 5", () => {
    const many = Array.from({ length: 9 }, (_, i) => entry({ handle: `h${i}`, keywords: ["payroll"] }));
    expect(rank("payroll", many)).toHaveLength(5);
    expect(rank("payroll", many, 2)).toHaveLength(2);
  });

  it("returns nothing rather than a fallback list when nothing matches", () => {
    expect(rank("quantum tunnelling", [entry({ keywords: ["payroll"] })])).toEqual([]);
  });

  it("returns nothing for an all-stopword query", () => {
    expect(rank("the and of", [entry({ keywords: ["payroll"] })])).toEqual([]);
  });

  it("a single incidental description term is not enough to route someone", () => {
    // Pins MIN_SCORE so a later edit can't silently drop it. A lone
    // description hit (weight 1) must not surface a colleague on its own —
    // this is the exact shape of the real over-firing case (a CI card's
    // prose happened to contain "deploy" and "test").
    const descriptionOnly = entry({ handle: "raj", task: "ci-pipeline", keywords: ["ci"], name: "CI pipeline",
                                     description: "Answers questions about the deploy and test pipeline." });
    expect(rank("deploy", [descriptionOnly])).toEqual([]);

    // A lone keyword hit (weight 3) clears the floor on its own and still routes.
    const keywordHit = entry({ handle: "tanaka", task: "adr", keywords: ["deploy"] });
    expect(rank("deploy", [keywordHit])[0]!.handle).toBe("tanaka");
  });

  // The discipline that decides whether this tool survives contact with
  // users. Every one of these is ordinary coding vocabulary that must NOT
  // suggest a colleague. Adapted from Composio's bare-verb test.
  it.each([
    "deploy the worker to production",
    "fix the failing test",
    "write an email validation regex",
    "the issue is on line 42",
    "post the results to the console",
    "connect to the local postgres database",
  ])("stays silent on bare coding vocabulary: %s", (query) => {
    const roster = [
      entry({ handle: "tanaka", task: "adr", keywords: ["adr"], name: "ADR history",
              description: "Why past architecture decisions were made." }),
      entry({ handle: "mia", task: "payroll", keywords: ["payroll", "salary"], name: "Payroll",
              description: "Answers payroll questions." }),
      // A card whose prose incidentally contains ordinary coding vocabulary.
      // Without this, the block above only proves "no shared token → no
      // match," which the "quantum tunnelling" test already covers — it
      // never exercises the real boundary: a description that happens to
      // contain a query word.
      entry({ handle: "raj", task: "ci-pipeline", keywords: ["ci"], name: "CI pipeline",
              description: "Answers questions about the deploy and test pipeline." }),
    ];
    expect(rank(query, roster)).toEqual([]);
  });
});

describe("sanitize", () => {
  // Callee-authored text reaching a caller's terminal is escape-injection
  // surface — the same reason MAX_DETAIL_LENGTH exists in the protocol.
  // Matches sanitizeDetail's precedent there: a control character becomes a
  // space, not nothing, so it can't glue two words together.
  it("replaces ANSI escapes and other control characters with a space, rather than deleting them", () => {
    expect(sanitize("\x1b[2Jwiped")).toBe(" [2Jwiped");
  });
  it("does not run two sentences together when it neutralizes a newline", () => {
    // BundleTask.description permits embedded newlines. Deleting the
    // newline outright would turn this into "auth.Also covers payroll." —
    // the exact bug a card author would see as broken, unsanitized output.
    expect(sanitize("Handles auth.\nAlso covers payroll.")).toBe("Handles auth. Also covers payroll.");
  });
  it("collapses a run of consecutive control characters (e.g. CRLF) to a single space", () => {
    expect(sanitize("line one\r\nline two")).toBe("line one line two");
  });
  it("truncates past the limit", () => {
    expect(sanitize("x".repeat(300), 10)).toHaveLength(10);
  });
  it("leaves ordinary text alone", () => {
    expect(sanitize("Why we picked OAuth — the ADR.")).toBe("Why we picked OAuth — the ADR.");
  });
});

describe("toEntries", () => {
  it("builds @org/handle addresses and flattens tasks", () => {
    const entries = toEntries("acme", "acme", [
      { handle: "tanaka", agent_kind: "claude", updated_at: 1, truncated: false,
        tasks: [{ id: "adr", name: "ADR", description: "Why.", keywords: ["auth"] },
                { id: "ask", name: "Ask", description: "Q.", keywords: [] }] },
    ]);
    expect(entries).toHaveLength(2);
    expect(entries[0]!.address).toBe("@acme/tanaka");
    expect(entries[0]!.roster).toBe("acme");
  });
});

describe("renderResults", () => {
  const results = rank("auth migration", [
    { roster: "acme", handle: "tanaka", address: "@acme/tanaka", task: "adr",
      name: "ADR history", description: "Why decisions were made.", keywords: ["auth", "migration"] },
  ]);

  it("prints a runnable command with --task before the message", () => {
    // Matches the canonical ordering `agentcall card` already prints.
    expect(renderResults(results, [{ name: "acme", ageSeconds: 5, stale: false }]))
      .toContain('agentcall call @acme/tanaka --task adr "<message>"');
  });

  it("shows which terms matched and where, so the agent can judge", () => {
    expect(renderResults(results, [{ name: "acme", ageSeconds: 5, stale: false }]))
      .toMatch(/matched:.*auth.*keywords/);
  });

  it("says nothing matched rather than listing a fallback", () => {
    const out = renderResults([], [{ name: "acme", ageSeconds: 5, stale: false }]);
    expect(out).toMatch(/no match/i);
    expect(out).not.toContain("agentcall call");
  });

  it("names a stale roster and its age", () => {
    expect(renderResults(results, [{ name: "acme", ageSeconds: 7200, stale: true }]))
      .toMatch(/acme.*stale/i);
  });

  // With no --roster, every joined roster merges into ONE ranking, and every
  // address is handle@<same relay> — the roster name is the only way to tell
  // where a suggested colleague came from. Tested in both directions so an
  // unconditional prefix (or a permanently-absent one) would fail one side.
  it("does not prefix a result with its roster when only one roster is in scope", () => {
    const out = renderResults(results, [{ name: "acme", ageSeconds: 5, stale: false }]);
    expect(out).not.toContain("[acme]");
  });

  it("prefixes each result with its own roster when more than one roster is in scope", () => {
    const multi = rank("auth migration", [
      { roster: "acme", handle: "tanaka", address: "@acme/tanaka", task: "adr",
        name: "ADR history", description: "Why decisions were made.", keywords: ["auth", "migration"] },
      { roster: "other", handle: "mia", address: "@acme/mia", task: "auth-flow",
        name: "Auth migration guide", description: "How auth migrated.", keywords: ["auth", "migration"] },
    ]);
    const out = renderResults(multi, [
      { name: "acme", ageSeconds: 5, stale: false },
      { name: "other", ageSeconds: 5, stale: false },
    ]);
    expect(out).toContain("[acme] @acme/tanaka");
    expect(out).toContain("[other] @acme/mia");
  });

  it("says when a member's tasks were not fully indexed", () => {
    const truncated = rank("payroll", [
      { roster: "acme", handle: "mia", address: "@acme/mia", task: "payroll",
        name: "Payroll", description: "d", keywords: ["payroll"], truncated: true },
    ]);
    expect(renderResults(truncated, [{ name: "acme", ageSeconds: 1, stale: false }]))
      .toContain("agentcall card @acme/mia");
  });

  // The payload sits in `task` and `description` — both pass through
  // sanitize() on this human render path. `name` deliberately does not: the
  // renderer prints the task *id* (needed for --task on the command line
  // below it), not the display name, so name earns its place by being
  // scored, not displayed. It is still sanitized on the --json path (see
  // index.ts), so its omission here is not a gap.
  it("emits no escape sequences even when a card contains them", () => {
    const evil = rank("payroll", [
      { roster: "acme", handle: "x", address: "@acme/x", task: "t\x1b[31m",
        name: "Payroll", description: "d\x1b[0m\nFAKE: 0 results", keywords: ["payroll"] },
    ]);
    const output = renderResults(evil, [{ name: "acme", ageSeconds: 1, stale: false }]);
    const lines = output.split("\n");
    // No control character survives WITHIN any single line (ESC, CR, BEL, ...).
    for (const line of lines) expect(line).not.toMatch(/\p{Cc}/u);
    // And no EXTRA lines: \p{Cc} matches "\n" itself, so a naive whole-output
    // check can't tell "no escapes" from "an injected newline split this into
    // an extra line that forges a result or paints over real output."
    // sanitize() neutralizes newlines in field content (replacing them with
    // a space, never leaving a literal "\n"), so this fixture — one
    // non-truncated result, one roster in scope — renders exactly 4 lines:
    // address+task, description, matched, call command. A 5th would mean one
    // leaked through.
    expect(lines).toHaveLength(4);
  });
});

describe("allRostersFailed", () => {
  // Not this case: nothing was even attempted (no rosters joined at all).
  it("is false when there were no memberships to try", () => {
    expect(allRostersFailed(0, 0)).toBe(false);
  });
  // Not this case: every attempted roster refreshed (or failed-open to a
  // stale cache) successfully — a genuine "no match" result is possible.
  it("is false when every membership produced a status", () => {
    expect(allRostersFailed(3, 3)).toBe(false);
  });
  // Not this case: partial failure. Real results (or a real stale warning)
  // reached the user for the rosters that did succeed.
  it("is false when only some memberships failed", () => {
    expect(allRostersFailed(3, 1)).toBe(false);
  });
  // This IS the case: every roster was attempted and every one failed, so
  // "no match" would misrepresent a total outage as a genuine empty result.
  it("is true when there was at least one membership and none produced a status", () => {
    expect(allRostersFailed(2, 0)).toBe(true);
  });
});
