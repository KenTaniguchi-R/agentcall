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
  envelope: { caps: ["read", "write", "exec"] },
  threadable: false,
  skill: "",
};
const browse: Task = {
  id: "browse-docs",
  name: "Browse documentation",
  description: "Read public documentation.",
  examples: [],
  keywords: [],
  envelope: { caps: ["read", "fetch"] },
  workdir: "/srv/docs",
  threadable: true,
  skill: "",
};
const shell: Task = {
  id: "shell",
  name: "Run diagnostics",
  description: "Run a diagnostic command.",
  examples: [],
  keywords: [],
  envelope: { caps: ["exec"] },
  threadable: false,
  skill: "",
};

const policy: Policy = {
  description: "Production support policy",
  default_offer: ["ask", "missing-task"],
  callers: {
    alice: { offer: ["deploy", "shell"], block: false },
    "blocked-bot": { offer: ["deploy"], block: true },
  },
  groups: {
    engineers: { roster_id: ROSTER_ID, offer: ["browse-docs"] },
  },
  tests: [{ caller: "alice", accept: ["deploy"], groups: [], deny: [] }],
};

describe("renderPolicyReport", () => {
  it("renders effective default, caller, group, block, task, and assertion policy in plain language", () => {
    const report = renderPolicyReport(policy, [ASK_TASK, deploy, browse, shell], {
      agentKind: "claude",
      managed: true,
      defaultWorkdir: "/srv/agentcall-default",
    });

    expect(report).toContain("Effective capability policy");
    expect(report).toContain("Agent runtime: Claude");
    expect(report).toContain("Administrator policy: active — combined result shown below");
    expect(report).toContain("Policy checks: 1 passed while loading this policy");
    expect(report).toMatch(/Everyone registered[\s\S]*ask — Ask a question[\s\S]*read — inspect files[\s\S]*Working directory: \/srv\/agentcall-default/);
    expect(report).toMatch(/Named caller rule: alice \(before roster grants\)[\s\S]*deploy — Deploy production[\s\S]*write — change files[\s\S]*exec — run shell commands/);
    expect(report).toMatch(/shell — Run diagnostics[\s\S]*exec — run shell commands[\s\S]*WARNING: exec can read, change, and send data outside this working directory/);
    expect(report).toMatch(/Named caller rule: blocked-bot \(before roster grants\)[\s\S]*BLOCKED — no task can run/);
    expect(report).toMatch(new RegExp(`Roster rule: engineers \\(${ROSTER_ID}\\) — adds for each attested member[\\s\\S]*browse-docs — Browse documentation[\\s\\S]*fetch — use web tools[\\s\\S]*Working directory: /srv/docs`));
    expect(report).toContain("Ignored missing task references: missing-task");
    expect(report).toContain("For one caller: start with the base rule, add their named rule, then add every roster the relay attests.");
    expect(report).toContain("An exec grant includes practical read, write, and network power through Bash");
  });

  it("states the weaker Codex enforcement semantics instead of implying per-tool controls", () => {
    const report = renderPolicyReport(policy, [ASK_TASK, deploy, browse, shell], {
      agentKind: "codex",
      managed: false,
      defaultWorkdir: "/srv/agentcall-default",
    });

    expect(report).toContain("Agent runtime: Codex");
    expect(report).toContain("Codex only enforces the write boundary");
    expect(report).toContain("read-only or workspace-write sandbox");
    expect(report).toContain("fetch and exec are not separate Codex controls");
    expect(report).toContain("Codex can execute shell commands whether or not a task declares exec");
    expect(report).toContain("On verified codex-cli 0.146.0");
    expect(report).toContain("shell tool attempts are recorded by an observe-only hook");
    expect(report).toContain("unless managed-only hooks are required");
    expect(report).toContain("Other Codex releases or allow_managed_hooks_only=true may silently skip that hook");
    expect(report).toContain("Run agentcall doctor to verify the exact Codex session hook");
    expect(report).toContain("non-hooked read routes remain unrecorded");
    expect(report).not.toContain("shell actions are recorded, not blocked");
  });
});
