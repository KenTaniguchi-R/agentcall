import { describe, expect, it, beforeEach, vi } from "vitest";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getLinePaths, getMachinePaths, type MachinePaths } from "../src/paths.js";
import { saveLineConfig } from "../src/lines.js";
import { generateIdentityKeys } from "../src/keys.js";
import { loadPerson, savePerson } from "../src/person.js";
import {
  addLine as addLineImpl, listLinesReport, publishStoredKeys,
  removeLine as removeLineImpl, setPrimary,
  type AddLineOpts, type RemoveLineOpts,
} from "../src/commands/line.js";
import { tempDir } from "./helpers.js";

// addLine/removeLine fall back to the real installListenerService/
// uninstallListenerService whenever a test omits its opts seam
// (installListenerServiceFn/uninstallFn/installFn) — and the real ones shell out
// to the actual `launchctl bootstrap`/`bootout` on whoever's machine runs
// this suite, regardless of how sandboxed MachinePaths.userHome is (the
// launchd *session* is the real logged-in user's; only the plist file path
// is sandboxed). That already happened once while writing this file: it
// booted out the developer's real listener and replaced it with one
// pointing at a since-deleted tmp dir. Mocking the module here turns a
// missing seam into an immediate, loud test failure instead of a silent
// real-system side effect — every test below must pass its own no-op.
vi.mock("../src/listener-service.js", () => ({
  installListenerService: () => {
    throw new Error("real installListenerService reached in a test — pass installListenerServiceFn/installFn");
  },
  uninstallListenerService: () => {
    throw new Error("real uninstallListenerService reached in a test — pass uninstallFn");
  },
}));

let m: MachinePaths;
beforeEach(() => {
  const root = tempDir("agentcall-linecmd-");
  m = getMachinePaths(root, root);
  mkdirSync(m.linesDir, { recursive: true });
});

const ok = async () => ({ org: "acme", token: "tok" });
const base = { org: "acme", handle: "ken", token: "t", relay: "https://r.example", agent_kind: "claude" as const };

// listenerPathDirs (addLine's/removeLine's extraPathDirs default — see
// listenerPath.ts) falls back to the real `which` via defaultResolveBin
// whenever resolveBin/extraPathDirs is omitted, and it's evaluated eagerly
// as an argument expression, so it runs even when installListenerServiceFn/
// installFn is a total no-op. These wrappers default resolveBin to a
// deterministic no-op so no test below shells out by accident; the two
// tests that assert on the derivation itself pass their own resolveBin,
// which overrides this default.
const noNetworkResolveBin = () => null;
// `invite` is defaulted here for the same reason `resolveBin` is: every
// registration needs one (tenancy, #74), and threading a literal through all
// ~20 call sites below would only obscure what each test is actually about.
// The tests that care about the invite itself pass their own, or call
// addLineImpl directly.
function addLine(m: MachinePaths, opts: AddLineOpts): ReturnType<typeof addLineImpl> {
  return addLineImpl(m, { resolveBin: noNetworkResolveBin, invite: "test-invite", publishKeysFn: async () => {}, ...opts });
}
function removeLine(m: MachinePaths, name: string, opts: RemoveLineOpts = {}): void {
  removeLineImpl(m, name, { resolveBin: noNetworkResolveBin, ...opts });
}

