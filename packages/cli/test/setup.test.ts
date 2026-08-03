import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runSetup, warnIfEphemeralServiceBin, type SetupOpts } from "../src/setup.js";
import { getLinePaths, getMachinePaths, type MachinePaths } from "../src/paths.js";
import { listLines, saveLineConfig } from "../src/lines.js";
import { loadPerson, savePerson } from "../src/person.js";
import { addLine, type AddLineOpts } from "../src/commands/line.js";
import type { LineConfig } from "../src/config.js";
import { AgentRunError } from "../src/runner.js";

// addLine/removeLine (and so runSetup, which delegates to addLine) fall back
// to the real installListenerService/uninstallListenerService whenever a seam is
// omitted — and the real ones shell out to the actual `launchctl bootstrap`/
// `bootout` on whoever's machine runs this suite, regardless of how
// sandboxed MachinePaths.userHome is (only the plist *file* path is
// sandboxed; the launchd *session* is the real logged-in user's). This is
// the same guard line-cmd.test.ts carries, added there after this exact
// class of bug booted out the developer's real listener — every test below
// must pass its own skipService/installListenerServiceFn, or fail loudly here
// instead of silently reaching the real thing.
vi.mock("../src/listener-service.js", () => ({
  installListenerService: () => {
    throw new Error("real installListenerService reached in a test — pass skipService or installListenerServiceFn");
  },
  uninstallListenerService: () => {
    throw new Error("real uninstallListenerService reached in a test — pass an uninstall seam");
  },
}));

// A local stand-in for the relay: registerHandle's real implementation
// spends the handle it registers permanently (handle release isn't
// implemented — see #16), so no test here may reach it, not even against a
// throwaway local HTTP server. Every runSetup call below goes through
// `addLine` with this `register` seam instead, which still exercises
// addLine's real validation/ordering/disk-writes/launchd wiring — just with
// no network underneath it.
const R = "https://r.example";
const stubRegister = async (_relay: string, _invite: string, handle: string) =>
  ({ org: "acme", token: "tok-123", address: `${handle}@fake.example` });
const base: LineConfig = { org: "acme", handle: "ken", token: "t", relay: R, agent_kind: "claude" };

// The real addLine, wired to stubRegister instead of the network. Used as
// the `addLineFn` seam by every test below unless a test needs to observe
// one of addLine's own callbacks (publishCardFn, installListenerServiceFn) —
// those pass their own wrapper built the same way.
const fakeAddLine = (m: MachinePaths, opts: AddLineOpts) =>
  addLine(m, { ...opts, register: stubRegister, publishKeysFn: async () => {}, publishCardFn: opts.publishCardFn ?? (async () => undefined) });

// addLine derives extraPathDirs (listenerPathDirs, see listenerPath.ts) eagerly
// as an argument expression, so it runs even when installListenerServiceFn is a
// total no-op — and by default that derivation falls back to the real
// `which` via defaultResolveBin. run() below defaults resolveBin to this so
// no test in this file shells out by accident; "threads its resolveBin
// seam..." overrides it explicitly to prove an override still reaches
// addLine's derivation.
const noNetworkResolveBin = () => null;
// runSetup now requires opts.invite on the first-run path (throws "An
// organization invite is required." before even prompting for a handle —
// see the dedicated "requires an invite for a fresh enrollment" test, which
// calls runSetup directly rather than through this helper). Defaulted here
// so the tests below, which are about everything else, don't all have to
// repeat it.
function run(opts: SetupOpts): Promise<{ ready: boolean }> {
  return runSetup({ resolveBin: noNetworkResolveBin, invite: "test-invite", ...opts });
}

let home: string;
let m: MachinePaths;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "agentcall-setup-"));
  process.env.AGENTCALL_HOME = home;
  m = getMachinePaths(home, home);
});
afterEach(() => {
  delete process.env.AGENTCALL_HOME;
});

