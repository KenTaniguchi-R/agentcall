import { describe, expect, it } from "vitest";
import { renderPolicyReport } from "../src/policy-report.js";
import type { Policy } from "../src/policy.js";
import { ASK_TASK, type Task } from "../src/tasks.js";

const ROSTER_ID = "r".repeat(22);
const deploy: Task = {
  id: "deploy",
  name: "Deploy production",
  description: "Build and deploy the service.",
  examples: [],
  keywords: [],
  threadable: false,
  skill: "",
};
const browse: Task = {
  id: "browse-docs",
  name: "Browse documentation",
  description: "Read public documentation.",
  examples: [],
  keywords: [],
  threadable: true,
  skill: "",
};
const shell: Task = {
  id: "shell",
  name: "Run diagnostics",
  description: "Run a diagnostic command.",
  examples: [],
  keywords: [],
  threadable: false,
  skill: "",
};

const policy: Policy = {
  description: "Production support policy",
  default_clearance: "public",
  callers: {
    alice: { clearance: "internal", block: false },
    "blocked-bot": { clearance: "internal", block: true },
  },
  groups: {
    engineers: { roster_id: ROSTER_ID, clearance: "internal" },
  },
  tests: [{ caller: "alice", expect_clearance: "internal", groups: [] }],
};

describe("renderPolicyReport", () => {
  it("renders effective default, caller, group, block, task, and assertion policy in plain language", () => {
    const report = renderPolicyReport(policy, [ASK_TASK, deploy, browse, shell], {
      agentKind: "claude",
      managed: true,
      defaultWorkdir: "/srv/agentcall-default",
    });

    expect(report).toContain("Effective clearance policy");
    expect(report).toContain("Agent runtime: Claude");
    expect(report).toContain("Administrator policy: active — combined result shown below");
    expect(report).toContain("Policy checks: 1 passed while loading this policy");
    // Capabilities are gone (#372): every task reads and only reads, so the
    // report states that once per task instead of enumerating a per-task list.
    // The per-audience task menus are gone too (#379): the task list is the
    // same for everyone, so it is printed once and each audience shows only
    // the clearance it resolves to.
    expect(report).toMatch(/Tasks — every caller who is not blocked can request any of these[\s\S]*ask — Ask a question[\s\S]*inspect files — answers are read-only[\s\S]*Working directory: \/srv\/agentcall-default/);
    // Every task reports the SAME directory now: #372 deleted task `workdir`,
    // so the spawn directory is derived per CALLER from the sensitivity map
    // rather than per task.
    expect(report).toMatch(/browse-docs — Browse documentation[\s\S]*Working directory: \/srv\/agentcall-default/);
    expect(report).toMatch(/shell — Run diagnostics[\s\S]*inspect files — answers are read-only/);
    expect(report).not.toMatch(/exec — run shell commands/);
    expect(report).toMatch(/Base rule: Everyone registered[\s\S]*May be told: public content and below/);
    expect(report).toMatch(/Named caller rule: alice \(before roster clearances\)[\s\S]*May be told: internal content and below/);
    expect(report).toMatch(/Named caller rule: blocked-bot \(before roster clearances\)[\s\S]*BLOCKED — no call is answered at all/);
    expect(report).toMatch(new RegExp(`Roster rule: engineers \\(${ROSTER_ID}\\) — applies to each attested member[\\s\\S]*May be told: internal content and below`));
    expect(report).toContain("For one caller: start with the base rule, take the highest of their named rule and every roster the relay attests.");
    // The refusal is the enforcement point, so it has to appear in the report
    // the owner reads to understand what their policy does.
    expect(report).toContain("anything unlabelled is secret and never leaves");
    expect(report).toContain("the reply is refused unless that is at or below the caller's clearance");
  });

  it("states the weaker Codex enforcement semantics instead of implying per-tool controls", () => {
    const report = renderPolicyReport(policy, [ASK_TASK, deploy, browse, shell], {
      agentKind: "codex",
      managed: false,
      defaultWorkdir: "/srv/agentcall-default",
    });

    expect(report).toContain("Agent runtime: Codex");
    expect(report).toContain("Codex has no per-tool restriction");
    expect(report).toContain("--sandbox read-only stops writes, not reads or execution");
    expect(report).toContain("the clearance check on the reply is what bounds what leaves");
    expect(report).toContain("Bundled authenticated Codex apps, web search, and image generation are disabled on every spawn");
    expect(report).toContain("On verified codex-cli 0.146.0");
    expect(report).toContain("shell tool attempts are recorded by an observe-only hook");
    expect(report).toContain("unless managed-only hooks are required");
    expect(report).toContain("Other Codex releases or allow_managed_hooks_only=true may silently skip that hook");
    expect(report).toContain("Run agentcall doctor to verify the exact Codex session hook");
    expect(report).toContain("non-hooked read routes remain unrecorded");
    expect(report).not.toContain("shell actions are recorded, not blocked");
    // #372 deleted fetch and exec as separate grants, so the report must stop
    // describing them as Codex controls that merely happen to be unenforced.
    expect(report).not.toContain("fetch and exec are not separate Codex controls");
  });
});
