import { describe, expect, it } from "vitest";
import { decide, DENY_REASON, runGuard, type GuardDeps, type GuardInput } from "../src/guard.js";
import { getPaths } from "../src/paths.js";

const HOME = "/Users/owner";
const CWD = "/Users/owner/AgentCall/public";
// Identity realpath: these tests assert path logic, not symlink resolution.
const id = (p: string) => p;

const call = (tool: string, input: Record<string, unknown>, cwd = CWD): GuardInput =>
  ({ tool_name: tool, tool_input: input, cwd });

describe("decide — exact-target tools", () => {
  it("denies reading inside a denied directory", () => {
    const v = decide(call("Read", { file_path: "/Users/owner/.ssh/id_rsa" }), HOME, id);
    expect(v.allow).toBe(false);
  });

  it("denies a denied basename anywhere on disk", () => {
    const v = decide(call("Read", { file_path: "/Users/owner/proj/.env" }), HOME, id);
    expect(v.allow).toBe(false);
  });

  it("allows .env.example, which is not a secret", () => {
    const v = decide(call("Read", { file_path: "/Users/owner/proj/.env.example" }), HOME, id);
    expect(v.allow).toBe(true);
  });

  it("allows an ordinary project file", () => {
    const v = decide(call("Read", { file_path: "/Users/owner/proj/src/index.ts" }), HOME, id);
    expect(v.allow).toBe(true);
  });

  it("resolves relative paths against cwd", () => {
    const v = decide(call("Read", { file_path: "../../.ssh/id_rsa" }), HOME, id);
    expect(v.allow).toBe(false);
  });

  it("follows a symlink into a denied directory", () => {
    const realpath = (p: string) => (p === "/tmp/x" ? "/Users/owner/.ssh/id_rsa" : p);
    const v = decide(call("Read", { file_path: "/tmp/x" }), HOME, realpath);
    expect(v.allow).toBe(false);
  });

  it("denies writing into the agent's own config", () => {
    const v = decide(call("Write", { file_path: "/Users/owner/.claude/settings.json" }), HOME, id);
    expect(v.allow).toBe(false);
  });

  it("denies reading agentcall's own relay token", () => {
    const v = decide(call("Read", { file_path: "/Users/owner/.agentcall/config.json" }), HOME, id);
    expect(v.allow).toBe(false);
  });
});

describe("decide — tilde is a path, not a literal directory", () => {
  it("denies a tilde-prefixed read", () => {
    const v = decide(call("Read", { file_path: "~/.ssh/id_rsa" }), HOME, id);
    expect(v.allow).toBe(false);
  });

  it("denies a tilde-prefixed Grep root", () => {
    const v = decide(call("Grep", { path: "~/.ssh", pattern: "KEY" }), HOME, id);
    expect(v.allow).toBe(false);
  });
});

describe("decide — case folding on a case-insensitive filesystem", () => {
  it("denies an upper-cased denied directory", () => {
    const v = decide(call("Read", { file_path: "/Users/owner/.SSH/id_rsa" }), HOME, id);
    expect(v.allow).toBe(false);
  });

  it("denies an upper-cased denied basename", () => {
    const v = decide(call("Read", { file_path: "/Users/owner/proj/KEY.PEM" }), HOME, id);
    expect(v.allow).toBe(false);
  });
});

describe("decide — scanning tools reach through a parent", () => {
  it("denies Grep rooted at home, which contains denied paths", () => {
    const v = decide(call("Grep", { path: "/Users/owner", pattern: "PRIVATE KEY" }), HOME, id);
    expect(v.allow).toBe(false);
  });

  it("denies Grep rooted at /", () => {
    const v = decide(call("Grep", { path: "/", pattern: "PRIVATE KEY" }), HOME, id);
    expect(v.allow).toBe(false);
  });

  it("allows Grep rooted at a project that contains nothing denied", () => {
    const v = decide(call("Grep", { path: "/Users/owner/proj", pattern: "TODO" }), HOME, id);
    expect(v.allow).toBe(true);
  });

  it("denies LS of a denied directory — LS is granted by the read cap", () => {
    const v = decide(call("LS", { path: "/Users/owner/.ssh" }), HOME, id);
    expect(v.allow).toBe(false);
  });

  it("denies LS rooted at home", () => {
    const v = decide(call("LS", { path: "/Users/owner" }), HOME, id);
    expect(v.allow).toBe(false);
  });
});

