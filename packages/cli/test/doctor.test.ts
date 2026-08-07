import { chmodSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkCredentialStorage, checkLineKeyHealth, checkRecoveryHealth, runDoctor } from "../src/doctor.js";
import { saveLineConfig } from "../src/lines.js";
import { getLinePaths, getMachinePaths, type MachinePaths } from "../src/paths.js";
import { GUARD_PROBE_LINE } from "../src/verify.js";
import type { AgentKind } from "../src/runner.js";
import { generateIdentityKeys } from "../src/keys.js";
import { encryptionKeyTranscript, fromBase64Url, HPKE_SUITE, keyIdFor, signTranscript, type EncryptionKeyRecordType } from "@benree/agentcall-shared";
import type { StoredKeys } from "../src/keys.js";
import { tempDir, tempMachine } from "./helpers.js";

// A single-line machine, still used by tests that only care about one line's
// checks. Multi-line behavior gets its own describe block below.
const LINE = "claude";
const CLI_INSTALL_ROOT = tempDir("agentcall-cli-install-");
const CLI_ENTRY = join(CLI_INSTALL_ROOT, "agentcall.js");
const CLI_BIN = join(CLI_INSTALL_ROOT, "agentcall");
writeFileSync(CLI_ENTRY, "#!/usr/bin/env node\n");
symlinkSync(CLI_ENTRY, CLI_BIN);

function freshMachine(): MachinePaths {
  const m = tempMachine("agentcall-doctor-");
  mkdirSync(m.linesDir, { recursive: true });
  return m;
}

// A temp home whose calls.log already contains a denial, as a real guard run
// would have left behind. Shared with verify.test.ts's checkGuard tests. Per
// the per-line layout, that's .agentcall/lines/<GUARD_PROBE_LINE>/calls.log —
// checkGuard's default probes run doctor's guard probe under that fixed line
// name (see verify.ts) — not the flat legacy .agentcall/calls.log.
function homeWithDenial(): string {
  const home = tempDir("guardcheck-");
  const callsLog = getLinePaths(getMachinePaths(home), GUARD_PROBE_LINE).callsLog;
  mkdirSync(dirname(callsLog), { recursive: true });
  writeFileSync(callsLog,
    JSON.stringify({ ts: "2026-07-31T00:00:00.000Z", type: "tool_denied", tool: "Read" }) + "\n");
  return home;
}

const okVerifyFns = {
  resolveBin: () => "/fake/bin/claude",
  runFn: async () => ({ text: "OK" }),
  execFn: () => {},
};

const fakeCall = async () => ({ type: "call_reply", call_id: "c1", text: "hi", task: "ask" }) as never;

const baseDeps = {
  platform: "darwin" as const,
  inspectListenerServiceFn: () => ({ kind: "launchd" as const, installed: true, running: true }),
  getStatusFn: async () => ({ online: true }),
  getRecoveryStatusFn: async () => ({ issued: true, generation: 2, recovery_public_id: "agr_aaaaaaaaaaaaaaaa" }),
  verifyFns: okVerifyFns,
  callFn: fakeCall,
  // Never spawn a real `claude` in tests: checkGuard's default probe does
  // that on a real machine, and every test below with agent_kind "claude"
  // would otherwise fall through to it and hang/burn credentials in CI.
  guardFn: async () => ({ output: "blocked", home: homeWithDenial() }),
  // Same reasoning for the direct probe: its default spawns node against the
  // built dist/guard-entry.js, which does not exist when vitest runs from src.
  guardBinaryFn: async () => true,
  keyHealthFn: async () => [],
  pkgFn: () => ({
    name: "@benree/agentcall",
    version: "0.4.0",
    bin: { agentcall: "./bin/agentcall.js" },
  }),
  selfPathFn: () => CLI_ENTRY,
  whichFn: () => [CLI_BIN],
};

