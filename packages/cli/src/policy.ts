import { existsSync, readFileSync } from "node:fs";
import { z } from "zod";
import type { Paths } from "./paths.js";
import type { Task } from "./tasks.js";

export const PolicySchema = z.object({
  description: z.string().max(500).default(""),
  default_offer: z.array(z.string()).default(["ask"]),
  callers: z
    .record(
      z.string(),
      z.object({
        offer: z.array(z.string()).default([]),
        block: z.boolean().default(false),
      }),
    )
    .default({}),
});
export type Policy = z.infer<typeof PolicySchema>;

export const DEFAULT_POLICY: Policy = { description: "", default_offer: ["ask"], callers: {} };

// Missing file -> safe default (fresh install). Malformed file -> THROW:
// silently falling back to DEFAULT_POLICY would grant `ask` to callers the
// owner explicitly blocked. The listener maps the throw to a call_failed
// agent_error without spawning anything.
export function loadPolicy(p: Paths): Policy {
  if (!existsSync(p.policyFile)) return DEFAULT_POLICY;
  return PolicySchema.parse(JSON.parse(readFileSync(p.policyFile, "utf8")));
}

// Grant entries may carry the spec's "+" prefix ("+schedule-meeting");
// semantics are additive either way, so the prefix is just stripped.
const stripPlus = (id: string) => id.replace(/^\+/, "");

export function offeredFor(policy: Policy, from: string): string[] | "blocked" {
  const entry = policy.callers[from];
  if (entry?.block) return "blocked";
  const ids = new Set(policy.default_offer.map(stripPlus));
  for (const id of entry?.offer ?? []) ids.add(stripPlus(id));
  return [...ids];
}

export type TaskResolution =
  | { ok: true; task: Task }
  | { ok: false; code: "blocked" | "task_not_offered" | "task_unknown"; offered: string[] };

// CaMeL invariant: this runs on relay-verified `from` and local files only,
// BEFORE the caller's message is placed in any prompt. The message cannot
// influence which task (and therefore which envelope) is chosen.
export function resolveTask(policy: Policy, tasks: Task[], from: string, requested?: string): TaskResolution {
  const offered = offeredFor(policy, from);
  if (offered === "blocked") return { ok: false, code: "blocked", offered: [] };
  // Menu = offered ids that actually exist on disk; stale grants are dropped.
  const menu = offered.filter((id) => tasks.some((t) => t.id === id));
  if (requested !== undefined) {
    const task = tasks.find((t) => t.id === requested);
    if (!task) return { ok: false, code: "task_unknown", offered: menu };
    if (!menu.includes(requested)) return { ok: false, code: "task_not_offered", offered: menu };
    return { ok: true, task };
  }
  if (menu.length === 1) return { ok: true, task: tasks.find((t) => t.id === menu[0])! };
  if (menu.includes("ask")) return { ok: true, task: tasks.find((t) => t.id === "ask")! };
  return { ok: false, code: "task_not_offered", offered: menu };
}
