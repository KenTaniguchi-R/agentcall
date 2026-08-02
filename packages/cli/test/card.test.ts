import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildCardUpload, publishCard } from "../src/card.js";
import { getLinePaths, getMachinePaths } from "../src/paths.js";
import { ASK_TASK, type Task } from "../src/tasks.js";
import type { Policy } from "../src/policy.js";
import type { LineConfig } from "../src/config.js";

const cfg: LineConfig = { org: "acme", handle: "ken", token: "t", agent_kind: "claude", relay: "https://r" };
const intro: Task = {
  id: "owner-introduction", name: "Intro", description: "Introduce the owner.",
  examples: ["who is ken?"], keywords: [], envelope: { caps: ["read"] }, threadable: true, skill: "secret steps",
};
const meet: Task = {
  id: "schedule-meeting", name: "Schedule", description: "Book a time.",
  examples: [], keywords: [], envelope: { caps: ["read", "fetch"] }, threadable: true, skill: "",
};

describe("buildCardUpload", () => {
  const policy: Policy = {
    description: "Ken's agent",
    default_offer: ["ask", "owner-introduction"],
    callers: {
      mia: { offer: ["+schedule-meeting"], block: false },
      spammer: { offer: ["owner-introduction"], block: true },
    },
    groups: { eng: { roster_id: "g".repeat(22), offer: ["schedule-meeting"] } },
  };

  it("includes card metadata but never envelopes or SKILL.md content", () => {
    const upload = buildCardUpload(cfg, policy, [ASK_TASK, intro, meet]);
    expect(upload).toMatchObject({ description: "Ken's agent", agent_kind: "claude", default_offer: ["ask", "owner-introduction"] });
    const introEntry = upload.tasks.find((t) => t.id === "owner-introduction")!;
    expect(introEntry).toEqual({ id: "owner-introduction", name: "Intro", description: "Introduce the owner.", examples: ["who is ken?"], keywords: [] });
    expect(JSON.stringify(upload)).not.toContain("secret steps");
    expect(JSON.stringify(upload)).not.toContain("caps");
  });

  it("maps caller grants (stripping + prefixes) and omits blocked callers", () => {
    const upload = buildCardUpload(cfg, policy, [ASK_TASK, intro, meet]);
    expect(upload.grants).toEqual({ mia: ["schedule-meeting"] });
    expect(upload.group_grants).toEqual({ ["g".repeat(22)]: ["schedule-meeting"] });
    expect(upload.blocked).toEqual(["spammer"]);
  });

  it("drops offered/granted ids that have no task on disk", () => {
    const stale: Policy = {
      description: "", default_offer: ["ask", "gone"],
      callers: { mia: { offer: ["also-gone"], block: false } }, groups: {},
    };
    const upload = buildCardUpload(cfg, stale, [ASK_TASK]);
    expect(upload.default_offer).toEqual(["ask"]);
    expect(upload.grants).toEqual({});
    expect(upload.tasks.map((t) => t.id)).toEqual(["ask"]);
  });

  it("publishes task keywords to the relay", () => {
    const upload = buildCardUpload(
      { org: "acme", handle: "ken", token: "t", agent_kind: "claude", relay: "https://r.test" },
      { description: "d", default_offer: ["adr"], callers: {}, groups: {} },
      [{ id: "adr", name: "ADR", description: "Why.", examples: [],
         keywords: ["auth", "migration"], envelope: { caps: ["read"] }, threadable: true, skill: "" }],
    );
    expect(upload.tasks[0]!.keywords).toEqual(["auth", "migration"]);
  });
});

describe("publishCard", () => {
  function tempPaths() {
    const root = mkdtempSync(join(tmpdir(), "agentcall-pub-"));
    const p = getLinePaths(getMachinePaths(root, root), "claude");
    mkdirSync(p.dir, { recursive: true });
    return p;
  }

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
});
