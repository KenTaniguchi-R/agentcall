import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, createReadStream, createWriteStream, openSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { getPaths, type Paths } from "./paths.js";
import { saveConfig, relayUrl, type Config } from "./config.js";
import { registerHandle } from "./api.js";
import { srtSettings } from "./srt.js";
import { appendSnippet } from "./snippet.js";
import { installLaunchAgent } from "./launchd.js";

// Directories launchd's fixed PATH (see launchd.ts's plistContent) actually
// searches. If claude/codex/npx resolve outside of these, the background
// listener won't find them even though an interactive shell (with nvm/fnm
// on PATH) does.
const LAUNCHD_PATH_DIRS = ["/opt/homebrew/bin", "/usr/local/bin"];

export interface SetupOpts {
  handle?: string;
  agent?: "claude" | "codex";
  yes?: boolean;
  snippet?: boolean;
  relay?: string;
  skipLaunchd?: boolean;
  io?: { ask(question: string): Promise<string> };
  // Test seams — production callers should leave these as the defaults.
  hasBin?: (name: string) => boolean;
  resolveBin?: (name: string) => string | null;
}

function defaultResolveBin(name: string): string | null {
  try {
    const out = execFileSync("which", [name], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    return out || null;
  } catch {
    return null;
  }
}

// Opens /dev/tty directly (rather than process.stdin/stdout) so the prompt
// still works when stdin/stdout are piped, e.g. `agentcall setup | tee log`.
// Falls back to stdin/stdout if /dev/tty isn't available (non-interactive
// environments, some CI runners).
function defaultAsk(question: string): Promise<string> {
  return new Promise((resolve) => {
    let input: NodeJS.ReadableStream = process.stdin;
    let output: NodeJS.WritableStream = process.stdout;
    try {
      const fd = openSync("/dev/tty", "r+");
      input = createReadStream("", { fd });
      output = createWriteStream("", { fd });
    } catch {
      /* no controlling tty; fall back to stdin/stdout */
    }
    const rl = createInterface({ input, output });
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

async function detectAgentKind(
  opts: SetupOpts, hasBin: (name: string) => boolean, ask: (q: string) => Promise<string>,
): Promise<"claude" | "codex"> {
  if (opts.agent) {
    if (opts.agent !== "claude" && opts.agent !== "codex") {
      throw new Error(`--agent must be "claude" or "codex", got "${opts.agent}"`);
    }
    return opts.agent;
  }
  const hasClaude = hasBin("claude");
  const hasCodex = hasBin("codex");
  if (hasClaude && !hasCodex) return "claude";
  if (hasCodex && !hasClaude) return "codex";
  if (hasClaude && hasCodex) {
    if (opts.yes) return "claude";
    const answer = (await ask("Both claude and codex found on PATH. Which should agentcall use? [claude/codex]: "))
      .trim()
      .toLowerCase();
    return answer === "codex" ? "codex" : "claude";
  }
  throw new Error(
    "Neither `claude` nor `codex` was found on PATH. Install one of them, or pass --agent to override detection.",
  );
}

function warnIfOutsideLaunchdPath(name: string, resolveBin: (n: string) => string | null): void {
  const path = resolveBin(name);
  if (!path) return; // already surfaced via detectAgentKind's error, or not required (e.g. npx)
  if (!LAUNCHD_PATH_DIRS.includes(dirname(path))) {
    console.error(
      `Warning: \`${name}\` resolves to ${path}, outside ${LAUNCHD_PATH_DIRS.join(":")}. ` +
        `The background listener (launchd) only searches ${LAUNCHD_PATH_DIRS.join(":")}:/usr/bin:/bin, ` +
        `so \`agentcall listen\` may fail to find \`${name}\` even though this shell can. ` +
        `If calls fail with "command not found", symlink \`${name}\` into ${LAUNCHD_PATH_DIRS[0]}.`,
    );
  }
}

export async function runSetup(opts: SetupOpts): Promise<void> {
  const paths: Paths = getPaths();
  const hasBinFn = opts.hasBin ?? ((name) => (opts.resolveBin ?? defaultResolveBin)(name) !== null);
  const resolveBinFn = opts.resolveBin ?? defaultResolveBin;
  const ask = opts.io?.ask ?? defaultAsk;

  const agentKind = await detectAgentKind(opts, hasBinFn, ask);
  warnIfOutsideLaunchdPath(agentKind, resolveBinFn);
  warnIfOutsideLaunchdPath("npx", resolveBinFn);

  const handle = opts.handle ?? (await ask("Choose a handle (e.g. ken): ")).trim();
  if (!handle) throw new Error("A handle is required.");

  const relay = (opts.relay ?? relayUrl()).replace(/\/+$/, "");

  const { token, address } = await registerHandle(relay, handle, agentKind);
  const cfg: Config = { handle, token, agent_kind: agentKind, relay };
  saveConfig(paths, cfg);

  writeFileSync(paths.srtFile, JSON.stringify(srtSettings(paths), null, 2) + "\n");
  mkdirSync(paths.publicDir, { recursive: true });

  if (!opts.skipLaunchd) installLaunchAgent(paths);

  if (opts.snippet !== false) {
    appendSnippet(join(homedir(), ".claude", "CLAUDE.md"));
    appendSnippet(join(homedir(), ".codex", "AGENTS.md"));
  }

  console.log(
    `\nagentcall is set up.\n` +
      `  Handle:  ${handle}\n` +
      `  Agent:   ${agentKind}\n` +
      `  Relay:   ${relay}\n` +
      `  Address: ${address}\n\n` +
      `Share your address so others can call your agent:\n` +
      `  agentcall call ${address} "hello"\n`,
  );
}
