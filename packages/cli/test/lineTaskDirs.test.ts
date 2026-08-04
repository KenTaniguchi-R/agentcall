import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { getLinePaths, type MachinePaths } from "../src/paths.js";
import { lineTaskDirs } from "../src/lineTaskDirs.js";
import { tempMachine } from "./helpers.js";

function freshMachine(): MachinePaths {
  return tempMachine("agentcall-linetasks-");
}

describe("lineTaskDirs", () => {
  it("returns an empty array when linesDir does not exist yet", () => {
    const m = freshMachine();
    expect(lineTaskDirs(m)).toEqual([]);
  });

  it("returns each line's tasksDir for a healthy, fully-configured line", () => {
    const m = freshMachine();
    const claude = getLinePaths(m, "claude");
    mkdirSync(claude.dir, { recursive: true });
    writeFileSync(claude.configFile, JSON.stringify({ handle: "ken", token: "t", relay: "https://r.example" }));
    expect(lineTaskDirs(m)).toEqual([claude.tasksDir]);
  });

  // The whole point of this function existing separately from listLines: it
  // never reads config.json, so a line with no config (never finished setup)
  // or a corrupt one still contributes its tasksDir. Under listLines that
  // worked by accident — loadLineConfig's throw was caught and the path
  // returned anyway. Here it works on purpose, by construction: there is no
  // config read to catch a failure from. A broken line's task directory is
  // exactly as sensitive as a healthy one's — it must still be denied.
  it("still contributes the tasksDir for a line with no config.json", () => {
    const m = freshMachine();
    const unfinished = getLinePaths(m, "unfinished");
    mkdirSync(unfinished.dir, { recursive: true });
    // Deliberately no configFile written.
    expect(lineTaskDirs(m)).toEqual([unfinished.tasksDir]);
  });

  it("still contributes the tasksDir for a line with a corrupt config.json", () => {
    const m = freshMachine();
    const corrupt = getLinePaths(m, "corrupt");
    mkdirSync(corrupt.dir, { recursive: true });
    writeFileSync(corrupt.configFile, "{not json");
    expect(lineTaskDirs(m)).toEqual([corrupt.tasksDir]);
  });

  // Order-independent on purpose: lineTaskDirs has no .sort() of its own
  // (unlike listLines, which sorts by name) — readdirSync's order is
  // filesystem-dependent, so this compares both sides sorted rather than
  // asserting any particular order out of lineTaskDirs itself.
  it("enumerates every line, healthy and broken alike, regardless of order", () => {
    const m = freshMachine();
    const a = getLinePaths(m, "a-line");
    const b = getLinePaths(m, "b-broken");
    mkdirSync(a.dir, { recursive: true });
    writeFileSync(a.configFile, JSON.stringify({ handle: "ken", token: "t", relay: "https://r.example" }));
    mkdirSync(b.dir, { recursive: true });
    writeFileSync(b.configFile, "{not json");
    expect(lineTaskDirs(m).sort()).toEqual([a.tasksDir, b.tasksDir].sort());
  });

  it("ignores a directory entry that is not a valid line name", () => {
    const m = freshMachine();
    mkdirSync(join(m.linesDir, "Not-Valid"), { recursive: true });
    mkdirSync(join(m.linesDir, "also invalid"), { recursive: true });
    expect(lineTaskDirs(m)).toEqual([]);
  });

  it("ignores a non-directory entry under linesDir", () => {
    const m = freshMachine();
    mkdirSync(m.linesDir, { recursive: true });
    writeFileSync(join(m.linesDir, "stray-file"), "not a line");
    expect(lineTaskDirs(m)).toEqual([]);
  });
});
