import { HANDLE_RE, TASK_ID_RE } from "@benree/agentcall-shared";
import { offeredFor, type Policy } from "./policy.js";
import type { Task } from "./tasks.js";

export type Verb = "allow" | "revoke" | "block" | "unblock" | "offer" | "unoffer";

// Pure policy mutations behind the flat CLI verbs. Each returns a NEW
// Policy plus the lines the CLI prints. Validation throws Error with a
// user-facing message. Grant-adding verbs (allow/offer) hard-error on a
// task id with no manifest on disk — publishing a dangling grant is never
// what the owner wants; removals are idempotent and never error.
export function execVerb(
  policy: Policy, tasks: Task[], verb: Verb, a: string, b?: string,
): { policy: Policy; lines: string[] } {
  const requireHandle = (h: string) => {
    if (!HANDLE_RE.test(h)) throw new Error(`"${h}" is not a valid handle.`);
    return h;
  };
  const requireTaskId = (id: string | undefined, forVerb: string) => {
    if (!id || !TASK_ID_RE.test(id)) throw new Error(`${forVerb} needs a valid task id.`);
    return id;
  };
  const requireTaskExists = (id: string) => {
    if (!tasks.some((t) => t.id === id)) {
      throw new Error(`No task "${id}" exists on disk. Create it first: agentcall task new ${id}`);
    }
    return id;
  };
  const clone = (): Policy => ({
    description: policy.description,
    default_offer: [...policy.default_offer],
    callers: Object.fromEntries(
      Object.entries(policy.callers).map(([k, v]) => [k, { offer: [...v.offer], block: v.block }]),
    ),
  });
  const menuLine = (next: Policy, handle: string): string => {
    const offered = offeredFor(next, handle);
    return offered === "blocked"
      ? `${handle} is blocked; grants are kept but inactive until: agentcall unblock ${handle}`
      : `${handle} can now: ${offered.join(", ")}`;
  };

  const next = clone();
  switch (verb) {
    case "allow": {
      const handle = requireHandle(a);
      const id = requireTaskExists(requireTaskId(b, "allow"));
      const entry = next.callers[handle] ?? { offer: [], block: false };
      if (!entry.offer.includes(id)) entry.offer.push(id);
      next.callers[handle] = entry;
      return { policy: next, lines: [menuLine(next, handle)] };
    }
    case "revoke": {
      const handle = requireHandle(a);
      const id = requireTaskId(b, "revoke");
      const entry = next.callers[handle];
      if (entry) {
        entry.offer = entry.offer.filter((x) => x.replace(/^\+/, "") !== id);
        if (entry.offer.length === 0 && !entry.block) delete next.callers[handle];
      }
      return { policy: next, lines: [next.callers[handle] ? menuLine(next, handle) : `${handle} has no grants.`] };
    }
    case "block": {
      const handle = requireHandle(a);
      const entry = next.callers[handle] ?? { offer: [], block: false };
      entry.block = true;
      next.callers[handle] = entry;
      return { policy: next, lines: [`${handle} is blocked.`] };
    }
    case "unblock": {
      const handle = requireHandle(a);
      const entry = next.callers[handle];
      if (entry) {
        entry.block = false;
        if (entry.offer.length === 0) delete next.callers[handle];
      }
      return { policy: next, lines: [next.callers[handle] ? menuLine(next, handle) : `${handle} is not blocked.`] };
    }
    case "offer": {
      const id = requireTaskExists(requireTaskId(a, "offer"));
      if (!next.default_offer.includes(id)) next.default_offer.push(id);
      return { policy: next, lines: [`Offered to anyone: ${next.default_offer.join(", ")}`] };
    }
    case "unoffer": {
      const id = requireTaskId(a, "unoffer");
      next.default_offer = next.default_offer.filter((x) => x.replace(/^\+/, "") !== id);
      return { policy: next, lines: [`Offered to anyone: ${next.default_offer.join(", ") || "(nothing — invite-only)"}`] };
    }
  }
}
