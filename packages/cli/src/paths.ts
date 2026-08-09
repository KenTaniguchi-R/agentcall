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
  /** Source sensitivity map (#372). Absent means every source is `secret`. */
  scopeFile: string;
  cardSnapshotFile: string;
  callsLog: string;
  toolsLog: string;
  tasksDir: string;
  shareDir: string;
  // Line-scoped because contexts.json binds an agent session to (caller, task,
  // agent_kind, workdir), and contexts-out.json is keyed by the `from` handle
  // placing the call. Machine-scoping either would leak one audience into another.
  contextsFile: string;
  contextsOutFile: string;
  /** Crash-safe online credential candidate; never contains a recovery proof. */
  recoveryPendingFile: string;
}

export function getMachinePaths(
  stateRoot: string = process.env.AGENTCALL_HOME ?? os.homedir(),
  userHome: string = os.homedir(),
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
    // Deliberately independent of stateRoot and AGENTCALL_HOME: an unprivileged
    // user must not be able to relocate the administrator-owned policy.
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
    scopeFile: join(dir, "scope.json"),
    cardSnapshotFile: join(dir, "card.pushed.json"),
    callsLog: join(dir, "calls.log"),
    toolsLog: join(dir, "tools.log"),
    tasksDir: join(authored, "tasks"),
    shareDir: join(authored, "public"),
    contextsFile: join(dir, "contexts.json"),
    contextsOutFile: join(dir, "contexts-out.json"),
    recoveryPendingFile: join(dir, "recovery-pending.json"),
  };
}
