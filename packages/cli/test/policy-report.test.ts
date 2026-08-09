import { describe, expect, it } from "vitest";
import { renderPolicyReport } from "../src/policy-report.js";
import type { Policy } from "../src/policy.js";
import { ASK_TASK, type Task } from "../src/tasks.js";

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
  tests: [{ caller: "alice", expect_access: "allowed" as const }],
};

describe("renderPolicyReport", () => {
  it("renders effective default, caller, block, task, and assertion policy in plain language", () => {
    const report = renderPolicyReport(policy, [ASK_TASK, deploy, browse, shell], {
      agentKind: "claude",
      defaultWorkdir: "/srv/agentcall-default",
      readableRoots: ["/srv/agentcall-default", "/srv/shared"],
    });

    expect(report).toContain("Effective access policy");
    expect(report).toContain("Agent runtime: Claude");
    expect(report).toContain("Policy checks: 1 passed while loading this policy");
    // Capabilities are gone (#372): every task reads and only reads, so the
    // report states that once per task instead of enumerating a per-task list.
    // The per-audience task menus are gone too (#379): the task list is the
    // same for everyone, so it is printed once and each audience shows only
    // whether calls are admitted.
    expect(report).toMatch(/Tasks — every caller who is not blocked can request any of these[\s\S]*ask — Ask a question[\s\S]*inspect files — answers are read-only[\s\S]*Working directory: \/srv\/agentcall-default/);
    // Every task reports the same derived directory: scope is line-wide, not
    // per task or per caller.
    expect(report).toMatch(/browse-docs — Browse documentation[\s\S]*Working directory: \/srv\/agentcall-default/);
    expect(report).toMatch(/shell — Run diagnostics[\s\S]*inspect files — answers are read-only/);
    expect(report).not.toMatch(/exec — run shell commands/);
    expect(report).toMatch(/Base rule: Everyone registered[\s\S]*ANSWERED — calls from this audience are admitted/);
    expect(report).toMatch(/Named caller rule: alice \(overrides the base rule\)[\s\S]*ANSWERED — calls from this audience are admitted/);
    expect(report).toMatch(/Named caller rule: blocked-bot \(overrides the base rule\)[\s\S]*BLOCKED — no call is answered at all/);
    expect(report).toContain("For one caller: a named rule wins; otherwise the base rule applies.");
    expect(report).toContain("Claude may read under: /srv/agentcall-default, /srv/shared.");
    expect(report).toContain("Paths outside those roots, and paths on the built-in or owner denylist, are refused at the read.");
    expect(report).toContain("Bash is recorded, not blocked, and bypasses this read guard.");
    expect(report).toContain("The answer itself is not inspected");
    expect(report).not.toMatch(/reply is refused/i);
  });

  it("states the weaker Codex enforcement semantics instead of implying per-tool controls", () => {
    const report = renderPolicyReport(policy, [ASK_TASK, deploy, browse, shell], {
      agentKind: "codex",
      defaultWorkdir: "/srv/agentcall-default",
      readableRoots: ["/srv/agentcall-default"],
    });

    expect(report).toContain("Agent runtime: Codex");
    // The honest statement. Codex gets no guard hook at all as of 2026-08-07 —
    // it previously ran one in "observe" mode, which recorded a verdict and
    // then allowed the call unconditionally. The report says the plain thing
    // rather than naming a control that never denied anything.
    expect(report).toContain("on Codex there is NO read guard");
    expect(report).toContain("--sandbox read-only stops writes, not reads or");
    expect(report).toContain("can be told to read anything on this machine");
    expect(report).toContain("Bundled authenticated Codex apps, web search, and image generation are disabled on every spawn");
    // No control may be named that does not exist. These three all described
    // the observe-mode hook, which is gone; a report that still mentioned it
    // would be the #390 defect again.
    expect(report).not.toMatch(/clearance check on the reply/i);
    expect(report).not.toMatch(/observe/i);
    expect(report).not.toMatch(/recorded and then allowed/i);
    expect(report).not.toContain("shell actions are recorded, not blocked");
    // #372 deleted fetch and exec as separate grants, so the report must stop
    // describing them as Codex controls that merely happen to be unenforced.
    expect(report).not.toContain("fetch and exec are not separate Codex controls");
  });

  it("does not invent a read root when none is usable", () => {
    const report = renderPolicyReport(policy, [ASK_TASK], {
      agentKind: "claude",
      defaultWorkdir: "/srv/agentcall-default",
      readableRoots: [],
    });

    expect(report).toContain("Claude has no usable configured read root.");
    expect(report).not.toContain("Claude may read under:");
  });
});
