import { existsSync, readFileSync } from "node:fs";
import { buildCardUpload } from "./card.js";
import type { LineConfig } from "./config.js";
import type { LinePaths } from "./paths.js";
import { accessFor } from "./access.js";
import { loadPolicy, type Policy } from "./policy.js";
import { ASK_TASK, loadTasks } from "./tasks.js";

interface CardReport {
  menu: string[];     // the owner's card as callers see it
  problems: string[]; // ✗ — broken manifests, unreadable or invalid policy; CLI exits 1
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

  // The dangling-grant checks that used to live here are gone with the menu:
  // there is no longer any way for policy.json to name a task, so it cannot
  // name one that does not exist. What replaces them is the clearance readout
  // below — the owner-facing question is no longer "who can run what" but
  // "who can be told what".
  const upload = buildCardUpload(cfg, policy, tasks);
  const menu: string[] = [`${cfg.handle} (${cfg.agent_kind})${upload.description ? ` — ${upload.description}` : ""}`];
  menu.push("  Every caller who is not blocked can request:");
  for (const t of upload.tasks) menu.push(`    ${t.id} — ${t.description}`);
  menu.push(`  Anyone registered by default: ${policy.default_access}`);
  // Resolved, not the raw entry: a block sinks a named clearance, and printing
  // the stored value would tell the owner a grant is live that is not.
  const named = Object.keys(policy.callers).sort((x, y) => x.localeCompare(y));
  for (const caller of named) {
    menu.push(`    ${caller}: ${accessFor(policy, caller)}`);
  }

  // Codex gets no guard hook at all as of 2026-08-07. It previously ran one in
  // "observe" mode, which recorded a verdict and then allowed the tool call
  // unconditionally — including on its own failure paths. Installing a guard
  // that never denies bought a log line and a second meaning for the word
  // "guard"; the hook is gone and this notice says the plain thing instead.
  if (cfg.agent_kind === "codex") {
    for (const t of tasks) {
      if (t.id === ASK_TASK.id) continue;
      notices.push(
        `task "${t.id}": codex has no per-tool restriction and no read guard, so it can run ` +
        `shell commands and read anything on this machine. --sandbox read-only prevents writes ` +
        `but not reads or execution, and nothing checks the answer. Use Claude for a bounded line.`,
      );
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
