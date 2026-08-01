import { describe, expect, it } from "vitest";
import { decide, DENY_REASON, type GuardInput } from "../src/guard.js";

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
