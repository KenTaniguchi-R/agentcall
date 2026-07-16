import { describe, expect, it } from "vitest";
import { buildCardUpload } from "../src/card.js";
import { ASK_TASK, type Task } from "../src/tasks.js";
import type { Policy } from "../src/policy.js";
import type { Config } from "../src/config.js";

const cfg: Config = { handle: "ken", token: "t", agent_kind: "claude", relay: "https://r" };
const intro: Task = {
  id: "owner-introduction", name: "Intro", description: "Introduce the owner.",
  examples: ["who is ken?"], tier: "T1", envelope: { caps: ["read"], write_paths: [], network: [] }, skill: "secret steps",
};
const meet: Task = {
  id: "schedule-meeting", name: "Schedule", description: "Book a time.",
  examples: [], tier: "T2", envelope: { caps: ["read", "fetch"], write_paths: [], network: ["calendar.google.com"] }, skill: "",
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
    expect(introEntry).toEqual({ id: "owner-introduction", name: "Intro", description: "Introduce the owner.", examples: ["who is ken?"], tier: "T1" });
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
