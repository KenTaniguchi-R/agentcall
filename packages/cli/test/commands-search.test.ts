import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { ExitOnly, type Deps, type Io } from "../src/commands/deps.js";
import { saveConfig } from "../src/config.js";
import { saveMembership } from "../src/rosters.js";
import { getPaths } from "../src/paths.js";

vi.mock("../src/searchRefresh.js", () => ({ refreshRoster: vi.fn() }));

import { search } from "../src/commands/search.js";
import { refreshRoster } from "../src/searchRefresh.js";

function fakeIo(): Io & { lines: string[]; errors: string[] } {
  const lines: string[] = [];
  const errors: string[] = [];
  return {
    lines, errors,
    log: (s) => lines.push(s),
    error: (s) => errors.push(s),
    ask: async () => "",
  };
}

const bundleEntries = (handle = "sota") => [{
  handle,
  agent_kind: "claude" as const,
  updated_at: 1,
  truncated: false,
  tasks: [{ id: "ask", name: "Ask", description: "TypeScript architecture", keywords: ["typescript"] }],
}];

let dir: string;
let deps: Deps & { io: ReturnType<typeof fakeIo> };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "agentcall-search-"));
  const paths = getPaths(dir);
  deps = { paths, io: fakeIo() };
  saveConfig(paths, { handle: "ken", token: "tok", relay: "https://r.test" });
  vi.mocked(refreshRoster).mockReset();
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("search", () => {
  it("throws pointing at `agentcall roster join` when nothing is joined", async () => {
    await expect(search(deps, ["typescript"], { limit: 5 })).rejects.toThrow(/agentcall roster join/);
    expect(deps.io.lines).toEqual([]);
  });

  it("throws pointing at `agentcall roster list` when --roster names an unjoined roster", async () => {
    saveMembership(deps.paths, { name: "acme", relay: "https://r.test", roster_id: "a".repeat(22) });
    await expect(search(deps, ["typescript"], { roster: "nope", limit: 5 })).rejects.toThrow(/agentcall roster list/);
  });

  it("degrades a single unreachable roster without aborting the search", async () => {
    saveMembership(deps.paths, { name: "working", relay: "https://r.test", roster_id: "a".repeat(22) });
    saveMembership(deps.paths, { name: "broken", relay: "https://r.test", roster_id: "b".repeat(22) });
    vi.mocked(refreshRoster).mockImplementation(async (_p, name) => {
      if (name === "broken") throw new Error("unreachable");
      return { entries: bundleEntries(), ageSeconds: 0, stale: false };
    });

    await search(deps, ["typescript"], { limit: 5, json: true });

    expect(deps.io.errors).toEqual(["broken: unreachable"]);
    const json = JSON.parse(deps.io.lines.join(""));
    expect(json.results).toMatchObject([{ roster: "working", handle: "sota", task: "ask" }]);
  });

  it("throws ExitOnly when every joined roster fails, rather than reporting no matches", async () => {
    saveMembership(deps.paths, { name: "one", relay: "https://r.test", roster_id: "a".repeat(22) });
    saveMembership(deps.paths, { name: "two", relay: "https://r.test", roster_id: "b".repeat(22) });
    vi.mocked(refreshRoster).mockRejectedValue(new Error("down"));

    // ExitOnly specifically, not a plain Error: run() recognizes it and
    // prints nothing extra, because the per-roster errors below already
    // told the user what happened — asserting a message here would verify
    // output that no longer exists.
    await expect(search(deps, ["typescript"], { limit: 5, json: true })).rejects.toBeInstanceOf(ExitOnly);

    // The empty-result JSON still printed — this is a caller-facing signal
    // distinct from the thrown failure, per allRostersFailed's contract.
    const json = JSON.parse(deps.io.lines.join(""));
    expect(json.results).toEqual([]);
    expect(deps.io.errors).toEqual(["one: down", "two: down"]);
  });
});
