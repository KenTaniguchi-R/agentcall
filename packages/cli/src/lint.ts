import { existsSync, readFileSync } from "node:fs";
import { buildCardUpload } from "./card.js";
import type { Config } from "./config.js";
import type { Paths } from "./paths.js";
import { loadPolicy, type Policy } from "./policy.js";
import { loadTasks } from "./tasks.js";

export interface CardReport {
  menu: string[];     // the owner's card as callers see it
  problems: string[]; // ✗ — broken manifests, dangling policy refs, unreadable policy; CLI exits 1
  notices: string[];  // ! — staleness / never-pushed; informational, exit 0
}

// The owner-facing view of `agentcall card` with no arguments: render the
// menu from the same loadPolicy/loadTasks/buildCardUpload path the push
// uses, but route every warning to the terminal instead of the listener
// log (spec: error-visibility principle).
export function buildCardReport(cfg: Config, p: Paths): CardReport {
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

  const exists = (id: string) => tasks.some((t) => t.id === id.replace(/^\+/, ""));
  for (const id of policy.default_offer) {
    if (!exists(id)) problems.push(`policy.json: default_offer references "${id.replace(/^\+/, "")}" but no such task exists`);
  }
  for (const [caller, entry] of Object.entries(policy.callers)) {
    for (const id of entry.offer) {
      if (!exists(id)) problems.push(`policy.json: grant for ${caller} references "${id.replace(/^\+/, "")}" but no such task exists`);
    }
  }

  const upload = buildCardUpload(cfg, policy, tasks);
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const menu: string[] = [`${cfg.handle} (${cfg.agent_kind})${upload.description ? ` — ${upload.description}` : ""}`];
  menu.push("  Offered to anyone:");
  for (const id of upload.default_offer) {
    const t = byId.get(id)!;
    menu.push(`    ${id} [${t.tier}] — ${t.description}`);
  }
  const grantEntries = Object.entries(upload.grants);
  if (grantEntries.length > 0) {
    menu.push("  Granted per caller:");
    for (const [caller, ids] of grantEntries) menu.push(`    ${caller}: ${ids.join(", ")}`);
  }
  const blocked = Object.entries(policy.callers).filter(([, e]) => e.block).map(([h]) => h);
  if (blocked.length > 0) menu.push(`  Blocked: ${blocked.join(", ")}`);

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
