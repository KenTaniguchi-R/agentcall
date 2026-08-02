import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { decide, DENY_REASON, runGuard, type GuardDeps, type GuardInput } from "../src/guard.js";
import { getLinePaths, getMachinePaths } from "../src/paths.js";

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

  // ~/.codex holds auth.json and a config.toml that routinely carries API
  // keys in plaintext — the same argument that put ~/.claude on the list.
  it("denies reading inside ~/.codex", () => {
    const v = decide(call("Read", { file_path: "/Users/owner/.codex/auth.json" }), HOME, id);
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

describe("decide — allowed workdir boundary", () => {
  const ROOT = "/Users/owner/code/payments";
  const bounded = (tool: string, input: Record<string, unknown>, cwd = ROOT) =>
    decide(call(tool, input, cwd), HOME, id, "/opt/agentcall", ROOT);

  it("allows file tools inside the resolved workdir", () => {
    expect(bounded("Read", { file_path: `${ROOT}/src/index.ts` }).allow).toBe(true);
    expect(bounded("Write", { file_path: `${ROOT}/notes/new.md` }).allow).toBe(true);
  });

  it("denies exact file targets outside the resolved workdir", () => {
    expect(bounded("Read", { file_path: "/Users/owner/code/payroll/secrets.ts" }))
      .toMatchObject({ allow: false, rule: "outside-allowed-root" });
    expect(bounded("Edit", { file_path: "../payroll/secrets.ts" }))
      .toMatchObject({ allow: false, rule: "outside-allowed-root" });
  });

  it("denies searches and absolute glob selectors outside the resolved workdir", () => {
    expect(bounded("Grep", { path: "/Users/owner/code", pattern: "token" }))
      .toMatchObject({ allow: false, rule: "outside-allowed-root" });
    expect(bounded("Glob", { pattern: "/Users/owner/code/payroll/**/*.ts" }))
      .toMatchObject({ allow: false, rule: "outside-allowed-root" });
  });

  it("still records but allows Bash because exec is an explicit residual", () => {
    expect(bounded("Bash", { command: "cat /Users/owner/code/payroll/secrets.ts" }).allow).toBe(true);
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

  it("denies closed, not open, when `path` is present but not a string", () => {
    // A non-string path must not silently fall back to cwd — that would let
    // an array or a number sail past the root check entirely.
    const v1 = decide(call("Grep", { path: ["/Users/owner/.ssh"], pattern: "x" }), HOME, id);
    expect(v1.allow).toBe(false);
    const v2 = decide(call("Grep", { path: 0, pattern: "x" }), HOME, id);
    expect(v2.allow).toBe(false);
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

  it("denies closed, not open, when `pattern` is absent", () => {
    // Unlike Grep's `glob`, Glob's `pattern` IS the path — there is no
    // root-only check to fall back on, so absent must not mean "everything".
    const v = decide(call("Glob", {}), HOME, id);
    expect(v.allow).toBe(false);
  });

  it("denies closed, not open, when `pattern` is not a string", () => {
    const v = decide(call("Glob", { pattern: 7 }), HOME, id);
    expect(v.allow).toBe(false);
  });
});

describe("decide — the guard protects its own installed code", () => {
  // Synthetic root, not the machine's real install path: `guardRoot` is the
  // 4th, overridable param. A fresh node process re-imports guard.js on every
  // hook invocation, so a Write here neuters every check after it inside the
  // SAME call — this is the finding that blocked the merge.
  const GUARD_ROOT = "/Users/owner/coding/agentcall/packages/cli";

  it("denies overwriting the guard's own entry point", () => {
    const v = decide(call("Write", { file_path: `${GUARD_ROOT}/dist/guard-entry.js` }), HOME, id, GUARD_ROOT);
    expect(v.allow).toBe(false);
  });

  it("denies overwriting guard.js itself", () => {
    const v = decide(call("Write", { file_path: `${GUARD_ROOT}/dist/guard.js` }), HOME, id, GUARD_ROOT);
    expect(v.allow).toBe(false);
  });

  it("still allows writes outside the guard root with the same override in place", () => {
    const v = decide(call("Write", { file_path: "/Users/owner/proj/src/index.ts" }), HOME, id, GUARD_ROOT);
    expect(v.allow).toBe(true);
  });

  it("denies a Grep rooted at the guard's package root", () => {
    const v = decide(call("Grep", { path: GUARD_ROOT, pattern: "x" }), HOME, id, GUARD_ROOT);
    expect(v.allow).toBe(false);
  });
});

describe("decide — task envelopes and launch config are protected", () => {
  // "AgentCall/tasks" is no longer a fixed DENIED_DIRS entry — under the
  // per-line layout tasks live at AgentCall/<line>/tasks, and runGuard passes
  // every line's tasksDir in as an extraDeniedRoot instead. These tests
  // exercise decide() the same way runGuard does, by passing the root in.
  const TASKS = "/Users/owner/AgentCall/ask-line/tasks";

  it("denies writing a task's SKILL.md, which sets its capability envelope", () => {
    const v = decide(call("Write", { file_path: `${TASKS}/ask/SKILL.md` }), HOME, id, undefined, undefined, [TASKS]);
    expect(v.allow).toBe(false);
  });

  it("denies a Grep rooted at the tasks directory", () => {
    const v = decide(call("Grep", { path: TASKS, pattern: "tools" }), HOME, id, undefined, undefined, [TASKS]);
    expect(v.allow).toBe(false);
  });

  it("denies writing a LaunchAgents plist, which controls how the listener is launched", () => {
    const v = decide(
      call("Write", { file_path: "/Users/owner/Library/LaunchAgents/com.agentcall.listener.plist" }),
      HOME, id,
    );
    expect(v.allow).toBe(false);
  });

  it.each([".zshrc", ".zprofile", ".bashrc", ".bash_profile", ".profile"])(
    "denies writing %s, a shell startup file",
    (file) => {
      const v = decide(call("Write", { file_path: `/Users/owner/${file}` }), HOME, id);
      expect(v.allow).toBe(false);
    },
  );
});

describe("guard security root", () => {
  it("denies the real home's .ssh, not the state root's", () => {
    const verdict = decide(
      { tool_name: "Read", tool_input: { file_path: "/Users/real/.ssh/id_rsa" }, cwd: "/tmp/work" },
      "/Users/real",
      id,
    );
    expect(verdict.allow).toBe(false);
  });

  it("denies one line's config from another line's agent (.agentcall is a denied root)", () => {
    const verdict = decide(
      { tool_name: "Read", tool_input: { file_path: "/Users/real/.agentcall/lines/codex/config.json" }, cwd: "/tmp/work" },
      "/Users/real",
      id,
    );
    expect(verdict.allow).toBe(false);
  });
});

describe("per-line task directories are denied", () => {
  it("denies AgentCall/<line>/tasks when passed as an extra root", () => {
    const verdict = decide(
      { tool_name: "Write", tool_input: { file_path: "/Users/real/AgentCall/codex/tasks/x/SKILL.md" }, cwd: "/tmp/work" },
      "/Users/real",
      id,
      "/pkg",
      undefined,
      [join("/Users/real", "AgentCall", "codex", "tasks")],
    );
    expect(verdict.allow).toBe(false);
  });

  it("still allows the line's own share directory", () => {
    const verdict = decide(
      { tool_name: "Write", tool_input: { file_path: "/Users/real/AgentCall/codex/public/notes.md" }, cwd: "/tmp/work" },
      "/Users/real",
      id,
      "/pkg",
      undefined,
      [join("/Users/real", "AgentCall", "codex", "tasks")],
    );
    expect(verdict.allow).toBe(true);
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

describe("decide — WebFetch is scheme-checked", () => {
  it("allows an ordinary http(s) url", () => {
    expect(decide(call("WebFetch", { url: "https://example.com" }), HOME, id).allow).toBe(true);
    expect(decide(call("WebFetch", { url: "http://example.com" }), HOME, id).allow).toBe(true);
  });

  it("denies a file:// url, which would read the local filesystem", () => {
    const v = decide(call("WebFetch", { url: "file:///Users/owner/.ssh/id_rsa" }), HOME, id);
    expect(v.allow).toBe(false);
  });

  it("denies a non-string or missing url", () => {
    expect(decide(call("WebFetch", { url: 7 }), HOME, id).allow).toBe(false);
    expect(decide(call("WebFetch", {}), HOME, id).allow).toBe(false);
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
  const logLines: Array<{ file: string; line: string }> = [];
  // userHome === stateRoot here, matching this file's old flat-HOME tests:
  // the security root the existing assertions below rely on is HOME.
  const linePaths = getLinePaths(getMachinePaths(HOME, HOME), "test-line");
  const deps: GuardDeps = {
    line: linePaths,
    callId: "call-123",
    now: () => "2026-07-31T00:00:00.000Z",
    realpath: id,
    appendLine: (file, line) => logLines.push({ file, line }),
  };
  return {
    deps, lines: logLines,
    calls: () => logLines.filter((l) => l.file === linePaths.callsLog).map((l) => JSON.parse(l.line)),
    tools: () => logLines.filter((l) => l.file === linePaths.toolsLog).map((l) => JSON.parse(l.line)),
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

  // Codex treats exit 2 with an EMPTY stderr as a failed hook and runs the
  // tool anyway; only exit 2 WITH a reason on stderr blocks. Every fail-closed
  // path must therefore carry text, or the guard's fail-closed paths fail OPEN
  // the moment the same entry point is wired to a codex spawn.
  it.each([
    ["unparseable input", "not json"],
    ["a payload with no tool name", JSON.stringify({ cwd: CWD })],
  ])("emits a non-empty stderr reason when failing closed on %s", (_label, raw) => {
    const h = harness();
    const out = runGuard(raw, h.deps);
    expect(out.exitCode).toBe(2);
    expect(out.stderr.trim()).not.toBe("");
  });

  it("emits a non-empty stderr reason when the audit write throws", () => {
    const h = harness();
    const out = runGuard(payload("Read", { file_path: "/Users/owner/proj/a.ts" }), {
      ...h.deps,
      appendLine: () => { throw new Error("ENOSPC: no space left on device"); },
    });
    expect(out.exitCode).toBe(2);
    expect(out.stderr.trim()).not.toBe("");
  });

  it("keeps the stderr reason free of the resolved path, as with stdout", () => {
    const h = harness();
    const out = runGuard(payload("Read", { file_path: "/Users/owner/.ssh/id_rsa" }), h.deps);
    expect(out.stderr).not.toContain("id_rsa");
  });
});

// The codex spawn gets the same hook, but codex's own kernel-enforced
// `deny_read` is the boundary there — not this. Observing rather than
// enforcing keeps the guard from denying codex tools it cannot classify
// (`apply_patch` and friends), which would break the runtime while adding
// no security. See the design spec.
describe("runGuard — observe mode", () => {
  it("records a credential read without denying it", () => {
    const h = harness();
    const out = runGuard(payload("Read", { file_path: "/Users/owner/.ssh/id_rsa" }), h.deps, "observe");
    expect(out.exitCode).toBe(0);
    expect(out.stdout).toBe("");
    expect(h.calls()[0]).toMatchObject({ type: "tool_attempt_flagged", tool: "Read" });
  });

  it("records an unclassified tool without denying it", () => {
    const h = harness();
    const out = runGuard(payload("apply_patch", { patch: "x" }), h.deps, "observe");
    expect(out.exitCode).toBe(0);
    expect(out.stdout).toBe("");
  });

  it("still writes every call to tools.log", () => {
    const h = harness();
    runGuard(payload("Bash", { command: "sed -n '1,200p' a.ts" }), h.deps, "observe");
    expect(h.tools()[0]).toMatchObject({ type: "tool_call", tool: "Bash" });
  });

  // PreToolUse reports what the model ATTEMPTED, and in observe mode nothing
  // downstream is blocked by us — so an `allowed` field would assert an
  // outcome this hook never observes.
  it("does not claim an allow/deny outcome it cannot observe", () => {
    const h = harness();
    runGuard(payload("Bash", { command: "echo hi" }), h.deps, "observe");
    expect(h.tools()[0]).not.toHaveProperty("allowed");
    expect(h.tools()[0]).toMatchObject({ mode: "observe" });
  });

  // Not a boundary here, so a guard failure must not cost availability.
  it("fails open when the audit write throws", () => {
    const h = harness();
    const out = runGuard(payload("Read", { file_path: "/Users/owner/proj/a.ts" }), {
      ...h.deps,
      appendLine: () => { throw new Error("ENOSPC: no space left on device"); },
    }, "observe");
    expect(out.exitCode).toBe(0);
  });
});

// End-to-end through the real filesystem, unlike harness()'s synthetic HOME:
// runGuard's own extraDeniedRoots computation (lineTaskDirs) reads
// deps.line.machine.linesDir off disk, so these are the only tests that
// exercise that enumeration rather than a hand-passed array.
// Unlike harness()'s synthetic HOME, these use real mkdtempSync directories,
// so lineTaskDirs' readdirSync actually runs — this is the only describe
// block that exercises the on-disk enumeration itself, rather than a
// hand-passed extraDeniedRoots array. Critically, stateRoot and userHome are
// two DIFFERENT real directories in every test here, simulating a redirected
// AGENTCALL_HOME: the acting line's own on-disk state lives under stateRoot,
// exactly as it would with AGENTCALL_HOME set, while the lines being
// enumerated for denial live under userHome, the real machine home. A version
// of runGuard that enumerated deps.line.machine directly (stateRoot-rooted)
// would find nothing here and silently ALLOW every write below — that is
// exactly the regression this block exists to catch.
describe("runGuard — enumerates every line's tasksDir from the real home, not a redirected state root", () => {
  function splitHomes() {
    return {
      stateRoot: mkdtempSync(join(tmpdir(), "agentcall-guard-state-")),
      userHome: mkdtempSync(join(tmpdir(), "agentcall-guard-home-")),
    };
  }

  function actingDeps(stateRoot: string, userHome: string): GuardDeps {
    const acting = getLinePaths(getMachinePaths(stateRoot, userHome), "acting");
    return {
      line: acting, callId: "call-1", now: () => "2026-08-01T00:00:00.000Z",
      realpath: (p) => p, appendLine: () => {},
    };
  }

  it("denies another line's tasks directory under the real home, including a line with no config.json", () => {
    const { stateRoot, userHome } = splitHomes();
    // The REAL machine — rooted at userHome for both fields — is what
    // lineTaskDirs must enumerate from, not deps.line.machine (which sits
    // under the redirected stateRoot below and has no lines under it at all).
    const realMachine = getMachinePaths(userHome, userHome);
    const other = getLinePaths(realMachine, "other-line");
    // Never finished setup — no config.json — and per lineTaskDirs' contract
    // that must not exempt its tasksDir from being denied.
    mkdirSync(other.dir, { recursive: true });

    const out = runGuard(
      payload("Write", { file_path: join(other.tasksDir, "ask", "SKILL.md") }),
      actingDeps(stateRoot, userHome),
    );
    const decision = JSON.parse(out.stdout);
    expect(decision.hookSpecificOutput.permissionDecision).toBe("deny");
  });

  // Legacy flat layout, pre-dating per-line: still real and writable on
  // every already-set-up machine until Task 12, so it must stay denied
  // independently of the per-line enumeration above.
  it("denies the legacy flat AgentCall/tasks directory under the real home", () => {
    const { stateRoot, userHome } = splitHomes();
    const legacyTask = join(userHome, "AgentCall", "tasks", "ask", "SKILL.md");
    const out = runGuard(payload("Write", { file_path: legacyTask }), actingDeps(stateRoot, userHome));
    const decision = JSON.parse(out.stdout);
    expect(decision.hookSpecificOutput.permissionDecision).toBe("deny");
  });

  it("still allows writing to the acting line's own share directory", () => {
    const { stateRoot, userHome } = splitHomes();
    const deps = actingDeps(stateRoot, userHome);
    const out = runGuard(payload("Write", { file_path: join(deps.line.shareDir, "notes.md") }), deps);
    expect(out.stdout).toBe("");
    expect(out.exitCode).toBe(0);
  });
});
