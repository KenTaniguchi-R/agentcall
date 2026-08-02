import { describe, expect, it, beforeEach, vi } from "vitest";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getLinePaths, getMachinePaths, type MachinePaths } from "../src/paths.js";
import { saveLineConfig } from "../src/lines.js";
import { startAllListeners } from "../src/listenAll.js";

let m: MachinePaths;
beforeEach(() => {
  const root = mkdtempSync(join(tmpdir(), "agentcall-all-"));
  m = getMachinePaths(root, root);
  mkdirSync(m.linesDir, { recursive: true });
});

const base = { token: "t", relay: "https://r.example", agent_kind: "claude" as const };

describe("startAllListeners", () => {
  it("starts one listener per callable line", () => {
    saveLineConfig(getLinePaths(m, "claude"), { ...base, handle: "ken" });
    saveLineConfig(getLinePaths(m, "codex"), { ...base, handle: "ken-cdx" });
    const started: string[] = [];
    const h = startAllListeners(m, { start: (d) => { started.push(d.paths.name); return { stop() {} }; } });
    expect(started).toEqual(["claude", "codex"]);
    expect(h.started).toEqual(["claude", "codex"]);
    h.stop();
  });

  it("skips a caller-only line", () => {
    saveLineConfig(getLinePaths(m, "caller"), { handle: "ken", token: "t", relay: "https://r.example" });
    const h = startAllListeners(m, { start: () => ({ stop() {} }) });
    expect(h.started).toEqual([]);
    h.stop();
  });

  it("skips an orphaned line without throwing", () => {
    mkdirSync(getLinePaths(m, "half").dir, { recursive: true });
    saveLineConfig(getLinePaths(m, "claude"), { ...base, handle: "ken" });
    const h = startAllListeners(m, { start: () => ({ stop() {} }) });
    expect(h.started).toEqual(["claude"]);
    h.stop();
  });

  it("stops every listener it started", () => {
    saveLineConfig(getLinePaths(m, "claude"), { ...base, handle: "ken" });
    saveLineConfig(getLinePaths(m, "codex"), { ...base, handle: "ken-cdx" });
    let stops = 0;
    startAllListeners(m, { start: () => ({ stop() { stops++; } }) }).stop();
    expect(stops).toBe(2);
  });

  // One process now holds every line's socket. Before this test existed,
  // startListener throwing synchronously at startup (its deliberate "a bad
  // workdir fails loud" contract — see listener.ts) for ONE line took the
  // whole loop down: lines started before it leaked (pushed into `handles`
  // but never returned, so never reachable via `stop()`), and lines after it
  // in iteration order never got a chance to start at all.
  it("keeps starting other lines when one fails to start, and logs the failure by name", () => {
    saveLineConfig(getLinePaths(m, "alpha"), { ...base, handle: "ken-a" });
    saveLineConfig(getLinePaths(m, "broken"), { ...base, handle: "ken-b" });
    saveLineConfig(getLinePaths(m, "zulu"), { ...base, handle: "ken-z" });
    const errors: string[] = [];
    const errorSpy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      errors.push(args.map(String).join(" "));
    });
    try {
      const h = startAllListeners(m, {
        start: (d) => {
          if (d.paths.name === "broken") throw new Error(`config.json workdir "/no/such/project" does not exist.`);
          return { stop() {} };
        },
      });
      expect(h.started).toEqual(["alpha", "zulu"]);
      expect(errors.some((e) => e.includes('"broken"') && e.includes("does not exist"))).toBe(true);
      h.stop();
    } finally {
      errorSpy.mockRestore();
    }
  });

  // The "no callable lines" case (tested above) is a healthy, expected state
  // — a caller-only install, say — and must stay non-fatal. This is a
  // different state: lines existed, were callable, and were attempted, but
  // NONE of them could start. A process that's technically "up" but silently
  // answering no calls at all is worse than one that's visibly down, so this
  // is the one case `startAllListeners` deliberately throws for, to make
  // `agentcall listen` exit non-zero instead of sitting there looking
  // healthy.
  it("throws when every callable line fails to start, rather than running with nothing listening", () => {
    saveLineConfig(getLinePaths(m, "alpha"), { ...base, handle: "ken-a" });
    saveLineConfig(getLinePaths(m, "beta"), { ...base, handle: "ken-b" });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(() =>
        startAllListeners(m, { start: () => { throw new Error("boom"); } }),
      ).toThrow(/every callable line/i);
    } finally {
      errorSpy.mockRestore();
    }
  });
});
