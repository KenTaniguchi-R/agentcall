import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildCardUpload, publishCard } from "../src/card.js";
import { getLinePaths, getMachinePaths, getPaths } from "../src/paths.js";
import { ASK_TASK, type Task } from "../src/tasks.js";
import type { Policy } from "../src/policy.js";
import type { Config } from "../src/config.js";

const cfg: Config = { handle: "ken", token: "t", agent_kind: "claude", relay: "https://r" };
const intro: Task = {
  id: "owner-introduction", name: "Intro", description: "Introduce the owner.",
  examples: ["who is ken?"], envelope: { caps: ["read"] }, skill: "secret steps",
};
const meet: Task = {
  id: "schedule-meeting", name: "Schedule", description: "Book a time.",
  examples: [], envelope: { caps: ["read", "fetch"] }, skill: "",
};

describe("buildCardUpload", () => {
  const policy: Policy = {
    description: "Ken's agent",
    default_offer: ["ask", "owner-introduction"],
    callers: {
      mia: { offer: ["+schedule-meeting"], block: false },
      spammer: { offer: ["owner-introduction"], block: true },
    },
  };

  it("includes card metadata but never envelopes or SKILL.md content", () => {
    const upload = buildCardUpload(cfg, policy, [ASK_TASK, intro, meet]);
    expect(upload).toMatchObject({ description: "Ken's agent", agent_kind: "claude", default_offer: ["ask", "owner-introduction"] });
    const introEntry = upload.tasks.find((t) => t.id === "owner-introduction")!;
    expect(introEntry).toEqual({ id: "owner-introduction", name: "Intro", description: "Introduce the owner.", examples: ["who is ken?"] });
    expect(JSON.stringify(upload)).not.toContain("secret steps");
    expect(JSON.stringify(upload)).not.toContain("caps");
  });

  it("maps caller grants (stripping + prefixes) and omits blocked callers", () => {
    const upload = buildCardUpload(cfg, policy, [ASK_TASK, intro, meet]);
    expect(upload.grants).toEqual({ mia: ["schedule-meeting"] });
  });

  it("drops offered/granted ids that have no task on disk", () => {
    const stale: Policy = { description: "", default_offer: ["ask", "gone"], callers: { mia: { offer: ["also-gone"], block: false } } };
    const upload = buildCardUpload(cfg, stale, [ASK_TASK]);
    expect(upload.default_offer).toEqual(["ask"]);
    expect(upload.grants).toEqual({});
    expect(upload.tasks.map((t) => t.id)).toEqual(["ask"]);
  });
});

describe("publishCard", () => {
  function tempPaths() {
    const p = getPaths(mkdtempSync(join(tmpdir(), "agentcall-pub-")));
    mkdirSync(p.dir, { recursive: true });
    return p;
  }

  it("exposes the snapshot path on Paths", () => {
    expect(getPaths("/tmp/fakehome").cardSnapshotFile).toBe("/tmp/fakehome/.agentcall/card.pushed.json");
  });

  it("pushes the built upload and writes the snapshot", async () => {
    const p = tempPaths();
    let pushed: unknown;
    const upload = await publishCard(cfg, p, async (_relay, _auth, u) => { pushed = u; });
    expect(pushed).toEqual(upload);
    expect(upload.default_offer).toEqual(["ask"]); // DEFAULT_POLICY, no tasks dir
    const snap = JSON.parse(readFileSync(p.cardSnapshotFile, "utf8"));
    expect(snap).toEqual(upload);
  });

  it("does not write the snapshot when the push fails", async () => {
    const p = tempPaths();
    await expect(publishCard(cfg, p, async () => { throw new Error("relay down"); })).rejects.toThrow("relay down");
    expect(() => readFileSync(p.cardSnapshotFile, "utf8")).toThrow();
  });

  // publishCard's second parameter is structural (policyFile/tasksDir/
  // cardSnapshotFile), not the legacy `Paths` — so a per-line install
  // (LinePaths, from getLinePaths) satisfies it too, with no separate
  // line-scoped function needed. This is what `agentcall line add` relies on.
  it("also accepts LinePaths, for multi-line installs", async () => {
    const root = mkdtempSync(join(tmpdir(), "agentcall-pub-line-"));
    const p = getLinePaths(getMachinePaths(root, root), "claude");
    mkdirSync(p.dir, { recursive: true });
    let pushed: unknown;
    const upload = await publishCard(cfg, p, async (_relay, _auth, u) => { pushed = u; });
    expect(pushed).toEqual(upload);
    const snap = JSON.parse(readFileSync(p.cardSnapshotFile, "utf8"));
    expect(snap).toEqual(upload);
  });
});
