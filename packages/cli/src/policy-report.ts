import { accessFor, type Access } from "./access.js";
import type { CallableLineConfig } from "./config.js";
import { type Policy } from "./policy.js";
import { type Task } from "./tasks.js";

interface PolicyReportOptions {
  agentKind: CallableLineConfig["agent_kind"];
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
  access: Access,
): string[] {
  const lines = [heading];
  if (access === "blocked") {
    lines.push("  BLOCKED — no call is answered at all");
    return lines;
  }
  // One grantable level, so there is no "and below" to state: everything the
  // owner has labelled is reachable, and everything else is refused at the read.
  lines.push("  ANSWERED — may be told anything not marked secret");
  lines.push("  A secret source is refused when the agent tries to read it, with a fixed reason");
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
    "For one caller: a named rule wins; otherwise a blocked roster wins over an allowed one; otherwise the base rule.",
    "A named caller block overrides the default and every roster rule.",
    "",
    // Empty is not a valid handle, so the base rule cannot accidentally pick up
    // a named caller's clearance.
    ...renderAudience("Base rule: Everyone registered", accessFor(policy, "")),
  );

  for (const [caller] of Object.entries(policy.callers).sort(([a], [b]) => a.localeCompare(b))) {
    // accessFor applies the same block precedence as listener admission.
    lines.push(
      "",
      ...renderAudience(
        `Named caller rule: ${caller} (overrides rosters)`,
        accessFor(policy, caller),
      ),
    );
  }

  for (const [name, group] of Object.entries(policy.groups).sort(([a], [b]) => a.localeCompare(b))) {
    // Defaults plus exactly this attested roster, matching accessFor's
    // production union semantics.
    lines.push(
      "",
      ...renderAudience(
        `Roster rule: ${name} (${group.roster_id}) — applies to each attested member`,
        accessFor(policy, "", [group.roster_id]),
      ),
    );
  }

  return `${lines.join("\n")}\n`;
}
