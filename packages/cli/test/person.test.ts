import { describe, expect, it, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getMachinePaths, type MachinePaths } from "../src/paths.js";
import { loadPerson, savePerson, resolvePrimary } from "../src/person.js";

let m: MachinePaths;
beforeEach(() => {
  const root = mkdtempSync(join(tmpdir(), "agentcall-person-"));
  m = getMachinePaths(root, root);
  mkdirSync(m.dir, { recursive: true });
});

describe("savePerson / loadPerson", () => {
  it("round-trips and writes 0600", () => {
    savePerson(m, { primary_line: "claude" });
    expect(loadPerson(m).primary_line).toBe("claude");
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
    const leftovers = readFileSync(m.personFile, "utf8");
    expect(leftovers).toContain("claude");
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
