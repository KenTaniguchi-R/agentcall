import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import type { Deps, Io } from "../src/commands/deps.js";
import { saveConfig } from "../src/config.js";
import { getPaths } from "../src/paths.js";
import type { Policy } from "../src/policy.js";
import type { Verb } from "../src/verbs.js";

vi.mock("../src/verbs.js", async () => {
  const actual = await vi.importActual<typeof import("../src/verbs.js")>("../src/verbs.js");
  return { ...actual, execVerb: vi.fn() };
});
vi.mock("../src/card.js", async () => {
  const actual = await vi.importActual<typeof import("../src/card.js")>("../src/card.js");
  return { ...actual, publishCard: vi.fn() };
});

import { policyVerb } from "../src/commands/policy.js";
import { execVerb } from "../src/verbs.js";
import { publishCard } from "../src/card.js";

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
const NEXT_POLICY: Policy = { description: "", default_offer: ["ask", "translate"], callers: {} };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "agentcall-policy-"));
  deps = { paths: getPaths(dir), io: fakeIo() };
  saveConfig(deps.paths, { handle: "ken", token: "t", agent_kind: "claude", relay: "https://r.test" });
  vi.mocked(execVerb).mockReset();
  vi.mocked(execVerb).mockReturnValue({ policy: NEXT_POLICY, lines: ["ok"] });
  vi.mocked(publishCard).mockReset();
  vi.mocked(publishCard).mockResolvedValue({
    description: "", agent_kind: "claude", default_offer: [], grants: {}, tasks: [],
  });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

// The six CLI verbs (allow/revoke/block/unblock/offer/unoffer) are wired in
// index.ts to policyVerb(realDeps(), "<verb>", [...args]). Confirmed by
// reading index.ts: they differ ONLY in the verb string and argument count
// (allow/revoke take handle+task-id, block/unblock take handle,
// offer/unoffer take task-id) — same guard, same save/print/republish
// sequence for all six. This table is the collapse's coverage: every verb
// really does reach execVerb with the right string and arguments.
const cases: { verb: Verb; args: string[] }[] = [
  { verb: "allow", args: ["mia", "translate"] },
  { verb: "revoke", args: ["mia", "translate"] },
  { verb: "block", args: ["mia"] },
  { verb: "unblock", args: ["mia"] },
  { verb: "offer", args: ["translate"] },
  { verb: "unoffer", args: ["translate"] },
];

describe.each(cases)("policyVerb($verb)", ({ verb, args }) => {
  it(`reaches execVerb with verb="${verb}" and the given arguments`, async () => {
    await policyVerb(deps, verb, args);

    expect(execVerb).toHaveBeenCalledTimes(1);
    const call = vi.mocked(execVerb).mock.calls[0];
    expect(call[2]).toBe(verb);
    expect(call[3]).toBe(args[0]);
    expect(call[4]).toBe(args[1]); // undefined for single-arg verbs
  });

  it("prints execVerb's lines, saves the returned policy, and republishes the card", async () => {
    await policyVerb(deps, verb, args);

    expect(deps.io.lines).toEqual(["ok", "Card updated."]);
    expect(publishCard).toHaveBeenCalledTimes(1);
  });
});

describe("policyVerb guard", () => {
  it("throws for a caller-only install without ever reaching execVerb", async () => {
    saveConfig(deps.paths, { handle: "ken", token: "t", relay: "https://r.test" }); // no agent_kind

    await expect(policyVerb(deps, "block", ["mia"])).rejects.toThrow(/caller-only.*no card or policy to manage/);
    expect(execVerb).not.toHaveBeenCalled();
  });
});

describe("policyVerb card-push failure", () => {
  it("warns but does not throw when the policy save succeeded but the republish failed", async () => {
    vi.mocked(publishCard).mockRejectedValue(new Error("relay down"));

    await policyVerb(deps, "block", ["mia"]);

    expect(deps.io.lines).toEqual(["ok"]); // no "Card updated." line
    expect(deps.io.errors).toEqual([
      "Warning: policy saved locally, but the card push failed (Error: relay down). Run `agentcall card push` later.",
    ]);
  });
});

describe("policyVerb propagates execVerb validation errors", () => {
  it("does not swallow a thrown Error (e.g. an invalid handle) — run() handles it", async () => {
    vi.mocked(execVerb).mockImplementation(() => {
      throw new Error('"Bad Handle" is not a valid handle. Use the bare handle (e.g. ken), not handle@host.');
    });

    await expect(policyVerb(deps, "block", ["Bad Handle"])).rejects.toThrow(/not a valid handle/);
    expect(publishCard).not.toHaveBeenCalled();
  });
});
