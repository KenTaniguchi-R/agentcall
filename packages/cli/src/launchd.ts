import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { Paths } from "./paths.js";

export const LAUNCH_LABEL = "tech.benree.agentcall.listener";
type ExecCmd = (cmd: string[]) => void;

const defaultExec: ExecCmd = (cmd) => {
  execFileSync(cmd[0]!, cmd.slice(1), { stdio: "ignore" });
};

function uid(): number {
  return process.getuid?.() ?? 501;
}

// Base search path launchd falls back to. extraPathDirs (from setup's bin
// detection) and the node binary's own dir are prepended ahead of these so
// the listener can find an agent/node install that lives outside them (e.g.
// ~/.local/bin, nvm/fnm shims).
const BASE_PATH_DIRS = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"];

export function plistContent(nodeBin: string, cliScript: string, p: Paths, extraPathDirs: string[] = []): string {
  const pathDirs = [...new Set([...extraPathDirs, dirname(nodeBin), ...BASE_PATH_DIRS])];
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LAUNCH_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${nodeBin}</string>
    <string>${cliScript}</string>
    <string>listen</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${p.listenerLog}</string>
  <key>StandardErrorPath</key><string>${p.listenerLog}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>${pathDirs.join(":")}</string>
    <key>HOME</key><string>${p.home}</string>
  </dict>
</dict>
</plist>
`;
}

export function installLaunchAgent(p: Paths, execCmd: ExecCmd = defaultExec, extraPathDirs: string[] = []): void {
  const cliScript = fileURLToPath(new URL("../dist/index.js", import.meta.url));
  mkdirSync(dirname(p.plistFile), { recursive: true });
  writeFileSync(p.plistFile, plistContent(process.execPath, cliScript, p, extraPathDirs));
  try {
    execCmd(["launchctl", "bootout", `gui/${uid()}/${LAUNCH_LABEL}`]);
  } catch {
    /* not loaded */
  }
  execCmd(["launchctl", "bootstrap", `gui/${uid()}`, p.plistFile]);
}

export function uninstallLaunchAgent(p: Paths, execCmd: ExecCmd = defaultExec): void {
  try {
    execCmd(["launchctl", "bootout", `gui/${uid()}/${LAUNCH_LABEL}`]);
  } catch {
    /* not loaded */
  }
  if (existsSync(p.plistFile)) rmSync(p.plistFile);
}
