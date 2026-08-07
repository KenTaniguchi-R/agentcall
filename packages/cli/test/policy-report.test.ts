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
  default_access: "allowed", callers: {
    alice: {},
    "blocked-bot": { access: "blocked" },
  },
  groups: {
    engineers: { roster_id: ROSTER_ID },
  },
  tests: [{ caller: "alice", groups: [], expect_access: "allowed" as const }],
};

describe("renderPolicyReport", () => {
  it("renders effective default, caller, group, block, task, and assertion policy in plain language", () => {
    const report = renderPolicyReport(policy, [ASK_TASK, deploy, browse, shell], {
      agentKind: "claude",
      defaultWorkdir: "/srv/agentcall-default",
    });

    expect(report).toContain("Effective access policy");
    expect(report).toContain("Agent runtime: Claude");
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
    expect(report).toMatch(/Base rule: Everyone registered[\s\S]*ANSWERED — may be told anything not marked secret/);
    expect(report).toMatch(/Named caller rule: alice \(overrides rosters\)[\s\S]*ANSWERED — may be told anything not marked secret/);
    expect(report).toMatch(/Named caller rule: blocked-bot \(overrides rosters\)[\s\S]*BLOCKED — no call is answered at all/);
    expect(report).toMatch(new RegExp(`Roster rule: engineers \\(${ROSTER_ID}\\) — applies to each attested member[\\s\\S]*ANSWERED — may be told anything not marked secret`));
    expect(report).toContain("For one caller: a named rule wins; otherwise a blocked roster wins over an allowed one; otherwise the base rule.");
    // The enforcement point is the READ, and the report has to say so. It
    // previously claimed the reply was refused unless the context was within
    // clearance; no such check exists (listener.ts only runs redactOutbound).
    // Pinned as an absence too, because naming a control that does not exist
    // tells an owner they are covered when they are not.
    expect(report).toContain("anything unlabelled is secret and never leaves");
    expect(report).toContain("refused AT THE READ, before the agent sees it");
    expect(report).toContain("The answer itself is not inspected");
    expect(report).not.toMatch(/reply is refused/i);
  });

  it("states the weaker Codex enforcement semantics instead of implying per-tool controls", () => {
    const report = renderPolicyReport(policy, [ASK_TASK, deploy, browse, shell], {
      agentKind: "codex",
      defaultWorkdir: "/srv/agentcall-default",
    });

    expect(report).toContain("Agent runtime: Codex");
    // The honest statement, and the one this test previously got wrong. On
    // codex the guard runs in observe mode AND there is no reply check, so
    // nothing in the sensitivity model is enforced — clearance decides only
    // what gets logged. The old text pointed at "the clearance check on the
    // reply" as the compensating control, which does not exist.
    expect(report).toContain("on Codex the sensitivity model is NOT enforced");
    expect(report).toContain("recorded and then allowed");
    expect(report).toContain("--sandbox read-only stops writes, not reads or execution");
    expect(report).toContain("intent, not as a boundary");
    expect(report).not.toMatch(/clearance check on the reply/i);
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
