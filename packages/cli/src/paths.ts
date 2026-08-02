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
