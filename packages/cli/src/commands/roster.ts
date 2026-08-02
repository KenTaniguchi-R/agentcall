import { ask } from "../tty.js";
import { getPaths, type Paths } from "../paths.js";
import { loadConfig, relayUrl } from "../config.js";
import { createRoster, joinRoster } from "../api.js";
import { forgetMembership, loadMemberships, saveMembership } from "../rosters.js";

// One injected I/O surface for every command. Injected rather than calling
// console directly because vitest runs files in parallel and a process-wide
// console spy is shared mutable state between suites.
export type Io = {
  log(s: string): void;
  error(s: string): void;
  ask(q: string): Promise<string>;
};
export type Deps = { paths: Paths; io: Io };

export function realDeps(): Deps {
  return {
    paths: getPaths(),
    io: { log: (s) => console.log(s), error: (s) => console.error(s), ask },
  };
}

export async function rosterCreate(d: Deps, o: { as: string }): Promise<void> {
  const cfg = loadConfig(d.paths);
  const { roster_id, secret } = await createRoster(relayUrl(cfg), { handle: cfg.handle, token: cfg.token });
  saveMembership(d.paths, { name: o.as, relay: relayUrl(cfg), roster_id });
  d.io.log(`Roster created and saved locally as "${o.as}".\n`);
  d.io.log(`  id:     ${roster_id}`);
  d.io.log(`  secret: ${secret}\n`);
  // Printed once and never stored: the relay keeps only a SHA-256 digest.
  d.io.log("The secret is shown once and is not recoverable. Share both with colleagues:");
  d.io.log(`  agentcall roster join ${roster_id} --secret ${secret} --as ${o.as}`);
}

export async function rosterJoin(d: Deps, rosterId: string, o: { secret: string; as: string }): Promise<void> {
  const cfg = loadConfig(d.paths);
  await joinRoster(relayUrl(cfg), { handle: cfg.handle, token: cfg.token }, rosterId, o.secret);
  // The secret is spent here and never written to disk: from now on the
  // handle token plus the relay-side membership row is what authorizes.
  saveMembership(d.paths, { name: o.as, relay: relayUrl(cfg), roster_id: rosterId });
  d.io.log(`Joined. Saved locally as "${o.as}".`);
  d.io.log(`Try: agentcall search "<what you need to know>"`);
}

export function rosterList(d: Deps): void {
  const rosters = loadMemberships(d.paths);
  if (rosters.length === 0) {
    d.io.log("No rosters joined. Ask a colleague for a roster id and secret, then:\n  agentcall roster join <id> --secret <secret> --as <name>");
    return;
  }
  for (const r of rosters) d.io.log(`${r.name}\t${r.roster_id}\t${r.relay}`);
}

export function rosterForget(d: Deps, name: string): void {
  forgetMembership(d.paths, name);
  d.io.log(`Forgot "${name}" locally. Your membership on the relay is unchanged — there is no leave operation.`);
}
