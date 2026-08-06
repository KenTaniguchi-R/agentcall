import { mkdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildCardUpload, publishCard } from "../src/card.js";
import { ASK_TASK, type Task } from "../src/tasks.js";
import type { Policy } from "../src/policy.js";
import type { LineConfig } from "../src/config.js";
import { tempLine } from "./helpers.js";

const cfg: LineConfig = { org: "acme", handle: "ken", token: "t", agent_kind: "claude", relay: "https://r" };
const intro: Task = {
  id: "owner-introduction", name: "Intro", description: "Introduce the owner.",
  examples: ["who is ken?"], keywords: [], threadable: true, skill: "secret steps",
};
const meet: Task = {
  id: "schedule-meeting", name: "Schedule", description: "Book a time.",
  examples: [], keywords: [], threadable: true, skill: "",
};

describe("buildCardUpload", () => {
  const policy: Policy = {
    description: "Ken's agent",
    default_clearance: "public",
    callers: {
      mia: { clearance: "internal", block: false },
      spammer: { clearance: "internal", block: true },
    },
    groups: { eng: { roster_id: "g".repeat(22), clearance: "internal" } },
  };

  it("includes card metadata but never SKILL.md content", () => {
    const upload = buildCardUpload(cfg, policy, [ASK_TASK, intro, meet]);
    expect(upload).toMatchObject({ description: "Ken's agent", agent_kind: "claude" });
    const introEntry = upload.tasks.find((t) => t.id === "owner-introduction")!;
    expect(introEntry).toEqual({ id: "owner-introduction", name: "Intro", description: "Introduce the owner.", examples: ["who is ken?"], keywords: [] });
    expect(JSON.stringify(upload)).not.toContain("secret steps");
    expect(JSON.stringify(upload)).not.toContain("caps");
  });

  // Replaces "maps caller grants (stripping + prefixes) and omits blocked
  // callers" and "drops offered/granted ids that have no task on disk". Both
  // pinned menu projection, which #379 deleted: a card is now the whole task
  // list, so there is no grant to map and no dangling id to drop. `blocked` is
  // the surviving half and is checked here.
  it("publishes every task on disk, and no per-caller menu", () => {
    const upload = buildCardUpload(cfg, policy, [ASK_TASK, intro, meet]);
    expect(upload.tasks.map((t) => t.id)).toEqual(["ask", "owner-introduction", "schedule-meeting"]);
    expect(Object.keys(upload)).toEqual(["description", "agent_kind", "tasks", "blocked"]);
  });

  // The clearance table is the owner's assessment of their own callers. It
  // must not travel with the card, where the callers it assesses could read
  // it — only the blocked list, which they can already infer by calling.
  it("publishes blocked callers but never the clearance table", () => {
    const upload = buildCardUpload(cfg, policy, [ASK_TASK, intro, meet]);
    expect(upload.blocked).toEqual(["spammer"]);
    const serialized = JSON.stringify(upload);
    expect(serialized).not.toContain("internal");
    expect(serialized).not.toContain("mia");
    expect(serialized).not.toContain("g".repeat(22));
  });

  it("publishes task keywords to the relay", () => {
    const upload = buildCardUpload(
      { org: "acme", handle: "ken", token: "t", agent_kind: "claude", relay: "https://r.test" },
      { description: "d", default_clearance: "public", callers: {}, groups: {} },
      [{ id: "adr", name: "ADR", description: "Why.", examples: [],
         keywords: ["auth", "migration"], threadable: true, skill: "" }],
    );
    expect(upload.tasks[0]!.keywords).toEqual(["auth", "migration"]);
  });
});

describe("publishCard", () => {
  function tempPaths() {
    const p = tempLine("claude", "agentcall-pub-");
    mkdirSync(p.dir, { recursive: true });
    return p;
  }

  it("pushes the built upload and writes the snapshot", async () => {
    const p = tempPaths();
    let pushed: unknown;
    const upload = await publishCard(cfg, p, async (_relay, _auth, u) => { pushed = u; });
    expect(pushed).toEqual(upload);
    expect(upload.tasks.map((t) => t.id)).toEqual(["ask"]); // DEFAULT_POLICY, no tasks dir
    const snap = JSON.parse(readFileSync(p.cardSnapshotFile, "utf8"));
    expect(snap).toEqual(upload);
  });

  it("does not write the snapshot when the push fails", async () => {
    const p = tempPaths();
    await expect(publishCard(cfg, p, async () => { throw new Error("relay down"); })).rejects.toThrow("relay down");
    expect(() => readFileSync(p.cardSnapshotFile, "utf8")).toThrow();
  });
});
