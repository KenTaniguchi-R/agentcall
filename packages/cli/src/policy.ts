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
import { AccessPolicySchema, AccessSchema, accessFor } from "./access.js";
import { writeJsonAtomic } from "./json-store.js";
import type { Paths } from "./paths.js";
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

export const DEFAULT_POLICY: Policy = {
  description: "", default_access: "allowed", callers: {}, offline_delivery: { enabled: false },
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

export function loadUserPolicy(p: Paths): Policy {
  return readOptionalJson(p.policyFile, "user policy", PolicySchema) ?? DEFAULT_POLICY;
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
export function loadPolicy(p: Paths): Policy {
  return validatePolicy(p, loadUserPolicy(p));
}

// Validate a proposed user policy before writing it. CLI mutations use this to
// reject a change that would break an assertion, preserving the last known-good
// file and listener availability.
//
// There was a machine-scoped administrator ceiling here until 2026-08-07
// (max_clearance + blocked_callers + its own assertions, merged by
// applyManagedPolicy). It was READ but never WRITTEN: no command produced the
// file, so an administrator had to hand-author JSON into a platform-specific
// path they could only find by reading this source. An enterprise control with
// no tooling is one nobody can use. Restore it from git history alongside a
// command that writes it, not on its own.
export function validatePolicy(p: Paths, user: Policy): Policy {
  const effective = validateEffectivePolicy(user);
  validatePolicyAssertions(effective, user.tests ?? [], "user policy");
  return effective;
}

// Writes the exact shape PolicySchema parses, so hand-edits and the CLI
// verbs (verbs.ts) interoperate on the same file.
export function savePolicy(p: Paths, policy: Policy): void {
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
  effective: Policy, assertions: readonly PolicyAssertion[], source: "user policy",
): void {
  for (const [index, assertion] of assertions.entries()) {
    const actual = accessFor(effective, assertion.caller);
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
  policy: Policy, tasks: Task[], from: string, requested?: string,
): TaskResolution {
  // Blocked is the one rule clearance cannot express as a level: it beats every
  // task grant and refuses before any task is
  // named so a blocked caller learns nothing about what exists.
  if (accessFor(policy, from) === "blocked") {
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