describe("addLine", () => {
  // Was: asserts both helpers receive the org-prefixed address host. The host
  // is no longer part of an address, so the invariant that remains is that both
  // publish against the same relay for the same line.
  it("publishes identity and encryption against the same relay", async () => {
    const paths = getLinePaths(m, "caller");
    const keys = await generateIdentityKeys(paths);
    const relays: string[] = [];
    await publishStoredKeys(
      { org: "acme", handle: "ken", token: "t", relay: "https://agentcall.benree.tech" },
      keys,
      paths,
      {
        identity: async (relay) => { relays.push(relay); },
        encryption: async (relay) => { relays.push(relay); },
      },
    );
    expect(relays).toEqual(["https://agentcall.benree.tech", "https://agentcall.benree.tech"]);
  });
  it("persists identity keys before registration and config immediately after", async () => {
    let keysExistedAtRegistration = false;
    await addLine(m, { name: "codex", handle: "ken-cdx", agent: "codex", relay: "https://r.example",
      register: async () => { keysExistedAtRegistration = existsSync(getLinePaths(m, "codex").identityKeyFile); return ok(); },
      installListenerServiceFn: () => {}, publishCardFn: async () => undefined, verify: false });
    const l = getLinePaths(m, "codex");
    expect(keysExistedAtRegistration).toBe(true);
    expect(JSON.parse(readFileSync(l.configFile, "utf8")).token).toBe("tok");
  });

  it("publishes exactly the key material committed before registration", async () => {
    let persistedAtRegister = "";
    let published = "";
    await addLine(m, {
      name: "caller", handle: "ken-c", relay: "https://r.example", callerOnly: true,
      register: async () => {
        persistedAtRegister = JSON.parse(readFileSync(getLinePaths(m, "caller").identityKeyFile, "utf8")).identity_pub;
        return ok();
      },
      publishKeysFn: async (_cfg, keys) => { published = keys.identity_pub; }, verify: false,
    });
    expect(published).toBe(persistedAtRegister);
  });

  it("keeps persisted credentials and gives a recovery command when key publication fails", async () => {
    const warnings: string[] = [];
    await addLine(m, {
      name: "caller", handle: "ken-c", relay: "https://r.example", callerOnly: true,
      register: ok, publishKeysFn: async () => { throw new Error("offline"); },
      warn: (line) => warnings.push(line), verify: false,
    });
    expect(existsSync(getLinePaths(m, "caller").configFile)).toBe(true);
    expect(warnings.join("\n")).toContain("agentcall keys publish --line caller");
  });

  it("leaves the disk untouched when the handle is taken", async () => {
    const taken = async () => { throw new Error("Handle \"ken-cdx\" is already taken."); };
    await expect(addLine(m, { name: "codex", handle: "ken-cdx", agent: "codex", relay: "https://r.example",
      register: taken, installListenerServiceFn: () => {}, publishCardFn: async () => undefined, verify: false }))
      .rejects.toThrow(/already taken/);
    expect(readdirSync(m.linesDir)).toEqual([]);
  });

  it("gives one concurrent setup exclusive ownership of a line directory", async () => {
    let registrations = 0;
    const register = async () => { registrations += 1; return ok(); };
    const options = {
      name: "caller", handle: "ken-c", relay: "https://r.example", callerOnly: true,
      register, publishKeysFn: async () => {}, verify: false,
    };
    const first = addLine(m, options);
    const second = addLine(m, options);
    const settled = await Promise.allSettled([first, second]);
    expect(settled.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(settled.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(registrations).toBe(1);
    expect(existsSync(getLinePaths(m, "caller").identityKeyFile)).toBe(true);
    expect(existsSync(getLinePaths(m, "caller").configFile)).toBe(true);
  });

  it("rejects an invalid line name before registering", async () => {
    let called = false;
    await expect(addLine(m, { name: "../evil", handle: "x", agent: "codex", relay: "https://r.example",
      register: async () => { called = true; return { org: "acme", token: "t" }; },
      installListenerServiceFn: () => {}, publishCardFn: async () => undefined, verify: false }))
      .rejects.toThrow(/line name/i);
    expect(called).toBe(false);
  });

  it("refuses a name that already exists", async () => {
    saveLineConfig(getLinePaths(m, "codex"), base);
    let called = false;
    await expect(addLine(m, { name: "codex", handle: "other", agent: "codex", relay: "https://r.example",
      register: async () => { called = true; return { org: "acme", token: "t" }; },
      installListenerServiceFn: () => {}, publishCardFn: async () => undefined, verify: false }))
      .rejects.toThrow(/already/);
    expect(called).toBe(false);
  });

  it("refuses a handle another line already holds", async () => {
    saveLineConfig(getLinePaths(m, "claude"), { ...base, handle: "ken-cdx" });
    let called = false;
    await expect(addLine(m, { name: "codex", handle: "ken-cdx", agent: "codex", relay: "https://r.example",
      register: async () => { called = true; return { org: "acme", token: "t" }; },
      installListenerServiceFn: () => {}, publishCardFn: async () => undefined, verify: false }))
      .rejects.toThrow(/ken-cdx/);
    expect(called).toBe(false);
  });

  it("warns when the handle is a predictable derivative of an existing one", async () => {
    saveLineConfig(getLinePaths(m, "claude"), { ...base, handle: "ken" });
    const warnings: string[] = [];
    await addLine(m, { name: "codex", handle: "ken-codex", agent: "codex", relay: "https://r.example",
      register: ok, installListenerServiceFn: () => {}, publishCardFn: async () => undefined, verify: false,
      warn: (s) => warnings.push(s) });
    expect(warnings.join(" ")).toMatch(/guess/i);
  });

  it("installs no launch agent for a caller-only line", async () => {
    let installed = false;
    await addLine(m, { name: "caller", handle: "ken-c", relay: "https://r.example", callerOnly: true,
      register: ok, installListenerServiceFn: () => { installed = true; }, publishCardFn: async () => undefined, verify: false });
    expect(installed).toBe(false);
  });

  // Regression: a nvm/fnm-managed node install (or claude/npx living outside
  // /opt/homebrew/bin and /usr/local/bin) needs its dir on the listener service's
  // PATH, or the supervised listener can't find its own agent binary at
  // spawn time. setup used to compute this and pass it straight through;
  // addLine must accept and forward it too, or every line loses the fix.
  it("forwards extraPathDirs into the installListenerService seam", async () => {
    let captured: string[] | undefined;
    await addLine(m, { name: "codex", handle: "ken-cdx", agent: "codex", relay: "https://r.example",
      register: ok, publishCardFn: async () => undefined, verify: false,
      extraPathDirs: ["/Users/x/.nvm/versions/node/v24/bin"],
      installListenerServiceFn: (_m, options) => { captured = options?.extraPathDirs; } });
    expect(captured).toEqual(["/Users/x/.nvm/versions/node/v24/bin"]);
  });

  // The motivating case for this whole feature: claude on one line, codex on
  // another. When extraPathDirs isn't explicitly given, addLine must derive
  // it from EVERY ready line on the machine (via listenerPathDirs), not just
  // the one it's currently adding — otherwise the shared plist only ever
  // learns about whichever agent's line was created/reinstalled most
  // recently.
  it("derives extraPathDirs from every ready line's agent kind, not just the one being added", async () => {
    saveLineConfig(getLinePaths(m, "claude"), { ...base, agent_kind: "claude" });
    let captured: string[] | undefined;
    await addLine(m, { name: "codex", handle: "ken-cdx", agent: "codex", relay: "https://r.example",
      register: ok, publishCardFn: async () => undefined, verify: false,
      resolveBin: (name) =>
        name === "claude" ? "/opt/claude-dir/claude"
        : name === "codex" ? "/opt/codex-dir/codex"
        : name === "npx" ? "/opt/npx-dir/npx"
        : null,
      installListenerServiceFn: (_m, options) => { captured = options?.extraPathDirs; } });
    expect(captured?.slice().sort()).toEqual(["/opt/claude-dir", "/opt/codex-dir", "/opt/npx-dir"].sort());
  });

  // AddLineOpts.verify was accepted but never read (flagged in Task 10's
  // report). Wired here to mirror setup.ts's own post-registration verify
  // step: verification runs by default for a callable line, and a failure
  // warns (the handle is already spent — see the comment above the
  // saveLineConfig call) rather than throwing.
  describe("verify", () => {
    it("verifies the agent by default and warns, without throwing, when it fails", async () => {
      const warnings: string[] = [];
      await expect(addLine(m, {
        name: "codex", handle: "ken-cdx", agent: "codex", relay: "https://r.example",
        register: ok, installListenerServiceFn: () => {}, publishCardFn: async () => undefined,
        warn: (s) => warnings.push(s),
        verifyFns: { resolveBin: () => { throw new Error("no codex binary on PATH"); } },
      })).resolves.toBeDefined();
      expect(warnings.join(" ")).toMatch(/verif/i);
    });

    it("logs a passing verification", async () => {
      const logs: string[] = [];
      await addLine(m, {
        name: "codex", handle: "ken-cdx", agent: "codex", relay: "https://r.example",
        register: ok, installListenerServiceFn: () => {}, publishCardFn: async () => undefined,
        log: (s) => logs.push(s),
        verifyFns: { resolveBin: () => "/fake/bin/codex", execFn: () => {}, runFn: async () => ({ text: "OK" }) },
      });
      expect(logs.join(" ")).toMatch(/agent run/i);
    });

    it("skips verification entirely when verify is false, even if verifyFns would fail", async () => {
      let touched = false;
      await addLine(m, {
        name: "codex", handle: "ken-cdx", agent: "codex", relay: "https://r.example",
        register: ok, installListenerServiceFn: () => {}, publishCardFn: async () => undefined, verify: false,
        verifyFns: { resolveBin: () => { touched = true; throw new Error("must not run"); } },
      });
      expect(touched).toBe(false);
    });

    it("never verifies a caller-only line — there is no agent to verify", async () => {
      let touched = false;
      await addLine(m, {
        name: "caller", handle: "ken-c", relay: "https://r.example", callerOnly: true,
        register: ok, installListenerServiceFn: () => {}, publishCardFn: async () => undefined,
        verifyFns: { resolveBin: () => { touched = true; throw new Error("must not run"); } },
      });
      expect(touched).toBe(false);
    });
  });
});

describe("removeLine", () => {
  it("archives the line rather than deleting it, preserving calls.log", () => {
    saveLineConfig(getLinePaths(m, "codex"), base);
    saveLineConfig(getLinePaths(m, "claude"), base);
    savePerson(m, { primary_line: "claude" });
    const callsLogContent = "2026-08-01T00:00:00Z inbound from mia: hello\n";
    writeFileSync(getLinePaths(m, "codex").callsLog, callsLogContent);
    removeLine(m, "codex", { confirm: true, uninstallFn: () => {}, installFn: () => {} });
    expect(existsSync(getLinePaths(m, "codex").dir)).toBe(false);
    const archivedName = readdirSync(m.removedDir)[0]!;
    expect(archivedName).toMatch(/^codex-/);
    // The archive exists to preserve the audit trail of what this address
    // disclosed — prove it actually does, not just that a directory moved.
    expect(readFileSync(join(m.removedDir, archivedName, "calls.log"), "utf8")).toBe(callsLogContent);
  });

  it("deletes outright with --purge", () => {
    saveLineConfig(getLinePaths(m, "codex"), base);
    saveLineConfig(getLinePaths(m, "claude"), base);
    savePerson(m, { primary_line: "claude" });
    removeLine(m, "codex", { confirm: true, purge: true, uninstallFn: () => {}, installFn: () => {} });
    expect(existsSync(m.removedDir)).toBe(false);
  });

  it("refuses the primary while another line exists", () => {
    saveLineConfig(getLinePaths(m, "codex"), base);
    saveLineConfig(getLinePaths(m, "claude"), base);
    savePerson(m, { primary_line: "claude" });
    expect(() => removeLine(m, "claude", { confirm: true, uninstallFn: () => {} })).toThrow(/line primary/);
  });

  it("refuses the only line", () => {
    saveLineConfig(getLinePaths(m, "claude"), base);
    savePerson(m, { primary_line: "claude" });
    expect(() => removeLine(m, "claude", { confirm: true, uninstallFn: () => {} })).toThrow(/uninstall --purge/);
  });

  it("requires confirmation, because the handle can never be reclaimed", () => {
    saveLineConfig(getLinePaths(m, "codex"), base);
    saveLineConfig(getLinePaths(m, "claude"), base);
    savePerson(m, { primary_line: "claude" });
    expect(() => removeLine(m, "codex", { confirm: false, uninstallFn: () => {} })).toThrow(/--yes/);
  });

  // Regression: the confirmation message used to always say "abandons the
  // handle" — falling back to the literal string "?" for an orphan that
  // never held one — which is misleading for a directory that never
  // finished registration in the first place.
  it("still requires confirmation for an orphaned directory, with an honest message (no handle to abandon)", () => {
    mkdirSync(getLinePaths(m, "half").dir, { recursive: true });
    saveLineConfig(getLinePaths(m, "claude"), base);
    savePerson(m, { primary_line: "claude" });
    expect(() => removeLine(m, "half", { confirm: false, uninstallFn: () => {} })).toThrow(/--yes/);
    try {
      removeLine(m, "half", { confirm: false, uninstallFn: () => {} });
    } catch (e) {
      const msg = String(e instanceof Error ? e.message : e);
      expect(msg).not.toContain("abandons the handle");
      expect(msg).not.toContain(`"?"`);
      expect(msg).toContain("never finished registration");
    }
  });

  it("removes an orphaned line directory", () => {
    mkdirSync(getLinePaths(m, "half").dir, { recursive: true });
    saveLineConfig(getLinePaths(m, "claude"), base);
    savePerson(m, { primary_line: "claude" });
    removeLine(m, "half", { confirm: true, uninstallFn: () => {}, installFn: () => {} });
    expect(existsSync(getLinePaths(m, "half").dir)).toBe(false);
  });

  it("refuses the only usable line even when a stray orphaned directory exists", () => {
    saveLineConfig(getLinePaths(m, "claude"), base);
    mkdirSync(getLinePaths(m, "half").dir, { recursive: true });
    savePerson(m, { primary_line: "claude" });
    // Raw directory count is 2 (claude + the orphan), but only claude is
    // usable — removing it would still leave zero lines that can answer or
    // call, so the guard must trip on usable count, not directory count.
    expect(() => removeLine(m, "claude", { confirm: true, uninstallFn: () => {} })).toThrow(/uninstall --purge/);
  });

  // Regression: the reinstall branch used to call installListenerService(m) with
  // no extraPathDirs at all, which rewrites the plist with an EMPTY PATH —
  // clobbering the surviving line's agent dir, not just failing to add the
  // removed one's. By the time this branch runs, the removed line's
  // directory is already gone, so listenerPathDirs(m) here must reflect only
  // what's left.
  it("reinstall derives extraPathDirs from the surviving line, not an empty list", () => {
    saveLineConfig(getLinePaths(m, "claude"), { ...base, agent_kind: "claude" });
    saveLineConfig(getLinePaths(m, "codex"), { ...base, handle: "ken-cdx", agent_kind: "codex" });
    savePerson(m, { primary_line: "claude" });
    let captured: string[] | undefined;
    removeLine(m, "codex", {
      confirm: true,
      uninstallFn: () => {},
      installFn: (_m, options) => { captured = options?.extraPathDirs; },
      // codex resolves to a real dir too, not null — if listenerPathDirs ran
      // BEFORE the archive (i.e. against a machine state that still has
      // codex), codex's dir would leak into the result and this assertion
      // would fail. A resolveBin that only resolves the survivor would let
      // "not empty" pass regardless of ordering; this pins "survivors only".
      resolveBin: (name) =>
        name === "claude" ? "/opt/claude-dir/claude"
        : name === "codex" ? "/opt/codex-dir/codex"
        : name === "npx" ? "/opt/npx-dir/npx"
        : null,
    });
    expect(captured).toEqual(["/opt/claude-dir", "/opt/npx-dir"]);
  });
});

describe("listLinesReport", () => {
  it("lists a line with an unparseable relay instead of throwing, alongside a healthy one", () => {
    saveLineConfig(getLinePaths(m, "claude"), base);
    saveLineConfig(getLinePaths(m, "broken"), { ...base, handle: "ken-b", relay: "not-a-url" });
    savePerson(m, { primary_line: "claude" });
    const rows = listLinesReport(m);
    expect(rows.map((r) => r.name)).toEqual(["broken", "claude"]);
    expect(rows.find((r) => r.name === "broken")!.address).toBe("@acme/ken-b");
    // The happy-path formatting ("<handle>@<relay host>") had no assertion of
    // its own — only the broken row did, above. `base.relay` is
    // "https://r.example", so this pins the host-only, scheme-stripped form.
    expect(rows.find((r) => r.name === "claude")!.address).toBe("@acme/ken");
  });
});

describe("setPrimary", () => {
  it("rewrites person.json and nothing else", () => {
    saveLineConfig(getLinePaths(m, "claude"), base);
    saveLineConfig(getLinePaths(m, "codex"), base);
    savePerson(m, { primary_line: "claude" });
    const before = readFileSync(getLinePaths(m, "claude").configFile, "utf8");
    setPrimary(m, "codex");
    expect(loadPerson(m).primary_line).toBe("codex");
    expect(readFileSync(getLinePaths(m, "claude").configFile, "utf8")).toBe(before);
  });

  it("refuses a line that does not exist", () => {
    saveLineConfig(getLinePaths(m, "claude"), base);
    expect(() => setPrimary(m, "nope")).toThrow(/nope/);
  });
});
