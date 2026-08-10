import { execFileSync } from "node:child_process";
import {
  installLaunchAgent,
  isLaunchAgentInstalled,
  LAUNCH_LABEL,
  launchAgentFile,
  uninstallLaunchAgent,
} from "./launchd.js";
import type { Paths } from "./paths.js";
import {
  installSystemdService,
  isSystemdServiceInstalled,
  type ServiceExec,
  SYSTEMD_UNIT,
  systemdServiceFile,
  uninstallSystemdService,
} from "./systemd.js";

interface ListenerServiceOptions {
  platform?: NodeJS.Platform;
  execCmd?: ServiceExec;
  extraPathDirs?: string[];
}

export interface ListenerServiceStatus {
  kind: "launchd" | "systemd";
  installed: boolean;
  running: boolean;
}

type QueryService = (command: string[]) => string;

interface ListenerServiceAdapter {
  kind: ListenerServiceStatus["kind"];
  file: (machine: Paths) => string;
  isInstalled: (machine: Paths) => boolean;
  install: (machine: Paths, exec?: ServiceExec, extraPathDirs?: string[]) => void;
  uninstall: (machine: Paths, exec?: ServiceExec) => void;
  restartCommand: string;
  isRunning: (query: QueryService) => boolean;
}

const ADAPTERS: Partial<Record<NodeJS.Platform, ListenerServiceAdapter>> = {
  darwin: {
    kind: "launchd",
    file: launchAgentFile,
    isInstalled: isLaunchAgentInstalled,
    install: installLaunchAgent,
    uninstall: uninstallLaunchAgent,
    restartCommand: `launchctl kickstart -k gui/$UID/${LAUNCH_LABEL}`,
    isRunning: (query) => query(["launchctl", "list"]).includes(LAUNCH_LABEL),
  },
  linux: {
    kind: "systemd",
    file: systemdServiceFile,
    isInstalled: isSystemdServiceInstalled,
    install: installSystemdService,
    uninstall: uninstallSystemdService,
    restartCommand: `systemctl --user restart ${SYSTEMD_UNIT}`,
    isRunning: (query) => query(["systemctl", "--user", "is-active", SYSTEMD_UNIT]).trim() === "active",
  },
};

function platformFrom(options?: ListenerServiceOptions): NodeJS.Platform {
  return options?.platform ?? process.platform;
}

function unsupported(platform: NodeJS.Platform): never {
  throw new Error(
    `Background listener installation is not supported on ${platform}. ` +
      "Run `agentcall listen` under your platform's process supervisor instead.",
  );
}

function adapterFor(platform: NodeJS.Platform): ListenerServiceAdapter {
  return ADAPTERS[platform] ?? unsupported(platform);
}

export function listenerServiceRestartCommand(platform: NodeJS.Platform = process.platform): string | null {
  return ADAPTERS[platform]?.restartCommand ?? null;
}

export function listenerServiceFile(
  machine: Paths,
  platform: NodeJS.Platform = process.platform,
): string {
  return adapterFor(platform).file(machine);
}

export function installListenerService(
  machine: Paths,
  options: ListenerServiceOptions = {},
): void {
  adapterFor(platformFrom(options)).install(machine, options.execCmd, options.extraPathDirs);
}

export function uninstallListenerService(
  machine: Paths,
  options: Omit<ListenerServiceOptions, "extraPathDirs"> = {},
): void {
  adapterFor(platformFrom(options)).uninstall(machine, options.execCmd);
}

export function inspectListenerService(
  machine: Paths,
  options: { platform?: NodeJS.Platform; query?: QueryService } = {},
): ListenerServiceStatus {
  const platform = options.platform ?? process.platform;
  const query = options.query ?? ((command: string[]) => {
    return execFileSync(command[0]!, command.slice(1), {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  });
  const adapter = adapterFor(platform);
  let running = false;
  try {
    running = adapter.isRunning(query);
  } catch {
    running = false;
  }
  return { kind: adapter.kind, installed: adapter.isInstalled(machine), running };
}