describe("doctor CLI install provenance", () => {
  it("reports the package identity and running entry for one resolved install", async () => {
    const m = freshMachine();
    const lines: string[] = [];

    await runDoctor({ ...baseDeps, machine: m, log: (line) => lines.push(line) });

    expect(lines[0]).toBe(`✓ CLI install — @benree/agentcall@0.4.0; running ${CLI_ENTRY}`);
  });

  it("warns without changing the exit code when PATH contains two distinct installs", async () => {
    const m = freshMachine();
    saveLineConfig(getLinePaths(m, "caller"), {
      org: "acme", handle: "solo", token: "t", relay: "https://relay.example",
    });
    const secondRoot = tempDir("agentcall-cli-shadow-");
    const secondEntry = join(secondRoot, "agentcall.js");
    const secondBin = join(secondRoot, "agentcall");
    writeFileSync(secondEntry, "#!/usr/bin/env node\n");
    symlinkSync(secondEntry, secondBin);
    const cleanLines: string[] = [];
    const shadowedLines: string[] = [];
    const cleanCode = await runDoctor({
      ...baseDeps,
      machine: m,
      log: (line) => cleanLines.push(line),
    });
    const shadowedCode = await runDoctor({
      ...baseDeps,
      machine: m,
      whichFn: () => [secondBin, CLI_BIN],
      log: (line) => shadowedLines.push(line),
    });

    expect(shadowedCode).toBe(cleanCode);
    expect(shadowedLines[0]).toContain("! CLI install");
    expect(shadowedLines[0]).toContain(secondEntry);
    expect(shadowedLines[0]).toContain(CLI_ENTRY);
  });

  it("deduplicates PATH entries that symlink to the same real executable", async () => {
    const root = tempDir("agentcall-doctor-bin-");
    const real = join(root, "agentcall.js");
    const first = join(root, "first-agentcall");
    const second = join(root, "second-agentcall");
    writeFileSync(real, "#!/usr/bin/env node\n");
    symlinkSync(real, first);
    symlinkSync(real, second);
    const lines: string[] = [];

    await runDoctor({
      ...baseDeps,
      machine: freshMachine(),
      selfPathFn: () => real,
      whichFn: () => [first, second],
      log: (line) => lines.push(line),
    });

    expect(lines[0]).toContain("✓ CLI install");
    expect(lines[0]).not.toContain("multiple installs");
  });

  it("still reports package and running entry when PATH lookup fails", async () => {
    const lines: string[] = [];

    await runDoctor({
      ...baseDeps,
      machine: freshMachine(),
      whichFn: () => { throw new Error("which unavailable"); },
      log: (line) => lines.push(line),
    });

    expect(lines[0]).toContain("! CLI install");
    expect(lines[0]).toContain("@benree/agentcall@0.4.0");
    expect(lines[0]).toContain(CLI_ENTRY);
  });

  it("prints install provenance before the missing-config failure", async () => {
    const lines: string[] = [];

    const code = await runDoctor({
      ...baseDeps,
      machine: freshMachine(),
      log: (line) => lines.push(line),
    });

    expect(code).toBe(1);
    expect(lines[0]).toContain("CLI install");
    expect(lines.at(-1)).toContain("No agentcall config found");
  });
});

describe("doctor credential storage", () => {
  it("reports the plaintext location and private POSIX permissions without exposing the token", () => {
    const m = freshMachine();
    const paths = getLinePaths(m, LINE);
    saveLineConfig(paths, { org: "acme", handle: "ken", token: "never-print-me", relay: "https://relay.example" });

    const check = checkCredentialStorage(paths, "darwin");

    expect(check).toMatchObject({ name: "handle credential storage", ok: true });
    expect(check.detail).toContain(paths.configFile);
    expect(check.detail).toContain("permissions 600 in a 700 directory");
    expect(check.detail).not.toContain("never-print-me");
  });

  it("fails when the token file or containing line directory is not private", () => {
    const m = freshMachine();
    const paths = getLinePaths(m, LINE);
    saveLineConfig(paths, { org: "acme", handle: "ken", token: "t", relay: "https://relay.example" });
    chmodSync(paths.dir, 0o755);
    chmodSync(paths.configFile, 0o644);

    const check = checkCredentialStorage(paths, "linux");

    expect(check).toMatchObject({ name: "handle credential storage", ok: false });
    expect(check.detail).toContain("permissions 644 in a 755 directory");
    expect(check.hint).toContain("chmod 700");
    expect(check.hint).toContain("chmod 600");
  });

  it("makes an insecure credential store fail the complete doctor run", async () => {
    const m = freshMachine();
    const paths = getLinePaths(m, LINE);
    saveLineConfig(paths, { org: "acme", handle: "ken", token: "t", relay: "https://relay.example" });
    chmodSync(paths.configFile, 0o644);
    const lines: string[] = [];

    const code = await runDoctor({ ...baseDeps, machine: m, log: (line) => lines.push(line) });

    expect(code).toBe(1);
    expect(lines.join("\n")).toContain("✗ handle credential storage");
  });

  it("does not pretend to evaluate Windows ACLs with POSIX mode bits", () => {
    const m = freshMachine();
    const paths = getLinePaths(m, LINE);
    saveLineConfig(paths, { org: "acme", handle: "ken", token: "t", relay: "https://relay.example" });

    expect(checkCredentialStorage(paths, "win32")).toMatchObject({
      name: "handle credential storage",
      ok: true,
      warn: true,
    });
  });
});

