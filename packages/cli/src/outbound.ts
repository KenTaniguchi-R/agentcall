import { readyLines } from "./lines.js";
import type { LineContext } from "./lineContext.js";
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
export function pickOutboundLine(
  m: MachinePaths, destinationRelay: string, opts: { as?: string } = {},
): LineContext {
  const lines = readyLines(m);
  const want = host(destinationRelay);

  if (opts.as !== undefined && opts.as !== "") {
    const chosen = lines.find((l) => l.name === opts.as);
    if (!chosen) {
      throw new Error(`No line named "${opts.as}". This machine has: ${lines.map((l) => l.name).join(", ") || "none"}.`);
    }
    if (host(chosen.config.relay) !== want) {
      throw new Error(
        `Line "${opts.as}" is registered on ${host(chosen.config.relay)}, but that address is on ${want}. ` +
          `A line can only call within its own relay.`,
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
  const candidates = lines.filter((l) => host(l.config.relay) === want);
  if (candidates.length === 0) {
    const relays = [...new Set(lines.map((l) => host(l.config.relay)))];
    throw new Error(
      `No line on ${want}. This machine has lines on: ${relays.join(", ") || "no relays"}. ` +
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
    `Several lines can call ${want} (${candidates.map((l) => l.name).join(", ")}) and the primary is not among them. ` +
      `Pick one with --as <line>.`,
  );
}
