import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import type { Deps, Io } from "../src/commands/deps.js";
import { ExitOnly } from "../src/commands/deps.js";
import { saveConfig } from "../src/config.js";
import { addContact } from "../src/contacts.js";
import { getPaths } from "../src/paths.js";
import { savePolicy } from "../src/policy.js";

vi.mock("../src/api.js", async () => {
  const actual = await vi.importActual<typeof import("../src/api.js")>("../src/api.js");
  return { ...actual, fetchCard: vi.fn() };
});
vi.mock("../src/card.js", async () => {
  const actual = await vi.importActual<typeof import("../src/card.js")>("../src/card.js");
  return { ...actual, publishCard: vi.fn() };
});

import { card, taskNew } from "../src/commands/card.js";
import { fetchCard } from "../src/api.js";
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

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "agentcall-card-"));
  deps = { paths: getPaths(dir), io: fakeIo() };
  vi.mocked(fetchCard).mockReset();
  vi.mocked(publishCard).mockReset();
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("card (no argument — review own card)", () => {
  it("throws when the install is caller-only (no agent configured)", async () => {
    saveConfig(deps.paths, { handle: "ken", token: "t", relay: "https://r.test" });

    await expect(card(deps, undefined)).rejects.toThrow(/caller-only.*no card to review/);
    expect(deps.io.lines).toEqual([]);
  });

  it("prints the owner's menu and stays exit-clean when there are no problems", async () => {
    saveConfig(deps.paths, { handle: "ken", token: "t", agent_kind: "claude", relay: "https://r.test" });

    await card(deps, undefined);

    expect(deps.io.lines.join("\n")).toContain("ken (claude)");
    // No policy problems (default policy, no tasks dir) -> no Problems section.
    expect(deps.io.lines.join("\n")).not.toContain("Problems:");
  });

  it("prints the Problems section and throws ExitOnly (exit 1, no redundant summary line) when the policy is broken", async () => {
    saveConfig(deps.paths, { handle: "ken", token: "t", agent_kind: "claude", relay: "https://r.test" });
    // default_offer references a task with no manifest on disk.
    savePolicy(deps.paths, { description: "", default_offer: ["ghost"], callers: {} });

    const rejection = card(deps, undefined);
    await expect(rejection).rejects.toBeInstanceOf(ExitOnly);
    expect(deps.io.lines.join("\n")).toContain("Problems:");
    expect(deps.io.lines.join("\n")).toContain('references "ghost" but no such task exists');
  });
});

describe("card push", () => {
  it("throws when the install is caller-only", async () => {
    saveConfig(deps.paths, { handle: "ken", token: "t", relay: "https://r.test" });

    await expect(card(deps, "push")).rejects.toThrow(/caller-only.*publish/);
    expect(publishCard).not.toHaveBeenCalled();
  });

  it("publishes the local card and reports success", async () => {
    saveConfig(deps.paths, { handle: "ken", token: "t", agent_kind: "claude", relay: "https://r.test" });
    vi.mocked(publishCard).mockResolvedValue({
      description: "", agent_kind: "claude", default_offer: [], grants: {}, tasks: [],
    });

    await card(deps, "push");

    expect(publishCard).toHaveBeenCalledWith(expect.objectContaining({ handle: "ken" }), deps.paths);
    expect(deps.io.lines).toEqual(["Card published."]);
  });
});

describe("card <address> — fetch a remote card", () => {
  it("throws (with the 'or push' hint) when the address cannot be resolved", async () => {
    saveConfig(deps.paths, { handle: "ken", token: "t", agent_kind: "claude", relay: "https://r.test" });

    await expect(card(deps, "nope")).rejects.toThrow(/No contact named "nope".*or 'push'/s);
    expect(fetchCard).not.toHaveBeenCalled();
  });

  it("fetches and prints the remote agent's menu", async () => {
    saveConfig(deps.paths, { handle: "ken", token: "t", agent_kind: "claude", relay: "https://r.test" });
    vi.mocked(fetchCard).mockResolvedValue({
      handle: "sota", description: "TS expert", agent_kind: "claude", updated_at: 1,
      tasks: [{ id: "ask", name: "Ask", description: "General Q&A", examples: ["how's typescript?"], keywords: [] }],
    });

    await card(deps, "sota@r.test");

    expect(fetchCard).toHaveBeenCalledWith("https://r.test", "sota", { handle: "ken", token: "t" });
    expect(deps.io.lines).toEqual([
      "sota (claude) — TS expert",
      "  ask — General Q&A",
      "      e.g. how's typescript?",
      '\nCall with: agentcall call sota@r.test --task <id> "<message>"',
    ]);
  });

  it("resolves a saved contact by its short name before fetching", async () => {
    saveConfig(deps.paths, { handle: "ken", token: "t", agent_kind: "claude", relay: "https://r.test" });
    addContact(deps.paths, "sota", "sota@r.test");
    vi.mocked(fetchCard).mockResolvedValue({
      handle: "sota", description: "", agent_kind: "claude", updated_at: 1, tasks: [],
    });

    await card(deps, "sota");

    expect(fetchCard).toHaveBeenCalledWith("https://r.test", "sota", { handle: "ken", token: "t" });
  });

  it("propagates a fetch failure for run() to report", async () => {
    saveConfig(deps.paths, { handle: "ken", token: "t", agent_kind: "claude", relay: "https://r.test" });
    vi.mocked(fetchCard).mockRejectedValue(new Error("Card fetch failed (500)."));

    await expect(card(deps, "sota@r.test")).rejects.toThrow("Card fetch failed (500).");
  });
});

describe("taskNew", () => {
  it("scaffolds a task file and prints next-steps hints", () => {
    taskNew(deps, "translate-doc");

    expect(deps.io.lines[0]).toMatch(/^Created .*translate-doc.*SKILL\.md/);
    expect(deps.io.lines.join("\n")).toContain("agentcall offer translate-doc");
    expect(deps.io.lines.join("\n")).toContain("agentcall allow <handle> translate-doc");
  });

  it("throws rather than setting an exit code for an invalid task id", () => {
    expect(() => taskNew(deps, "Not Valid")).toThrow(/not a valid task id/);
    expect(deps.io.errors).toEqual([]);
  });
});
