import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import { HANDLE_RE, MAX_CARD_BLOCKED_CALLERS, ROSTER_ID_RE, TASK_ID_RE } from "@benree/agentcall-shared";
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

export const ManagedPolicySchema = z.object({
  version: z.literal(1),
  // Omitted means the administrator does not constrain task grants. An empty
  // list is an intentional deny-all ceiling.
  allowed_tasks: z.array(z.string().regex(TASK_ID_RE)).optional(),
  blocked_callers: z.array(z.string().regex(HANDLE_RE)).default([]),
}).strict();
export type ManagedPolicy = z.infer<typeof ManagedPolicySchema>;

export const DEFAULT_POLICY: Policy = { description: "", default_offer: ["ask"], callers: {}, groups: {} };

// Missing file -> safe default (fresh install). Malformed file -> THROW:
// silently falling back to DEFAULT_POLICY would grant `ask` to callers the
// owner explicitly blocked. The listener maps the throw to a call_failed
// agent_error without spawning anything.
function readOptionalJson<T>(file: string, label: string, schema: z.ZodType<T>): T | undefined {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error(`${label} is unreadable: ${String(error)}`, { cause: error });
  }
  try {
    return schema.parse(JSON.parse(raw));
  } catch (error) {
    throw new Error(`${label} is invalid: ${String(error)}`, { cause: error });
  }
}

export function loadUserPolicy(p: Paths): Policy {
  return readOptionalJson(p.policyFile, "user policy", PolicySchema) ?? DEFAULT_POLICY;
}

function applyManagedPolicy(user: Policy, managed: ManagedPolicy): Policy {
  const allowed = managed.allowed_tasks === undefined
    ? undefined
    : new Set(managed.allowed_tasks);
  const filter = (offers: string[]) => allowed === undefined
    ? [...offers]
    : offers.filter((id) => allowed.has(stripPlus(id)));

  const callerEntries = new Map(Object.entries(user.callers).map(([handle, entry]) => [
    handle,
    { offer: filter(entry.offer), block: entry.block },
  ]));
  for (const handle of managed.blocked_callers) {
    const entry = callerEntries.get(handle) ?? { offer: [], block: false };
    callerEntries.set(handle, { ...entry, block: true });
  }

  return {
    description: user.description,
    default_offer: filter(user.default_offer),
    callers: Object.fromEntries(callerEntries),
    groups: Object.fromEntries(Object.entries(user.groups).map(([name, group]) => [
      name,
      { ...group, offer: filter(group.offer) },
    ])),
  };
}

function validateEffectivePolicy(policy: Policy): Policy {
  const blocked = Object.values(policy.callers).filter((entry) => entry.block).length;
  if (blocked > MAX_CARD_BLOCKED_CALLERS) {
    throw new Error(
      `effective policy blocks ${blocked} callers; at most ${MAX_CARD_BLOCKED_CALLERS} can be enforced and published`,
    );
  }
  return policy;
}

// Enforcement and publication use the effective policy. A missing managed
// file is intentionally silent; any other read or parse failure is fatal so an
// administrator restriction can never disappear through fallback.
export function loadPolicy(p: Paths): Policy {
  const user = loadUserPolicy(p);
  const managed = readOptionalJson(p.managedPolicyFile, "managed policy", ManagedPolicySchema);
  return validateEffectivePolicy(managed === undefined ? user : applyManagedPolicy(user, managed));
}

// Writes the exact shape PolicySchema parses, so hand-edits and the CLI
// verbs (verbs.ts) interoperate on the same file.
export function savePolicy(p: Paths, policy: Policy): void {
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
