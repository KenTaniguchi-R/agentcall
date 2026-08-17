import { randomBytes } from "node:crypto";
import { z } from "zod";
import { CONTEXT_ID_RE, CONTEXT_TTL_MS, MAX_CONTEXTS, MAX_CONTEXT_TURNS } from "@benree/agentcall-shared";
import type { Paths } from "./paths.js";
import { readJsonStore, writeJsonAtomic } from "./json-store.js";

// The binding is the whole security design in one shape. `context_id` is the
// only field that ever travels; `agent_session_id` is the capability it stands
// in for and must never be serialized onto the wire, into an audit log, or into
// an error message.
const ContextBindingSchema = z.object({
  context_id: z.string().regex(CONTEXT_ID_RE),
  agent_session_id: z.string().min(1),
  caller: z.string().min(1),
  task: z.string().min(1),
  agent_kind: z.enum(["claude", "codex"]),
  workdir: z.string().min(1),
  turns: z.number().int().nonnegative(),
  created_at: z.number().int(),
  last_used_at: z.number().int(),
});
export type ContextBinding = z.infer<typeof ContextBindingSchema>;

// 16 bytes -> 22 base64url characters with no padding, which is exactly what
// CONTEXT_ID_RE accepts. randomBytes, not Math.random: this is a bearer token
// for one specific agent session.
export function mintContextId(): string {
  return "ctx_" + randomBytes(16).toString("base64url");
}

interface AdmitInput {
  context_id: string;
  caller: string;
  task: string;
  agent_kind: "claude" | "codex";
  workdir: string;
  now: number;
}

// Every condition must hold, and a failure is indistinguishable from every
// other failure by design — the caller only ever learns "context_unknown", so a
// guessed token cannot be used to probe whether it exists but belongs to
// someone else.
export function admitContext(list: ContextBinding[], input: AdmitInput): ContextBinding | undefined {
  const b = list.find((x) => x.context_id === input.context_id);
  if (!b) return undefined;
  if (b.caller !== input.caller) return undefined;
  if (b.task !== input.task) return undefined;
  if (b.agent_kind !== input.agent_kind) return undefined;
  if (b.workdir !== input.workdir) return undefined;
  if (input.now - b.last_used_at >= CONTEXT_TTL_MS) return undefined;
  if (b.turns >= MAX_CONTEXT_TURNS) return undefined;
  return b;
}

// Expiry first, then a most-recently-used cap. The cap is what keeps inbound
// calls from driving an unbounded local file.
export function pruneContexts(list: ContextBinding[], now: number): ContextBinding[] {
  return list
    .filter((b) => now - b.last_used_at < CONTEXT_TTL_MS)
    .sort((a, b) => b.last_used_at - a.last_used_at)
    .slice(0, MAX_CONTEXTS);
}

export function upsertContext(list: ContextBinding[], binding: ContextBinding): ContextBinding[] {
  return [binding, ...list.filter((b) => b.context_id !== binding.context_id)];
}

// Fails SAFE: an unreadable or malformed store yields no bindings, so every
// resume is refused and every call still works as a fresh one. This is the
// opposite of loadPolicy's deliberate throw — there, a silent default would
// GRANT what the owner withheld; here, a silent empty only DENIES.
export function loadContexts(p: Paths): ContextBinding[] {
  return readJsonStore(p.contextsFile, z.array(ContextBindingSchema), {
    missing: () => [],
    corrupt: () => [],
  });
}

// 0600, same posture as config.json: this file holds real agent session ids and
// the handle of everyone who has held a conversation with this agent.
export function saveContexts(p: Paths, list: ContextBinding[]): void {
  writeJsonAtomic(p.contextsFile, list);
}
