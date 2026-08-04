import os from "node:os";
import { join } from "node:path";

// Three concepts that used to be one string called `home`:
//   userHome  — the real account home. The plist's HOME, ~/Library/LaunchAgents,
//               and the guard's security root (the home whose .ssh/.claude/.codex
//               get denied). Redirecting this is how a test home silently stopped
//               protecting the real one.
//   stateRoot — where agentcall keeps its own state. Redirectable via
//               AGENTCALL_HOME, which is a TEST SEAM and not a user feature.
//   authored  — owner-edited task markdown, kept outside the dotfile dir so it
//               is visible in Finder. Follows stateRoot.
export interface MachinePaths {
  userHome: string;
  stateRoot: string;
  dir: string;
  personFile: string;
  contactsFile: string;
  knownPeersFile: string;
  replayReservationsFile: string;
  linesDir: string;
  removedDir: string;
  listenerLog: string;
  telemetryHealthFile: string;
  // Machine-scoped, not line-scoped, on purpose. It is an administrator ceiling:
  // if it were per-line, adding a line would escape it. It is also deliberately
  // independent of stateRoot/AGENTCALL_HOME — see managedPolicyPath below.
  managedPolicyFile: string;
}

export interface LinePaths {
  machine: MachinePaths;
  name: string;
  dir: string;
  configFile: string;
  // Line-scoped for the same reason as the group below, and the sharpest case
  // of it: the identity key is the trust root FOR AN ADDRESS, and a line is
  // exactly one handle on one relay. Machine-scoping it would hand two lines a
  // single identity key, which would let line A sign key records for line B's
  // address — the relay could then serve B's contacts a key A controls.
  //
  // One file holds BOTH key pairs on purpose, so a partial write cannot leave
  // an identity without its encryption key. There is deliberately no separate
  // encryption-key path.
  identityKeyFile: string;
  policyFile: string;
  cardSnapshotFile: string;
  callsLog: string;
  toolsLog: string;
  tasksDir: string;
  shareDir: string;
  // Line-scoped, not machine-scoped, because every one of these is keyed to an
  // audience. Rosters and the bundle cache are membership held by a handle on
  // a relay, and a line is exactly "a handle on a relay" — a second line on a
  // different relay must not read the first's memberships. contexts.json binds
  // an agent session to (caller, task, agent_kind, workdir), all of which are
  // per-line, and contexts-out.json is keyed by the `from` handle placing the
  // call. Machine-scoping any of them would leak one audience into another.
  rostersFile: string;
  rosterCacheFile: string;
  contextsFile: string;
  contextsOutFile: string;
  /** Crash-safe online credential candidate; never contains a recovery proof. */
  recoveryPendingFile: string;
}

function managedPolicyPath(platform: NodeJS.Platform = process.platform): string {
  if (platform === "darwin") return "/Library/Application Support/agentcall/policy.json";
  if (platform === "linux") return "/etc/agentcall/policy.json";
  throw new Error(`Managed policy is not supported on ${platform}`);
}

export function getMachinePaths(
  stateRoot: string = process.env.AGENTCALL_HOME ?? os.homedir(),
  userHome: string = os.homedir(),
  platform: NodeJS.Platform = process.platform,
): MachinePaths {
  const dir = join(stateRoot, ".agentcall");
  return {
    userHome,
    stateRoot,
    dir,
    personFile: join(dir, "person.json"),
    contactsFile: join(dir, "contacts.json"),
    knownPeersFile: join(dir, "known_peers.json"),
    replayReservationsFile: join(dir, "replay_reservations.json"),
    linesDir: join(dir, "lines"),
    removedDir: join(dir, "removed"),
    // One process serves every line, so there is one listener log.
    listenerLog: join(dir, "listener.log"),
    telemetryHealthFile: join(dir, "telemetry-health.json"),
    // Deliberately independent of stateRoot and AGENTCALL_HOME: an unprivileged
    // user must not be able to relocate the administrator-owned policy.
    managedPolicyFile: managedPolicyPath(platform),
  };
}

export function getLinePaths(machine: MachinePaths, name: string): LinePaths {
  const dir = join(machine.linesDir, name);
  const authored = join(machine.stateRoot, "AgentCall", name);
  return {
    machine,
    name,
    dir,
    configFile: join(dir, "config.json"),
    identityKeyFile: join(dir, "identity.key.json"),
    policyFile: join(dir, "policy.json"),
    cardSnapshotFile: join(dir, "card.pushed.json"),
    callsLog: join(dir, "calls.log"),
    toolsLog: join(dir, "tools.log"),
    tasksDir: join(authored, "tasks"),
    shareDir: join(authored, "public"),
    rostersFile: join(dir, "rosters.json"),
    rosterCacheFile: join(dir, "roster-cache.json"),
    contextsFile: join(dir, "contexts.json"),
    contextsOutFile: join(dir, "contexts-out.json"),
    recoveryPendingFile: join(dir, "recovery-pending.json"),
  };
}
