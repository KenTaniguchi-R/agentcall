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
  linesDir: string;
  removedDir: string;
  listenerLog: string;
}

export interface LinePaths {
  machine: MachinePaths;
  name: string;
  dir: string;
  configFile: string;
  policyFile: string;
  cardSnapshotFile: string;
  callsLog: string;
  toolsLog: string;
  tasksDir: string;
  shareDir: string;
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
    linesDir: join(dir, "lines"),
    removedDir: join(dir, "removed"),
    // One process serves every line, so there is one listener log.
    listenerLog: join(dir, "listener.log"),
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
    policyFile: join(dir, "policy.json"),
    cardSnapshotFile: join(dir, "card.pushed.json"),
    callsLog: join(dir, "calls.log"),
    toolsLog: join(dir, "tools.log"),
    tasksDir: join(authored, "tasks"),
    shareDir: join(authored, "public"),
  };
}

// Legacy: one flat namespace conflating userHome/stateRoot/authored. Kept
// verbatim so every existing consumer keeps compiling. Deleted in Task 12
// once nothing imports it — see MachinePaths/LinePaths above for the split.
export interface Paths {
  home: string; dir: string; configFile: string;
  callsLog: string; listenerLog: string; toolsLog: string; publicDir: string;
  tasksDir: string; policyFile: string; cardSnapshotFile: string;
  contactsFile: string;
}

export function getPaths(home: string = process.env.AGENTCALL_HOME ?? os.homedir()): Paths {
  const dir = join(home, ".agentcall");
  return {
    home, dir,
    configFile: join(dir, "config.json"),
    callsLog: join(dir, "calls.log"),
    listenerLog: join(dir, "listener.log"),
    toolsLog: join(dir, "tools.log"),
    publicDir: join(home, "AgentCall", "public"),
    policyFile: join(dir, "policy.json"),
    tasksDir: join(home, "AgentCall", "tasks"),
    cardSnapshotFile: join(dir, "card.pushed.json"),
    contactsFile: join(dir, "contacts.json"),
  };
}
