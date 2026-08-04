import { lstatSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CONTEXT_ID_RE, CONTEXT_TTL_MS, MAX_CONTEXTS, MAX_CONTEXT_TURNS } from "@benree/agentcall-shared";
import {
  admitContext, loadContexts, mintContextId, pruneContexts, saveContexts, upsertContext,
  type ContextBinding,
} from "../src/contexts.js";
import { tempLine } from "./helpers.js";

const NOW = 1_800_000_000_000;

function binding(over: Partial<ContextBinding> = {}): ContextBinding {
  return {
    context_id: mintContextId(),
    agent_session_id: "real-agent-session-uuid",
    caller: "sota",
    task: "ask",
    agent_kind: "claude",
    workdir: "/tmp/work",
    turns: 1,
    created_at: NOW,
    last_used_at: NOW,
    ...over,
  };
}

const admitOf = (b: ContextBinding) => ({
  context_id: b.context_id, caller: b.caller, task: b.task,
  agent_kind: b.agent_kind, workdir: b.workdir, now: NOW,
});

describe("mintContextId", () => {
  it("mints ids matching the protocol shape", () => {
    for (let i = 0; i < 50; i++) expect(CONTEXT_ID_RE.test(mintContextId())).toBe(true);
  });

  it("does not repeat", () => {
    const seen = new Set(Array.from({ length: 500 }, () => mintContextId()));
    expect(seen.size).toBe(500);
  });
});

describe("admitContext", () => {
  it("admits a matching binding", () => {
    const b = binding();
    expect(admitContext([b], admitOf(b))?.context_id).toBe(b.context_id);
  });

  it("refuses an unknown id", () => {
    const b = binding();
    expect(admitContext([b], { ...admitOf(b), context_id: mintContextId() })).toBeUndefined();
  });

  // The whole point: possession of a token is not authority to use it.
  it("refuses a different caller", () => {
    const b = binding();
    expect(admitContext([b], { ...admitOf(b), caller: "mallory" })).toBeUndefined();
  });

  // A context born under a privileged task must not be resumable under a
  // task the caller was offered instead.
  it("refuses a different task", () => {
    const b = binding();
    expect(admitContext([b], { ...admitOf(b), task: "deploy-status" })).toBeUndefined();
  });

  it("refuses a different agent kind", () => {
    const b = binding();
    expect(admitContext([b], { ...admitOf(b), agent_kind: "codex" })).toBeUndefined();
  });

  // codex exec resume cannot be told a working directory, so it inherits the
  // recorded one. If the owner re-pointed workdir, resuming would run the
  // agent somewhere they no longer intend.
  it("refuses a changed workdir", () => {
    const b = binding();
    expect(admitContext([b], { ...admitOf(b), workdir: "/tmp/elsewhere" })).toBeUndefined();
  });

  it("refuses past the TTL", () => {
    const b = binding({ last_used_at: NOW - CONTEXT_TTL_MS - 1 });
    expect(admitContext([b], { ...admitOf(b), now: NOW })).toBeUndefined();
  });

  it("admits right up to the TTL", () => {
    const b = binding({ last_used_at: NOW - CONTEXT_TTL_MS + 1 });
    expect(admitContext([b], { ...admitOf(b), now: NOW })).toBeDefined();
  });

  it("refuses past the turn cap", () => {
    const b = binding({ turns: MAX_CONTEXT_TURNS });
    expect(admitContext([b], admitOf(b))).toBeUndefined();
  });
});

describe("pruneContexts", () => {
  it("drops expired bindings", () => {
    const fresh = binding();
    const stale = binding({ last_used_at: NOW - CONTEXT_TTL_MS - 1 });
    expect(pruneContexts([fresh, stale], NOW).map((b) => b.context_id)).toEqual([fresh.context_id]);
  });

  it("caps the store at MAX_CONTEXTS, evicting least recently used", () => {
    const list = Array.from({ length: MAX_CONTEXTS + 10 }, (_, i) =>
      binding({ last_used_at: NOW - i }));
    const pruned = pruneContexts(list, NOW);
    expect(pruned).toHaveLength(MAX_CONTEXTS);
    expect(pruned[0]!.last_used_at).toBe(NOW);          // most recent kept
    expect(pruned.at(-1)!.last_used_at).toBe(NOW - MAX_CONTEXTS + 1);
  });
});

