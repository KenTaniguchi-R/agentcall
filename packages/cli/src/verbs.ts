import { HANDLE_RE, TASK_ID_RE } from "@benree/agentcall-shared";
import { offeredFor, stripPlus, type Policy } from "./policy.js";
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
    if (!HANDLE_RE.test(h)) {
      throw new Error(`"${h}" is not a valid handle. Use the bare handle (e.g. ken), not handle@host.`);
    }
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
  // Enforcement (resolveTask) only ever offers ids that exist on disk; the
  // printed menu must match, or an owner reading `allow`'s output would
  // believe a dangling grant is live when a caller would never see it.
  const menuLine = (next: Policy, handle: string): string => {
    const offered = offeredFor(next, handle);
    if (offered === "blocked") {
      return `${handle} is blocked; grants are kept but inactive until: agentcall unblock ${handle}`;
    }
    const menu = offered.filter((id) => tasks.some((t) => t.id === id));
    return `${handle} can now: ${menu.join(", ")}`;
  };
  const defaultOfferLine = (next: Policy): string => {
    const menu = next.default_offer.map(stripPlus).filter((id) => tasks.some((t) => t.id === id));
    return `Offered to anyone: ${menu.join(", ") || "(nothing — invite-only)"}`;
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
        entry.offer = entry.offer.filter((x) => stripPlus(x) !== id);
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
      return { policy: next, lines: [defaultOfferLine(next)] };
    }
    case "unoffer": {
      const id = requireTaskId(a, "unoffer");
      next.default_offer = next.default_offer.filter((x) => stripPlus(x) !== id);
      return { policy: next, lines: [defaultOfferLine(next)] };
    }
  }
}
