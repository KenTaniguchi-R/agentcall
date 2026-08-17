#!/usr/bin/env node
// `wrangler dev` for the relay, against a config derived from wrangler.jsonc
// with the `routes` entry removed.
//
// Why this exists (#413): wrangler dev simulates the configured route by
// rewriting the request URL to it. Measured against wrangler 4.118.0 — a request
// sent to 127.0.0.1:8799, and another sent with `Host: relay.acme.example`, both
// arrived at the Worker as `http://agent-call.app/...`. index.ts derives the
// relay's identity from that URL and stamps it into X-Verified-Relay-Origin;
// do.ts then rejects any caller frame whose envelope disagrees. The client
// computes its side honestly from the address it dialled, so the two can never
// agree locally and every call fails `protocol_error` on its first frame —
// before the listener spawns, before the guard runs, before any reply. Local
// end-to-end testing is impossible.
//
// Deployed relays are unaffected: Cloudflare does not rewrite the URL, so the
// Worker sees the host the client actually reached and the two agree by
// construction. This is a development-only defect with a development-only fix.
//
// Why derived rather than a second checked-in config: there would be two
// descriptions of one deployment, and the one nobody deploys would rot. A named
// environment (`"env": { "dev": { "routes": [] } }`) clears routes in one file
// but wrangler does not inherit vars, durable_objects, d1_databases,
// analytics_engine_datasets or ratelimits into it — measured, the Worker started
// with ASSETS as its only binding. So: transform the real config, per run.

import { readFileSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// The entry as it is actually written, on one line. Deliberately strict: a
// transform that is not certain what it removed must not produce a config at
// all, because the failure it would cause — a dev server that silently still
// rewrites the URL — is #413 itself, and it presents as an unexplained
// `protocol_error` rather than as a configuration problem.
// The trailing \n is part of the match so the line goes away entirely rather
// than leaving a blank one behind.
const ROUTES_LINE = /^[ \t]*"routes"[ \t]*:[ \t]*\[.*\],?[ \t]*\n/m;

export function stripRoutes(source) {
  if (!ROUTES_LINE.test(source)) {
    throw new Error(
      'Could not find a single-line "routes" entry in apps/relay/wrangler.jsonc.\n' +
      "Refusing to derive a dev config: a wrangler dev server that still carries a\n" +
      "route rewrites every request URL to it, and every local call then fails with\n" +
      '"protocol_error" on its first frame (#413).\n' +
      "If the entry was reformatted, update ROUTES_LINE in scripts/relay-dev.mjs.",
    );
  }
  return source.replace(ROUTES_LINE, "").replace(/\n{3,}/g, "\n\n");
}

// Kept out of the module's import-time work so the test can import stripRoutes
// without spawning a dev server.
function main() {
  const relayDir = join(dirname(fileURLToPath(import.meta.url)), "..", "apps/relay");
  const source = join(relayDir, "wrangler.jsonc");
  // Must sit beside the real config: wrangler resolves `main`, the assets
  // directory and `migrations_dir` relative to the config file it was given.
  const derived = join(relayDir, "wrangler.dev.generated.jsonc");

  writeFileSync(derived, [
    "// GENERATED — do not edit, do not commit. Written by scripts/relay-dev.mjs",
    "// from wrangler.jsonc with the `routes` entry removed. See #413.",
    stripRoutes(readFileSync(source, "utf8")),
  ].join("\n"));

  const child = spawn(
    "wrangler",
    ["dev", "--config", derived, ...process.argv.slice(2)],
    { cwd: relayDir, stdio: "inherit", shell: false },
  );
  child.on("exit", (code, signal) => process.exit(signal ? 1 : code ?? 0));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
