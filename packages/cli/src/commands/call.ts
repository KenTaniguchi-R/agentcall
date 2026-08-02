import { loadConfig, relayUrl } from "../config.js";
import { callAgent, CallError } from "../callClient.js";
import { getStatus } from "../api.js";
import { resolveAddress } from "../contacts.js";
import type { Deps } from "./deps.js";

export async function call(
  d: Deps,
  address: string,
  messageParts: string[],
  o: { json?: boolean; task?: string },
): Promise<void> {
  // Config is loaded before resolution so the address can be checked against
  // the relay this call will actually dial (see resolveAddress).
  const cfg = loadConfig(d.paths);
  const parsed = resolveAddress(d.paths, address, relayUrl(cfg));
  if (!parsed.ok) throw new Error(parsed.error);
  if (parsed.warning) d.io.error(parsed.warning);
  const message = messageParts.join(" ");
  try {
    const reply = await callAgent({
      relay: relayUrl(cfg),
      from: cfg.handle,
      token: cfg.token,
      to: parsed.handle,
      message,
      task: o.task,
      onStatus: (s) => d.io.error(s === "ringing" ? "ringing..." : "answered, agent working..."),
    });
    d.io.log(o.json ? JSON.stringify(reply) : reply.text);
  } catch (e) {
    // CallError distinguishes error kinds for the user (offline, busy, task
    // not offered, ...); only the generic catch-and-set-exitCode is run()'s
    // job, so that part is all that's stripped from here.
    if (e instanceof CallError) throw new Error(`Call failed (${e.code}): ${e.message}`);
    throw e;
  }
}

export async function status(d: Deps, address: string): Promise<void> {
  // Presence is caller-only on the relay, so status now needs credentials —
  // this used to fall back to the default relay with no config at all.
  const cfg = loadConfig(d.paths);
  const cfgRelay = relayUrl(cfg);
  const parsed = resolveAddress(d.paths, address, cfgRelay);
  if (!parsed.ok) throw new Error(parsed.error);
  if (parsed.warning) d.io.error(parsed.warning);
  const { online } = await getStatus(cfgRelay, parsed.handle, { handle: cfg.handle, token: cfg.token });
  d.io.log(online ? "online" : "offline");
  // Three-valued exit code (online/offline/error), not run()'s pass/fail —
  // set directly here rather than through a throw. run() only ever produces
  // 0 or 1, so it cannot express "checked successfully, and it's offline".
  process.exitCode = online ? 0 : 2;
}
