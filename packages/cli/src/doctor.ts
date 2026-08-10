import { authOf, fetchKeys, getRecoveryStatus, getStatus } from "./api.js";
import { accessSync, constants, existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { encryptionKeyTranscript, importIdentityPublicKey, keyIdFor, verifyTranscript } from "@benree/agentcall-shared";
import { configAddress, loadConfig, relayUrl, type Config } from "./config.js";
import { loadScope, workdirFor } from "./scope.js";
import {
  inspectListenerService,
  type ListenerServiceStatus,
} from "./listener-service.js";
import type { Paths } from "./paths.js";
import { inspectEncryptionKeyRing, loadKeys } from "./keys.js";
import { assertPrivateFile } from "./json-store.js";
import { checkKnownPeersStore } from "./known-peers.js";
import { buildCardUpload } from "./card.js";
import { accessFor } from "./access.js";
import { loadPolicy } from "./policy.js";
import { loadTasks } from "./tasks.js";
import { loadExecutionJournal } from "./execution-journal.js";
import {
  checkGuard, formatCheck, short, verifyAgent,
  type GuardBinaryProbeFn, type GuardProbeFn,
  type VerifyCheck, type VerifyFns,
} from "./verify.js";

interface DoctorDeps {
  paths: Paths;
  // Test seams — production callers should leave these as the defaults.
  verifyFns?: VerifyFns;
  getStatusFn?: typeof getStatus;
  getRecoveryStatusFn?: typeof getRecoveryStatus;
  platform?: NodeJS.Platform;
  inspectListenerServiceFn?: (paths: Paths) => ListenerServiceStatus;
  guardFn?: GuardProbeFn;
  guardBinaryFn?: GuardBinaryProbeFn;
  keyHealthFn?: (cfg: Config, paths: Paths) => Promise<VerifyCheck[]>;
  pkgFn?: () => CliPackageManifest;
  selfPathFn?: () => string;
  whichFn?: (bin: string) => string[];
}

export type DiagnosticStatus = "pass" | "warning" | "fail";

export interface DiagnosticCheck {
  name: string;
  status: DiagnosticStatus;
  detail?: string;
  hint?: string;
}

export interface SelfDiagnostics {
  tasks: Array<{
    id: string;
    name: string;
    description: string;
    threadable: boolean;
    timeout_s?: number;
  }>;
  policy: {
    description: string;
    default_access: string;
    callers: Array<{ caller: string; access: string }>;
    assertions_passed: number;
  };
  card: {
    status: "current" | "never-published" | "stale" | "unreadable" | "unavailable";
  };
}

export interface DoctorReport {
  ok: boolean;
  checks: DiagnosticCheck[];
  notes: string[];
  self?: SelfDiagnostics;
}

interface CliPackageManifest {
  name: string;
  version: string;
  bin: Record<string, string>;
}

function readCliPackageManifest(): CliPackageManifest {
  const value: unknown = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  if (!value || typeof value !== "object") throw new Error("CLI package manifest is not an object");
  const manifest = value as Partial<CliPackageManifest>;
  if (typeof manifest.name !== "string" || typeof manifest.version !== "string" ||
      !manifest.bin || typeof manifest.bin !== "object") {
    throw new Error("CLI package manifest is missing name, version, or bin");
  }
  return manifest as CliPackageManifest;
}

function runningEntryPath(): string {
  if (!process.argv[1]) throw new Error("Node did not report the running CLI entry path");
  return realpathSync(process.argv[1]);
}

function whichAll(bin: string): string[] {
  return execFileSync("which", ["-a", bin], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).split(/\r?\n/).filter(Boolean);
}

function checkCliInstall(
  deps: Pick<DoctorDeps, "pkgFn" | "selfPathFn" | "whichFn"> = {},
): VerifyCheck {
  let manifest: CliPackageManifest;
  let selfPath: string;
  let bin: string;
  try {
    manifest = (deps.pkgFn ?? readCliPackageManifest)();
    selfPath = (deps.selfPathFn ?? runningEntryPath)();
    const bins = Object.keys(manifest.bin);
    if (bins.length !== 1) throw new Error(`CLI package manifest must declare exactly one bin; found ${bins.length}`);
    bin = bins[0]!;
  } catch (error) {
    return {
      name: "CLI install",
      ok: false,
      detail: short(error),
      hint: "reinstall the CLI package, then run its doctor command again",
    };
  }

  const identity = `${manifest.name}@${manifest.version}; running ${selfPath}`;
  try {
    const resolved = [...new Set((deps.whichFn ?? whichAll)(bin).map((path) => realpathSync(path)))];
    if (resolved.length < 2) return { name: "CLI install", ok: true, detail: identity };

    const unexpected = resolved.filter((path) => path !== selfPath);
    return {
      name: "CLI install",
      ok: true,
      warn: true,
      detail: `${identity}; multiple installs on PATH: ${resolved.join(", ")}`,
      hint: `the first ${bin} on PATH wins; remove or reorder the unexpected install${unexpected.length === 1 ? "" : "s"}: ${unexpected.join(", ")}`,
    };
  } catch (error) {
    return {
      name: "CLI install",
      ok: true,
      warn: true,
      detail: `${identity}; PATH inspection unavailable: ${short(error)}`,
      hint: `check which ${bin} executable appears first on PATH`,
    };
  }
}

// The relay token is still plaintext at rest. Until a signed standalone
// listener can bind an OS-keystore ACL to AgentCall's own executable identity,
// the honest local floor is a private regular file inside a private line
// directory. Report the exact storage location without ever reading or
// printing the credential itself.
export function checkCredentialStorage(
  paths: Paths,
  platform: NodeJS.Platform = process.platform,
): VerifyCheck {
  try {
    const dir = lstatSync(paths.dir);
    const file = lstatSync(paths.configFile);
    if (!dir.isDirectory() || dir.isSymbolicLink()) {
      throw new Error(`${paths.dir} must be a real directory, not a symlink`);
    }
    if (!file.isFile() || file.isSymbolicLink()) {
      throw new Error(`${paths.configFile} must be a regular file, not a symlink`);
    }
    if (platform === "win32") {
      return {
        name: "handle credential storage",
        ok: true,
        warn: true,
        detail: `plaintext file at ${paths.configFile}; Windows ACLs were not evaluated`,
        hint: "restrict this file to the current user; OS credential storage is not implemented yet",
      };
    }

    const dirMode = dir.mode & 0o777;
    const fileMode = file.mode & 0o777;
    const secure = dirMode === 0o700 && fileMode === 0o600;
    return {
      name: "handle credential storage",
      ok: secure,
      detail: secure
        ? `plaintext file at ${paths.configFile}; permissions 600 in a 700 directory`
        : `plaintext file at ${paths.configFile}; permissions ${fileMode.toString(8)} in a ${dirMode.toString(8)} directory`,
      hint: secure
        ? undefined
        : `run \`chmod 700 "${paths.dir}" && chmod 600 "${paths.configFile}"\``,
    };
  } catch (error) {
    return {
      name: "handle credential storage",
      ok: false,
      detail: short(error),
      hint: `restore a regular config file at ${paths.configFile}, then run \`chmod 700 "${paths.dir}" && chmod 600 "${paths.configFile}"\``,
    };
  }
}

export async function checkKeyHealth(
  cfg: Config, paths: Paths, fetchFn: typeof fetchKeys = fetchKeys,
): Promise<VerifyCheck[]> {
  let local;
  try {
    assertPrivateFile(paths.identityKeyFile, { dir: paths.dir, checkFile: false });
    local = loadKeys(paths);
  } catch (error) {
    return [{ name: "local identity keys", ok: false, detail: short(error), hint: "run `agentcall setup` to create persisted keys" }];
  }
  const checks: VerifyCheck[] = [{ name: "local identity keys", ok: true, detail: `epoch ${local.epoch}, permissions 600` }];
  try {
    const remote = await fetchFn(
      relayUrl(cfg), authOf(cfg), cfg.handle,
    );
    const expectedAddress = configAddress(cfg);
    const signatureValid = await verifyTranscript(
      await importIdentityPublicKey(remote.identity.identity_pub),
      encryptionKeyTranscript(remote.encryption.record),
      remote.encryption.signature,
    );
    const now = Date.now();
    const validityCurrent = remote.encryption.record.not_before <= now && now < remote.encryption.record.not_after;
    const keyIdMatches = remote.encryption.record.key_id === await keyIdFor(remote.encryption.record.pub);
    const matches = remote.identity.address === expectedAddress &&
      remote.identity.identity_pub === local.identity_pub &&
      remote.encryption.record.pub === local.encryption_pub &&
      remote.encryption.record.epoch === local.epoch && signatureValid && validityCurrent && keyIdMatches;
    checks.push({
      name: "published identity keys", ok: matches,
      detail: matches ? `relay matches local epoch ${local.epoch}` : "relay records do not match the persisted local keys",
      hint: matches ? undefined : "run `agentcall admin keys publish`",
    });
  } catch (error) {
    checks.push({ name: "published identity keys", ok: false, detail: short(error), hint: "run `agentcall admin keys publish`" });
  }
  return checks;
}

export async function checkRecoveryHealth(
  cfg: Config, fetchFn: typeof getRecoveryStatus = getRecoveryStatus,
): Promise<VerifyCheck> {
  try {
    const status = await fetchFn(
      relayUrl(cfg), authOf(cfg),
    );
    return status.issued
      ? {
        name: "recovery proof", ok: true,
        detail: `generation ${status.generation}; public ID ${status.recovery_public_id}; long-lived full-authority backup`,
      }
      : {
        name: "recovery proof", ok: true, warn: true,
        detail: "not issued; loss of this installation token is unrecoverable",
        hint: "run `agentcall recovery issue` and save the proof out of band",
      };
  } catch (error) {
    return { name: "recovery proof", ok: false, detail: short(error) };
  }
}

function diagnosticCheck(check: VerifyCheck): DiagnosticCheck {
  return {
    name: check.name,
    status: check.ok ? check.warn ? "warning" : "pass" : "fail",
    ...(check.detail === undefined ? {} : { detail: check.detail }),
    ...(check.hint === undefined ? {} : { hint: check.hint }),
  };
}

function finishReport(
  checks: DiagnosticCheck[], notes: string[], self?: SelfDiagnostics,
): DoctorReport {
  return {
    ok: checks.every((check) => check.status !== "fail"),
    checks,
    notes,
    ...(self === undefined ? {} : { self }),
  };
}

export function diagnoseSelfConfiguration(
  cfg: Config & { agent_kind: NonNullable<Config["agent_kind"]> }, paths: Paths,
): { checks: VerifyCheck[]; self: SelfDiagnostics } {
  const taskProblems: string[] = [];
  const tasks = loadTasks(paths, (message) => taskProblems.push(message.replace(/^agentcall: /, "")));
  const taskSummary = tasks.map(({ id, name, description, threadable, timeout_s }) => ({
    id, name, description, threadable, ...(timeout_s === undefined ? {} : { timeout_s }),
  }));
  const checks: VerifyCheck[] = [{
    name: "task validity",
    ok: taskProblems.length === 0,
    detail: taskProblems.length === 0
      ? `${tasks.length} task(s) load successfully`
      : taskProblems.join("; "),
    hint: taskProblems.length === 0 ? undefined : `repair the invalid manifests under ${paths.tasksDir}`,
  }];

  let policy;
  try {
    policy = loadPolicy(paths);
  } catch (error) {
    checks.push({
      name: "effective policy", ok: false, detail: short(error),
      hint: `repair ${paths.policyFile}; policy mutation commands remain available for recovery`,
    });
    checks.push({
      name: "card drift", ok: true, warn: true,
      detail: "unavailable while the effective policy is invalid",
      hint: "repair the policy, then run `agentcall doctor` again",
    });
    return {
      checks,
      self: {
        tasks: taskSummary,
        policy: { description: "", default_access: "unavailable", callers: [], assertions_passed: 0 },
        card: { status: "unavailable" },
      },
    };
  }

  const callers = Object.keys(policy.callers).sort((a, b) => a.localeCompare(b)).map((caller) => ({
    caller,
    access: accessFor(policy, caller),
  }));
  checks.push({
    name: "effective policy", ok: true,
    detail: `default ${policy.default_access}; ${callers.length} named caller(s); ${policy.tests?.length ?? 0} assertion(s) passed`,
  });
  checks.push({
    name: "durable mailbox capability", ok: true,
    detail: policy.offline_delivery.enabled
      ? "enabled; published card must advertise durable-mailbox-v1"
      : "disabled (default)",
  });

  let cardStatus: SelfDiagnostics["card"]["status"];
  const expected = buildCardUpload(cfg, policy, tasks);
  if (!existsSync(paths.cardSnapshotFile)) {
    cardStatus = "never-published";
  } else {
    try {
      const snapshot: unknown = JSON.parse(readFileSync(paths.cardSnapshotFile, "utf8"));
      cardStatus = JSON.stringify(snapshot) === JSON.stringify(expected) ? "current" : "stale";
    } catch {
      cardStatus = "unreadable";
    }
  }
  checks.push({
    name: "card drift", ok: true, warn: cardStatus !== "current",
    detail: cardStatus,
    hint: cardStatus === "current" ? undefined : "run `agentcall admin card publish` after reviewing this report",
  });

  if (cfg.agent_kind === "codex") {
    checks.push({
      name: "Codex runtime isolation", ok: true, warn: true,
      detail: "Codex has no per-tool restriction or read guard; read-only sandboxing does not prevent reads or execution",
      hint: "use Claude when outbound data must be bounded",
    });
  }

  return {
    checks,
    self: {
      tasks: taskSummary,
      policy: {
        description: policy.description,
        default_access: policy.default_access,
        callers,
        assertions_passed: policy.tests?.length ?? 0,
      },
      card: { status: cardStatus },
    },
  };
}

export function renderDoctorHuman(report: DoctorReport): string {
  const lines = report.checks.map((check) => formatCheck({
    name: check.name,
    ok: check.status !== "fail",
    warn: check.status === "warning",
    detail: check.detail,
    hint: check.hint,
  }));
  lines.push(...report.notes);
  if (report.self) {
    lines.push("", `Tasks (${report.self.tasks.length})`);
    for (const task of report.self.tasks) lines.push(`  ${task.id} — ${task.name}`);
    lines.push("", "Effective policy");
    lines.push(`  Default access: ${report.self.policy.default_access}`);
    lines.push(`  Assertions passed: ${report.self.policy.assertions_passed}`);
    for (const caller of report.self.policy.callers) lines.push(`  ${caller.caller}: ${caller.access}`);
    lines.push("", `Card publication: ${report.self.card.status}`);
  }
  return lines.join("\n");
}

// Verifies that this installation can answer calls. Ladder semantics (see the
// design spec): static checks are informational and never block the agent
// checks, EXCEPT a missing/corrupt config (nothing to verify) and caller-only
// (nothing to verify, and that's fine — contributes no failure). The
// verifyAgent ladder stops itself at its first failure. The report is healthy
// iff no check has `fail` status; warnings do not turn the run red.
export async function diagnoseInstallation(deps: DoctorDeps): Promise<DoctorReport> {
  const checks: DiagnosticCheck[] = [];
  const notes: string[] = [];
  let self: SelfDiagnostics | undefined;
  const report = (c: VerifyCheck) => {
    checks.push(diagnosticCheck(c));
  };

  report(checkCliInstall(deps));

  // There is one supervisor artifact and one listener process per installation.
  const platform = deps.platform ?? process.platform;
  if (platform === "darwin" || platform === "linux") {
    const status = (deps.inspectListenerServiceFn ?? ((machine) =>
      inspectListenerService(machine, { platform })))(deps.paths);
    report({
      name: `background listener (${status.kind})`,
      ok: status.running,
      hint: status.running ? undefined : "re-run `agentcall setup` to install it, or run `agentcall listen` in a terminal",
    });
    // Diagnostic only, never fatal on its own: this distinguishes "setup
    // never installed the plist" from "it's installed but not currently
    // loaded" (e.g. someone ran `launchctl bootout` by hand). Both explain
    // the same failed check above, so this must not double-count it.
    if (!status.running) {
      const artifact = status.kind === "launchd" ? "launch agent plist" : "systemd user unit";
      report({
        name: artifact,
        ok: true,
        warn: true,
        detail: status.installed
          ? `${status.kind === "launchd" ? "plist" : "unit"} file exists but the listener is not running`
          : `${status.kind === "launchd" ? "plist" : "unit"} file was never installed`,
        hint: status.installed
          ? status.kind === "launchd"
            ? "run `launchctl kickstart gui/$(id -u)/tech.benree.agentcall.listener`, or re-run `agentcall setup`"
            : "run `systemctl --user restart agentcall-listener.service`, or re-run `agentcall setup`"
          : "run `agentcall setup`",
      });
    }
  }


  const peerStore = checkKnownPeersStore(deps.paths);
  report({ name: "known-peer trust store", ok: peerStore.ok, detail: peerStore.detail });

  report(checkCredentialStorage(deps.paths, platform));
  let cfg: Config;
  try {
    cfg = loadConfig(deps.paths);
    report({ name: "config", ok: true, detail: `${cfg.handle} -> ${relayUrl(cfg)}` });
  } catch (error) {
    report({ name: "config", ok: false, detail: short(error), hint: "run `agentcall setup` first or follow the migration guidance" });
    return finishReport(checks, notes);
  }

  {
    const paths = deps.paths;

    report(await checkRecoveryHealth(cfg, deps.getRecoveryStatusFn));

    for (const keyCheck of await (deps.keyHealthFn ?? checkKeyHealth)(cfg, paths)) report(keyCheck);

    try {
      const ring = inspectEncryptionKeyRing(paths);
      report({
        name: "mailbox key ring", ok: true,
        detail: `current epoch ${ring.current_epoch}; ${ring.retained_live_epochs.length} retained live epoch(s)`,
      });
    } catch (error) {
      report({ name: "mailbox key ring", ok: true, warn: true, detail: short(error) });
    }

    try {
      accessSync(paths.dir, constants.W_OK);
      const records = existsSync(paths.executionJournalFile) ? loadExecutionJournal(paths) : [];
      report({
        name: "execution journal", ok: true,
        detail: existsSync(paths.executionJournalFile)
          ? `${records.length} retained durable execution record(s); private store is writable`
          : "private store is writable; journal will be created on the first durable lease",
      });
    } catch (error) {
      report({
        name: "execution journal", ok: false, detail: short(error),
        hint: `restore private writable state at ${paths.dir}`,
      });
    }

    if (!cfg.agent_kind) {
      notes.push("caller-only — no agent to verify. You can still call others.");
      return finishReport(checks, notes);
    }
    report({
      name: "durable listener compatibility", ok: true,
      detail: "listener advertises durable-mailbox-v1 with lease-bound acknowledgements",
    });

    const local = diagnoseSelfConfiguration(cfg as Config & { agent_kind: NonNullable<Config["agent_kind"]> }, paths);
    for (const check of local.checks) report(check);
    self = local.self;

    // #372 deleted `workdir` from config.json; the spawn directory is derived
    // from the scope instead. That derivation deliberately SKIPS a
    // source that no longer exists rather than throwing — one stale entry must
    // not take a line offline — which trades a loud failure for a quiet
    // fallback to an empty share directory. This is where that trade is paid
    // back: an owner whose repository moved sees it named here instead of
    // discovering it as an agent that suddenly knows nothing.
    let workdirDir: string | undefined;
    try {
      const scope = loadScope(paths);
      const missing = scope.roots.filter((r) => !existsSync(r));
      workdirDir = workdirFor(scope, paths.shareDir, paths.userHome);
      if (missing.length > 0) {
        report({
          name: "scope", ok: false,
          detail: `${missing.length} root(s) missing: ${missing.join(", ")}`,
          hint: "fix or remove those roots in ~/.agentcall/scope.json",
        });
      } else if (scope.roots.length === 0) {
        // A warning, not a failure. A caller-only line legitimately has no
        // scope, and `doctor` exiting 1 on one would report a working install
        // as broken. It IS worth saying, because on an answering line it means
        // setup did not write the file and the agent can read nothing.
        report({
          name: "scope", ok: true, warn: true,
          detail: "no root is declared, so the agent can read nothing",
          hint: "run `agentcall setup` again, or add a root to ~/.agentcall/scope.json",
        });
      } else {
        report({ name: "scope", ok: true, detail: `${scope.roots.length} root(s), ${scope.denied.length} extra denial(s)` });
      }
      report({ name: "workdir", ok: true, detail: `${workdirDir} (derived from the first root)` });
    } catch (e) {
      report({
        name: "scope", ok: false, detail: short(e),
        hint: "fix ~/.agentcall/scope.json — the listener refuses every call while it is unparseable",
      });
    }

    // ConfigSchema types `relay` as a bare string, so a syntactically
    // broken value still parses as a valid config and would otherwise only
    // surface as a network failure from the status check below —
    // indistinguishable from a listener that simply isn't running. Caught
    // here, before that call, so the two read differently in the output.
    let relayValid = true;
    try {
      new URL(relayUrl(cfg));
    } catch {
      relayValid = false;
      // relayUrl(cfg), not cfg.relay: AGENTCALL_RELAY, when set, is what
      // relayUrl actually validates (it takes precedence over cfg.relay — see
      // config.ts). Naming cfg.relay here would send the owner to fix a
      // config.json field that a valid AGENTCALL_RELAY override already
      // bypassed.
      report({
        name: "relay config",
        ok: false,
        detail: `"${relayUrl(cfg)}" is not a valid URL`,
        hint: "fix `relay` in ~/.agentcall/config.json — or, if set, AGENTCALL_RELAY, which takes precedence",
      });
    }

    let online = false;
    if (relayValid) {
      try {
        online = (await (deps.getStatusFn ?? getStatus)(
          relayUrl(cfg), cfg.handle, authOf(cfg),
        )).online;
        report({
          name: "relay status",
          ok: online,
          detail: online ? "online" : "offline",
          hint: online ? undefined : "the listener isn't connected — check ~/.agentcall/listener.log",
        });
      } catch (e) {
        report({ name: "relay status", ok: false, detail: short(e) });
      }
    }

    // Falls back to shareDir when workdir didn't resolve: per the ladder
    // semantics above, a static-check failure reports itself but must not
    // stop the agent checks from running.
    const agentWorkdir = workdirDir ?? paths.shareDir;
    const agentChecks = await verifyAgent(cfg.agent_kind, agentWorkdir, deps.verifyFns);
    for (const c of agentChecks) report(c);
    const agentOk = agentChecks.every((c) => c.ok);

    // Runtime-specific guard evidence. Claude needs a real tool attempt plus a
    // direct binary fallback; Codex exposes its effective hook status through
    // app-server without another model call. Gated on agentOk because probing
    // through a broken agent install tests nothing.
    if (cfg.agent_kind === "claude" && agentOk) {
      report(await checkGuard(deps.guardFn, deps.guardBinaryFn));
    }

    if (agentOk && !online) notes.push("runtime probe passed, but the listener is offline.");
  }

  return finishReport(checks, notes, self);
}
