import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Paths } from "./paths.js";

export const SYSTEMD_UNIT = "agentcall-listener.service";
export type ServiceExec = (command: string[]) => void;

const BASE_PATH_DIRS = ["/usr/local/bin", "/usr/bin", "/bin"];

const defaultExec: ServiceExec = (command) => {
  execFileSync(command[0]!, command.slice(1), { stdio: "ignore" });
};

function assertUnitValue(value: string): void {
  if (/\u0000|\r|\n/.test(value)) {
    throw new Error("Cannot create systemd unit: paths must not contain NUL or newlines");
  }
}

function quoteUnitWord(value: string): string {
  assertUnitValue(value);
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("%", "%%")}"`;
}

function environmentValue(name: string, value: string): string {
  return quoteUnitWord(`${name}=${value}`);
}

function outputPath(value: string): string {
  assertUnitValue(value);
  return value
    .replaceAll("%", "%%")
    .replaceAll("\\", "\\\\")
    .replaceAll(" ", "\\x20")
    .replaceAll("\t", "\\x09");
}

export function systemdServiceFile(machine: Paths): string {
  return join(machine.userHome, ".config", "systemd", "user", SYSTEMD_UNIT);
}

function systemdUnitContent(
  nodeBin: string,
  cliScript: string,
  machine: Paths,
  extraPathDirs: string[] = [],
): string {
  const pathDirs = [...new Set([...extraPathDirs, dirname(nodeBin), ...BASE_PATH_DIRS])];
  return `[Unit]
Description=AgentCall listener
Wants=network-online.target
After=network-online.target

[Service]
Type=simple
ExecStart=${quoteUnitWord(nodeBin)} ${quoteUnitWord(cliScript)} listen
Restart=always
RestartSec=2
Environment=${environmentValue("HOME", machine.userHome)}
Environment=${environmentValue("PATH", pathDirs.join(":"))}
StandardOutput=append:${outputPath(machine.listenerLog)}
StandardError=append:${outputPath(machine.listenerLog)}

[Install]
WantedBy=default.target
`;
}

export function isSystemdServiceInstalled(machine: Paths): boolean {
  return existsSync(systemdServiceFile(machine));
}

export function installSystemdService(
  machine: Paths,
  exec: ServiceExec = defaultExec,
  extraPathDirs: string[] = [],
): void {
  const cliScript = fileURLToPath(new URL("../dist/index.js", import.meta.url));
  const unitFile = systemdServiceFile(machine);
  mkdirSync(dirname(unitFile), { recursive: true });
  writeFileSync(unitFile, systemdUnitContent(process.execPath, cliScript, machine, extraPathDirs), { mode: 0o600 });
  // writeFileSync's mode is ignored when the file already exists. Repair a
  // permissive unit from an older/manual install instead of preserving it.
  chmodSync(unitFile, 0o600);
  exec(["systemctl", "--user", "daemon-reload"]);
  exec(["systemctl", "--user", "enable", SYSTEMD_UNIT]);
  exec(["systemctl", "--user", "restart", SYSTEMD_UNIT]);
}

export function uninstallSystemdService(
  machine: Paths,
  exec: ServiceExec = defaultExec,
): void {
  try {
    exec(["systemctl", "--user", "disable", "--now", SYSTEMD_UNIT]);
  } catch {
    /* not installed or not running */
  }
  const unitFile = systemdServiceFile(machine);
  if (existsSync(unitFile)) rmSync(unitFile);
  exec(["systemctl", "--user", "daemon-reload"]);
  try {
    exec(["systemctl", "--user", "reset-failed", SYSTEMD_UNIT]);
  } catch {
    /* no failed state */
  }
}
