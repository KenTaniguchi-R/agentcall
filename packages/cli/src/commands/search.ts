import { loadConfig, relayUrl } from "../config.js";
import { loadMemberships } from "../rosters.js";
import { allRostersFailed, rank, renderResults, sanitize, toEntries, type RosterStatus, type SearchEntry } from "../search.js";
import { refreshRoster } from "../searchRefresh.js";
import { ExitOnly, type Deps } from "./roster.js";

export async function search(
  d: Deps,
  questionParts: string[],
  o: { roster?: string; limit: number; json?: boolean; offline?: boolean },
): Promise<void> {
  const cfg = loadConfig(d.paths);
  const relay = relayUrl(cfg);
  const identity = { relay, caller: cfg.handle };
  const memberships = loadMemberships(d.paths)
    .filter((m) => m.relay === relay)
    .filter((m) => !o.roster || m.name.toLowerCase() === o.roster.toLowerCase());

  if (memberships.length === 0) {
    throw new Error(
      o.roster
        ? `No roster named "${o.roster}" on ${relay} — run \`agentcall roster list\`.`
        : `No rosters joined on ${relay}. Ask a colleague for a roster id and secret, then:\n  agentcall roster join <id> --secret <secret> --as <name>`,
    );
  }

  const host = new URL(relay).host;
  const entries: SearchEntry[] = [];
  const statuses: RosterStatus[] = [];
  for (const m of memberships) {
    try {
      // Each roster degrades on its own: one unreachable roster must not
      // take down a search across the others.
      const out = await refreshRoster(d.paths, m.name, m.roster_id, identity, { handle: cfg.handle, token: cfg.token }, { offline: o.offline });
      entries.push(...toEntries(m.name, host, out.entries));
      statuses.push({ name: m.name, ageSeconds: out.ageSeconds, stale: out.stale });
    } catch (e) {
      d.io.error(`${m.name}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // Every roster attempted, every one failed: not a genuine no-results
  // run, so a script or calling agent gating on exit code must be able to
  // tell the difference. Partial failure stays exit 0 — see allRostersFailed.
  const failed = allRostersFailed(memberships.length, statuses.length);

  const results = rank(questionParts.join(" "), entries, o.limit);
  if (o.json) {
    d.io.log(JSON.stringify({
      query: questionParts.join(" "),
      rosters: statuses.map((s) => ({ name: s.name, cache_age_seconds: s.ageSeconds, stale: s.stale })),
      results: results.map((r) => ({
        roster: r.roster, address: r.address, handle: r.handle, task: r.task,
        name: sanitize(r.name, 100), description: sanitize(r.description, 1000),
        score: r.score, matched: r.matched,
      })),
    }));
  } else {
    d.io.log(renderResults(results, statuses));
  }

  if (failed) {
    // ExitOnly: per-roster errors already printed above; a summary line
    // here would be new, undeclared output that didn't exist pre-refactor.
    throw new ExitOnly();
  }
}
