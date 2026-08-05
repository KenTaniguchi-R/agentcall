import { readyLines } from "./lines.js";
import type { LineContext } from "./line-context.js";
import type { MachinePaths } from "./paths.js";
import { resolvePrimary } from "./person.js";

// Exported so callers that derive a display address from a possibly-invalid
// relay string (e.g. commands/line.ts's listLinesReport) share this exact
// fallback instead of growing a second one that could drift out of step.
export function host(relay: string): string {
  try {
    return new URL(relay).host;
  } catch {
    return relay.replace(/\/+$/, "");
  }
}

// callClient dials ONE relay for both authentication and destination
// (callClient.ts:36), so "one identity outbound" can only mean one identity
// per relay. With every line on the same relay — the common case — this is
// always the primary and the user never sees it.
// Selects by organization, not by relay host. The address used to name a relay
// and this matched against it; an address is a registry key now and names an
// org instead. That is the rule this was always approximating — a line may only
// call inside its own organization, so the relay host was a proxy for the org.
export function pickOutboundLine(
  m: MachinePaths, want: string, opts: { as?: string } = {},
): LineContext {
  const lines = readyLines(m);

  if (opts.as !== undefined && opts.as !== "") {
    const chosen = lines.find((l) => l.name === opts.as);
    if (!chosen) {
      throw new Error(`No line named "${opts.as}". This machine has: ${lines.map((l) => l.name).join(", ") || "none"}.`);
    }
    if (chosen.config.org !== want) {
      throw new Error(
        `Line "${opts.as}" belongs to organization "${chosen.config.org}", but that address is in "${want}". ` +
          `A line can only call within its own organization.`,
      );
    }
    return { machine: m, ...chosen };
  }

  // No lines at all is a different failure from "lines, but none on this
  // relay", and it needs a different answer: telling someone with no install
  // to `line add --relay` presumes an install they do not have. It is also the
  // string the packed-CLI consumer job pins as what an unconfigured install
  // must say (see .github/workflows/ci.yml) — keep the phrase if you reword.
  if (lines.length === 0) {
    throw new Error("No agentcall config found. Run `agentcall setup` first.");
  }
  const candidates = lines.filter((l) => l.config.org === want);
  if (candidates.length === 0) {
    const orgs = [...new Set(lines.map((l) => l.config.org))];
    throw new Error(
      `No line in organization "${want}". This machine has lines in: ${orgs.join(", ") || "no organizations"}. ` +
        `Add one with \`agentcall line add <name> --relay <url>\`.`,
    );
  }
  if (candidates.length === 1) return { machine: m, ...candidates[0]! };

  let primary: string | undefined;
  try {
    primary = resolvePrimary(m, lines.map((l) => l.name));
  } catch {
    primary = undefined;
  }
  const chosen = candidates.find((l) => l.name === primary);
  if (chosen) return { machine: m, ...chosen };

  throw new Error(
    `Several lines can call into "${want}" (${candidates.map((l) => l.name).join(", ")}) and the primary is not among them. ` +
      `Pick one with --as <line>.`,
  );
}
