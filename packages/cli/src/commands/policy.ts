import { publishCard } from "../card.js";
import { loadConfig } from "../config.js";
import { loadPolicy, savePolicy } from "../policy.js";
import { loadTasks } from "../tasks.js";
import { execVerb, type Verb } from "../verbs.js";
import type { Deps } from "./deps.js";

// The six policy verbs (allow/revoke/block/unblock/offer/unoffer) differed
// only by the verb string passed to execVerb — same caller-only guard, same
// save-then-print-then-republish sequence, same non-fatal push-failure
// warning. Collapsed here rather than kept as six near-identical functions.
export async function policyVerb(d: Deps, verb: Verb, args: string[]): Promise<void> {
  const { paths } = d;
  const cfg = loadConfig(paths);
  if (!cfg.agent_kind) {
    throw new Error("This handle is caller-only (no agent configured) — there is no card or policy to manage.");
  }
  const [a, b] = args;
  const { policy, lines } = execVerb(loadPolicy(paths), loadTasks(paths), verb, a, b);
  savePolicy(paths, policy);
  for (const line of lines) d.io.log(line);
  try {
    await publishCard(cfg, paths);
    d.io.log("Card updated.");
  } catch (e) {
    // Non-fatal: policy is already saved to disk; only the republish failed.
    d.io.error(`Warning: policy saved locally, but the card push failed (${String(e)}). Run \`agentcall card push\` later.`);
  }
}
