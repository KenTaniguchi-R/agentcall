import { describe, expect, it } from "vitest";
import { rank, tokenize, type SearchEntry } from "../src/search.js";

const entry = (over: Partial<SearchEntry>): SearchEntry => ({
  roster: "acme", handle: "tanaka", address: "tanaka@relay.test", task: "adr",
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
      entry({ handle: "nobody", address: "nobody@relay.test", task: "invented",
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
    const spammy = entry({ handle: "spam", task: "spam", description: "payroll ".repeat(50), name: "N" });
    const honest = entry({ handle: "honest", task: "honest", keywords: ["payroll"], name: "N", description: "D" });
    expect(rank("payroll", [spammy, honest])[0]!.handle).toBe("honest");
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
