import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { parse as parseYaml } from "yaml";
import { MAX_KEYWORD_LENGTH, MAX_TASK_KEYWORDS, TASK_ID_RE } from "@benree/agentcall-shared";
import type { LinePaths } from "./paths.js";

// The capability envelope is gone (#372). A call answers a question; the reply
// is the only sink, so there is no write/exec/fetch grant to model. What a task
// may reach is a property of the sources it reads, which sensitivity.ts answers,
// and of who is asking, which clearance.ts answers.

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
// drift: this is the authoring side of the card metadata callers inspect
  // highest.
  keywords: z.array(z.string().min(1).max(MAX_KEYWORD_LENGTH)).max(MAX_TASK_KEYWORDS).default([]),
  timeout_s: z.number().int().positive().max(300).optional(),
  // No `workdir`. #372 deleted it with the line-level one: where the agent
  // runs is derived from the sensitivity map (sensitivity.ts's workdirFor), so
  // a task naming its own directory could only ever contradict it. `.strict()`
  // below means a SKILL.md still carrying one fails to load with a named
  // warning rather than silently doing nothing.
  // Follow-up calls. Safe by default now that the reply is the only sink: the
  // multi-turn risk the old derivation managed was an attacker planting a
  // premise on turn 1 and cashing it on turn 5 against a write or exec grant,
  // and neither exists any more.
  threadable: z.boolean().default(true),
// Strict: a SKILL.md still carrying `tools:` from the capability model now
// fails to load with a named warning, rather than being silently ignored while
// its author believes it still grants or restricts something.
}).strict();
type SkillFrontmatterType = z.infer<typeof SkillFrontmatter>;

export interface Task {
  id: string;
  name: string;
  description: string;
  examples: string[];
  keywords: string[];
  timeout_s?: number;
  threadable: boolean;
  skill: string; // SKILL.md body (after the frontmatter), embedded into the spawn prompt
}

export const ASK_TASK: Task = {
  id: "ask",
  name: "Ask a question",
  description: "Answer questions using the files in the public directory.",
  examples: [],
  keywords: [],
  threadable: true,
  skill: "",
};

// Reads ~/AgentCall/<line>/tasks/<id>/SKILL.md (YAML frontmatter + body).
// Invalid or duplicate entries are skipped with a warning rather than
// failing the whole listener: one broken manifest must not take every other
// task offline.
export function loadTasks(p: LinePaths, warn: (msg: string) => void = console.error): Task[] {
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
      timeout_s: fm.timeout_s,
      threadable: fm.threadable,
      skill: body,
    });
  }
  return tasks;
}

// Scaffold for `agentcall task new`. Parses cleanly as-is: the TODO
// description shows up verbatim on the owner's card review, which is its
// own nudge to edit before offering. Commented lines document every
// optional frontmatter field with its default.
const SKILL_TEMPLATE = `---
description: TODO — one line callers will see on your card
# name: defaults to the directory name
# timeout_s: 300
# threadable: true       # allow --continue follow-ups; defaults true
# examples:
#   - An example message a caller might send
# keywords:              # terms published on the task card
#   - auth
#   - migration
---
# Instructions for this task

Describe how your agent should perform it. This text is given to the
agent verbatim when a caller invokes the task.
`;

// Creates ~/AgentCall/<line>/tasks/<id>/SKILL.md from the template and
// returns the file path. Never overwrites; never touches policy — a
// scaffolded task is invisible to callers until the owner runs
// `agentcall offer <id>` or `agentcall allow <handle> <id>` (create ≠ publish).
export function scaffoldTask(p: LinePaths, id: string): string {
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
