import os from "node:os";
import { join } from "node:path";

export interface Paths {
  home: string; dir: string; configFile: string; srtFile: string;
  callsLog: string; listenerLog: string; publicDir: string; plistFile: string;
}

export function getPaths(home: string = process.env.AGENTCALL_HOME ?? os.homedir()): Paths {
  const dir = join(home, ".agentcall");
  return {
    home, dir,
    configFile: join(dir, "config.json"),
    srtFile: join(dir, "srt.json"),
    callsLog: join(dir, "calls.log"),
    listenerLog: join(dir, "listener.log"),
    publicDir: join(home, "AgentCall", "public"),
    plistFile: join(home, "Library", "LaunchAgents", "tech.benree.agentcall.listener.plist"),
  };
}