describe("doctor recovery health", () => {
  const cfg = { org: "acme", handle: "ken", token: "secret", relay: "https://relay.example" };

  it("reports the generation without exposing either credential", async () => {
    const check = await checkRecoveryHealth(cfg, async () => ({
      issued: true, generation: 7, recovery_public_id: "agr_aaaaaaaaaaaaaaaa",
    }));
    expect(check).toMatchObject({ name: "recovery proof", ok: true });
    expect(check.detail).toContain("generation 7");
    expect(check.detail).not.toContain("secret");
  });

  it("warns that an unissued proof makes token loss unrecoverable", async () => {
    expect(await checkRecoveryHealth(cfg, async () => ({ issued: false, generation: 0 }))).toMatchObject({
      name: "recovery proof", ok: true, warn: true,
    });
  });
});

describe("doctor key health", () => {
  const signed = async (local: StoredKeys, record: EncryptionKeyRecordType) => {
    const privateKey = await crypto.subtle.importKey(
      "pkcs8", fromBase64Url(local.identity_pkcs8) as BufferSource,
      { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"],
    );
    return signTranscript(privateKey, encryptionKeyTranscript(record));
  };

  it("proves persisted keys and the relay record are identical", async () => {
    const m = freshMachine();
    const paths = getLinePaths(m, LINE);
    const cfg = { org: "acme", handle: "ken", token: "t", relay: "https://relay.example" };
    const local = await generateIdentityKeys(paths);
    const now = Date.now();
    const record: EncryptionKeyRecordType = {
      v: 1, relay_origin: "relay.example",
      address: "@acme/ken", key_id: await keyIdFor(local.encryption_pub), suite: HPKE_SUITE,
      pub: local.encryption_pub, epoch: local.epoch, not_before: now - 1_000, not_after: now + 60_000, prev: null,
    };
    const checks = await checkLineKeyHealth(cfg, paths, async () => ({
      identity: { v: 1, relay_origin: "relay.example", address: "@acme/ken", identity_pub: local.identity_pub },
      encryption: { record, signature: await signed(local, record) },
    }));
    expect(checks).toEqual([
      expect.objectContaining({ name: "local identity keys", ok: true }),
      expect.objectContaining({ name: "published identity keys", ok: true }),
    ]);
  });

  it("fails when the relay's published record differs from disk", async () => {
    const m = freshMachine();
    const paths = getLinePaths(m, LINE);
    const cfg = { org: "acme", handle: "ken", token: "t", relay: "https://relay.example" };
    const local = await generateIdentityKeys(paths);
    const now = Date.now();
    const record: EncryptionKeyRecordType = {
      v: 1, relay_origin: "relay.example",
      address: "@acme/ken", key_id: await keyIdFor(local.encryption_pub), suite: HPKE_SUITE,
      pub: local.encryption_pub, epoch: local.epoch + 1, not_before: now - 1_000, not_after: now + 60_000, prev: null,
    };
    const checks = await checkLineKeyHealth(cfg, paths, async () => ({
      identity: { v: 1, relay_origin: "relay.example", address: "@acme/ken", identity_pub: local.identity_pub },
      encryption: { record, signature: await signed(local, record) },
    }));
    expect(checks.at(-1)).toMatchObject({ name: "published identity keys", ok: false });
  });

  it("fails before relay access when the line key directory is not 0700", async () => {
    const m = freshMachine();
    const paths = getLinePaths(m, LINE);
    await generateIdentityKeys(paths);
    chmodSync(paths.dir, 0o755);
    let fetched = false;
    const checks = await checkLineKeyHealth(
      { org: "acme", handle: "ken", token: "t", relay: "https://relay.example" }, paths,
      async () => { fetched = true; throw new Error("must not fetch"); },
    );
    expect(checks[0]).toMatchObject({ name: "local identity keys", ok: false });
    expect(checks[0]?.detail).toContain("expected 700");
    expect(fetched).toBe(false);
  });

  it("fails when relay records match but their signature is invalid", async () => {
    const m = freshMachine();
    const paths = getLinePaths(m, LINE);
    const local = await generateIdentityKeys(paths);
    const now = Date.now();
    const record: EncryptionKeyRecordType = {
      v: 1, relay_origin: "relay.example",
      address: "@acme/ken", key_id: await keyIdFor(local.encryption_pub), suite: HPKE_SUITE,
      pub: local.encryption_pub, epoch: local.epoch, not_before: now - 1_000, not_after: now + 60_000, prev: null,
    };
    const checks = await checkLineKeyHealth(
      { org: "acme", handle: "ken", token: "t", relay: "https://relay.example" }, paths,
      async () => ({
        identity: { v: 1, relay_origin: "relay.example", address: "@acme/ken", identity_pub: local.identity_pub },
        encryption: { record, signature: "invalid" },
      }),
    );
    expect(checks.at(-1)).toMatchObject({ name: "published identity keys", ok: false });
  });

  it.each([
    { name: "expired", record: async (local: StoredKeys) => ({
      key_id: await keyIdFor(local.encryption_pub), not_before: 1, not_after: 2,
    }) },
    { name: "wrong key id", record: async () => ({
      key_id: "a".repeat(32), not_before: Date.now() - 1_000, not_after: Date.now() + 60_000,
    }) },
  ])("fails when matching relay records are $name", async ({ record: fields }) => {
    const m = freshMachine();
    const paths = getLinePaths(m, LINE);
    const local = await generateIdentityKeys(paths);
    const values = await fields(local);
    const record: EncryptionKeyRecordType = {
      v: 1, relay_origin: "@acme/ken".slice("@acme/ken".indexOf("@") + 1), address: "@acme/ken", suite: HPKE_SUITE, pub: local.encryption_pub,
      epoch: local.epoch, prev: null, ...values,
    };
    const checks = await checkLineKeyHealth(
      { org: "acme", handle: "ken", token: "t", relay: "https://relay.example" }, paths,
      async () => ({
        identity: { v: 1, relay_origin: "relay.example", address: "@acme/ken", identity_pub: local.identity_pub },
        encryption: { record, signature: await signed(local, record) },
      }),
    );
    expect(checks.at(-1)).toMatchObject({ name: "published identity keys", ok: false });
  });
});

// A VerifyFns whose agent-binary resolution fails for exactly one kind, so a
// multi-line test can make one line's ladder fail without touching the
// others sharing the same (single, non-per-line) deps.verifyFns seam.
function failingVerifyFor(kind: AgentKind) {
  return {
    resolveBin: (k: AgentKind) => {
      if (k === kind) throw new Error(`no ${k} binary on PATH`);
      return `/fake/bin/${k}`;
    },
    runFn: async () => ({ text: "OK" }),
    execFn: () => {},
  };
}

describe("runDoctor", () => {


  it("reports a running systemd user listener on Linux", async () => {
    const m = freshMachine();
    saveLineConfig(getLinePaths(m, LINE), {
      org: "acme", handle: "ken", token: "t", agent_kind: "claude", relay: "https://relay.example",
    });
    const lines: string[] = [];

    const code = await runDoctor({
      ...baseDeps,
      machine: m,
      platform: "linux",
      inspectListenerServiceFn: () => ({ kind: "systemd", installed: true, running: true }),
      log: (line) => lines.push(line),
    });

    expect(code).toBe(0);
    expect(lines.join("\n")).toContain("✓ background listener (systemd)");
  });


  it("exits 0 and runs every check including the relay self-call when all pass", async () => {
    const m = freshMachine();
    saveLineConfig(getLinePaths(m, LINE), { org: "acme", handle: "ken", token: "t", agent_kind: "claude", relay: "https://relay.example" });
    const lines: string[] = [];
    const code = await runDoctor({ ...baseDeps, machine: m, log: (l) => lines.push(l) });
    expect(code).toBe(0);
    const out = lines.join("\n");
    for (const name of ["config", "workdir", "background listener", "relay status", "agent binary", "agent run", "relay self-call"]) {
      expect(out).toContain(`✓ ${name}`);
    }
  });

  // Was "reports a broken workdir but still runs the agent checks". #372
  // deleted config.json's `workdir`; the spawn directory is derived from the
  // sensitivity map. That derivation deliberately SKIPS a source that no longer
  // exists rather than throwing — one stale entry must not take a line offline
  // — which trades a loud failure for a quiet fallback to an empty directory.
  // This is where that trade is paid back, so it still has to be named, and
  // still has to be informational: the agent checks below it run either way.
  it("names a root that has gone missing, but still runs the agent checks", async () => {
    const m = freshMachine();
    const paths = getLinePaths(m, LINE);
    saveLineConfig(paths, {
      org: "acme", handle: "ken", token: "t", agent_kind: "claude", relay: "https://relay.example",
    });
    mkdirSync(paths.dir, { recursive: true });
    writeFileSync(paths.scopeFile, JSON.stringify({ roots: ["/no/such/project"] }));
    const lines: string[] = [];
    const code = await runDoctor({ ...baseDeps, machine: m, log: (l) => lines.push(l) });
    expect(code).toBe(1);
    const out = lines.join("\n");
    expect(out).toContain("✗ scope");
    expect(out).toContain("/no/such/project");
    expect(out).toContain("scope.json");
    expect(out).toContain("✓ agent run");
  });

  // Was "reports a configured workdir by path when it is valid". The path is
  // now derived rather than configured, so what the owner needs to see is which
  // directory the derivation actually picked.
  it("reports the derived workdir by path", async () => {
    const m = freshMachine();
    const paths = getLinePaths(m, LINE);
    saveLineConfig(paths, {
      org: "acme", handle: "ken", token: "t", agent_kind: "claude", relay: "https://relay.example",
    });
    const repo = join(m.userHome, "code", "payments");
    mkdirSync(repo, { recursive: true });
    mkdirSync(paths.dir, { recursive: true });
    writeFileSync(paths.scopeFile, JSON.stringify({ roots: [repo] }));
    const lines: string[] = [];
    await runDoctor({ ...baseDeps, machine: m, log: (l) => lines.push(l) });
    expect(lines.join("\n")).toContain(`✓ workdir — ${repo} (derived from the first root)`);
  });

  // A line whose map names nothing can read nothing — the fresh-install state
  // #372 opened by describing. It is a real finding, and must not read as a
  // clean bill of health.
  it("warns about a scope with no root rather than passing it silently", async () => {
    const m = freshMachine();
    saveLineConfig(getLinePaths(m, LINE), {
      org: "acme", handle: "ken", token: "t", agent_kind: "claude", relay: "https://relay.example",
    });
    const lines: string[] = [];
    await runDoctor({ ...baseDeps, machine: m, log: (l) => lines.push(l) });
    const out = lines.join("\n");
    // A warning, not a failure: this is the fail-closed end of the model
    // working as designed, and `setup` reaches it legitimately when it runs
    // outside a git repository. Exiting 1 on an empty line would be wrong.
    expect(out).toContain("! scope");
    expect(out).toMatch(/no root is declared/i);
  });

  it("exits 1 with a setup hint when there is no config", async () => {
    const m = freshMachine();
    const lines: string[] = [];
    const code = await runDoctor({ ...baseDeps, machine: m, log: (l) => lines.push(l) });
    expect(code).toBe(1);
    expect(lines.join("\n")).toContain("agentcall setup");
  });

  it("exits 0 and says caller-only when the config has no agent_kind", async () => {
    const m = freshMachine();
    saveLineConfig(getLinePaths(m, "caller"), { org: "acme", handle: "solo", token: "t", relay: "https://relay.example" });
    const lines: string[] = [];
    const code = await runDoctor({ ...baseDeps, machine: m, log: (l) => lines.push(l) });
    expect(code).toBe(0);
    expect(lines.join("\n")).toContain("caller-only");
  });

  it("skips the relay self-call (but still runs agent checks) when the handle is offline", async () => {
    const m = freshMachine();
    saveLineConfig(getLinePaths(m, LINE), { org: "acme", handle: "ken", token: "t", agent_kind: "claude", relay: "https://relay.example" });
    const lines: string[] = [];
    let selfCalled = false;
    const code = await runDoctor({
      ...baseDeps,
      machine: m,
      getStatusFn: async () => ({ online: false }),
      callFn: async () => {
        selfCalled = true;
        return { type: "call_reply", call_id: "c1", text: "hi", task: "ask" } as never;
      },
      log: (l) => lines.push(l),
    });
    expect(code).toBe(1);
    expect(selfCalled).toBe(false);
    const out = lines.join("\n");
    expect(out).toContain("✓ agent run");
    expect(out).toContain("skipping relay self-call");
  });

  it("skips spawn and self-call after a failed codex auth check", async () => {
    const m = freshMachine();
    saveLineConfig(getLinePaths(m, LINE), { org: "acme", handle: "ken", token: "t", agent_kind: "codex", relay: "https://relay.example" });
    let spawned = false;
    const lines: string[] = [];
    const code = await runDoctor({
      ...baseDeps,
      machine: m,
      verifyFns: {
        resolveBin: () => "/fake/bin/codex",
        execFn: () => {
          throw new Error("Not logged in");
        },
        runFn: async () => {
          spawned = true;
          return { text: "OK" };
        },
      },
      log: (l) => lines.push(l),
    });
    expect(code).toBe(1);
    expect(spawned).toBe(false);
    expect(lines.join("\n")).toContain("codex login");
  });

  it("reports the launchd listener as not loaded without blocking agent checks", async () => {
    const m = freshMachine();
    saveLineConfig(getLinePaths(m, LINE), { org: "acme", handle: "ken", token: "t", agent_kind: "claude", relay: "https://relay.example" });
    const lines: string[] = [];
    const code = await runDoctor({
      ...baseDeps,
      machine: m,
      inspectListenerServiceFn: () => ({ kind: "launchd", installed: true, running: false }),
      log: (l) => lines.push(l),
    });
    expect(code).toBe(1);
    const out = lines.join("\n");
    expect(out).toContain("✗ background listener");
    expect(out).toContain("✓ agent run");
    // Diagnostic-only: distinguishes "plist never installed" from "installed
    // but not currently loaded" without itself turning the run red twice.
    expect(out).toContain("! launch agent plist");
  });

  // Guards against a regression that deletes the `if (cfg.agent_kind ===
  // "claude" && agentOk)` block in doctor.ts, or calls checkGuard
  // unconditionally — either would pass the rest of the suite silently,
  // which is exactly the kind of silent failure this check exists to catch.
  it("runs the tool guard check for a claude install and reports it passing", async () => {
    const m = freshMachine();
    saveLineConfig(getLinePaths(m, LINE), { org: "acme", handle: "ken", token: "t", agent_kind: "claude", relay: "https://relay.example" });
    const lines: string[] = [];
    const code = await runDoctor({ ...baseDeps, machine: m, log: (l) => lines.push(l) });
    expect(code).toBe(0);
    expect(lines.join("\n")).toContain("✓ tool guard");
  });

  // An unprovable guard row must not turn a healthy install's doctor run red:
  // the model declining the probe's read is a fact about the model, and the
  // owner has nothing to fix.
  it("keeps exit 0 when the guard check can only warn", async () => {
    const m = freshMachine();
    saveLineConfig(getLinePaths(m, LINE), { org: "acme", handle: "ken", token: "t", agent_kind: "claude", relay: "https://relay.example" });
    const lines: string[] = [];
    const code = await runDoctor({
      ...baseDeps,
      machine: m,
      guardFn: async () => ({ output: "I'd rather not read .env", home: tempDir("empty-") }),
      guardBinaryFn: async () => true,
      log: (l) => lines.push(l),
    });
    expect(code).toBe(0);
    expect(lines.join("\n")).toContain("! tool guard");
  });





  // A relay string that is syntactically not a URL currently reaches the
  // network call and fails there — folding a config mistake into the same
  // bucket as "the listener isn't running." Caught before the network call
  // so the two are distinguishable in the output.
  it("reports a malformed relay string as its own failure, not folded into offline", async () => {
    const m = freshMachine();
    saveLineConfig(getLinePaths(m, LINE), { org: "acme", handle: "ken", token: "t", agent_kind: "claude", relay: "not a url" });
    let statusCalled = false;
    const lines: string[] = [];
    const code = await runDoctor({
      ...baseDeps,
      machine: m,
      getStatusFn: async () => {
        statusCalled = true;
        return { online: true };
      },
      log: (l) => lines.push(l),
    });
    expect(code).toBe(1);
    expect(statusCalled).toBe(false);
    const out = lines.join("\n");
    expect(out).toContain("✗ relay config");
    expect(out).not.toContain("relay status — offline");
  });

  // relayUrl(cfg) prefers AGENTCALL_RELAY over cfg.relay, and the check above
  // validates THAT value with `new URL(relayUrl(cfg))` — so a broken env var
  // must be named in the detail, not the (perfectly valid) cfg.relay it
  // overrode. Naming the wrong string here would send the owner to edit a
  // config.json field that was never the problem.
  it("names the actually-validated relay (AGENTCALL_RELAY), not cfg.relay, when it's malformed", async () => {
    const m = freshMachine();
    saveLineConfig(getLinePaths(m, LINE), { org: "acme", handle: "ken", token: "t", agent_kind: "claude", relay: "https://relay.example" });
    process.env.AGENTCALL_RELAY = "not a url";
    try {
      const lines: string[] = [];
      const code = await runDoctor({ ...baseDeps, machine: m, log: (l) => lines.push(l) });
      expect(code).toBe(1);
      const out = lines.join("\n");
      expect(out).toContain("not a url");
      expect(out).not.toContain("relay.example");
    } finally {
      delete process.env.AGENTCALL_RELAY;
    }
  });
});

describe("runDoctor across lines", () => {
  it("reports every line and exits non-zero if any callable line fails", async () => {
    const m = freshMachine();
    const base = { org: "acme", handle: "ken", token: "t", agent_kind: "claude" as const, relay: "https://relay.example" };
    saveLineConfig(getLinePaths(m, "claude"), base);
    saveLineConfig(getLinePaths(m, "codex"), { ...base, handle: "ken-cdx", agent_kind: "codex" as AgentKind });
    const out: string[] = [];
    const code = await runDoctor({
      ...baseDeps,
      machine: m,
      log: (s) => out.push(s),
      verifyFns: failingVerifyFor("codex"),
    });
    const joined = out.join("\n");
    expect(joined).toContain("line claude");
    expect(joined).toContain("line codex");
    expect(code).toBe(1);
  });

  it("treats a caller-only line as fine, not as a failure, alongside a healthy callable line", async () => {
    const m = freshMachine();
    saveLineConfig(getLinePaths(m, LINE), { org: "acme", handle: "ken", token: "t", agent_kind: "claude", relay: "https://relay.example" });
    saveLineConfig(getLinePaths(m, "caller"), { org: "acme", handle: "solo", token: "t", relay: "https://relay.example" });
    const out: string[] = [];
    const code = await runDoctor({ ...baseDeps, machine: m, log: (s) => out.push(s) });
    expect(code).toBe(0);
    expect(out.join("\n")).toContain("caller-only");
  });

  it("reports an orphaned line as broken and exits non-zero", async () => {
    const m = freshMachine();
    mkdirSync(getLinePaths(m, "half").dir, { recursive: true });
    const out: string[] = [];
    const code = await runDoctor({ ...baseDeps, machine: m, log: (s) => out.push(s) });
    expect(out.join("\n")).toMatch(/half/);
    expect(code).toBe(1);
  });

  it("probes the guard once per agent kind, not once per line", async () => {
    const m = freshMachine();
    const base = { org: "acme", handle: "ken-a", token: "t", agent_kind: "claude" as const, relay: "https://relay.example" };
    saveLineConfig(getLinePaths(m, "a"), base);
    saveLineConfig(getLinePaths(m, "b"), { ...base, handle: "ken-b" });
    let probes = 0;
    await runDoctor({
      ...baseDeps,
      machine: m,
      log: () => {},
      guardFn: async () => {
        probes++;
        return { output: "blocked", home: homeWithDenial() };
      },
    });
    expect(probes).toBe(1);
  });

  it("checks the single launch agent once, not per line", async () => {
    const m = freshMachine();
    const base = { org: "acme", handle: "ken-a", token: "t", agent_kind: "claude" as const, relay: "https://relay.example" };
    saveLineConfig(getLinePaths(m, "a"), base);
    saveLineConfig(getLinePaths(m, "b"), { ...base, handle: "ken-b" });
    let listed = 0;
    await runDoctor({
      ...baseDeps,
      machine: m,
      log: () => {},
      inspectListenerServiceFn: () => {
        listed++;
        return { kind: "launchd", installed: true, running: true };
      },
    });
    expect(listed).toBe(1);
  });
});
