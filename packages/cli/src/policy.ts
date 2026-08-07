// policy.json as a FILE: loading it, layering the administrator's copy over
// it, checking its assertions, and writing it back.
//
// What the file MEANS — the clearance table and how a caller resolves against
// it — is clearance.ts's job, and this module parses with that module's schema
// rather than declaring a second one for the same file. Before #379 it did
// declare its own (a task menu), which is why clearance.ts needed a lenient
// projection to read the same bytes; deleting the menu deleted the projection.
import { readFileSync } from "node:fs";
import { z } from "zod";
import { HANDLE_RE, MAX_CARD_BLOCKED_CALLERS } from "@benree/agentcall-shared";
import {
  AccessPolicySchema, GROUP_NAME_RE, AccessSchema, capAccess, accessFor,
  type Access,
} from "./access.js";
import { writeJsonAtomic } from "./json-store.js";
import type { LinePaths } from "./paths.js";
import type { Task } from "./tasks.js";

const MAX_POLICY_ASSERTIONS = 100;

// One expectation per assertion, and it is the value that actually governs
// what leaves: the clearance this caller resolves to. The task-menu era used
// accept/deny lists over task ids, which were only ever a proxy for this.
// `deny: ["*"]` — "this caller gets nothing" — maps onto "blocked" exactly.
//
// `secret` is absent for the same structural reason it is absent from
// AccessSchema: no clearance grants it, so no assertion can expect it.
const PolicyAssertionSchema = z.object({
  caller: z.string().regex(HANDLE_RE),
  groups: z.array(z.string().regex(GROUP_NAME_RE)).max(20).default([]),
  expect_access: AccessSchema,
}).strict();
type PolicyAssertion = z.infer<typeof PolicyAssertionSchema>;

// The whole file: clearance.ts's shape plus the assertions, which are a
// property of the file rather than of resolution. `.extend` on a strict object
// stays strict, so a typo anywhere still fails the parse.
const PolicySchema = AccessPolicySchema.extend({
  tests: z.array(PolicyAssertionSchema).max(MAX_POLICY_ASSERTIONS).optional(),
});
export type Policy = z.infer<typeof PolicySchema>;

const ManagedPolicySchema = z.object({
  version: z.literal(1),
  // Omitted means the administrator does not cap clearance. This is the
  // successor to the task-menu era's `allowed_tasks`: that bounded which tasks
  // the owner could grant, this bounds how much any grant can reveal. There is
  // no deny-all value because `blocked_callers` is the deny-all lever, and
  // because `secret` is not grantable in the first place.
  max_clearance: AccessSchema.optional(),
  blocked_callers: z.array(z.string().regex(HANDLE_RE)).default([]),
  tests: z.array(PolicyAssertionSchema).max(MAX_POLICY_ASSERTIONS).optional(),
}).strict();
type ManagedPolicy = z.infer<typeof ManagedPolicySchema>;

export const DEFAULT_POLICY: Policy = {
  description: "", default_access: "allowed", callers: {}, groups: {},
};

// Missing file -> safe default (fresh install). Malformed file -> THROW:
// silently falling back to DEFAULT_POLICY would hand `public` to callers the
// owner explicitly blocked. The listener maps the throw to an encrypted failure
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

export function loadUserPolicy(p: LinePaths): Policy {
  return readOptionalJson(p.policyFile, "user policy", PolicySchema) ?? DEFAULT_POLICY;
}

function applyManagedPolicy(user: Policy, managed: ManagedPolicy): Policy {
  const ceiling = managed.max_clearance;
  const cap = (value: Access | undefined) =>
    value === undefined || ceiling === undefined ? value : capAccess(value, ceiling);

  const callerEntries = new Map(Object.entries(user.callers).map(([handle, entry]) => {
    const access = cap(entry.access);
    return [handle, access === undefined ? {} : { access }] as const;
  }));
  // An administrator may close a line the owner opened, never the reverse —
  // which is why this overwrites rather than merges with the owner's value.
  for (const handle of managed.blocked_callers) {
    callerEntries.set(handle, { access: "blocked" });
  }

  const assertions = [...(user.tests ?? []), ...(managed.tests ?? [])];
  return {
    description: user.description,
    default_access: cap(user.default_access) ?? user.default_access,
    callers: Object.fromEntries(callerEntries),
    groups: Object.fromEntries(Object.entries(user.groups).map(([name, group]) => {
      const access = cap(group.access);
      return [name, { roster_id: group.roster_id, ...(access === undefined ? {} : { access }) }];
    })),
    ...(assertions.length > 0 ? { tests: assertions } : {}),
  };
}

