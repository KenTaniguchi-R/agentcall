import { clearanceFor } from "./clearance.js";
import type { CallableLineConfig } from "./config.js";
import { type Policy } from "./policy.js";
import type { Sensitivity } from "./sensitivity.js";
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
  lines.push(`    Working directory: ${defaultWorkdir}`);
  if (task.timeout_s !== undefined) lines.push(`    Time limit: ${task.timeout_s} seconds`);
  return lines;
}

// One audience, one clearance. Before #379 this printed a per-audience task
// menu; a task is no longer individually granted, so the task list is the same
// for everyone and what changes per audience is only how much of an answer may
// reach them.
function renderAudience(
  heading: string,
  clearance: Sensitivity | "blocked",
): string[] {
  const lines = [heading];
  if (clearance === "blocked") {
    lines.push("  BLOCKED — no call is answered at all (a saved clearance stays inactive)");
    return lines;
  }
  lines.push(`  May be told: ${clearance} content and below`);
  lines.push("  Anything more sensitive is refused at the reply, with a fixed reason");
  return lines;
}

export function renderPolicyReport(
  policy: Policy,
  tasks: readonly Task[],
  options: PolicyReportOptions,
): string {
  const lines = [
    "Effective clearance policy",
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
  // Enforcement is on the READ, not on the reply. An earlier revision of this
  // block said the reply was refused unless the context was within clearance —
  // there is no such check anywhere. listener.ts runs redactOutbound over the
  // answer, which replaces credential-shaped strings and this line's own relay
  // token, and nothing else looks at it. Naming a control that does not exist
  // is worse than naming none: it tells an owner they are covered.
  lines.push(
    "  Sources are labelled by sensitivity; anything unlabelled is secret and never leaves.",
    "  A path above this caller's clearance is refused AT THE READ, before the agent sees it.",
    "  The answer itself is not inspected — only credential-shaped strings are redacted from it.",
  );
  if (options.agentKind === "claude") {
    lines.push(
      "  Claude denies first-class tools not named by the task, and Bash is recorded, not blocked.",
    );
  } else {
    lines.push(
      "  WARNING: on Codex the sensitivity model is NOT enforced. The guard runs in observe",
      "  mode, so a read above this caller's clearance is recorded and then allowed.",
      "  --sandbox read-only stops writes, not reads or execution, and there is no check on the",
      "  reply. Treat a Codex line's clearances as documentation of intent, not as a boundary.",
      "  Bundled authenticated Codex apps, web search, and image generation are disabled on every spawn.",
      "  On verified codex-cli 0.146.0, shell tool attempts are recorded by an observe-only hook unless managed-only hooks are required.",
      "  Other Codex releases or allow_managed_hooks_only=true may silently skip that hook; non-hooked read routes remain unrecorded.",
      "  Run agentcall doctor to verify the exact Codex session hook is active and trusted on this machine.",
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
    "For one caller: start with the base rule, take the highest of their named rule and every roster the relay attests.",
    "A named caller block overrides every default and roster clearance.",
    "",
    // Empty is not a valid handle, so the base rule cannot accidentally pick up
    // a named caller's clearance.
    ...renderAudience("Base rule: Everyone registered", clearanceFor(policy, "")),
  );

  for (const [caller] of Object.entries(policy.callers).sort(([a], [b]) => a.localeCompare(b))) {
    // clearanceFor applies the same block precedence as listener admission.
    lines.push(
      "",
      ...renderAudience(
        `Named caller rule: ${caller} (before roster clearances)`,
        clearanceFor(policy, caller),
      ),
    );
  }

  for (const [name, group] of Object.entries(policy.groups).sort(([a], [b]) => a.localeCompare(b))) {
    // Defaults plus exactly this attested roster, matching clearanceFor's
    // production union semantics.
    lines.push(
      "",
      ...renderAudience(
        `Roster rule: ${name} (${group.roster_id}) — applies to each attested member`,
        clearanceFor(policy, "", [group.roster_id]),
      ),
    );
  }

  return `${lines.join("\n")}\n`;
}
