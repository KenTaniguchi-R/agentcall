#!/usr/bin/env node
// #373 — measure over-tainting for the sensitivity/clearance model (#372).
//
// Spawns a real read-only agent per question, records every path it touches
// via probe-hook.mjs, classifies those paths against labels.json, and tallies
// against the decision rule pre-committed in the issue.
//
// Usage:
//   node scripts/spikes/overtaint/run.mjs --repo <abs> --notes <abs> [--only q01,q02]
//
// Output: results.json next to this file, plus a table on stdout.
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ORDER = { public: 0, internal: 1, secret: 2 };
const CLEARANCE = "internal"; // the clearance a coworker would hold

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
}

const REPO = resolve(arg("repo", process.cwd()));
const NOTES = resolve(arg("notes", join(REPO, "docs")));
const ONLY = arg("only", "")?.split(",").filter(Boolean) ?? [];

const labelSpec = JSON.parse(readFileSync(join(HERE, "labels.json"), "utf8"));
const questions = JSON.parse(readFileSync(join(HERE, "questions.json"), "utf8"))
  .filter((q) => ONLY.length === 0 || ONLY.includes(q.id));

const rules = labelSpec.rules.map((r) => ({
  prefix: r.prefix.replace("<REPO>", REPO).replace("<NOTES>", NOTES),
  sensitivity: r.sensitivity,
}));

// First match wins, so labels.json can carve a `secret` subtree out of an
// otherwise `internal` root. A bare startsWith would let `/a/bc` match a `/a/b`
// rule, so boundaries are checked explicitly.
function classify(rawPath) {
  const p = resolve(REPO, rawPath);
  for (const rule of rules) {
    if (p === rule.prefix || p.startsWith(rule.prefix + sep)) return rule.sensitivity;
  }
  return labelSpec.default;
}

const PROMPT_SUFFIX =
  "\n\nAnswer from the files available to you. Be concise — three sentences at most.";

function runOne(question) {
  const log = join(HERE, `.paths-${question.id}.jsonl`);
  rmSync(log, { force: true });
  writeFileSync(log, "");

  const settings = JSON.stringify({
    hooks: {
      PreToolUse: [
        { hooks: [{ type: "command", command: `node ${join(HERE, "probe-hook.mjs")}`, timeout: 10 }] },
      ],
    },
  });

  return new Promise((done) => {
    const started = Date.now();
    execFile(
      "claude",
      [
        "-p", question.text + PROMPT_SUFFIX,
        "--output-format", "json",
        "--permission-mode", "dontAsk",
        "--allowedTools", "Read,Grep,Glob,LS",
        "--settings", settings,
      ],
      { cwd: REPO, env: { ...process.env, SPIKE_PATH_LOG: log }, timeout: 300_000, maxBuffer: 32 * 1024 * 1024 },
      (err, stdout) => {
        const touched = existsSync(log)
          ? readFileSync(log, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l))
          : [];

        const seen = touched.map((t) => ({ ...t, sensitivity: classify(t.path) }));
        const max = seen.reduce(
          (acc, s) => (ORDER[s.sensitivity] > ORDER[acc] ? s.sensitivity : acc),
          "public",
        );

        let answer = "";
        try {
          answer = JSON.parse(stdout).result ?? "";
        } catch {
          answer = stdout.slice(0, 400);
        }

        done({
          id: question.id,
          question: question.text,
          error: err ? String(err.message).slice(0, 200) : null,
          elapsed_s: Math.round((Date.now() - started) / 1000),
          paths_touched: seen.length,
          max_sensitivity: max,
          would_refuse: ORDER[max] > ORDER[CLEARANCE],
          secret_paths: [...new Set(seen.filter((s) => s.sensitivity === "secret").map((s) => s.path))],
          answer: answer.slice(0, 600),
        });
      },
    );
  });
}

const results = [];
for (const q of questions) {
  process.stderr.write(`· ${q.id} …`);
  const r = await runOne(q);
  results.push(r);
  process.stderr.write(` ${r.max_sensitivity}${r.would_refuse ? " REFUSE" : ""} (${r.elapsed_s}s)\n`);
}

mkdirSync(HERE, { recursive: true });
writeFileSync(join(HERE, "results.json"), JSON.stringify({ repo: REPO, notes: NOTES, clearance: CLEARANCE, results }, null, 2));

const refused = results.filter((r) => r.would_refuse);
console.log("\n id   | paths | max        | refused | secret paths touched");
console.log("------|-------|------------|---------|---------------------");
for (const r of results) {
  console.log(
    ` ${r.id} | ${String(r.paths_touched).padStart(5)} | ${r.max_sensitivity.padEnd(10)} | ${r.would_refuse ? "  YES  " : "   no  "} | ${r.secret_paths.slice(0, 2).join(", ").slice(0, 60)}`,
  );
}
console.log(`\n${refused.length}/${results.length} would be refused at "${CLEARANCE}" clearance.`);
console.log("Decision rule (#373): <=2 proceed · 3-5 per-source scoping required · >=6 design does not survive.");
console.log("NOTE: `refused` is the raw count. Each still needs the by-eye call on whether the");
console.log("      secret read was genuinely needed (correct) or wandering (incorrect).");
