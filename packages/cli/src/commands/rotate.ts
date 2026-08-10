import { authOf, rotateToken } from "../api.js";
import {
  loadConfig, loadInstallation, relayUrl, saveConfig, type Installation,
} from "../config.js";
import { listenerServiceRestartCommand } from "../listener-service.js";
import { withFileLock } from "../file-lock.js";
import { getPaths } from "../paths.js";
import { fail } from "../errors.js";

export function register(program: { command(name: string): any }): void {
  program.command("rotate").description("replace this installation's relay token (use if it may have leaked)")
    .action(async () => {
      try { await rotateCredential(loadInstallation(getPaths())); }
      catch (error) { fail(error); }
    });
}

interface RotateDeps {
  rotate?: typeof rotateToken;
  log?: (line: string) => void;
  platform?: NodeJS.Platform;
}

export async function rotateCredential(installation: Installation, deps: RotateDeps = {}): Promise<void> {
  return withFileLock(installation.paths.configFile, "installation credential", () =>
    rotateLocked(installation, deps));
}

async function rotateLocked(installation: Installation, deps: RotateDeps): Promise<void> {
  const current = loadConfig(installation.paths);
  const log = deps.log ?? console.log;
  const { token } = await (deps.rotate ?? rotateToken)(relayUrl(current), authOf(current));
  saveConfig(installation.paths, { ...current, token });
  const restartCommand = listenerServiceRestartCommand(deps.platform);
  const backgroundGuidance = restartCommand ? `, or the background one with \`${restartCommand}\`` : "";
  const listenerGuidance = current.agent_kind
    ? `, but the listener will use it only after reconnecting. Restart now with \`agentcall listen\`${backgroundGuidance}.`
    : ".";
  log(`Token rotated for ${current.handle}. The old token is invalid for new connections immediately${listenerGuidance}`);
}
