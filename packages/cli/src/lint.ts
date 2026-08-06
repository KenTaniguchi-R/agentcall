import { existsSync, readFileSync } from "node:fs";
import { buildCardUpload } from "./card.js";
import type { LineConfig } from "./config.js";
import type { LinePaths } from "./paths.js";
import { clearanceFor } from "./clearance.js";
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
  menu.push(`  Anyone registered can be told: ${policy.default_clearance}`);
  // Resolved, not the raw entry: a block sinks a named clearance, and printing
  // the stored value would tell the owner a grant is live that is not.
  const named = Object.keys(policy.callers).sort((x, y) => x.localeCompare(y));
  for (const caller of named) {
    menu.push(`    ${caller}: ${clearanceFor(policy, caller)}`);
  }

  // codex has no per-tool allowlist (see runner.ts's codex branch): only the
  // Claude is held to a read-only tool list; codex has no per-tool restriction
  // at all. `--sandbox read-only` stops it writing, but not reading or running
  // commands, and the guard runs in observe mode there.
  //
  // This comment used to finish "so a codex line's answers are bounded by the
  // sandbox and the clearance check on the reply". There is no clearance check
  // on the reply — listener.ts only runs redactOutbound, which replaces
  // credential-shaped strings and the line's own token. Combined with the guard
  // observing rather than blocking, a codex line enforces NOTHING from the
  // sensitivity model; clearance there decides only what gets logged. Say that,
  // rather than pointing at a control that does not exist.
  if (cfg.agent_kind === "codex") {
    for (const t of tasks) {
      if (t.id === ASK_TASK.id) continue;
      notices.push(
        `task "${t.id}": codex has no per-tool restriction, so it can still run shell commands. ` +
        `--sandbox read-only prevents writes but not reads or execution, and the guard only ` +
        `observes on codex — a read above the caller's clearance is recorded and then allowed. ` +
        `Nothing checks the answer either. Clearances on a codex line are intent, not enforcement.`,
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
