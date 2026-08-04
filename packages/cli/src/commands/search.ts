import type { Command } from "commander";
import { addressHost, relayUrl } from "../config.js";
import { loadMemberships } from "../rosters.js";
import { refreshRoster } from "../searchRefresh.js";
import { allRostersFailed, DEFAULT_SEARCH_LIMIT, rank, renderResults, sanitize, toEntries, type RosterStatus, type SearchEntry } from "../search.js";
import type { LineContext } from "../lineContext.js";

type LineResolver = (line: string | undefined) => LineContext | undefined;

export function register(program: Command, lineFor: LineResolver): void {
  program
    .command("search")
    .description("find which colleague's agent can answer something")
    .argument("<question...>", "what you need to know")
    .option("--roster <name>", "search only this roster (default: all joined rosters)")
    .option("--limit <n>", "maximum results", (v) => Number.parseInt(v, 10), DEFAULT_SEARCH_LIMIT)
    .option("--json", "machine-readable output for your own agent")
    .option("--offline", "never refresh; use whatever is cached")
    .option("--line <name>", "line to search as (defaults to the primary line)")
    .action(async (questionParts: string[], o: { roster?: string; limit: number; json?: boolean; offline?: boolean; line?: string }) => {
      const ctx = lineFor(o.line);
      if (!ctx) return;
      const cfg = ctx.config;
      const relay = relayUrl(cfg);
      const identity = { relay, caller: cfg.handle };
      const memberships = loadMemberships(ctx.paths)
        .filter((m) => m.relay === relay)
        .filter((m) => !o.roster || m.name.toLowerCase() === o.roster.toLowerCase());

      if (memberships.length === 0) {
        console.error(
          o.roster
            ? `No roster named "${o.roster}" on ${relay} — run \`agentcall roster list\`.`
            : `No rosters joined on ${relay}. Ask a colleague for a roster id and join key, then:\n  agentcall roster join <id> --key <key> --as <name>`,
        );
        process.exitCode = 1;
        return;
      }

      const host = addressHost(cfg);
      const entries: SearchEntry[] = [];
      const statuses: RosterStatus[] = [];
      for (const m of memberships) {
        try {
          const out = await refreshRoster(ctx.paths, m.name, m.roster_id, identity, { org: cfg.org, handle: cfg.handle, token: cfg.token }, { offline: o.offline });
          entries.push(...toEntries(m.name, host, out.entries));
          statuses.push({ name: m.name, ageSeconds: out.ageSeconds, stale: out.stale });
        } catch (e) {
          console.error(`${m.name}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      if (allRostersFailed(memberships.length, statuses.length)) process.exitCode = 1;

      const results = rank(questionParts.join(" "), entries, o.limit);
      if (o.json) {
        console.log(JSON.stringify({
          query: questionParts.join(" "),
          rosters: statuses.map((s) => ({ name: s.name, cache_age_seconds: s.ageSeconds, stale: s.stale })),
          results: results.map((r) => ({
            roster: r.roster, address: r.address, handle: r.handle, task: r.task,
            name: sanitize(r.name, 100), description: sanitize(r.description, 1000),
            score: r.score, matched: r.matched,
          })),
        }));
        return;
      }
      console.log(renderResults(results, statuses));
    });
}
