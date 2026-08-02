import os from "node:os";
import { join } from "node:path";

export interface Paths {
  home: string; dir: string; configFile: string;
  callsLog: string; listenerLog: string; toolsLog: string; publicDir: string;
  tasksDir: string; policyFile: string; managedPolicyFile: string; cardSnapshotFile: string;
  contactsFile: string;
  rostersFile: string; rosterCacheFile: string;
  contextsFile: string;
  contextsOutFile: string;
}

export function managedPolicyPath(platform: NodeJS.Platform = process.platform): string {
  if (platform === "darwin") return "/Library/Application Support/agentcall/policy.json";
  if (platform === "linux") return "/etc/agentcall/policy.json";
  throw new Error(`Managed policy is not supported on ${platform}`);
}

export function getPaths(
  home: string = process.env.AGENTCALL_HOME ?? os.homedir(),
  platform: NodeJS.Platform = process.platform,
): Paths {
  const dir = join(home, ".agentcall");
  return {
    home, dir,
    configFile: join(dir, "config.json"),
    callsLog: join(dir, "calls.log"),
    listenerLog: join(dir, "listener.log"),
    toolsLog: join(dir, "tools.log"),
    publicDir: join(home, "AgentCall", "public"),
    policyFile: join(dir, "policy.json"),
    // Deliberately independent of home and AGENTCALL_HOME: an unprivileged
    // user must not be able to relocate the administrator-owned policy.
    managedPolicyFile: managedPolicyPath(platform),
    tasksDir: join(home, "AgentCall", "tasks"),
    cardSnapshotFile: join(dir, "card.pushed.json"),
    contactsFile: join(dir, "contacts.json"),
    rostersFile: join(dir, "rosters.json"),
    rosterCacheFile: join(dir, "roster-cache.json"),
    contextsFile: join(dir, "contexts.json"),
    contextsOutFile: join(dir, "contexts-out.json"),
  };
}
