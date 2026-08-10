import { writeJsonAtomic } from "./json-store.js";
import type { CardUploadType } from "@benree/agentcall-shared";
import { authOf, pushCard } from "./api.js";
import { relayUrl } from "./config.js";
import { loadPolicy } from "./policy.js";
import { loadTasks } from "./tasks.js";
import type { Config } from "./config.js";
import type { Paths } from "./paths.js";
import type { Policy } from "./policy.js";
import type { Task } from "./tasks.js";

// The upload contains only advertisement fields (id/name/description/
// examples/keywords) — never SKILL.md content, which is enforcement detail
// that stays on the callee's machine. Card and enforcement both derive from
// the same SKILL.md frontmatter, so they cannot disagree.
//
// Since #379 there is no per-caller menu to publish. A task is not
// individually granted, so every task on disk is advertised to every caller
// the owner has not blocked. What an answer may CONTAIN is decided later and
// locally, by clearance against the sensitivity of what the task read — and
// the clearance table is deliberately NOT published: it is the owner's
// assessment of their callers, which is exactly the kind of thing that should
// not be readable by the callers it assesses.
//
// `blocked` survives for the same reason it survives in policy.ts: it is the
// one rule clearance cannot express as a level.
export function buildCardUpload(cfg: Config, policy: Policy, tasks: Task[]): CardUploadType {
  // A card only exists for a callee. Caller-only handles (no agent_kind, a
  // config shape added by caller-only setup) have nothing to advertise —
  // every call site already guards on agent_kind, so reaching here without
  // one is a bug, not a user error; fail loud rather than emit a card whose
  // required agent_kind is undefined.
  if (!cfg.agent_kind) {
    throw new Error("Cannot build an agent card for a caller-only handle (no agent configured).");
  }
  return {
    description: policy.description,
    agent_kind: cfg.agent_kind,
    tasks: tasks.map(({ id, name, description, examples, keywords }) =>
      ({ id, name, description, examples, keywords })),
    blocked: Object.entries(policy.callers).filter(([, e]) => e.access === "blocked").map(([caller]) => caller),
  };
}

// Single path for every card publish (setup, `card push`, and policy verbs):
// build from local policy+tasks, push,
// then record what was pushed so `agentcall card` can detect staleness
// without any relay round-trip. The snapshot is written only after a
// successful push — a failed push must keep the old snapshot so staleness
// detection stays truthful. `cfg` and `p` must come from the same
// The config and paths belong to the same installation identity.
export async function publishCard(
  cfg: Config, p: Paths, push: typeof pushCard = pushCard,
): Promise<CardUploadType> {
  const upload = buildCardUpload(cfg, loadPolicy(p), loadTasks(p));
  await push(relayUrl(cfg), authOf(cfg), upload);
  writeJsonAtomic(p.cardSnapshotFile, upload);
  return upload;
}
