import os from "node:os";
import { join } from "node:path";

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