function validateEffectivePolicy(policy: Policy): Policy {
  const blocked = Object.values(policy.callers).filter((entry) => entry.access === "blocked").length;
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
export function loadPolicy(p: LinePaths): Policy {
  return validatePolicy(p, loadUserPolicy(p));
}

// Validate a proposed user policy against the installed managed layer before
// writing it. CLI mutations use this to reject a change that would break an
// assertion, preserving the last known-good file and listener availability.
//
// The user half is per-LINE (p.policyFile); the managed half is per-MACHINE
// (p.machine.managedPolicyFile). An administrator ceiling that lived on the
// line would be escaped by `agentcall line add`, and its path is deliberately
// independent of AGENTCALL_HOME — see paths.ts.
export function validatePolicy(p: LinePaths, user: Policy): Policy {
  const managed = readOptionalJson(p.machine.managedPolicyFile, "managed policy", ManagedPolicySchema);
  const effective = validateEffectivePolicy(managed === undefined ? user : applyManagedPolicy(user, managed));
  validatePolicyAssertions(effective, user.tests ?? [], "user policy");
  if (managed !== undefined) validatePolicyAssertions(effective, managed.tests ?? [], "managed policy");
  return effective;
}

// Writes the exact shape PolicySchema parses, so hand-edits and the CLI
// verbs (verbs.ts) interoperate on the same file.
export function savePolicy(p: LinePaths, policy: Policy): void {
  writeJsonAtomic(p.policyFile, policy);
}

type CallerEntry = Policy["callers"][string];

// `policy.callers` comes from JSON.parse + zod's z.record, whose output object
// inherits Object.prototype — and HANDLE_RE happily accepts "constructor".
// A bare `callers[handle]` therefore resolves to the Object constructor for
// any policy that doesn't define that key, which reads as a caller entry that
// isn't there. Every lookup goes through here so an inherited property can
// never be mistaken for a real entry. clearance.ts's `ownEntry` is the same
// guard on the resolution side.
export function callerEntry(policy: Policy, handle: string): CallerEntry | undefined {
  return Object.hasOwn(policy.callers, handle) ? policy.callers[handle] : undefined;
}

function validatePolicyAssertions(
  effective: Policy, assertions: readonly PolicyAssertion[], source: "user policy" | "managed policy",
): void {
  for (const [index, assertion] of assertions.entries()) {
    const unknownGroups = assertion.groups.filter((name) => !Object.hasOwn(effective.groups, name));
    if (unknownGroups.length > 0) {
      throw new Error(
        `${source} assertion ${index + 1} for "${assertion.caller}" references unknown groups: ${unknownGroups.join(", ")}`,
      );
    }
    const attestedGroups = assertion.groups.map((name) => effective.groups[name]!.roster_id);
    const actual = accessFor(effective, assertion.caller, attestedGroups);
    if (actual === assertion.expect_access) continue;
    throw new Error(
      `${source} assertion ${index + 1} for "${assertion.caller}" failed: ` +
      `expected ${assertion.expect_access}, got ${actual}`,
    );
  }
}

export type TaskResolution =
  | { ok: true; task: Task }
  | { ok: false; code: "blocked" | "task_unknown"; offered: string[] };

// CaMeL invariant: this runs on relay-verified `from` and local files only,
// BEFORE the caller's message is placed in any prompt. The message cannot
// influence which task is chosen.
//
// Since #379 there is no menu to consult. A task is not individually granted,
// so the only two questions here are whether the caller is blocked outright
// and whether the requested task exists on disk. What the resulting answer may
// CONTAIN is decided afterwards, by accessFor against the sensitivity of
// whatever the task actually read — one question where there used to be two.
export function resolveTask(
  policy: Policy, tasks: Task[], from: string, requested?: string, attestedGroups: readonly string[] = [],
): TaskResolution {
  // Blocked is the one rule clearance cannot express as a level: it beats every
  // grant, including an attested group's, and it refuses before any task is
  // named so a blocked caller learns nothing about what exists.
  if (accessFor(policy, from, attestedGroups) === "blocked") {
    return { ok: false, code: "blocked", offered: [] };
  }
  if (requested !== undefined) {
    const task = tasks.find((t) => t.id === requested);
    if (!task) return { ok: false, code: "task_unknown", offered: tasks.map((t) => t.id) };
    return { ok: true, task };
  }
  // `ask` is built in and always present (tasks.ts), so a call that names no
  // task always has somewhere to land and never has to ambiguate over a list.
  return { ok: true, task: tasks.find((t) => t.id === "ask")! };
}
