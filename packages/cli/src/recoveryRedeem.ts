import { loadConfig, normalizeRelay, relayUrl, saveConfig, type Config } from "./config.js";
import { redeemRecoveryCode, ApiError } from "./api.js";
import { printRecoveryCode } from "./recoveryPrint.js";
import type { Paths } from "./paths.js";

export interface RecoveryRedeemOpts {
  code: string;
  handle: string;
  relay?: string;
  // Explicit opt-in to overwrite a config that belongs to a DIFFERENT
  // handle. Without it, redeem refuses rather than silently destroying a
  // foreign, potentially still-callable install (see setup.ts's identical
  // guard for the caller-only-vs-callable case this mirrors).
  force?: boolean;
}

export interface RecoveryRedeemDeps {
  paths: Paths;
  log?: (line: string) => void;
  error?: (line: string) => void;
  // Test seams — production callers should leave these as the defaults.
  redeemFn?: typeof redeemRecoveryCode;
  loadConfigFn?: typeof loadConfig;
  saveConfigFn?: typeof saveConfig;
  writeRecovery?: (s: string) => void;
}

// Rebuilds ~/.agentcall/config.json from a recovery code. Shared by
// `recovery redeem`'s CLI action and its tests (index.ts itself isn't
// imported by tests — this is the same "extract the testable logic" split
// setup.ts uses for `runSetup`).
export async function runRecoveryRedeem(opts: RecoveryRedeemOpts, deps: RecoveryRedeemDeps): Promise<{ ok: boolean }> {
  const log = deps.log ?? console.log;
  const error = deps.error ?? console.error;
  const loadConfigFn = deps.loadConfigFn ?? loadConfig;
  const saveConfigFn = deps.saveConfigFn ?? saveConfig;
  const redeemFn = deps.redeemFn ?? redeemRecoveryCode;

  // Deliberately does not fail when there is no config to load: the whole
  // point of recovery is that there may be none (lost/deleted config.json).
  // But if one DOES exist, it needs to be inspected before overwriting it —
  // see the refusal below.
  let existingCfg: Config | undefined;
  try {
    existingCfg = loadConfigFn(deps.paths);
  } catch {
    existingCfg = undefined;
  }

  const relay = normalizeRelay(opts.relay ?? relayUrl());

  // A config for a DIFFERENT handle is a live, possibly-callable install on
  // this machine (see setup.ts's decideCallable/reuse guard for the same
  // class of problem). Clobbering it here would kill that handle's token —
  // unrecoverable unless its own recovery code was saved — and, if it has
  // agent_kind set, leave its LaunchAgent crash-looping against a config
  // assertCallableConfig now rejects.
  if (existingCfg && existingCfg.handle !== opts.handle && !opts.force) {
    error(
      `This machine's config.json is currently set up for "${existingCfg.handle}", not "${opts.handle}". ` +
        `Redeeming would overwrite it: "${existingCfg.handle}"'s token would stop working immediately, its ` +
        `background listener (if installed) would crash-loop and go silently offline, and "${existingCfg.handle}" ` +
        `would be unrecoverable on this machine unless you still hold its own recovery code.\n` +
        `Re-run with --force if you are sure you want to replace it.`,
    );
    return { ok: false };
  }

  try {
    const out = await redeemFn(relay, opts.handle, opts.code);
    const sameHandle = existingCfg !== undefined && existingCfg.handle === opts.handle;

    let next: Config;
    if (sameHandle && existingCfg) {
      // Normal re-key: same identity, just a fresh credential. Preserve the
      // local agent setup — dropping agent_kind here is exactly what used to
      // break the listener (assertCallableConfig throws in `agentcall
      // listen`, so launchd crash-loops it).
      next = { ...existingCfg, handle: opts.handle, token: out.token, relay };
    } else {
      // Either no prior config, or a different handle with --force: a
      // different identity is taking over this machine, so nothing carries
      // over silently — start caller-only, same as a fresh `recovery redeem`
      // with no config at all.
      if (existingCfg) {
        log(`Replacing the existing config for "${existingCfg.handle}" with a fresh one for "${opts.handle}".`);
      }
      next = { handle: opts.handle, token: out.token, relay };
    }

    saveConfigFn(deps.paths, next);
    log(`Recovered ${out.address}. Wrote ${deps.paths.configFile}.`);
    // Softened from "your previous token is now dead": that's true of the
    // credential, but auth only happens at WS upgrade (same gap as
    // /v1/token/rotate), so someone already holding an open listener socket
    // keeps receiving calls on it after this — the message must not imply
    // otherwise.
    log(
      "Your previous token no longer works for new connections. An already-connected listener holding that " +
        "token keeps its existing, open session until it disconnects on its own.",
    );
    if (next.agent_kind) {
      // Deliberately does not touch the LaunchAgent here: restarting it was
      // tried and reverted (see git history) — it ran before this point and
      // could throw (e.g. `launchctl bootstrap` failing over SSH with no Aqua
      // session), which meant the token was already saved and the old
      // recovery code already burned on the relay, but the new recovery code
      // below was never printed. Nothing below this comment may throw.
      log("Restart `agentcall listen` (or your background listener) to pick up the new token.");
    } else {
      log("Re-run `agentcall setup` to make this install callable again.");
    }
    printRecoveryCode(out.recovery_code, deps.writeRecovery);
    return { ok: true };
  } catch (e) {
    error(e instanceof ApiError ? e.message : String(e));
    return { ok: false };
  }
}