describe("decide — Grep's glob selects paths the root check never sees", () => {
  // NOTE: these close a targeted selector, NOT the boundary. `glob` only
  // narrows a root Grep is already allowed to search, so omitting it reads
  // MORE, not less: Grep(path: <project>, output_mode: "content") still
  // returns matching lines from a .env sitting in that project. A PreToolUse
  // hook can only allow or deny a whole call, so per-file filtering for Grep
  // has no home here yet. Denying an explicit `glob: ".env"` is worth doing on
  // its own — it is an unambiguous targeting attempt, and it gets logged.
  it("denies a glob naming a denied basename under an allowed root", () => {
    const v = decide(call("Grep", { path: "/Users/owner/proj", glob: ".env", pattern: ".+" }), HOME, id);
    expect(v.allow).toBe(false);
  });

  it("denies a glob enumerating keys under an allowed root", () => {
    const v = decide(call("Grep", { path: "/Users/owner/proj", glob: "**/*.pem", pattern: ".+" }), HOME, id);
    expect(v.allow).toBe(false);
  });

  it("denies a glob that climbs out of its root", () => {
    const v = decide(call("Grep", { path: "/Users/owner/proj", glob: "../../.ssh/*", pattern: ".+" }), HOME, id);
    expect(v.allow).toBe(false);
  });

  it("denies an absolute glob into a denied directory", () => {
    const v = decide(call("Grep", { path: "/Users/owner/proj", glob: "/Users/owner/.ssh/*", pattern: ".+" }), HOME, id);
    expect(v.allow).toBe(false);
  });

  it("allows an ordinary source-file glob", () => {
    const v = decide(call("Grep", { path: "/Users/owner/proj", glob: "**/*.ts", pattern: "TODO" }), HOME, id);
    expect(v.allow).toBe(true);
  });

  it("denies a glob that is not a string", () => {
    const v = decide(call("Grep", { path: "/Users/owner/proj", glob: 7, pattern: "x" }), HOME, id);
    expect(v.allow).toBe(false);
  });
});

describe("decide — Glob carries its path in the pattern", () => {
  it("denies an absolute pattern into a denied directory", () => {
    const v = decide(call("Glob", { pattern: "/Users/owner/.ssh/*" }), HOME, id);
    expect(v.allow).toBe(false);
  });

  it("denies a tilde pattern into a denied directory", () => {
    const v = decide(call("Glob", { pattern: "~/.ssh/*" }), HOME, id);
    expect(v.allow).toBe(false);
  });

  it("denies a pattern enumerating a denied basename", () => {
    expect(decide(call("Glob", { pattern: "**/.env" }), HOME, id).allow).toBe(false);
    expect(decide(call("Glob", { pattern: "**/*.pem" }), HOME, id).allow).toBe(false);
  });

  it("denies a pattern that escapes its root", () => {
    const v = decide(call("Glob", { pattern: "../../.ssh/*" }), HOME, id);
    expect(v.allow).toBe(false);
  });

  it("allows an ordinary source glob under cwd", () => {
    const v = decide(call("Glob", { pattern: "**/*.ts" }), HOME, id);
    expect(v.allow).toBe(true);
  });
});

describe("decide — a denied directory that is itself a symlink", () => {
  // ~/.aws is a symlink onto an encrypted volume. Targets get canonicalized;
  // if the denied roots do not, the canonical target is compared against an
  // alias it can never be inside, and the read is allowed.
  const realpath = (p: string) =>
    p.startsWith("/Users/owner/.aws") ? p.replace("/Users/owner/.aws", "/Volumes/private/aws") : p;

  it("denies the canonical path behind the symlink", () => {
    const v = decide(call("Read", { file_path: "/Volumes/private/aws/credentials" }), HOME, realpath);
    expect(v.allow).toBe(false);
  });

  it("denies the path through the symlink itself", () => {
    const v = decide(call("Read", { file_path: "/Users/owner/.aws/credentials" }), HOME, realpath);
    expect(v.allow).toBe(false);
  });

  it("denies a Grep rooted at the canonical directory", () => {
    const v = decide(call("Grep", { path: "/Volumes/private/aws", pattern: "aws_secret" }), HOME, realpath);
    expect(v.allow).toBe(false);
  });

  it("keeps flagging a Bash command that names the symlink — the lexical form survives", () => {
    const v = decide(call("Bash", { command: "cat ~/.aws/credentials" }), HOME, realpath);
    expect(v.allow).toBe(true);
    expect(v.allow === true && v.flag?.rule).toBeTruthy();
  });
});

describe("decide — writes to a path that does not exist yet", () => {
  it("resolves the longest existing ancestor through a symlink", () => {
    // /tmp/link exists and points into ~/.ssh; the leaf does not exist yet.
    const realpath = (p: string) => {
      if (p === "/tmp/link/new_key") throw new Error("ENOENT");
      if (p === "/tmp/link") return "/Users/owner/.ssh";
      return p;
    };
    const v = decide(call("Write", { file_path: "/tmp/link/new_key" }), HOME, realpath);
    expect(v.allow).toBe(false);
  });
});

describe("decide — Bash records but does not deny", () => {
  it("flags a command referencing a denied path, and still allows it", () => {
    const v = decide(call("Bash", { command: "cat ~/.ssh/id_rsa" }), HOME, id);
    expect(v.allow).toBe(true);
    expect(v.allow === true && v.flag?.rule).toBeTruthy();
  });

  it("does not flag ordinary work", () => {
    const v = decide(call("Bash", { command: "npm test" }), HOME, id);
    expect(v.allow).toBe(true);
    expect(v.allow === true && v.flag).toBeUndefined();
  });
});

