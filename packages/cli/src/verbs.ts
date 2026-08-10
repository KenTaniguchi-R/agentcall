import { HANDLE_RE } from "@benree/agentcall-shared";
import { AccessSchema, accessFor, type Access } from "./access.js";
import { callerEntry, type Policy } from "./policy.js";

// #379 collapsed four task-menu verbs (`allow`/`revoke`/`offer`/`unoffer`) into
// a single clearance setting. 2026-08-07 collapsed that in turn: with one
// grantable level there is no amount to set, only whether the line answers at
// all, so `clearance`/`clearance-reset`/`clearance-default` are gone and
// `block`/`unblock` are the whole per-caller surface. `access-default` remains
// because closing a line by default — answer only named callers — is a real
// posture the binary model can still express.
export type Verb = "block" | "unblock" | "access-default";

// Pure policy mutations behind the flat CLI verbs. Each returns a NEW
// Policy plus the lines the CLI prints. Validation throws Error with a
// user-facing message. Removals are idempotent and never error.
export function execVerb(
  policy: Policy, verb: Verb, a: string, b?: string,
): { policy: Policy; lines: string[] } {
  const requireHandle = (h: string) => {
    if (!HANDLE_RE.test(h)) {
      throw new Error(`"${h}" is not a valid handle. Use the bare handle (e.g. ken), not @org/handle.`);
    }
    return h;
  };
  const requireAccess = (value: string | undefined, forVerb: string): Access => {
    const parsed = AccessSchema.safeParse(value);
    if (!parsed.success) {
      throw new Error(`${forVerb} needs one of: ${AccessSchema.options.join(" or ")}.`);
    }
    return parsed.data;
  };
  const clone = (): Policy => ({
    description: policy.description,
    default_access: policy.default_access,
    callers: Object.fromEntries(
      Object.entries(policy.callers).map(([k, v]) => [
        k, v.access === undefined ? {} : { access: v.access },
      ]),
    ),
    ...(policy.tests === undefined ? {} : {
      tests: policy.tests.map((test) => ({
        caller: test.caller,
        expect_access: test.expect_access,
      })),
    }),
  });

  // Report what the caller actually RESOLVES to, not what was just written: the
  // the line default takes part. An owner reading this otherwise believes an
  // edit took effect that the default is overriding.
  const resolvedLine = (next: Policy, handle: string): string => {
    const resolved = accessFor(next, handle);
    return resolved === "blocked"
      ? `${handle} is blocked; no call from them is answered.`
      : `${handle} is answered, and can be told anything not marked secret.`;
  };

  const next = clone();
  switch (verb) {
    case "block": {
      const handle = requireHandle(a);
      next.callers[handle] = { access: "blocked" };
      return { policy: next, lines: [`${handle} is blocked.`] };
    }
    case "unblock": {
      const handle = requireHandle(a);
      // Delete rather than write `allowed`: an entry that matches the default
      // is noise, and leaving one behind would pin this caller against a later
      // change of `default_access`.
      if (callerEntry(next, handle)) delete next.callers[handle];
      return { policy: next, lines: [resolvedLine(next, handle)] };
    }
    case "access-default": {
      next.default_access = requireAccess(a, "access --default");
      return {
        policy: next,
        lines: next.default_access === "blocked"
          ? ["Only named callers are answered."]
          : ["Anyone registered is answered."],
      };
    }
  }
  // `b` is part of the signature for verbs that take a second argument; none
  // currently do. Referenced so the parameter is not silently dead.
  void b;
}
