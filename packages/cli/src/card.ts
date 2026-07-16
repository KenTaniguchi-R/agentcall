import type { CardUploadType } from "@benree/agentcall-shared";
import type { Config } from "./config.js";
import type { Policy } from "./policy.js";
import type { Task } from "./tasks.js";

const stripPlus = (id: string) => id.replace(/^\+/, "");

// The upload contains only advertisement fields (id/name/description/
// examples/tier) — never envelopes or SKILL.md content. Envelopes are
// enforcement detail that stays on the callee's machine; the card and the
// enforcement both derive from the same task.json, so they cannot disagree.
export function buildCardUpload(cfg: Config, policy: Policy, tasks: Task[]): CardUploadType {
  const exists = (id: string) => tasks.some((t) => t.id === id);
  const defaultOffer = policy.default_offer.map(stripPlus).filter(exists);

  const grants: Record<string, string[]> = {};
  for (const [caller, entry] of Object.entries(policy.callers)) {
    if (entry.block) continue;
    const ids = entry.offer.map(stripPlus).filter(exists);
    if (ids.length > 0) grants[caller] = ids;
  }

  const referenced = new Set([...defaultOffer, ...Object.values(grants).flat()]);
  return {
    description: policy.description,
    agent_kind: cfg.agent_kind,
    tasks: tasks
      .filter((t) => referenced.has(t.id))
      .map(({ id, name, description, examples, tier }) => ({ id, name, description, examples, tier })),
    default_offer: defaultOffer,
    grants,
  };
}