describe("decide — unknown shapes fail closed", () => {
  it("allows a tool with no filesystem surface", () => {
    expect(decide(call("WebSearch", { query: "typescript" }), HOME, id).allow).toBe(true);
    expect(decide(call("WebFetch", { url: "https://example.com" }), HOME, id).allow).toBe(true);
  });

  it("DENIES a tool it has never been taught", () => {
    // The LS failure mode: an unclassified tool has an argument shape this
    // function cannot inspect, so it must not be waved through.
    const v = decide(call("SomeNewTool", { path: "/Users/owner/.ssh" }), HOME, id);
    expect(v.allow).toBe(false);
  });

  it("denies a path-shaped tool whose argument is missing", () => {
    const v = decide(call("Read", {}), HOME, id);
    expect(v.allow).toBe(false);
  });

  it("denies when tool_input is not an object", () => {
    const v = decide({ tool_name: "Read", tool_input: null as never, cwd: CWD }, HOME, id);
    expect(v.allow).toBe(false);
  });
});

describe("DENY_REASON is a contract", () => {
  it("leaks no path, tilde, or rule name", () => {
    expect(DENY_REASON).not.toMatch(/[/~]/);
    expect(DENY_REASON).not.toMatch(/ssh|aws|env|keychain/i);
    expect(DENY_REASON.split(/[.!?]/).filter((s) => s.trim()).length).toBe(1);
  });
});

function harness() {
  const lines: Array<{ file: string; line: string }> = [];
  const deps: GuardDeps = {
    paths: getPaths(HOME),
    callId: "call-123",
    now: () => "2026-07-31T00:00:00.000Z",
    realpath: id,
    appendLine: (file, line) => lines.push({ file, line }),
  };
  const p = getPaths(HOME);
  return {
    deps, lines,
    calls: () => lines.filter((l) => l.file === p.callsLog).map((l) => JSON.parse(l.line)),
    tools: () => lines.filter((l) => l.file === p.toolsLog).map((l) => JSON.parse(l.line)),
  };
}

const payload = (tool: string, input: Record<string, unknown>) =>
  JSON.stringify({ hook_event_name: "PreToolUse", tool_name: tool, tool_input: input, cwd: CWD });

describe("runGuard", () => {
  it("allows an ordinary read, logging only to tools.log", () => {
    const h = harness();
    const out = runGuard(payload("Read", { file_path: "/Users/owner/proj/a.ts" }), h.deps);
    expect(out.exitCode).toBe(0);
    expect(out.stdout).toBe("");
    expect(h.calls()).toHaveLength(0);
    expect(h.tools()).toEqual([
      { ts: "2026-07-31T00:00:00.000Z", type: "tool_call", call_id: "call-123", tool: "Read", allowed: true },
    ]);
  });

  it("denies a credential read, logging to both streams", () => {
    const h = harness();
    const out = runGuard(payload("Read", { file_path: "/Users/owner/.ssh/id_rsa" }), h.deps);
    expect(out.exitCode).toBe(0);
    const decision = JSON.parse(out.stdout);
    expect(decision.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(decision.hookSpecificOutput.permissionDecisionReason).toBe(DENY_REASON);
    expect(h.calls()[0]).toMatchObject({ type: "tool_denied", call_id: "call-123", tool: "Read" });
    expect(h.tools()[0]).toMatchObject({ type: "tool_call", allowed: false });
  });

  it("never leaks the resolved path to the caller", () => {
    const h = harness();
    const out = runGuard(payload("Read", { file_path: "/Users/owner/.ssh/id_rsa" }), h.deps);
    expect(out.stdout).not.toContain("id_rsa");
    expect(out.stdout).not.toContain(".ssh");
    // …while the owner's log keeps the specifics.
    expect(JSON.stringify(h.calls()[0])).toContain("id_rsa");
  });

  it("records a flagged Bash command without denying it", () => {
    const h = harness();
    const out = runGuard(payload("Bash", { command: "cat /Users/owner/.ssh/id_rsa" }), h.deps);
    expect(out.exitCode).toBe(0);
    expect(out.stdout).toBe("");
    expect(h.calls()[0]).toMatchObject({ type: "tool_flagged", tool: "Bash" });
    expect(h.tools()[0]).toMatchObject({ allowed: true });
  });

  it("fails closed on unparseable input", () => {
    const h = harness();
    const out = runGuard("not json", h.deps);
    expect(out.exitCode).toBe(2);
  });

  it("fails closed on a payload with no tool name", () => {
    const h = harness();
    const out = runGuard(JSON.stringify({ cwd: CWD }), h.deps);
    expect(out.exitCode).toBe(2);
  });

  it("fails closed when the audit write throws", () => {
    // A full disk or read-only home must not become a silent allow. Without
    // the log writes inside the try, this exits 1 and Claude runs the tool.
    const h = harness();
    const out = runGuard(payload("Read", { file_path: "/Users/owner/proj/a.ts" }), {
      ...h.deps,
      appendLine: () => { throw new Error("ENOSPC: no space left on device"); },
    });
    expect(out.exitCode).toBe(2);
  });
});
