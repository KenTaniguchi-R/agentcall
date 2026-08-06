import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

import { createProgram } from "../packages/cli/dist/index.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function navigationPages(value) {
  if (Array.isArray(value)) return value.flatMap(navigationPages);
  if (!value || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([key, child]) =>
    key === "pages" && Array.isArray(child)
      ? child.filter((page) => typeof page === "string")
      : navigationPages(child));
}

function commandPaths(command, parents = []) {
  return command.commands.flatMap((child) => {
    const path = [...parents, child.name()];
    return [path.join(" "), ...commandPaths(child, path)];
  });
}

test("the generated CLI reference includes detailed help for every command", () => {
  const reference = readFileSync(join(root, "docs/site/reference/cli.mdx"), "utf8");
  const published = new Set(
    [...reference.matchAll(/^## (.+)$/gm)].map((match) => match[1]),
  );

  const missing = commandPaths(createProgram()).filter((path) => !published.has(path));
  assert.deepEqual(missing, []);
});

test("navigation publishes every core reader journey", () => {
  const config = JSON.parse(readFileSync(join(root, "docs/site/docs.json"), "utf8"));
  const published = new Set(navigationPages(config.navigation));
  const required = [
    "overview/concepts",
    "overview/how-it-works",
    "overview/limitations",
    "get-started/first-call",
    "get-started/receive-calls",
    "guides/calls-and-conversations",
    "guides/tasks-and-policy",
    "guides/discovery-and-contacts",
    "guides/identity-and-keys",
    "guides/multiple-lines",
    // Renamed from guides/listener-and-workdirs by #372, which deleted the
    // `workdir` setting the old title promised. The reader question is
    // unchanged — "what can my agent see?" — only the answer moved.
    "guides/listener-and-sensitivity",
    "guides/troubleshooting",
    "administration/invites",
    "administration/audit-and-retention",
    "administration/managed-deployment",
    "reference/configuration",
    "reference/a2a",
    "security/visibility-and-privacy",
  ];

  assert.deepEqual(required.filter((page) => !published.has(page)), []);
});
