import { fetchCard } from "../api.js";
import { publishCard } from "../card.js";
import { loadConfig, relayUrl } from "../config.js";
import { resolveAddress } from "../contacts.js";
import { buildCardReport } from "../lint.js";
import { scaffoldTask } from "../tasks.js";
import { ExitOnly, type Deps } from "./deps.js";

export async function card(d: Deps, target?: string): Promise<void> {
  const { paths } = d;
  if (target === undefined) {
    const cfg = loadConfig(paths);
    if (!cfg.agent_kind) {
      throw new Error("This handle is caller-only (no agent configured) — no card to review.");
    }
    const report = buildCardReport(cfg, paths);
    for (const line of report.menu) d.io.log(line);
    if (report.problems.length > 0) {
      d.io.log("\nProblems:");
      for (const p of report.problems) d.io.log(`  ✗ ${p}`);
    }
    if (report.notices.length > 0) {
      d.io.log("\nNotes:");
      for (const n of report.notices) d.io.log(`  ! ${n}`);
    }
    // ExitOnly: the menu/problems/notes above are the report; a summary
    // message here would be new, undeclared output that didn't exist
    // pre-refactor.
    if (report.problems.length > 0) throw new ExitOnly();
    return;
  }
  if (target === "push") {
    const cfg = loadConfig(paths);
    if (!cfg.agent_kind) {
      throw new Error("This handle is caller-only (no agent configured) and has nothing to publish a card for.");
    }
    await publishCard(cfg, paths);
    d.io.log("Card published.");
    return;
  }
  let cfg;
  try { cfg = loadConfig(paths); } catch { cfg = undefined; }
  const parsed = resolveAddress(paths, target, relayUrl(cfg));
  if (!parsed.ok) {
    throw new Error(`${parsed.error} (or 'push')`);
  }
  if (parsed.warning) d.io.error(parsed.warning);
  const remote = await fetchCard(
    cfg ? relayUrl(cfg) : relayUrl(undefined),
    parsed.handle,
    cfg ? { handle: cfg.handle, token: cfg.token } : undefined,
  );
  d.io.log(`${remote.handle} (${remote.agent_kind})${remote.description ? ` — ${remote.description}` : ""}`);
  for (const t of remote.tasks) {
    d.io.log(`  ${t.id} — ${t.description}`);
    for (const ex of t.examples) d.io.log(`      e.g. ${ex}`);
  }
  d.io.log(`\nCall with: agentcall call ${target} --task <id> "<message>"`);
}

export function taskNew(d: Deps, id: string): void {
  const file = scaffoldTask(d.paths, id);
  d.io.log(`Created ${file}\nEdit it, then:`);
  d.io.log(`  agentcall card                      # check it validates`);
  d.io.log(`  agentcall offer ${id}    # offer to everyone, or:`);
  d.io.log(`  agentcall allow <handle> ${id}`);
}
