import { existsSync, readFileSync } from "node:fs";
import { z } from "zod";
import { CONTEXT_ID_RE } from "@benree/agentcall-shared";
import type { LinePaths } from "./paths.js";
import { writeJsonAtomic } from "./json-store.js";

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

type OutboundKey = { relay: string; from: string; to: string };

const sameTarget = (a: OutboundContext, k: OutboundKey) =>
  a.relay === k.relay && a.from === k.from && a.to === k.to;

// Fails SAFE, same posture as loadContexts: an unreadable or malformed store
// yields no entries, so --continue reports "nothing stored" instead of
// resuming against garbage.
export function loadOutbound(p: LinePaths): OutboundContext[] {
  if (!existsSync(p.contextsOutFile)) return [];
  try {
    const parsed = z.array(OutboundContextSchema).safeParse(JSON.parse(readFileSync(p.contextsOutFile, "utf8")));
    return parsed.success ? parsed.data : [];
  } catch {
    return [];
  }
}

export function findOutbound(list: OutboundContext[], key: OutboundKey): OutboundContext | undefined {
  return list.find((e) => sameTarget(e, key));
}

// One open conversation per callee. A second call to the same address
// replaces the first rather than accumulating, so --continue never has to
// guess which of several threads was meant.
export function rememberOutbound(p: LinePaths, entry: OutboundContext): void {
  const next = [entry, ...loadOutbound(p).filter((e) => !sameTarget(e, entry))];
  // writeJsonAtomic carries the same 0600/0700 posture this used to hand-roll —
  // including the chmod after mkdir, since mkdirSync's mode is silently ignored
  // when the directory already exists — and adds the atomic replace, so a crash
  // mid-write can no longer leave a truncated store that loads as empty.
  writeJsonAtomic(p.contextsOutFile, next);
}
