import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

import * as protocol from "../packages/shared/dist/protocol.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const spec = readFileSync(join(root, "docs/spec/v1.md"), "utf8");

// A specification that has drifted is worse than none, because it reports a
// guarantee the code stopped making. The schema already pins frame shape, so
// what needs a mechanical check is the one thing prose owns alone: the table of
// enforced ceilings.

// Field-shape bounds. These are enforced by the zod schemas, which this
// document defers to for shape, so restating them in the limits table would
// duplicate a check that already fails closer to the value.
const SHAPE_BOUNDS = new Set([
  "MAX_DETAIL_LENGTH",
  "MAX_OFFERED_TASKS",
  "MAX_TASK_ID_LENGTH",
]);

// Bounds a callee applies to its own on-disk store. Never observable to a
// caller, so it is not part of the wire contract.
const LOCAL_BOUNDS = new Set(["MAX_CONTEXTS"]);

function numericConstants() {
  return Object.entries(protocol)
    .filter(([, value]) => typeof value === "number")
    .map(([name]) => name);
}

function tabulatedConstants() {
  const table = spec.match(/\n## Limits\n[\s\S]+?\n\n(?=[A-Za-z`])/);
  assert.ok(table, "the spec must keep a Limits section");
  return new Set([...table[0].matchAll(/\| `([A-Z][A-Z0-9_]*)` \|/g)].map((match) => match[1]));
}

test("every enforced ceiling the protocol defines appears in the spec's limits table", () => {
  const tabulated = tabulatedConstants();
  const missing = numericConstants().filter(
    (name) => !tabulated.has(name) && !SHAPE_BOUNDS.has(name) && !LOCAL_BOUNDS.has(name),
  );

  assert.deepEqual(
    missing,
    [],
    "add these to docs/spec/v1.md, or classify them in this test with a reason",
  );
});

test("the spec's limits table names no constant the protocol has dropped", () => {
  const defined = new Set(numericConstants());
  const phantom = [...tabulatedConstants()].filter((name) => !defined.has(name));

  assert.deepEqual(phantom, [], "docs/spec/v1.md promises limits that no longer exist");
});

// The generated protocol page takes its frame list from a hand-maintained array
// in the generator, so a frame added to a union reaches the wire without
// reaching the docs. That is not hypothetical: `call_queued` shipped in
// E2EERelayToCallerFrame and was missing from the page until this check existed.
test("the generated protocol reference documents every frame in the unions", async () => {
  const e2ee = await import("../packages/shared/dist/e2ee.js");
  const page = readFileSync(join(root, "docs/site/reference/protocol.mdx"), "utf8");
  const documented = new Set([...page.matchAll(/^### `([a-z_]+)`$/gm)].map((match) => match[1]));

  const wireFrames = new Set(
    ["E2EERelayToCallerFrame", "E2EEListenerToRelayFrame", "E2EERelayToListenerFrame"]
      .flatMap((name) => e2ee[name].options ?? e2ee[name].def?.options ?? [])
      // A preprocess-wrapped member hides its discriminator; those frames are
      // covered by the caller-to-relay group and checked by the pair below.
      .map((option) => option.shape?.type?.value ?? option.def?.shape?.type?.value)
      .filter(Boolean),
  );

  assert.deepEqual([...wireFrames].filter((frame) => !documented.has(frame)), []);
});

test("the spec and the generated reference describe the same frames", () => {
  const page = readFileSync(join(root, "docs/site/reference/protocol.mdx"), "utf8");
  const documented = [...page.matchAll(/^### `([a-z_]+)`$/gm)].map((match) => match[1]);

  const undescribed = [...new Set(documented)].filter((frame) => !spec.includes(`\`${frame}\``));
  assert.deepEqual(undescribed, [], "docs/spec/v1.md omits a frame the wire carries");
});

test("the spec states which implementation is not normative", () => {
  // The whole point of splitting the document from apps/relay is that a
  // self-hoster conforms to the contract rather than to our deployment. If that
  // sentence goes, the split has quietly stopped meaning anything.
  assert.match(spec, /`apps\/relay` is \*\*not\*\* normative/);
});

test("the spec uses RFC 2119 language and says so", () => {
  assert.match(spec, /RFC 2119/);
  assert.ok(
    (spec.match(/\bMUST NOT\b/g) ?? []).length >= 5,
    "a normative document should carry real prohibitions, not only permissions",
  );
});
