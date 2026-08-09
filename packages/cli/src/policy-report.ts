import { accessFor, type Access } from "./access.js";
import type { CallableLineConfig } from "./config.js";
import { type Policy } from "./policy.js";
import { type Task } from "./tasks.js";

interface PolicyReportOptions {
  agentKind: CallableLineConfig["agent_kind"];
  defaultWorkdir: string;
  readableRoots: readonly string[];
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
  lines.push(`    Working directory: ${defaultWorkdir}`);
  if (task.timeout_s !== undefined) lines.push(`    Time limit: ${task.timeout_s} seconds`);
  return lines;
}

// One audience, one access decision. Before #379 this printed a per-audience
// task menu; a task is no longer individually granted, so the task list is the
// same for everyone and policy only decides whether a call is admitted.
function renderAudience(
  heading: string,
  access: Access,
): string[] {
  const lines = [heading];
  if (access === "blocked") {
    lines.push("  BLOCKED — no call is answered at all");
    return lines;
  }
  lines.push("  ANSWERED — calls from this audience are admitted");
  lines.push("  Every admitted caller has the same task and read scope");
  return lines;
}

export function renderPolicyReport(
  policy: Policy,
  tasks: readonly Task[],
  options: PolicyReportOptions,
): string {
  const lines = [
    "Effective access policy",
    `Agent runtime: ${options.agentKind === "claude" ? "Claude" : "Codex"}`,
    policy.tests?.length
      ? `Policy checks: ${policy.tests.length} passed while loading this policy`
      : "Policy checks: none configured",
  ];
  if (policy.description) lines.push(`Purpose: ${policy.description}`);

  lines.push("", "Runtime enforcement");
  // Enforcement is on Claude's first-class file tools, not on the reply.
  // listener.ts runs redactOutbound over the answer, which replaces
  // credential-shaped strings and this line's own relay token, and nothing else
  // looks at it. Naming a control that does not exist tells an owner they are
  // covered when they are not.
  lines.push(
    options.readableRoots.length > 0
      ? `  Claude may read under: ${options.readableRoots.join(", ")}.`
      : "  Claude has no usable configured read root.",
    "  Paths outside those roots, and paths on the built-in or owner denylist, are refused at the read.",
    "  The answer itself is not inspected — only credential-shaped strings are redacted from it.",
  );
  if (options.agentKind === "claude") {
    lines.push(
      "  Claude permits read-only first-class tools; Bash is recorded, not blocked, and bypasses this read guard.",
    );
  } else {
    lines.push(
      "  WARNING: on Codex there is NO read guard. Nothing stops the agent reading a secret",
      "  path, and nothing checks the answer. --sandbox read-only stops writes, not reads or",
      "  execution. A Codex line can be told to read anything on this machine.",
      "  Bundled authenticated Codex apps, web search, and image generation are disabled on every spawn.",
      "  Use Claude for any line where what leaves the machine has to be bounded.",
    );
  }

  lines.push(
    "",
    "Tasks — every caller who is not blocked can request any of these",
  );
  if (tasks.length === 0) {
    lines.push("  (none)");
  } else {
    for (const task of tasks) lines.push(...renderTask(task, options.defaultWorkdir));
  }

  lines.push(
    "",
    "Rules that compose at call time",
    "For one caller: a named rule wins; otherwise the base rule applies.",
    "",
    // Empty is not a valid handle, so the base rule cannot accidentally pick up
    // a named caller's clearance.
    ...renderAudience("Base rule: Everyone registered", accessFor(policy, "")),
  );

  for (const [caller] of Object.entries(policy.callers).sort(([a], [b]) => a.localeCompare(b))) {
    // accessFor applies the same named-rule precedence as listener admission.
    lines.push(
      "",
      ...renderAudience(
        `Named caller rule: ${caller} (overrides the base rule)`,
        accessFor(policy, caller),
      ),
    );
  }

  return `${lines.join("\n")}\n`;
}