describe("runSetup", () => {
  it("creates person.json plus one line, and marks it primary", async () => {
    await run({
      handle: "ken", agent: "claude", relay: R, yes: true, snippet: false, verify: false,
      addLineFn: fakeAddLine, skipService: true,
    });
    expect(loadPerson(m).primary_line).toBe("claude");
    expect(listLines(m).map((l) => l.name)).toEqual(["claude"]);
    // mkdirSync(paths.shareDir) is addLine's (commands/line.ts), not tested
    // anywhere else — this is the callable half of what the old flat-config
    // "registers, writes config, creates public dir" test asserted.
    expect(existsSync(getLinePaths(m, "claude").shareDir)).toBe(true);
  });

  it("names the line after the agent kind", async () => {
    await run({
      handle: "ken", agent: "codex", relay: R, yes: true, snippet: false, verify: false,
      addLineFn: fakeAddLine, skipService: true,
    });
    expect(listLines(m).map((l) => l.name)).toEqual(["codex"]);
  });

  // Re-homed from main's "re-running setup ... reuses the saved config
  // instead of re-registering": there is no reuse path left to exercise
  // (a second run never calls addLine at all), so this instead pins the new
  // equivalent — a no-op that neither re-registers nor disturbs the
  // existing line's config.json.
  it("creates nothing on a second run and points at line add, leaving the existing line's config.json and policy.json untouched", async () => {
    const lp = getLinePaths(m, "claude");
    saveLineConfig(lp, base);
    savePerson(m, { primary_line: "claude" });
    const before = readFileSync(lp.configFile, "utf8");
    // Also pins the new equivalent of main's "does not overwrite an existing
    // policy.json on re-run": that test's own reuse path is gone (a second
    // run never touches an existing line's directory at all), so the same
    // "no-op" guarantee that protects config.json is what protects any
    // custom policy.json now too.
    mkdirSync(lp.dir, { recursive: true });
    const customPolicy = JSON.stringify({ description: "custom", default_offer: ["ask"] });
    writeFileSync(lp.policyFile, customPolicy);
    const out: string[] = [];
    // handle/relay match the existing "claude" line's — a mismatch on
    // either is the *different* refusal path covered by the two
    // "refuses an explicitly different relay/handle..." tests below.
    const res = await run({
      handle: base.handle, agent: "codex", relay: base.relay, yes: true, snippet: false, verify: false,
      addLineFn: () => { throw new Error("must not re-register on a second run"); },
      skipService: true, log: (s) => out.push(s),
    });
    expect(listLines(m).map((l) => l.name)).toEqual(["claude"]);
    expect(readFileSync(lp.configFile, "utf8")).toBe(before);
    expect(readFileSync(lp.policyFile, "utf8")).toBe(customPolicy);
    expect(out.join("\n")).toMatch(/agentcall line add/);
    expect(res.ready).toBe(true);
  });

  it("repairs the background service on a second run for an existing callable line", async () => {
    saveLineConfig(getLinePaths(m, "claude"), base);
    savePerson(m, { primary_line: "claude" });
    let installed = 0;

    await run({
      relay: R,
      snippet: false,
      verify: false,
      installListenerServiceFn: () => { installed += 1; },
      log: () => {},
    });

    expect(installed).toBe(1);
  });

  // Re-homed from main's "refuses to overwrite a corrupt credential config as
  // though it were a fresh install". A corrupt line is still a line: listLines
  // reports it as an orphan rather than throwing, so setup must take the
  // already-set-up branch — registering nothing (a burned handle is spent
  // permanently and globally) and leaving the broken file exactly as found for
  // the owner to fix or `line remove`.
  it("treats a corrupt line config as an existing install: no registration, file untouched", async () => {
    const lp = getLinePaths(m, "claude");
    mkdirSync(lp.dir, { recursive: true });
    writeFileSync(lp.configFile, "{\"org\":\"acme\"");
    savePerson(m, { primary_line: "claude" });
    const before = readFileSync(lp.configFile, "utf8");

    const res = await run({
      agent: "claude", yes: true, snippet: false, verify: false,
      addLineFn: () => { throw new Error("must not register against a corrupt line"); },
      skipService: true, log: () => {},
    });

    expect(res.ready).toBe(true);
    expect(readFileSync(lp.configFile, "utf8")).toBe(before);
    expect(listLines(m).map((l) => l.ok)).toEqual([false]);
  });

  it("creates an agentless line under --caller-only", async () => {
    await run({
      handle: "ken", callerOnly: true, relay: R, yes: true, snippet: false, verify: false,
      addLineFn: fakeAddLine, skipService: true,
    });
    expect(listLines(m)[0]!.config!.agent_kind).toBeUndefined();
    // The caller-only half of the old flat-config test: no agent means no
    // shareDir/tasksDir/policy — addLine's `if (agentKind)` block never runs.
    expect(existsSync(getLinePaths(m, "caller").shareDir)).toBe(false);
  });

  // Re-homed from main's #79 ("refuses an explicitly different relay instead
  // of silently reusing the saved registration"). Several relays on one
  // machine are legal now (that's what lines are for), so the remedy is no
  // longer "reuse silently ignored the flag" vs. "throw and point at
  // uninstall" — it's "throw only when the flag names something no existing
  // line provides, and point at `line add` instead of `uninstall`". Split
  // into two tests, one per flag, since runSetup checks them independently.
  it("refuses an explicitly different relay than any existing line's, pointing at line add", async () => {
    const lp = getLinePaths(m, "claude");
    saveLineConfig(lp, base);
    savePerson(m, { primary_line: "claude" });
    const before = readFileSync(lp.configFile, "utf8");

    await expect(run({
      relay: "https://other.example", snippet: false, verify: false, skipService: true,
      addLineFn: () => { throw new Error("must not register"); },
    })).rejects.toThrow(/no line on.*agentcall line add/i);

    expect(readFileSync(lp.configFile, "utf8")).toBe(before);
  });

  it("refuses an explicitly different handle than any existing line holds, pointing at line add", async () => {
    const lp = getLinePaths(m, "claude");
    saveLineConfig(lp, base);
    savePerson(m, { primary_line: "claude" });
    const before = readFileSync(lp.configFile, "utf8");

    await expect(run({
      handle: "someone-else", snippet: false, verify: false, skipService: true,
      addLineFn: () => { throw new Error("must not register"); },
    })).rejects.toThrow(/holds no line for the handle.*agentcall line add/i);

    expect(readFileSync(lp.configFile, "utf8")).toBe(before);
  });

  // Regression: re-running setup used to run agent detection (and its
  // "Which should agentcall use?" prompt) before the reuse check. That path
  // is gone entirely now — a second run short-circuits on `existing.length >
  // 0` before touching decideCallable/detectAgentKind at all.
  it("asks no questions on a second run", async () => {
    saveLineConfig(getLinePaths(m, "claude"), base);
    savePerson(m, { primary_line: "claude" });
    const asked: string[] = [];
    await run({
      relay: R, snippet: false, verify: false, skipService: true, addLineFn: fakeAddLine,
      hasBin: () => true, // both claude and codex on PATH — would normally prompt
      io: { ask: async (q) => { asked.push(q); return "claude"; } },
    });
    expect(asked).toEqual([]);
  });

  it("prompts for a missing handle via io.ask", async () => {
    const asked: string[] = [];
    await run({
      agent: "claude", relay: R, snippet: false, verify: false, skipService: true, addLineFn: fakeAddLine,
      io: { ask: async (q) => { asked.push(q); return "asked-handle"; } },
    });
    expect(listLines(m)[0]!.config!.handle).toBe("asked-handle");
    expect(asked.length).toBeGreaterThan(0);
  });

  it("requires an invite for a fresh enrollment", async () => {
    const home = mkdtempSync(join(tmpdir(), "agentcall-setup-"));
    process.env.AGENTCALL_HOME = home;
    try {
      await expect(runSetup({
        verify: false, handle: "ken", callerOnly: true, relay: "http://127.0.0.1:1", snippet: false,
      })).rejects.toThrow(/setup --invite/);
    } finally {
      delete process.env.AGENTCALL_HOME;
    }
  });

  it("detects the agent kind via injectable hasBin when --agent is omitted", async () => {
    await run({
      handle: "ken2", relay: R, snippet: false, verify: false, skipService: true, addLineFn: fakeAddLine,
      hasBin: (name) => name === "codex",
      io: { ask: async () => "y" },
    });
    expect(listLines(m)[0]!.name).toBe("codex");
    expect(listLines(m)[0]!.config!.agent_kind).toBe("codex");
  });

  it("falls back to caller-only with a notice when neither agent is found", async () => {
    const logs: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
      logs.push(a.map(String).join(" "));
    });
    try {
      let serviceInstallCalled = false;
      await run({
        handle: "ken3", relay: R, snippet: false, verify: false, addLineFn: fakeAddLine,
        hasBin: () => false,
        installListenerServiceFn: () => { serviceInstallCalled = true; },
      });
      expect(listLines(m)[0]!.config!.agent_kind).toBeUndefined();
      expect(serviceInstallCalled).toBe(false);
      expect(logs.some((l) => l.includes("caller-only"))).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  // The extraPathDirs derivation itself lives in listenerPath.ts's
  // listenerPathDirs, exercised directly in listenerPath.test.ts and via
  // addLine in line-cmd.test.ts. This just proves setup threads its
  // resolveBin seam all the way down to that derivation rather than letting
  // addLine fall back to the real `which` — the fake resolveBin below would
  // never match a real machine's paths, so a non-empty, exact-match result
  // is only possible if the seam actually reached addLine.
  it("threads its resolveBin seam through to installListenerService's extraPathDirs", async () => {
    let captured: string[] | undefined;
    await run({
      handle: "ken4", agent: "claude", relay: R, snippet: false, verify: false, addLineFn: fakeAddLine,
      resolveBin: (name) => (name === "claude" || name === "npx" ? `/Users/x/.local/bin/${name}` : null),
      installListenerServiceFn: (_m, options) => { captured = options?.extraPathDirs; },
    });
    expect(captured).toEqual(["/Users/x/.local/bin"]);
  });

  // policy.json/tasksDir/card-publish are addLine's own responsibility now
  // (see commands/line.ts), but nothing in line-cmd.test.ts currently
  // exercises them — kept here so the behavior stays covered somewhere.
  it("seeds policy.json + tasks dir and publishes the card", async () => {
    const cardCalls: LineConfig[] = [];
    await run({
      handle: "ken", agent: "claude", relay: R, snippet: false, verify: false, skipService: true,
      addLineFn: (m2, opts) =>
        addLine(m2, { ...opts, register: stubRegister, publishKeysFn: async () => {}, publishCardFn: async (cfg) => { cardCalls.push(cfg); } }),
    });
    const lp = getLinePaths(m, "claude");
    expect(existsSync(lp.tasksDir)).toBe(true);
    const policy = JSON.parse(readFileSync(lp.policyFile, "utf8"));
    expect(policy.default_offer).toEqual(["ask"]);
    expect(cardCalls).toHaveLength(1);
    expect(cardCalls[0]).toMatchObject({ agent_kind: "claude", relay: R });
  });
  // main's "does not overwrite an existing policy.json on re-run" has no
  // remaining code path (addLine refuses a name that already exists —
  // see line-cmd.test.ts — so a line's policy.json is never regenerated
  // after creation); its intent is now covered by the policy.json half of
  // "creates nothing on a second run..." above.
});

describe("setup progress output", () => {
  it("prints a progress line before registering with the relay", async () => {
    const logs: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
      logs.push(a.map(String).join(" "));
    });
    try {
      await run({
        handle: "ken9", agent: "claude", relay: R, snippet: false, verify: false, skipService: true,
        addLineFn: fakeAddLine,
      });
      expect(logs.some((l) => l.includes("Registering ken9"))).toBe(true);
      expect(logs.some((l) => /offered tasks run automatically without per-call approval/i.test(l))).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("warnIfEphemeralServiceBin", () => {
  it("stays silent for a durable bin directory because the service PATH includes it", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      warnIfEphemeralServiceBin("claude", () => "/home/ken/.local/bin/claude");
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it("warns when a binary resolves only from an ephemeral directory", () => {
    const errors: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => {
      errors.push(a.map(String).join(" "));
    });
    try {
      warnIfEphemeralServiceBin("claude", () => "/tmp/session/bin/claude");
    } finally {
      spy.mockRestore();
    }
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("install claude in a durable location");
    expect(errors[0]!.length).toBeLessThan(200);
  });

  it("stays silent when the binary is in a native service path", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      warnIfEphemeralServiceBin("claude", () => "/opt/homebrew/bin/claude");
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});

describe("caller-only setup", () => {
  // main's "--caller-only registers without agent_kind and skips
  // publicDir/launchd" is covered above by "creates an agentless line under
  // --caller-only", and main's "re-running --caller-only setup reuses the
  // config, asks nothing, stays caller-only" is the same no-op code path as
  // "creates nothing on a second run..." above (runSetup's existing.length >
  // 0 branch does not distinguish caller-only from callable) — not
  // duplicated here.
  it("prints a caller-only summary pointing at `line add`, not a setup re-run", async () => {
    const logs: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
      logs.push(a.map(String).join(" "));
    });
    try {
      await run({
        handle: "solo2", callerOnly: true, relay: R, snippet: false, verify: false, addLineFn: fakeAddLine,
        hasBin: () => false,
      });
      const summary = logs.join("\n");
      expect(summary).toContain("caller-only");
      // Must NOT tell the owner to re-run setup: setup is first-run only now,
      // so that instruction would send them round a loop that does nothing.
      expect(summary).toContain("agentcall line add");
      expect(summary).not.toMatch(/re-run `?agentcall setup/);
      expect(summary).not.toContain("Share your address");
    } finally {
      spy.mockRestore();
    }
  });

  it("asks 'Make your agent callable' and answering n yields caller-only", async () => {
    const asked: string[] = [];
    let serviceInstallCalled = false;
    await run({
      handle: "asker", relay: R, snippet: false, verify: false, addLineFn: fakeAddLine,
      hasBin: () => true, // agents ARE installed; user still opts out
      io: { ask: async (q) => { asked.push(q); return "n"; } },
      installListenerServiceFn: () => { serviceInstallCalled = true; },
    });
    expect(asked.some((q) => q.includes("callable"))).toBe(true);
    expect(asked.some((q) => /run automatically without per-call approval/i.test(q))).toBe(true);
    expect(listLines(m)[0]!.config!.agent_kind).toBeUndefined();
    expect(serviceInstallCalled).toBe(false);  });

  it("an empty answer defaults to callable", async () => {
    await run({
      handle: "defaulter", relay: R, snippet: false, verify: false, skipService: true, addLineFn: fakeAddLine,
      hasBin: (name) => name === "claude",
      io: { ask: async () => "" },
    });
    expect(listLines(m)[0]!.config!.agent_kind).toBe("claude");
  });

  // main also had:
  // - "--caller-only against an already-callable config makes no changes and
  //   points at uninstall" and "refuses a caller-only setup under a new
  //   handle when the machine already answers calls" — both are the same
  //   existing.length > 0 no-op/refusal code path already covered above
  //   ("creates nothing on a second run...", and the two "refuses an
  //   explicitly different relay/handle..." tests), just under the
  //   --caller-only flag, which runSetup's reuse branch does not treat
  //   specially.
  // - "re-running setup upgrades a caller-only config to callable, keeping
  //   handle and token" — this capability is GONE, not just re-homed: a
  //   second `runSetup` call never calls addLine (see the "creates nothing
  //   on a second run" test), so there is no code path left that upgrades an
  //   existing caller-only line in place. Turning a caller-only line callable
  //   now requires a new line (`agentcall line add <name> --agent <kind>`),
  //   which is a different address, not an upgrade of the same one. Flagging
  //   this as a semantic removal rather than silently dropping the test.
});

describe("runSetup verification", () => {
  it("passing verification: reports ready:true and prints the verified line", async () => {
    const logs: string[] = [];
    const logSpy = vi.spyOn(console, "log").mockImplementation((msg) => {
      logs.push(String(msg));
    });
    try {
      const result = await run({
        handle: "ken", agent: "claude", relay: R, snippet: false, skipService: true, addLineFn: fakeAddLine,
        verifyFns: { resolveBin: () => "/fake/bin/claude", runFn: async () => ({ text: "OK" }) },
      });
      expect(result.ready).toBe(true);
      expect(logs.join("\n")).toContain("agent verified");
    } finally {
      logSpy.mockRestore();
    }
  });

  it("failing verification: still saves the line + installs launchd, but reports NOT ready", async () => {
    const errors: string[] = [];
    const errSpy = vi.spyOn(console, "error").mockImplementation((msg) => {
      errors.push(String(msg));
    });
    try {
      const installed: string[] = [];
      const result = await run({
        handle: "ken", agent: "claude", relay: R, snippet: false, addLineFn: fakeAddLine,
        installListenerServiceFn: () => {
          installed.push("yes");
        },
        verifyFns: {
          resolveBin: () => "/fake/bin/claude",
          runFn: async () => {
            throw new AgentRunError(
              "could not parse agent output: Error: claude reported an error: Invalid API key · Please run /login",
              "agent_error",
            );
          },
        },
      });
      expect(result.ready).toBe(false);
      expect(listLines(m)[0]!.ok).toBe(true);
      expect(installed).toEqual(["yes"]);
      const out = errors.join("\n");
      expect(out).toContain("NOT ready");
      expect(out).toContain("/login");
      expect(out).toContain("agentcall doctor");
    } finally {
      errSpy.mockRestore();
    }
  });

  it("--no-verify (verify:false) skips verification entirely", async () => {
    let ran = false;
    const result = await run({
      handle: "ken", agent: "claude", relay: R, snippet: false, skipService: true, verify: false,
      addLineFn: fakeAddLine,
      verifyFns: {
        resolveBin: () => "/fake/bin/claude",
        runFn: async () => {
          ran = true;
          return { text: "OK" };
        },
      },
    });
    expect(result.ready).toBe(true);
    expect(ran).toBe(false);
  });

  it("caller-only setup never verifies", async () => {
    let ran = false;
    const result = await run({
      handle: "solo", relay: R, snippet: false, skipService: true, callerOnly: true, addLineFn: fakeAddLine,
      verifyFns: {
        resolveBin: () => "/fake/bin/claude",
        runFn: async () => {
          ran = true;
          return { text: "OK" };
        },
      },
    });
    expect(result.ready).toBe(true);
    expect(ran).toBe(false);
  });
});
