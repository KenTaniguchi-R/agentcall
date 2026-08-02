import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { rosterForget, rosterList, type Deps, type Io } from "../src/commands/roster.js";
import { saveMembership } from "../src/rosters.js";
import type { Paths } from "../src/paths.js";

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

let dir: string;
let deps: Deps & { io: ReturnType<typeof fakeIo> };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "agentcall-roster-"));
  const paths = { dir, rostersFile: join(dir, "rosters.json"), rosterCacheFile: join(dir, "roster-cache.json") } as Paths;
  deps = { paths, io: fakeIo() };
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("rosterList", () => {
  it("prints the onboarding hint when nothing is joined", () => {
    rosterList(deps);
    expect(deps.io.lines.join("\n")).toContain("No rosters joined");
  });

  it("prints one tab-separated row per membership", () => {
    saveMembership(deps.paths, { name: "acme", relay: "https://r.test", roster_id: "AAAAAAAAAAAAAAAAAAAAAA" });
    rosterList(deps);
    expect(deps.io.lines).toEqual(["acme\tAAAAAAAAAAAAAAAAAAAAAA\thttps://r.test"]);
  });
});

describe("rosterForget", () => {
  it("removes the local record and says the relay is unchanged", () => {
    saveMembership(deps.paths, { name: "acme", relay: "https://r.test", roster_id: "AAAAAAAAAAAAAAAAAAAAAA" });
    rosterForget(deps, "acme");
    expect(deps.io.lines.join("\n")).toContain("membership on the relay is unchanged");
    rosterList(deps);
    expect(deps.io.lines.join("\n")).toContain("No rosters joined");
  });

  it("throws rather than setting an exit code when the name is unknown", () => {
    // The command's contract: throw. index.ts's run() wrapper owns exit codes.
    expect(() => rosterForget(deps, "nope")).toThrow(/No roster named "nope"/);
    expect(deps.io.errors).toEqual([]);
  });
});
