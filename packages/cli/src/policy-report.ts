import type { CallableLineConfig } from "./config.js";
import { offeredFor, stripPlus, type Policy } from "./policy.js";
import { type Task } from "./tasks.js";

interface PolicyReportOptions {
  agentKind: CallableLineConfig["agent_kind"];
  managed: boolean;
  defaultWorkdir: string;
}

function renderTask(
  task: Task,
  defaultWorkdir: string,
): string[] {
  const lines = [
    `  ${task.id} — ${task.name}`,
    `    ${task.description}`,
  ];
  // Every task reads and only reads (#372): the reply is the only sink, so
  // there is no per-task capability list left to print.
  lines.push("    inspect files — answers are read-only");
  lines.push(`    Follow-up calls: ${task.threadable ? "allowed" : "not allowed"}`);
  lines.push(`    Working directory: ${task.workdir ?? defaultWorkdir}`);
  if (task.timeout_s !== undefined) lines.push(`    Time limit: ${task.timeout_s} seconds`);
  return lines;
}

function runnableTasks(offered: string[], tasks: readonly Task[]): Task[] {
  const ids = new Set(offered);
  return tasks.filter((task) => ids.has(task.id));
}

function renderAudience(
  heading: string,
  offered: string[] | "blocked",
  tasks: readonly Task[],
  defaultWorkdir: string,
): string[] {
  const lines = [heading];
  if (offered === "blocked") {
    lines.push("  BLOCKED — no task can run (saved grants remain inactive)");
    return lines;
  }
  const runnable = runnableTasks(offered, tasks);
  if (runnable.length === 0) {
    lines.push("  (no runnable tasks)");
    return lines;
  }
  for (const task of runnable) lines.push(...renderTask(task, defaultWorkdir));
  return lines;
}

function referencedTaskIds(policy: Policy): Set<string> {
  const ids = new Set(policy.default_offer.map(stripPlus));
  for (const entry of Object.values(policy.callers)) {
    for (const id of entry.offer) ids.add(stripPlus(id));
  }
  for (const group of Object.values(policy.groups)) {
    for (const id of group.offer) ids.add(stripPlus(id));
  }
  return ids;
}

export function renderPolicyReport(
  policy: Policy,
  tasks: readonly Task[],
  options: PolicyReportOptions,
): string {
  const lines = [
    "Effective capability policy",
    `Agent runtime: ${options.agentKind === "claude" ? "Claude" : "Codex"}`,
    options.managed
      ? "Administrator policy: active — combined result shown below"
      : "Administrator policy: not installed",
    policy.tests?.length
      ? `Policy checks: ${policy.tests.length} passed while loading this policy`
      : "Policy checks: none configured",
  ];
  if (policy.description) lines.push(`Purpose: ${policy.description}`);

  lines.push("", "Runtime enforcement");
  if (options.agentKind === "claude") {
    lines.push(
      "  Claude denies first-class tools not named by the task.",
      "  A fetch grant enables Claude's web tools but does not restrict them to an AgentCall domain allowlist.",
      "  An exec grant includes practical read, write, and network power through Bash, even when those caps are absent.",
      "  Bash is recorded, not blocked, and is not confined to the task working directory.",
    );
  } else {
    lines.push(
      "  Codex only enforces the write boundary with a read-only or workspace-write sandbox;",
      "  fetch and exec are not separate Codex controls, and read access is not confined to the working directory.",
      "  Codex can execute shell commands on any task; --sandbox read-only stops writes, not reads or execution.",
      "  Bundled authenticated Codex apps, web search, and image generation are disabled with strict configuration on every spawn.",
      "  AgentCall does not impose or audit a domain allowlist on Codex network access.",
      "  On verified codex-cli 0.146.0, shell tool attempts are recorded by an observe-only hook unless managed-only hooks are required.",
      "  Other Codex releases or allow_managed_hooks_only=true may silently skip that hook; non-hooked read routes remain unrecorded.",
      "  Run agentcall doctor to verify the exact Codex session hook is active and trusted on this machine.",
    );
  }

  lines.push(
    "",
    "Rules that compose at call time",
    "For one caller: start with the base rule, add their named rule, then add every roster the relay attests.",
    "A named caller block overrides every default and roster grant.",
    "",
    ...renderAudience(
      "Base rule: Everyone registered", offeredFor(policy, ""), tasks,
      options.defaultWorkdir,
    ),
  );

  for (const [caller] of Object.entries(policy.callers).sort(([a], [b]) => a.localeCompare(b))) {
    // offeredFor includes defaults and applies the same block precedence as
    // listener admission.
    lines.push(
      "",
      ...renderAudience(
        `Named caller rule: ${caller} (before roster grants)`,
        offeredFor(policy, caller),
        tasks,
        options.defaultWorkdir,
      ),
    );
  }

  for (const [name, group] of Object.entries(policy.groups).sort(([a], [b]) => a.localeCompare(b))) {
    // Empty is not a valid handle, so it cannot accidentally pick up a named
    // caller grant. The group preview is defaults plus exactly this attested
    // roster, matching offeredFor's production union semantics.
    lines.push(
      "",
      ...renderAudience(
        `Roster rule: ${name} (${group.roster_id}) — adds for each attested member`,
        offeredFor(policy, "", [group.roster_id]),
        tasks,
        options.defaultWorkdir,
      ),
    );
  }

  const taskIds = new Set(tasks.map((task) => task.id));
  const missing = [...referencedTaskIds(policy)].filter((id) => !taskIds.has(id)).sort();
  if (missing.length > 0) {
    lines.push("", `Ignored missing task references: ${missing.join(", ")}`);
  }

  return `${lines.join("\n")}\n`;
}
