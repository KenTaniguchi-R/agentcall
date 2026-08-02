import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { parse as parseYaml } from "yaml";
import { MAX_KEYWORD_LENGTH, MAX_TASK_KEYWORDS, TASK_ID_RE } from "@benree/agentcall-shared";
import type { Paths } from "./paths.js";

export const CAPS = ["read", "write", "fetch", "exec"] as const;
export type Cap = (typeof CAPS)[number];

// What a caller is granted for one call. `caps` is the whole envelope: it
// maps to claude's --allowedTools and codex's --sandbox level (see
// runner.ts), which is the only place a grant is actually enforced.
//
// This used to also carry `write_paths` and `network`, which existed solely
// to populate the OS sandbox's allowWrite/allowedDomains lists. With the
// sandbox gone they would grant nothing while still reading like a
// restriction on the owner's card, so they're gone too — a decorative
// permission is worse than no permission.
export interface Envelope {
  caps: Cap[];
}

// The default envelope for call sites that predate task scoping (the runner
// default) so nothing changes until a resolved task passes a narrower one.
export const FULL_ACCESS_ENVELOPE: Envelope = {
  caps: ["read", "write", "fetch", "exec"],
};

// A SKILL.md is YAML frontmatter between --- fences, then the skill body.
// Returns null when the file has no leading fence or no closing fence.
export function splitFrontmatter(text: string): { meta: string; body: string } | null {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)([\s\S]*)$/);
  if (!m) return null;
  return { meta: m[1]!, body: m[2] ?? "" };
}

// Frontmatter schema. The task id is NOT here — the directory name is the
// id, so there is no dual source to drift. `description` is the only
// required field: a card entry without one is useless to callers. `name`
// defaults to the id at load time.
export const SkillFrontmatter = z.object({
  name: z.string().min(1).max(100).optional(),
  description: z.string().min(1).max(1000),
  examples: z.array(z.string().max(500)).max(10).default([]),
  // Mirrors CardTask.keywords in packages/shared exactly. The two must not
  // drift: this is the authoring side of the field the search ranker weights
  // highest.
  keywords: z.array(z.string().min(1).max(MAX_KEYWORD_LENGTH)).max(MAX_TASK_KEYWORDS).default([]),
  tools: z.array(z.enum(CAPS)).default(["read"]),
  timeout_s: z.number().int().positive().max(300).optional(),
});
export type SkillFrontmatterType = z.infer<typeof SkillFrontmatter>;

export interface Task {
  id: string;
  name: string;
  description: string;
  examples: string[];
  keywords: string[];
  envelope: Envelope;
  timeout_s?: number;
  skill: string; // SKILL.md body (after the frontmatter), embedded into the spawn prompt
}

export const ASK_TASK: Task = {
  id: "ask",
  name: "Ask a question",
  description: "Answer questions using the files in the public directory.",
  examples: [],
  keywords: [],
  envelope: { caps: ["read"] },
  skill: "",
};

// Reads ~/AgentCall/tasks/<id>/SKILL.md (YAML frontmatter + body). Invalid
// or duplicate entries are skipped with a warning rather than failing the
// whole listener: one broken manifest must not take every other task
// offline.
export function loadTasks(p: Paths, warn: (msg: string) => void = console.error): Task[] {
  const tasks: Task[] = [ASK_TASK];
  if (!existsSync(p.tasksDir)) return tasks;
  for (const entry of readdirSync(p.tasksDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const id = entry.name;
    if (!TASK_ID_RE.test(id)) {
      warn(`agentcall: task "${id}": directory name is not a valid task id (lowercase kebab-case), skipped`);
      continue;
    }
    if (tasks.some((t) => t.id === id)) {
      warn(`agentcall: task "${id}": duplicate or reserved id, skipped`);
      continue;
    }
    const skillFile = join(p.tasksDir, id, "SKILL.md");
    if (!existsSync(skillFile)) {
      warn(`agentcall: task "${id}": missing SKILL.md, skipped`);
      continue;
    }
    let fm: SkillFrontmatterType;
    let body: string;
    try {
      const split = splitFrontmatter(readFileSync(skillFile, "utf8"));
      if (!split) {
        warn(`agentcall: task "${id}": SKILL.md has no YAML frontmatter (--- fences), skipped`);
        continue;
      }
      fm = SkillFrontmatter.parse(parseYaml(split.meta));
      body = split.body;
    } catch (e) {
      warn(`agentcall: task "${id}": invalid SKILL.md frontmatter, skipped (${String(e).slice(0, 200)})`);
      continue;
    }
    tasks.push({
      id,
      name: fm.name ?? id,
      description: fm.description,
      examples: fm.examples,
      keywords: fm.keywords,
      envelope: { caps: fm.tools },
      timeout_s: fm.timeout_s,
      skill: body,
    });
  }
  return tasks;
}

// Scaffold for `agentcall task new`. Parses cleanly as-is: the TODO
// description shows up verbatim on the owner's card review, which is its
// own nudge to edit before offering. Commented lines document every
// optional frontmatter field with its default.
export const SKILL_TEMPLATE = `---
description: TODO — one line callers will see on your card
# name: defaults to the directory name
# tools: [read]           # read | write | fetch | exec
# timeout_s: 300
# examples:
#   - An example message a caller might send
# keywords:              # search terms; weighted highest by \`agentcall search\`
#   - auth
#   - migration
---
# Instructions for this task

Describe how your agent should perform it. This text is given to the
agent verbatim when a caller invokes the task.
`;

// Creates ~/AgentCall/tasks/<id>/SKILL.md from the template and returns the
// file path. Never overwrites; never touches policy — a scaffolded task is
// invisible to callers until the owner runs `agentcall offer <id>` or
// `agentcall allow <handle> <id>` (create ≠ publish).
export function scaffoldTask(p: Paths, id: string): string {
  if (!TASK_ID_RE.test(id)) {
    throw new Error(`"${id}" is not a valid task id: lowercase letters, digits, and hyphens, starting with a letter or digit.`);
  }
  if (id === ASK_TASK.id) throw new Error(`"ask" is the built-in reserved task and can't be redefined.`);
  const dir = join(p.tasksDir, id);
  if (existsSync(dir)) throw new Error(`Task "${id}" already exists at ${dir}.`);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "SKILL.md");
  writeFileSync(file, SKILL_TEMPLATE);
  return file;
}
