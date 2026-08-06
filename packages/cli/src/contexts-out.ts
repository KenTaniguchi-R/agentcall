import { z } from "zod";
import { CONTEXT_ID_RE } from "@benree/agentcall-shared";
import type { LinePaths } from "./paths.js";
import { readJsonStore, writeJsonAtomic } from "./json-store.js";

// The caller's half, and deliberately a separate file from contexts.ts: this
// holds only opaque tokens the callee issued us, so losing it costs one
// retyped question. contexts.ts holds real agent session ids and gates a
// security property. Different blast radius, different file.
const OutboundContextSchema = z.object({
  relay: z.string().min(1),
  from: z.string().min(1),
  to: z.string().min(1),
  // The task the CONTEXT was resolved under, taken from the reply rather than
  // from what we requested -- `--task` is optional and the callee's policy
  // picks when it is omitted.
  task: z.string().min(1),
  context_id: z.string().regex(CONTEXT_ID_RE),
  at: z.number().int(),
});
export type OutboundContext = z.infer<typeof OutboundContextSchema>;

// `task` is optional on a LOOKUP (a `--continue` with no `--task` means "the
// conversation with this peer, whichever task it is on") but is always part of
// the identity of a stored entry — see rememberOutbound.
type OutboundKey = { relay: string; from: string; to: string; task?: string };

const sameTarget = (a: OutboundContext, k: OutboundKey) =>
  a.relay === k.relay && a.from === k.from && a.to === k.to
  && (k.task === undefined || a.task === k.task);

// Fails SAFE, same posture as loadContexts: an unreadable or malformed store
// yields no entries, so --continue reports "nothing stored" instead of
// resuming against garbage.
export function loadOutbound(p: LinePaths): OutboundContext[] {
  return readJsonStore(p.contextsOutFile, z.array(OutboundContextSchema), {
    missing: () => [],
    corrupt: () => [],
  });
}

// Every match, newest first (rememberOutbound prepends). The caller needs the
// COUNT, not just the first hit: one match resumes, several without a --task
// is the ambiguity `--continue` refuses to guess at.
export function matchOutbound(list: OutboundContext[], key: OutboundKey): OutboundContext[] {
  return list.filter((e) => sameTarget(e, key));
}

// One open conversation per callee PER TASK. Keying this on the callee alone
// meant calling the same peer on a second task silently discarded the first
// conversation — the callee had kept its binding (it keys by task and holds
// MAX_CONTEXTS of them), so only the caller's half was lost, and `--continue`
// then reported "no open conversation" for a thread that was still live.
//
// The no-guessing property this store was built for is preserved in the
// lookup instead of the write: `--continue` resumes only when exactly one
// conversation matches, and asks for a `--task` when more than one does.
export function rememberOutbound(p: LinePaths, entry: OutboundContext): void {
  // `entry` is itself a valid key with `task` always set, so this replaces on
  // the full (relay, from, to, task) tuple.
  const next = [entry, ...loadOutbound(p).filter((e) => !sameTarget(e, entry))];
  // writeJsonAtomic carries the same 0600/0700 posture this used to hand-roll —
  // including the chmod after mkdir, since mkdirSync's mode is silently ignored
  // when the directory already exists — and adds the atomic replace, so a crash
  // mid-write can no longer leave a truncated store that loads as empty.
  writeJsonAtomic(p.contextsOutFile, next);
}

// Drops every entry matching the key. The callee ends a conversation on its own
// schedule — the turn cap and the TTL are its bounds, not ours — and it only
// ever says so as `context_unknown`. Without this the caller's half outlives the
// callee's binding and `--continue` re-sends the dead context_id forever, since
// rememberOutbound only ever runs on the success path.
export function forgetOutbound(p: LinePaths, key: OutboundKey): void {
  const next = loadOutbound(p).filter((e) => !sameTarget(e, key));
  writeJsonAtomic(p.contextsOutFile, next);
}
