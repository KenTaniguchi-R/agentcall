import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

import { createProgram } from "../packages/cli/dist/index.js";
import {
  AGENT_TIMEOUT_MS,
  MAILBOX_TTL_MS,
  MAX_MESSAGE_BYTES,
  MAX_REPLY_BYTES,
  RATE_LIMIT_PER_HOUR,
  RELAY_CALL_TIMEOUT_MS,
} from "../packages/shared/dist/protocol.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// llms.txt and SKILL.md are read by agents, not people. A stale instruction
// there is not a typo the reader forgives — it is an agent confidently running
// a command that does not exist, or waiting on a limit that moved.
const AGENT_FACING = ["llms.txt", "SKILL.md"];

function read(file) {
  return readFileSync(join(root, file), "utf8");
}

function commandPaths(command, parents = []) {
  return command.commands.flatMap((child) => {
    const path = [...parents, child.name()];
    return [path.join(" "), ...commandPaths(child, path)];
  });
}

// Top-level commands that own subcommands. A second word after one of these is
// a subcommand and must resolve; a second word after `call` or `doctor` is an
// argument or prose and must not be checked.
function parentsWithChildren(command) {
  return new Set(
    command.commands.filter((child) => child.commands.length > 0).map((child) => child.name()),
  );
}

for (const file of AGENT_FACING) {
  test(`${file} invokes only commands the CLI actually has`, () => {
    const program = createProgram();
    const real = new Set(commandPaths(program));
    const grouped = parentsWithChildren(program);

    // A second word is only read as a subcommand when the first owns children,
    // so `agentcall contacts add` is checked as a pair while `agentcall call
    // <address>` is checked as `call` alone. Flags and placeholders are
    // excluded by requiring the second word to start with a letter.
    const invoked = [...read(file).matchAll(/\bagentcall ([a-z][a-z-]*)(?: ([a-z][a-z-]*))?/g)]
      .map(([, head, tail]) => (tail && grouped.has(head) ? `${head} ${tail}` : head));

    const unknown = [...new Set(invoked)].filter((path) => !real.has(path));
    assert.deepEqual(unknown, [], `${file} names commands that do not exist`);
  });

  test(`${file} states the limits the protocol actually enforces`, () => {
    // Collapse wrapping first: these are prose claims, and a sentence that
    // happens to break between the number and its unit is still the claim.
    const text = read(file).replace(/\s+/g, " ");
    // Each claim is written the way a reader meets it, and derived from the
    // constant rather than repeated, so moving the constant fails the gate
    // instead of silently making the document lie.
    const claims = [
      [`${RATE_LIMIT_PER_HOUR} calls per hour`, /(\d+) calls per hour/],
      [`${MAX_MESSAGE_BYTES / 1000} KB`, /messages? (?:cap(?:s)? at|is capped at) (\d+) KB/i],
      [`${MAX_REPLY_BYTES / 1000} KB`, /repl(?:y|ies) (?:cap(?:s)? at|at|is capped at) (\d+) KB/i],
      [`${MAILBOX_TTL_MS / 3_600_000} hours`, /up to (\d+) hours/],
      [`${AGENT_TIMEOUT_MS / 60_000} minutes`, /agent (?:times out|timeout is) (?:at )?(\d+) minutes?/],
      [`${RELAY_CALL_TIMEOUT_MS / 60_000}`, /relay (?:gives up at|timeout is) (\d+)/],
    ];

    for (const [expected, pattern] of claims) {
      const match = text.match(pattern);
      assert.ok(match, `${file} never states: ${expected}`);
      assert.equal(
        Number(match[1]),
        Number(expected.match(/\d+/)[0]),
        `${file} claims ${match[0]} but the protocol says ${expected}`,
      );
    }
  });

  test(`${file} does not promise cross-organization reach`, () => {
    // The federation non-goal is the one boundary an agent must never talk
    // itself past, so the document has to say so rather than merely not
    // contradict it.
    assert.match(
      read(file),
      /cross-organization|organization-scoped/i,
      `${file} must state the organization boundary`,
    );
  });
}

test("the plugin ships the same skill the repository root documents", () => {
  // A plugin loads skills from skills/<name>/SKILL.md, so the file has to exist
  // twice. Two copies drift, and the copy that drifts is the one nobody reads
  // during review — so the gate compares them rather than trusting discipline.
  assert.equal(
    read("skills/agentcall/SKILL.md"),
    read("SKILL.md"),
    "skills/agentcall/SKILL.md has drifted from SKILL.md — copy it across",
  );
});

test("the plugin manifests declare the version the CLI actually ships", () => {
  const cli = JSON.parse(read("packages/cli/package.json")).version;
  const plugin = JSON.parse(read(".claude-plugin/plugin.json"));
  const marketplace = JSON.parse(read(".claude-plugin/marketplace.json"));

  assert.equal(plugin.version, cli, ".claude-plugin/plugin.json version is stale");
  assert.equal(marketplace.metadata.version, cli, "marketplace metadata version is stale");
  assert.equal(marketplace.plugins[0].version, cli, "marketplace plugin version is stale");
  // A marketplace entry whose source does not resolve installs nothing.
  assert.equal(marketplace.plugins[0].source, "./");
  assert.equal(marketplace.plugins[0].name, plugin.name);
});

test("SKILL.md tells an agent what to do when the CLI is absent", () => {
  // Installing the plugin delivers instructions, not the binary. Without this
  // the skill's first act is to run a command that does not exist.
  const text = read("SKILL.md");
  assert.match(text, /command -v agentcall/);
  assert.match(text, /npm i -g @benree\/agentcall/);
});

test("SKILL.md carries the frontmatter a skill loader needs", () => {
  const text = read("SKILL.md");
  const frontmatter = text.match(/^---\n([\s\S]+?)\n---\n/);
  assert.ok(frontmatter, "SKILL.md must open with YAML frontmatter");
  assert.match(frontmatter[1], /^name: agentcall$/m);
  assert.match(frontmatter[1], /^description: \S/m);
});
