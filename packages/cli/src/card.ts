import { writeFileSync } from "node:fs";
import type { CardUploadType } from "@benree/agentcall-shared";
import { pushCard } from "./api.js";
import { relayUrl } from "./config.js";
import { loadPolicy } from "./policy.js";
import { loadTasks } from "./tasks.js";
import type { Config } from "./config.js";
import type { Paths } from "./paths.js";
import type { Policy } from "./policy.js";
import type { Task } from "./tasks.js";

const stripPlus = (id: string) => id.replace(/^\+/, "");

// The upload contains only advertisement fields (id/name/description/
// examples/tier) — never envelopes or SKILL.md content. Envelopes are
// enforcement detail that stays on the callee's machine; the card and the
// enforcement both derive from the same SKILL.md frontmatter, so they cannot
// disagree.
export function buildCardUpload(cfg: Config, policy: Policy, tasks: Task[]): CardUploadType {
  // A card only exists for a callee. Caller-only handles (no agent_kind, a
  // config shape added by caller-only setup) have nothing to advertise —
  // every call site already guards on agent_kind, so reaching here without
  // one is a bug, not a user error; fail loud rather than emit a card whose
  // required agent_kind is undefined.
  if (!cfg.agent_kind) {
    throw new Error("Cannot build an agent card for a caller-only handle (no agent configured).");
  }
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

// Single path for every card publish (setup, `card push`, policy verbs):
// build from local policy+tasks, push, then record what was pushed so
// `agentcall card` can detect staleness without any relay round-trip.
// The snapshot is written only after a successful push — a failed push
// must keep the old snapshot so staleness detection stays truthful.
export async function publishCard(cfg: Config, p: Paths, push: typeof pushCard = pushCard): Promise<CardUploadType> {
  const upload = buildCardUpload(cfg, loadPolicy(p), loadTasks(p));
  await push(relayUrl(cfg), { handle: cfg.handle, token: cfg.token }, upload);
  writeFileSync(p.cardSnapshotFile, JSON.stringify(upload, null, 2) + "\n");
  return upload;
}
