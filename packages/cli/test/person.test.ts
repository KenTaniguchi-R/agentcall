import { describe, expect, it, beforeEach } from "vitest";
import { existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync, statSync } from "node:fs";
import { getMachinePaths, type MachinePaths } from "../src/paths.js";
import { loadPerson, savePerson, resolvePrimary } from "../src/person.js";
import { tempDir } from "./helpers.js";

let m: MachinePaths;
beforeEach(() => {
  const root = tempDir("agentcall-person-");
  m = getMachinePaths(root, root);
  mkdirSync(m.dir, { recursive: true });
});

describe("savePerson / loadPerson", () => {
  it("round-trips and writes 0600", () => {
    savePerson(m, { primary_line: "claude" });
    expect(loadPerson(m).primary_line).toBe("claude");
    expect(statSync(m.dir).mode & 0o777).toBe(0o700);
    expect(statSync(m.personFile).mode & 0o777).toBe(0o600);
  });

  it("rejects a corrupt person.json rather than returning a partial record", () => {
    writeFileSync(m.personFile, "{not json");
    expect(() => loadPerson(m)).toThrow(/person\.json/);
  });

  it("rejects a schema-invalid person.json", () => {
    writeFileSync(m.personFile, JSON.stringify({ primary_line: 42 }));
    expect(() => loadPerson(m)).toThrow(/person\.json/);
  });

  it("does not leave a temp file behind", () => {
    savePerson(m, { primary_line: "claude" });
    // The previous version of this test only re-read personFile itself —
    // which would pass even if the .tmp file were never cleaned up, since
    // rename(2) doesn't require the source to vanish for the destination to
    // exist. Actually stat the .tmp path to prove the claim in the name.
    expect(existsSync(`${m.personFile}.tmp`)).toBe(false);
    expect(readdirSync(m.dir).filter((name) => name.startsWith(".person.json.") && name.endsWith(".tmp"))).toEqual([]);
    expect(readFileSync(m.personFile, "utf8")).toContain("claude");
  });

  it("does not let the legacy fixed temp path block a save", () => {
    mkdirSync(`${m.personFile}.tmp`);

    expect(() => savePerson(m, { primary_line: "claude" })).not.toThrow();
    expect(loadPerson(m).primary_line).toBe("claude");
    expect(statSync(`${m.personFile}.tmp`).isDirectory()).toBe(true);
  });

  it("preserves the previous primary line when serialization fails", () => {
    savePerson(m, { primary_line: "claude" });
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    expect(() => savePerson(m, { primary_line: "codex", circular } as never))
      .toThrow(/circular/i);
    expect(loadPerson(m).primary_line).toBe("claude");
    expect(readdirSync(m.dir).filter((name) => name.startsWith(".person.json.") && name.endsWith(".tmp"))).toEqual([]);
  });
});

describe("resolvePrimary", () => {
  it("returns the recorded primary when it still exists", () => {
    savePerson(m, { primary_line: "codex" });
    expect(resolvePrimary(m, ["claude", "codex"])).toBe("codex");
  });

  it("repairs a dangling primary when exactly one line remains", () => {
    savePerson(m, { primary_line: "gone" });
    expect(resolvePrimary(m, ["claude"])).toBe("claude");
    expect(loadPerson(m).primary_line).toBe("claude");
  });

  it("refuses to guess when the primary dangles and several lines exist", () => {
    savePerson(m, { primary_line: "gone" });
    expect(() => resolvePrimary(m, ["claude", "codex"])).toThrow(/agentcall line primary/);
  });

  it("adopts the only line when person.json is missing entirely", () => {
    expect(resolvePrimary(m, ["claude"])).toBe("claude");
    expect(loadPerson(m).primary_line).toBe("claude");
  });

  it("refuses when there are no lines at all", () => {
    expect(() => resolvePrimary(m, [])).toThrow(/agentcall setup/);
  });
});
