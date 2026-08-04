import { existsSync, readFileSync } from "node:fs";
import { buildCardUpload } from "./card.js";
import type { LineConfig } from "./config.js";
import type { LinePaths } from "./paths.js";
import { loadPolicy, stripPlus, type Policy } from "./policy.js";
import { ASK_TASK, loadTasks } from "./tasks.js";

interface CardReport {
  menu: string[];     // the owner's card as callers see it
  problems: string[]; // ✗ — broken manifests, dangling policy refs, unreadable policy; CLI exits 1
  notices: string[];  // ! — staleness / never-pushed; informational, exit 0
}

// The owner-facing view of `agentcall card` with no arguments: render the
// menu from the same loadPolicy/loadTasks/buildCardUpload path the push
// uses, but route every warning to the terminal instead of the listener
// log (spec: error-visibility principle).
export function buildCardReport(cfg: LineConfig, p: LinePaths): CardReport {
  const problems: string[] = [];
  const notices: string[] = [];

  const tasks = loadTasks(p, (msg) => problems.push(msg.replace(/^agentcall: /, "")));

  let policy: Policy;
  try {
    policy = loadPolicy(p);
  } catch (e) {
    problems.push(`policy.json: invalid (${String(e).slice(0, 200)})`);
    return { menu: [], problems, notices };
  }

  const exists = (id: string) => tasks.some((t) => t.id === stripPlus(id));
  for (const id of policy.default_offer) {
    if (!exists(id)) problems.push(`policy.json: default_offer references "${stripPlus(id)}" but no such task exists`);
  }
  for (const [caller, entry] of Object.entries(policy.callers)) {
    for (const id of entry.offer) {
      if (!exists(id)) problems.push(`policy.json: grant for ${caller} references "${stripPlus(id)}" but no such task exists`);
    }
  }
  for (const [group, entry] of Object.entries(policy.groups)) {
    for (const id of entry.offer) {
      if (!exists(id)) problems.push(`policy.json: grant for group ${group} references "${stripPlus(id)}" but no such task exists`);
    }
  }

  const upload = buildCardUpload(cfg, policy, tasks);
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const menu: string[] = [`${cfg.handle} (${cfg.agent_kind})${upload.description ? ` — ${upload.description}` : ""}`];
  menu.push("  Offered to anyone:");
  for (const id of upload.default_offer) {
    const t = byId.get(id)!;
    menu.push(`    ${id} — ${t.description}`);
  }
  const grantEntries = Object.entries(upload.grants);
  if (grantEntries.length > 0) {
    menu.push("  Granted per caller:");
    for (const [caller, ids] of grantEntries) {
      menu.push(`    ${caller}: ${ids.join(", ")}`);
    }
  }
  const blocked = Object.entries(policy.callers).filter(([, e]) => e.block).map(([h]) => h);
  if (blocked.length > 0) menu.push(`  Blocked: ${blocked.join(", ")}`);

  // codex has no per-tool allowlist (see runner.ts's codex branch): only the
  // `write` cap maps to anything (workspace-write vs read-only sandbox
  // level). A task's `tools:` list excluding "exec" promises no shell
  // execution, but under codex that promise doesn't hold — surface it here
  // rather than leave the owner to discover it the hard way.
  if (cfg.agent_kind === "codex") {
    for (const t of tasks) {
      if (t.id === ASK_TASK.id) continue;
      if (!t.envelope.caps.includes("exec")) {
        notices.push(
          `task "${t.id}": codex has no per-tool restriction, so this task can still execute arbitrary ` +
          `shell commands regardless of its \`tools:\` list — only the \`write\` cap has any real effect ` +
          `(it toggles codex's read-only vs workspace-write sandbox mode)`,
        );
      }
    }
  }

  if (!existsSync(p.cardSnapshotFile)) {
    notices.push("card has never been pushed — run `agentcall card push`");
  } else {
    try {
      const snapshot = JSON.parse(readFileSync(p.cardSnapshotFile, "utf8"));
      if (JSON.stringify(snapshot) !== JSON.stringify(upload)) {
        notices.push("card out of date: local menu differs from last push — run `agentcall card push`");
      }
    } catch {
      notices.push("card snapshot unreadable — run `agentcall card push` to refresh it");
    }
  }

  return { menu, problems, notices };
}
