import { HANDLE_RE } from "@benree/agentcall-shared";
import { GrantableClearance, clearanceFor, type GrantableClearanceType } from "./clearance.js";
import { callerEntry, type Policy } from "./policy.js";

// #379 collapsed four verbs into one. `allow`/`revoke`/`offer`/`unoffer` each
// edited a task menu; a task is no longer individually granted, so the only
// thing left to set is how much a caller may be told. `block`/`unblock` survive
// unchanged — an explicit block is the one rule clearance cannot express as a
// level, since it beats every grant including an attested group's.
export type Verb = "block" | "unblock" | "clearance" | "clearance-reset" | "clearance-default";

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
  // `secret` is rejected here for the same reason GrantableClearance excludes
  // it: it means "never leaves this machine", so a grantable secret would be a
  // bypass any policy edit could hand out.
  const requireLevel = (value: string | undefined, forVerb: string): GrantableClearanceType => {
    const parsed = GrantableClearance.safeParse(value);
    if (!parsed.success) {
      throw new Error(`${forVerb} needs a clearance level: ${GrantableClearance.options.join(" or ")}.`);
    }
    return parsed.data;
  };
  const clone = (): Policy => ({
    description: policy.description,
    default_clearance: policy.default_clearance,
    callers: Object.fromEntries(
      Object.entries(policy.callers).map(([k, v]) => [
        k, { ...(v.clearance === undefined ? {} : { clearance: v.clearance }), block: v.block },
      ]),
    ),
    groups: Object.fromEntries(
      Object.entries(policy.groups).map(([k, v]) => [
        k, { roster_id: v.roster_id, ...(v.clearance === undefined ? {} : { clearance: v.clearance }) },
      ]),
    ),
    ...(policy.tests === undefined ? {} : {
      tests: policy.tests.map((test) => ({
        caller: test.caller,
        groups: [...test.groups],
        expect_clearance: test.expect_clearance,
      })),
    }),
  });
  // Report what the caller actually resolves to, not what was just written:
  // the line default and any attested group can raise it, and a block sinks it
  // regardless. An owner reading `clearance`'s output otherwise believes an
  // edit took effect that a block is suppressing.
  const clearanceLine = (next: Policy, handle: string): string => {
    const resolved = clearanceFor(next, handle);
    if (resolved === "blocked") {
      return `${handle} is blocked; the clearance is kept but inactive until: agentcall unblock ${handle}`;
    }
    return `${handle} can be told ${resolved} content (rosters they are attested in may raise this).`;
  };

  const next = clone();
  switch (verb) {
    case "clearance": {
      const handle = requireHandle(a);
      const level = requireLevel(b, "clearance");
      // callerEntry, not next.callers[handle]: see policy.ts — a bare lookup
      // returns Object.prototype's own members for handles like "constructor".
      next.callers[handle] = { ...(callerEntry(next, handle) ?? { block: false }), clearance: level };
      return { policy: next, lines: [clearanceLine(next, handle)] };
    }
    case "clearance-reset": {
      const handle = requireHandle(a);
      const entry = callerEntry(next, handle);
      if (entry) {
        delete entry.clearance;
        // A bare entry that neither blocks nor clears is noise in the file.
        if (!entry.block) delete next.callers[handle];
      }
      return { policy: next, lines: [clearanceLine(next, handle)] };
    }
    case "clearance-default": {
      next.default_clearance = requireLevel(a, "clearance --default");
      return {
        policy: next,
        lines: [`Anyone registered can be told ${next.default_clearance} content.`],
      };
    }
    case "block": {
      const handle = requireHandle(a);
      next.callers[handle] = { ...callerEntry(next, handle), block: true };
      return { policy: next, lines: [`${handle} is blocked.`] };
    }
    case "unblock": {
      const handle = requireHandle(a);
      const entry = callerEntry(next, handle);
      if (entry) {
        entry.block = false;
        if (entry.clearance === undefined) delete next.callers[handle];
      }
      return { policy: next, lines: [clearanceLine(next, handle)] };
    }
  }
}
