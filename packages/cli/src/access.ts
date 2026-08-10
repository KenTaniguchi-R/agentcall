// Who this line answers at all. What a source is worth — `shared` or `secret` —
// lives in sensitivity.ts.
//
// This module is resolution only: the shape of an access table and the rules for
// reading one. The FILE that holds it (loading, the managed layer, assertions,
// saving) is policy.ts's job, and policy.ts parses with the schema declared here
// rather than a second one of its own.
//
// **Collapsed from a three-level clearance on 2026-08-07.** `public < internal`
// promised that one colleague could be told more than another, and nothing ever
// produced a `public` source label to make the distinction real — while the
// ordering caused a live bug (see sensitivity.ts). The product rule is simpler
// than the lattice was: everyone the line answers sees the same thing, and the
// only per-caller control is whether it answers at all. See
// docs/superpowers/specs/2026-08-07-open-default-design.md.
import { z } from "zod";

/** What the line does with a call. There is no third state. */
export const ACCESS = ["allowed", "blocked"] as const;
export type Access = (typeof ACCESS)[number];

export const AccessSchema = z.enum(ACCESS);

/** A fresh line answers anyone the relay lets through — the organization is the boundary. */
export const DEFAULT_ACCESS: Access = "allowed";

const CallerAccessSchema = z.object({
  access: AccessSchema.optional(),
}).strict();

export const AccessPolicySchema = z.object({
  description: z.string().max(500).default(""),
  default_access: AccessSchema.default(DEFAULT_ACCESS),
  callers: z.record(z.string(), CallerAccessSchema).default({}),
}).strict();

export type AccessPolicy = z.infer<typeof AccessPolicySchema>;

// `policy.callers` comes from JSON.parse + z.record, whose output inherits
// Object.prototype — and a handle pattern happily accepts "constructor". A bare
// `callers[handle]` therefore resolves to the Object constructor for any policy
// that does not define that key, which reads as a caller entry that isn't
// there. Same trap policy.ts:161-171 records; every lookup goes through here.
function ownEntry<T>(record: Record<string, T>, key: string): T | undefined {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

/**
 * Resolve whether this caller is answered.
 *
 * Runs on the relay-verified `from` and local files only, BEFORE the caller's
 * message reaches any prompt — the CaMeL invariant `policy.ts` records. The
 * message cannot influence access.
 *
 * An explicit per-caller rule wins; otherwise the line default applies.
 */
export function accessFor(
  policy: AccessPolicy,
  from: string,
): Access {
  const entry = ownEntry(policy.callers, from);
  if (entry?.access) return entry.access;

  return policy.default_access;
}
