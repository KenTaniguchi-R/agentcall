import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import { ROSTER_ID_RE } from "@benree/agentcall-shared";
import type { LinePaths } from "./paths.js";
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
  groups: z
    .record(
      z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
      z.object({
        roster_id: z.string().regex(ROSTER_ID_RE),
        offer: z.array(z.string()).default([]),
      }),
    )
    .default({}),
});
export type Policy = z.infer<typeof PolicySchema>;

export const DEFAULT_POLICY: Policy = { description: "", default_offer: ["ask"], callers: {}, groups: {} };

// Missing file -> safe default (fresh install). Malformed file -> THROW:
// silently falling back to DEFAULT_POLICY would grant `ask` to callers the
// owner explicitly blocked. The listener maps the throw to a call_failed
// agent_error without spawning anything.
export function loadPolicy(p: LinePaths): Policy {
  if (!existsSync(p.policyFile)) return DEFAULT_POLICY;
  return PolicySchema.parse(JSON.parse(readFileSync(p.policyFile, "utf8")));
}

// Writes the exact shape PolicySchema parses, so hand-edits and the CLI
// verbs (verbs.ts) interoperate on the same file.
export function savePolicy(p: LinePaths, policy: Policy): void {
  mkdirSync(dirname(p.policyFile), { recursive: true });
  writeFileSync(p.policyFile, JSON.stringify(policy, null, 2) + "\n");
}

// Grant entries may carry the spec's "+" prefix ("+schedule-meeting");
// semantics are additive either way, so the prefix is just stripped.
export const stripPlus = (id: string) => id.replace(/^\+/, "");

export type CallerEntry = Policy["callers"][string];
export type GroupEntry = Policy["groups"][string];

// `policy.callers` comes from JSON.parse + zod's z.record, whose output object
// inherits Object.prototype — and HANDLE_RE happily accepts "constructor".
// A bare `callers[handle]` therefore resolves to the Object constructor for
// any policy that doesn't define that key, which reads as a caller entry that
// isn't there. Every lookup goes through here so an inherited property can
// never be mistaken for a real entry.
export function callerEntry(policy: Policy, handle: string): CallerEntry | undefined {
  return Object.hasOwn(policy.callers, handle) ? policy.callers[handle] : undefined;
}

export function offeredFor(policy: Policy, from: string, attestedGroups: readonly string[] = []): string[] | "blocked" {
  const entry = callerEntry(policy, from);
  // Individual denial is the strongest rule. Group membership can expand a
  // menu, never resurrect a caller the owner explicitly blocked.
  if (entry?.block) return "blocked";
  const ids = new Set(policy.default_offer.map(stripPlus));
  for (const id of entry?.offer ?? []) ids.add(stripPlus(id));
  const attested = new Set(attestedGroups);
  for (const group of Object.values(policy.groups)) {
    if (!attested.has(group.roster_id)) continue;
    for (const id of group.offer) ids.add(stripPlus(id));
  }
  return [...ids];
}

export type TaskResolution =
  | { ok: true; task: Task }
  | { ok: false; code: "blocked" | "task_not_offered" | "task_unknown"; offered: string[] };

// CaMeL invariant: this runs on relay-verified `from` and local files only,
// BEFORE the caller's message is placed in any prompt. The message cannot
// influence which task (and therefore which envelope) is chosen.
export function resolveTask(
  policy: Policy, tasks: Task[], from: string, requested?: string, attestedGroups: readonly string[] = [],
): TaskResolution {
  const offered = offeredFor(policy, from, attestedGroups);
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
