import { existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { writeJsonAtomic } from "../json-store.js";
import { formatAddress, type AgentKind } from "@benree/agentcall-shared";
import { authOf, publishEncryptionKey, publishIdentityKey, registerHandle } from "../api.js";
import { publishCard } from "../card.js";
import { type LineConfig } from "../config.js";
import { loadSensitivityMap, withFloor, workdirFor } from "../sensitivity.js";
import { assertValidLineName, listLines, readyLines, saveLineConfig } from "../lines.js";
import { defaultSensitivityMap } from "../sensitivity.js";
import { listenerPathDirs } from "../listener-path.js";
import { getLinePaths, type LinePaths, type MachinePaths } from "../paths.js";
import { generateIdentityKeys, type StoredKeys } from "../keys.js";
import { loadPerson, resolvePrimary, savePerson } from "../person.js";
import { DEFAULT_POLICY } from "../policy.js";
import { installListenerService, uninstallListenerService } from "../listener-service.js";
import { formatCheck, verifyAgent, type VerifyFns } from "../verify.js";
import { withFileLock } from "../file-lock.js";

export interface AddLineOpts {
  name: string;
  handle: string;
  relay: string;
  // Every registration is an enrollment into a tenant (#74), and the tenant is
  // a property of the LINE, not the machine: `org` lives in LineConfig beside
  // `relay`. So a second line needs its own invite even on a machine that
  // already has one — it may be enrolling into a different tenant entirely,
  // and only the relay can tell us which.
  invite?: string;
  agent?: AgentKind;
  callerOnly?: boolean;
  // false skips the post-registration verify step (commander's --no-verify
  // on `line add`). Defaults to true for a callable line; irrelevant for a
  // caller-only one, which has no agent to verify. setup.ts passes false
  // here unconditionally — it does its own richer verify pass (with a
  // ready/not-ready summary) after addLine returns, and running both would
  // spawn the agent twice for one `agentcall setup`.
  verify?: boolean;
  verifyFns?: VerifyFns;
  warn?: (line: string) => void;
  log?: (line: string) => void;
  // Test seams. publishCardFn returns Promise<unknown> rather than
  // typeof publishCard's Promise<CardUploadType> so a test double can return
  // undefined without constructing a full card upload.
  register?: typeof registerHandle;
  publishCardFn?: (cfg: LineConfig, p: LinePaths) => Promise<unknown>;
  publishKeysFn?: (cfg: LineConfig, keys: StoredKeys, paths: LinePaths) => Promise<void>;
  installListenerServiceFn?: typeof installListenerService;
  // Dirs (an agent/npx binary resolved outside launchd's fixed base PATH) to
  // prepend to the listener service's PATH. Defaults to listenerPathDirs(m,
  // resolveBin) — derived from every ready line on the machine, including
  // the one this call just wrote to disk — rather than requiring the caller
  // to compute and pass it. Explicit values here are a test seam only; a
  // real caller has no reason to override the derived answer.
  extraPathDirs?: string[];
  // Only consulted when extraPathDirs is absent, and only as an input to
  // listenerPathDirs's own derivation — see there for the default.
  resolveBin?: (name: string) => string | null;
}

export async function publishStoredKeys(
  line: LineConfig,
  stored: StoredKeys,
  paths: LinePaths,
  fns: { identity?: typeof publishIdentityKey; encryption?: typeof publishEncryptionKey } = {},
): Promise<void> {
  const auth = authOf(line);
  await (fns.identity ?? publishIdentityKey)(line.relay, auth, stored);
  await (fns.encryption ?? publishEncryptionKey)(line.relay, auth, paths);
}

// A handle that is `<existing>-<something>` is guessable from an address the
// owner already handed out. The address is the sharing boundary, so a
// predictable one weakens the thing the line exists for — warn, don't refuse.
function derivativeOf(handle: string, existing: string[]): string | undefined {
  return existing.find((e) => handle.startsWith(`${e}-`));
}

export async function addLine(m: MachinePaths, opts: AddLineOpts): Promise<{ address: string }> {
  // Validate BEFORE the network call: a rejected name must not burn a handle.
  assertValidLineName(opts.name);
  const existing = listLines(m);
  if (existing.some((l) => l.name.toLowerCase() === opts.name.toLowerCase())) {
    throw new Error(`A line named "${opts.name}" already exists.`);
  }
  const heldHandles = existing.filter((l) => l.config).map((l) => l.config!.handle);
  if (heldHandles.includes(opts.handle)) {
    throw new Error(`This machine already holds the handle "${opts.handle}" on another line.`);
  }
  const near = derivativeOf(opts.handle, heldHandles);
  if (near) {
    (opts.warn ?? console.error)(
      `Warning: "${opts.handle}" is easy to guess from "${near}", which you have already shared. ` +
        `Anyone holding that address can find this one.`,
    );
  }

  const agentKind = opts.callerOnly ? undefined : opts.agent;
  // Checked here rather than left to registerHandle's own guard so it joins
  // the other pre-network validations above: a missing invite must not be
  // discovered after anything has been spent.
  const invite = opts.invite?.trim();
  if (!invite) {
    throw new Error(`An organization invite is required. Run \`agentcall line add ${opts.name} --invite <token>\`.`);
  }
  // Persist the private halves before either registration or publication. A
  // relay must never advertise a public key whose private half was not safely
  // committed on this machine.
  const paths = getLinePaths(m, opts.name);
  mkdirSync(m.linesDir, { recursive: true, mode: 0o700 });
  try {
    // This directory is also the cross-process reservation for the line name.
    // Unlike the later atomic file replacement, mkdir without `recursive`
    // has exactly one winner, so two setups cannot publish one key while a
    // competing setup leaves a different key on disk.
    mkdirSync(paths.dir, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(`A line named "${opts.name}" is already being created or has incomplete state at ${paths.dir}.`);
    }
    throw error;
  }
  return withFileLock(paths.configFile, "line credential", async () => {
  // Recovery may have won the sidecar immediately after our directory mkdir.
  // Recheck under the shared lock before spending the invite or publishing a
  // token, so whichever operation wins makes the other fail harmlessly.
  if (existsSync(paths.configFile) || existsSync(paths.recoveryPendingFile)) {
    throw new Error(`A line named "${opts.name}" was created while this command was waiting for its credential lock.`);
  }
  let keys: StoredKeys;
  let registration: Awaited<ReturnType<typeof registerHandle>>;
  try {
    keys = await generateIdentityKeys(paths);
    registration = await (opts.register ?? registerHandle)(opts.relay, invite, opts.handle, agentKind);
  } catch (error) {
    // This invocation owns the exclusive directory reservation, and the handle
    // was not spent. Removing it cannot delete a competing setup's state.
    rmSync(paths.dir, { recursive: true, force: true });
    throw error;
  }
  const { org, token } = registration;

  // Registration succeeded, so the handle is spent and unreclaimable (#16).
  // config.json is therefore the first post-registration write — the key file
  // above is deliberately pre-registration and contains no relay credential.
  // Everything below is recoverable by re-running; losing the token is not.
  const cfg: LineConfig = agentKind
    ? { org, handle: opts.handle, token, relay: opts.relay, agent_kind: agentKind }
    : { org, handle: opts.handle, token, relay: opts.relay };
  saveLineConfig(paths, cfg);

  // A line with no sensitivity map classifies every source `secret` and can
  // therefore answer nothing. Seeding it with the repository setup ran inside
  // is what makes a fresh line useful without making it generous: outside a
  // repository this writes an empty map, and doctor reports the line as unable
  // to answer rather than the line silently returning nothing.
  writeJsonAtomic(paths.sensitivityFile, defaultSensitivityMap(process.cwd(), paths.machine.userHome));

  const publishKeys = opts.publishKeysFn ?? publishStoredKeys;
  try {
    await publishKeys(cfg, keys, paths);
  } catch (error) {
    (opts.warn ?? console.error)(
      `Warning: keys are safely stored but could not be published (${String(error)}). ` +
      `Run \`agentcall keys publish --line ${opts.name}\` after checking the relay.`,
    );
  }

  if (agentKind) {
    mkdirSync(paths.shareDir, { recursive: true });
    mkdirSync(paths.tasksDir, { recursive: true });
    if (!existsSync(paths.policyFile)) {
      writeJsonAtomic(paths.policyFile, DEFAULT_POLICY);
    }
    try {
      await (opts.publishCardFn ?? publishCard)(cfg, paths);
    } catch (e) {
      (opts.warn ?? console.error)(
        `Warning: could not publish the card (${String(e)}). Run \`agentcall card push --line ${opts.name}\` later.`,
      );
    }
    // saveLineConfig above already put this line's config on disk, so
    // listenerPathDirs (which reads readyLines(m)) sees it — the derived PATH
    // covers this line's agent kind alongside every other ready line's.
    (opts.installListenerServiceFn ?? installListenerService)(m, {
      extraPathDirs: opts.extraPathDirs ?? listenerPathDirs(m, opts.resolveBin),
    });

    // Verification is best-effort feedback, not a gate: the handle is already
    // spent (see above), so a failed verify warns rather than throwing —
    // there's nothing left to undo, and the line still answers once the
    // owner fixes whatever verifyAgent found.
    if (opts.verify !== false) {
      const log = opts.log ?? console.log;
      const checks = await verifyAgent(agentKind, workdirFor(withFloor(loadSensitivityMap(paths), paths.machine.userHome), paths.shareDir), opts.verifyFns);
      for (const c of checks) log(formatCheck(c));
      const failure = checks.find((c) => !c.ok);
      if (failure) {
        (opts.warn ?? console.error)(
          `Warning: line "${opts.name}" did not pass verification (${failure.name}` +
            `${failure.detail ? ` — ${failure.detail}` : ""}). It's registered and will still receive calls; ` +
            `run \`agentcall doctor\` to check again once fixed.`,
        );
      }
    }
  }

  // person.json is written LAST, and only for the first line, so a failed
  // first setup never leaves primary_line pointing at a broken line.
  if (!existsSync(m.personFile)) savePerson(m, { primary_line: opts.name });
  return { address: formatAddress(org, opts.handle) };
  });
}

export interface RemoveLineOpts {
  confirm?: boolean;
  purge?: boolean;
  uninstallFn?: typeof uninstallListenerService;
  // Separate from uninstallFn: the reinstall branch below (readyLines still
  // has a callable line) calls install, not uninstall, and a test that only
  // stubs uninstallFn must not fall through to the real listener installer —
  // that shells out to the actual `launchctl bootstrap` on the real user's
  // launchd session regardless of how sandboxed MachinePaths.userHome is.
  installFn?: typeof installListenerService;
  // Same seam as AddLineOpts.resolveBin — feeds the reinstall branch's
  // listenerPathDirs derivation.
  resolveBin?: (name: string) => string | null;
}

export function removeLine(m: MachinePaths, name: string, opts: RemoveLineOpts = {}): void {
  const all = listLines(m);
  const target = all.find((l) => l.name === name);
  if (!target) throw new Error(`No line named "${name}".`);

  // Usable lines only — not raw directory count. listLines' "reportable, not
  // fatal" contract means `all` also includes orphaned/broken entries: a
  // stray half-made directory sitting next to your one real line must not
  // let that real line be removed (all.length would be 2, masking this
  // guard), and removing the orphan itself, with a real line still
  // standing, must not be blocked by it either. Only trips when the line
  // being removed is itself usable and is the last one.
  const targetIsUsable = target.ok && target.config !== undefined;
  if (targetIsUsable && readyLines(m).length <= 1) {
    throw new Error(
      `"${name}" is the only line on this machine — removing it would leave you unable to answer or call. ` +
        `Use \`agentcall uninstall --purge\` to remove agentcall entirely.`,
    );
  }
  let primary: string | undefined;
  try {
    primary = loadPerson(m).primary_line;
  } catch {
    primary = undefined;
  }
  if (primary === name) {
    throw new Error(`"${name}" is the primary line. Promote another first: agentcall line primary <name>`);
  }
  if (!opts.confirm) {
    // target.config is only ever set alongside target.ok (see listLines) —
    // an orphan directory (no config.json, or one that failed to parse) never
    // held a handle, so the "abandons a handle permanently" warning would be
    // false for it: nothing was ever registered, so nothing is at stake but
    // local files.
    throw new Error(
      target.config
        ? `Removing "${name}" abandons the handle "${target.config.handle}" permanently — handle release is ` +
          `not implemented, so nobody (including you) can ever register it again. Re-run with --yes to confirm.`
        : `Removing "${name}" discards its local files — it never finished registration (no usable config.json), ` +
          `so there's no handle at stake. Re-run with --yes to confirm.`,
    );
  }

  if (opts.purge) {
    rmSync(target.paths.dir, { recursive: true, force: true });
  } else {
    // Archive rather than delete: calls.log is the audit trail of what this
    // address disclosed, and removing a line should not destroy it silently.
    mkdirSync(m.removedDir, { recursive: true, mode: 0o700 });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    renameSync(target.paths.dir, join(m.removedDir, `${name}-${stamp}`));
  }

  // One process serves every line, so removing one means restarting it, not
  // unloading a per-line service. Reinstalling the single agent is how that
  // happens; skip it when nothing callable is left. The target's directory
  // is already gone/archived above, so readyLines(m) here reflects the
  // surviving lines only — listenerPathDirs derives their PATH dirs, not the
  // removed line's, and not an empty list that would clobber them.
  if (readyLines(m).some((l) => l.config.agent_kind)) {
    (opts.uninstallFn ?? uninstallListenerService)(m);
    (opts.installFn ?? installListenerService)(m, { extraPathDirs: listenerPathDirs(m, opts.resolveBin) });
  } else {
    (opts.uninstallFn ?? uninstallListenerService)(m);
  }
}

export function setPrimary(m: MachinePaths, name: string): void {
  const ready = readyLines(m);
  if (!ready.some((l) => l.name === name)) {
    throw new Error(`No usable line named "${name}". This machine has: ${ready.map((l) => l.name).join(", ") || "none"}.`);
  }
  savePerson(m, { primary_line: name });
}

interface LineRow {
  name: string;
  address: string;
  relay: string;
  state: "online" | "offline" | "caller-only" | "broken";
  primary: boolean;
}

export function listLinesReport(
  m: MachinePaths, presence: (cfg: LineConfig) => boolean = () => false,
): LineRow[] {
  let primary: string | undefined;
  try {
    primary = resolvePrimary(m, readyLines(m).map((l) => l.name));
  } catch {
    primary = undefined;
  }
  return listLines(m).map((l) => ({
    name: l.name,
    // The relay no longer appears here: an address is (org, handle), and the
    // relay is shown in its own column below. That also removes the reason
    // this had to tolerate an unparseable relay URL — a broken line still
    // lists, and its address still renders.
    address: l.config ? formatAddress(l.config.org, l.config.handle) : "—",
    relay: l.config?.relay ?? "—",
    state: !l.ok ? "broken" : !l.config!.agent_kind ? "caller-only" : presence(l.config!) ? "online" : "offline",
    primary: l.name === primary,
  }));
}