describe("upsertContext", () => {
  it("replaces by context_id rather than appending a duplicate", () => {
    const b = binding();
    const next = { ...b, turns: 2 };
    const out = upsertContext([b], next);
    expect(out).toHaveLength(1);
    expect(out[0]!.turns).toBe(2);
  });

  it("prepends a new binding", () => {
    const a = binding();
    const b = binding();
    expect(upsertContext([a], b).map((x) => x.context_id)).toEqual([b.context_id, a.context_id]);
  });
});

describe("load/save", () => {
  const paths = () => tempLine("claude", "agentcall-ctx-");

  it("round-trips", () => {
    const p = paths();
    const b = binding();
    saveContexts(p, [b]);
    expect(loadContexts(p)).toEqual([b]);
  });

  it("returns empty when the file is missing", () => {
    expect(loadContexts(paths())).toEqual([]);
  });

  // Fail SAFE, not loud. policy.ts throws on a malformed file because a silent
  // default would GRANT access the owner withheld. Here a silent empty DENIES
  // every resume, which is the safe direction — and a lost context costs a
  // caller one retyped question.
  it("returns empty when the file is malformed", () => {
    const p = paths();
    saveContexts(p, []);
    writeFileSync(p.contextsFile, "{ not json");
    expect(loadContexts(p)).toEqual([]);
  });

  // z.array(...) validates the whole array as a unit, so one bad entry drops
  // every entry, not just the bad one. That's deliberate and still safe: it
  // only ever denies more resumes, never grants one it shouldn't.
  it("discards the whole store when any entry fails the schema", () => {
    const p = paths();
    saveContexts(p, [binding()]);
    writeFileSync(p.contextsFile, JSON.stringify([{ context_id: "nope" }]));
    expect(loadContexts(p)).toEqual([]);
  });

  // The file holds real agent session ids and the handles of everyone who has
  // called. Same posture as config.json.
  it("writes owner-only", () => {
    const p = paths();
    saveContexts(p, [binding()]);
    expect(statSync(p.dir).mode & 0o777).toBe(0o700);
    expect(statSync(p.contextsFile).mode & 0o777).toBe(0o600);
  });

  it("replaces a planted store symlink without overwriting its target", () => {
    const p = paths();
    mkdirSync(p.dir, { recursive: true });
    const victim = join(p.dir, "victim.json");
    writeFileSync(victim, "OWNER DATA\n");
    symlinkSync(victim, p.contextsFile);

    saveContexts(p, []);

    expect(readFileSync(victim, "utf8")).toBe("OWNER DATA\n");
    expect(lstatSync(p.contextsFile).isSymbolicLink()).toBe(false);
    expect(loadContexts(p)).toEqual([]);
  });

  it("preserves the previous store and cleans its temp file when serialization fails", () => {
    const p = paths();
    const previous = binding();
    saveContexts(p, [previous]);
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    expect(() => saveContexts(p, [circular] as never)).toThrow(/circular/i);
    expect(loadContexts(p)).toEqual([previous]);
    expect(readdirSync(p.dir).filter((name) => name.startsWith(".contexts.json.") && name.endsWith(".tmp")))
      .toEqual([]);
  });

  // mkdirSync's `mode` is silently ignored when the directory already exists
  // (e.g. savePolicy creates it first, with no mode at all), so this must
  // exercise the existing-directory path, not just a fresh mkdir, or it would
  // pass whether or not saveContexts actually re-chmods.
  it("tightens an existing world-readable dir to owner-only", () => {
    const p = paths();
    mkdirSync(p.dir, { recursive: true, mode: 0o755 });
    saveContexts(p, [binding()]);
    expect(statSync(p.dir).mode & 0o777).toBe(0o700);
  });
});
