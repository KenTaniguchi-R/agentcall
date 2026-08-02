import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentKind } from "@benree/agentcall-shared";
import { registerHandle } from "../api.js";
import { publishCard } from "../card.js";
import type { LineConfig } from "../config.js";
import { assertValidLineName, listLines, readyLines, saveLineConfig } from "../lines.js";
import { launchPathDirs } from "../launchPath.js";
import { host } from "../outbound.js";
import { getLinePaths, type LinePaths, type MachinePaths } from "../paths.js";
import { loadPerson, resolvePrimary, savePerson } from "../person.js";
import { DEFAULT_POLICY } from "../policy.js";
import { uninstallLaunchAgent, installLaunchAgent } from "../launchd.js";

export interface AddLineOpts {
  name: string;
  handle: string;
  relay: string;
  agent?: AgentKind;
  callerOnly?: boolean;
  verify?: boolean;
  warn?: (line: string) => void;
  // Test seams. publishCardFn returns Promise<unknown> rather than
  // typeof publishCard's Promise<CardUploadType> so a test double can return
  // undefined without constructing a full card upload. publishCard's second
  // parameter is structural (policyFile/tasksDir/cardSnapshotFile), so
  // LinePaths satisfies it directly — no line-scoped variant needed.
  register?: typeof registerHandle;
  publishCardFn?: (cfg: LineConfig, p: LinePaths) => Promise<unknown>;
  installLaunchAgentFn?: typeof installLaunchAgent;
  // Dirs (an agent/npx binary resolved outside launchd's fixed base PATH) to
  // prepend to the LaunchAgent's plist PATH. Defaults to launchPathDirs(m,
  // resolveBin) — derived from every ready line on the machine, including
  // the one this call just wrote to disk — rather than requiring the caller
  // to compute and pass it. Explicit values here are a test seam only; a
  // real caller has no reason to override the derived answer.
  extraPathDirs?: string[];
  // Only consulted when extraPathDirs is absent, and only as an input to
  // launchPathDirs's own derivation — see there for the default.
  resolveBin?: (name: string) => string | null;
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
  const { token, address } = await (opts.register ?? registerHandle)(opts.relay, opts.handle, agentKind);

  // Registration succeeded, so the handle is spent and unreclaimable (#16).
  // config.json is therefore the very first thing written — everything below
  // is recoverable by re-running, losing the token is not.
  const paths = getLinePaths(m, opts.name);
  const cfg: LineConfig = agentKind
    ? { handle: opts.handle, token, relay: opts.relay, agent_kind: agentKind }
    : { handle: opts.handle, token, relay: opts.relay };
  saveLineConfig(paths, cfg);

  if (agentKind) {
    mkdirSync(paths.shareDir, { recursive: true });
    mkdirSync(paths.tasksDir, { recursive: true });
    if (!existsSync(paths.policyFile)) {
      writeFileSync(paths.policyFile, JSON.stringify(DEFAULT_POLICY, null, 2) + "\n", { mode: 0o600 });
    }
    try {
      await (opts.publishCardFn ?? publishCard)(cfg, paths);
    } catch (e) {
      (opts.warn ?? console.error)(
        `Warning: could not publish the card (${String(e)}). Run \`agentcall card push --line ${opts.name}\` later.`,
      );
    }
    // saveLineConfig above already put this line's config on disk, so
    // launchPathDirs (which reads readyLines(m)) sees it — the derived PATH
    // covers this line's agent kind alongside every other ready line's.
    (opts.installLaunchAgentFn ?? installLaunchAgent)(m, undefined, opts.extraPathDirs ?? launchPathDirs(m, opts.resolveBin));
  }

  // person.json is written LAST, and only for the first line, so a failed
  // first setup never leaves primary_line pointing at a broken line.
  if (!existsSync(m.personFile)) savePerson(m, { primary_line: opts.name });
  return { address };
}

export interface RemoveLineOpts {
  confirm?: boolean;
  purge?: boolean;
  uninstallFn?: typeof uninstallLaunchAgent;
  // Separate from uninstallFn: the reinstall branch below (readyLines still
  // has a callable line) calls install, not uninstall, and a test that only
  // stubs uninstallFn must not fall through to the real installLaunchAgent —
  // that shells out to the actual `launchctl bootstrap` on the real user's
  // launchd session regardless of how sandboxed MachinePaths.userHome is.
  installFn?: typeof installLaunchAgent;
  // Same seam as AddLineOpts.resolveBin — feeds the reinstall branch's
  // launchPathDirs derivation.
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
    throw new Error(
      `Removing "${name}" abandons the handle "${target.config?.handle ?? "?"}" permanently — handle release is ` +
        `not implemented, so nobody (including you) can ever register it again. Re-run with --yes to confirm.`,
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
  // surviving lines only — launchPathDirs derives their PATH dirs, not the
  // removed line's, and not an empty list that would clobber them.
  if (readyLines(m).some((l) => l.config.agent_kind)) {
    (opts.uninstallFn ?? uninstallLaunchAgent)(m);
    (opts.installFn ?? installLaunchAgent)(m, undefined, launchPathDirs(m, opts.resolveBin));
  } else {
    (opts.uninstallFn ?? uninstallLaunchAgent)(m);
  }
}

export function setPrimary(m: MachinePaths, name: string): void {
  const ready = readyLines(m);
  if (!ready.some((l) => l.name === name)) {
    throw new Error(`No usable line named "${name}". This machine has: ${ready.map((l) => l.name).join(", ") || "none"}.`);
  }
  savePerson(m, { primary_line: name });
}

export interface LineRow {
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
    // host() (shared with outbound.ts) falls back to the raw string on an
    // unparseable relay instead of throwing — a broken line must still show
    // up in the listing (marked broken below), same contract listLines
    // itself already guarantees. A bare `new URL(...).host` here would take
    // down the whole `line list` command over one bad config.json.
    address: l.config ? `${l.config.handle}@${host(l.config.relay)}` : "—",
    relay: l.config?.relay ?? "—",
    state: !l.ok ? "broken" : !l.config!.agent_kind ? "caller-only" : presence(l.config!) ? "online" : "offline",
    primary: l.name === primary,
  }));
}
