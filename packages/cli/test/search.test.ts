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
    expect(tokenize("Why DID we?!")).toEqual(["did"]); // "why" and "we" are stopwords
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
    const results = rank("payroll", [
      entry({ handle: "c", task: "in-description", description: "Handles payroll.", name: "N" }),
      entry({ handle: "a", task: "in-keywords", keywords: ["payroll"], name: "N", description: "D" }),
      entry({ handle: "b", task: "in-name", name: "Payroll", description: "D" }),
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
    ];
    expect(rank(query, roster)).toEqual([]);
  });
});
