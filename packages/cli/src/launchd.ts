import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Paths } from "./paths.js";

export const LAUNCH_LABEL = "tech.benree.agentcall.listener";
type ExecCmd = (cmd: string[]) => void;

// This module is the only place that knows the background listener is a
// macOS LaunchAgent. Everything outside it asks "is the listener installed?"
// rather than reaching for a plist path, so adding a systemd (or other)
// supervisor later is a sibling module rather than surgery across the CLI.
export function launchAgentFile(m: Paths): string {
  // userHome, not stateRoot: launchd only loads plists from the real account's
  // LaunchAgents directory, and a redirected state root must not move it.
  return join(m.userHome, "Library", "LaunchAgents", `${LAUNCH_LABEL}.plist`);
}

export function isLaunchAgentInstalled(m: Paths): boolean {
  return existsSync(launchAgentFile(m));
}

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

function xmlEscape(value: string): string {
  for (const character of value) {
    const codePoint = character.codePointAt(0)!;
    const isXml10Character =
      codePoint === 0x09 ||
      codePoint === 0x0a ||
      codePoint === 0x0d ||
      (codePoint >= 0x20 && codePoint <= 0xd7ff) ||
      (codePoint >= 0xe000 && codePoint <= 0xfffd) ||
      (codePoint >= 0x10000 && codePoint <= 0x10ffff);
    if (!isXml10Character) {
      throw new Error(
        `Cannot create LaunchAgent plist: XML 1.0 cannot represent U+${codePoint.toString(16).toUpperCase().padStart(4, "0")} in a path`,
      );
    }
  }
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

export function plistContent(
  nodeBin: string, cliScript: string, m: Paths, extraPathDirs: string[] = [],
): string {
  const pathDirs = [...new Set([...extraPathDirs, dirname(nodeBin), ...BASE_PATH_DIRS])];
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LAUNCH_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xmlEscape(nodeBin)}</string>
    <string>${xmlEscape(cliScript)}</string>
    <string>listen</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${xmlEscape(m.listenerLog)}</string>
  <key>StandardErrorPath</key><string>${xmlEscape(m.listenerLog)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>${xmlEscape(pathDirs.join(":"))}</string>
    <key>HOME</key><string>${xmlEscape(m.userHome)}</string>
  </dict>
</dict>
</plist>
`;
}

type SleepFn = () => void;
const defaultSleep: SleepFn = () => {
  execFileSync("/bin/sleep", ["0.3"]);
};

export function installLaunchAgent(
  m: Paths, execCmd: ExecCmd = defaultExec, extraPathDirs: string[] = [], sleep: SleepFn = defaultSleep,
): void {
  const cliScript = fileURLToPath(new URL("../dist/index.js", import.meta.url));
  const plistFile = launchAgentFile(m);
  mkdirSync(dirname(plistFile), { recursive: true });
  writeFileSync(plistFile, plistContent(process.execPath, cliScript, m, extraPathDirs));
  try {
    execCmd(["launchctl", "bootout", `gui/${uid()}/${LAUNCH_LABEL}`]);
  } catch {
    /* not loaded */
  }
  // Bootout of a running (KeepAlive) listener returns before launchd
  // finishes tearing it down, and a bootstrap issued during teardown fails
  // with "Input/output error" — retry briefly to ride it out.
  const BOOTSTRAP_ATTEMPTS = 5;
  for (let attempt = 1; ; attempt++) {
    try {
      execCmd(["launchctl", "bootstrap", `gui/${uid()}`, plistFile]);
      return;
    } catch (e) {
      if (attempt >= BOOTSTRAP_ATTEMPTS) throw e;
      sleep();
    }
  }
}

export function uninstallLaunchAgent(m: Paths, execCmd: ExecCmd = defaultExec): void {
  try {
    execCmd(["launchctl", "bootout", `gui/${uid()}/${LAUNCH_LABEL}`]);
  } catch {
    /* not loaded */
  }
  const plistFile = launchAgentFile(m);
  if (existsSync(plistFile)) rmSync(plistFile);
}
