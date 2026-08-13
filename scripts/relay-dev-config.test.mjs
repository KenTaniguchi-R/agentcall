import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { stripRoutes } from "./relay-dev.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const hostedConfig = join(repoRoot, "apps/relay/wrangler.jsonc");

test("removes the routes entry so wrangler dev cannot rewrite the request URL", () => {
  const source = readFileSync(hostedConfig, "utf8");
  const stripped = stripRoutes(source);

  // The whole point: with no route to simulate, `wrangler dev` leaves the
  // request URL alone, so `new URL(c.req.url).hostname` in index.ts reports the
  // host the client actually dialled and the caller's envelope can match it.
  assert.doesNotMatch(stripped, /custom_domain/);
  assert.doesNotMatch(stripped, /"routes"/);
});

test("keeps every binding, because a named environment would have dropped them", () => {
  // `"env": { "dev": { "routes": [] } }` clears routes in one file, but wrangler
  // does not inherit vars, durable_objects, d1_databases, analytics_engine_datasets
  // or ratelimits into a named environment — measured against wrangler 4.118.0,
  // which started with ASSETS as its only binding. Deriving the config instead
  // keeps all of them, and this asserts it.
  const stripped = stripRoutes(readFileSync(hostedConfig, "utf8"));
  for (const key of [
    "d1_databases", "durable_objects", "analytics_engine_datasets",
    "ratelimits", "vars", "assets", "triggers",
  ]) {
    assert.match(stripped, new RegExp(`"${key}"`), `${key} must survive`);
  }
});

test("changes nothing except the routes entry", () => {
  const source = readFileSync(hostedConfig, "utf8");
  const removed = source.split("\n").length - stripRoutes(source).split("\n").length;
  // One line for the entry itself. Comments above it are kept: they explain the
  // hosted deployment, and this file is derived per run, never reviewed.
  assert.equal(removed, 1);
});

test("fails loudly when the routes entry is not where it expects", () => {
  // The derived config is only safe while the transform is certain of what it
  // removed. A reformat that spreads `routes` over several lines must stop the
  // dev server rather than silently start one that still rewrites the URL —
  // that failure mode is #413 itself, and it cost a cross-machine debugging
  // session to find the first time.
  assert.throws(
    () => stripRoutes(`{\n  "name": "agentcall-relay",\n  "routes": [\n    { "pattern": "agent-call.app", "custom_domain": true }\n  ],\n}\n`),
    /routes/i,
  );
  assert.throws(() => stripRoutes(`{\n  "name": "agentcall-relay"\n}\n`), /routes/i);
});
