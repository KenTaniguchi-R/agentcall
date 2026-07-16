import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { parse as parseYaml } from "yaml";
import { TASK_ID_RE } from "@benree/agentcall-shared";
import type { Paths } from "./paths.js";

export const CAPS = ["read", "write", "fetch", "exec"] as const;
export type Cap = (typeof CAPS)[number];

export interface Envelope {
  caps: Cap[];
  write_paths: string[];
  network: string[];
}

// Today's single-tier behavior; the default envelope for call sites that
// predate task scoping (runner/srt defaults) so nothing changes until a
// resolved task passes a narrower one.
export const FULL_ACCESS_ENVELOPE: Envelope = {
  caps: ["read", "write", "fetch", "exec"],
  write_paths: ["public"],
  network: [],
};

// write_paths are relative to ~/AgentCall. Phase 1 allows only "public" or
// subpaths of it: dirs outside publicDir would be readable-never (srt's
// denyRead ~, see srt.ts) so writes there can't work with Read-before-Edit
// agents — a write_paths entry outside public is a broken grant that would
// silently no-op, so it's made inexpressible here rather than left for an
// owner to discover at call time. The character set still forbids "." so
// "../" traversal can't be expressed at all, and a leading "/" is rejected
// by the first-character class.
const WRITE_PATH_RE = /^public(?:\/[a-z0-9][a-z0-9\/_-]*)?$/;
// Hostnames for srt allowedDomains ("*.example.com" wildcards allowed).
const DOMAIN_RE = /^(\*\.)?[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/;

// A SKILL.md is YAML frontmatter between --- fences, then the skill body.
// Returns null when the file has no leading fence or no closing fence.
export function splitFrontmatter(text: string): { meta: string; body: string } | null {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
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
  tier: z.enum(["T1", "T2"]).default("T1"),
  tools: z.array(z.enum(CAPS)).default(["read"]),
  write_paths: z.array(z.string().regex(WRITE_PATH_RE)).default([]),
  network: z.array(z.string().regex(DOMAIN_RE)).default([]),
  timeout_s: z.number().int().positive().max(300).optional(),
});
export type SkillFrontmatterType = z.infer<typeof SkillFrontmatter>;

export interface Task {
  id: string;
  name: string;
  description: string;
  examples: string[];
  tier: "T1" | "T2";
  envelope: Envelope;
  timeout_s?: number;
  skill: string; // SKILL.md body (after the frontmatter), embedded into the spawn prompt
}

export const ASK_TASK: Task = {
  id: "ask",
  name: "Ask a question",
  description: "Answer questions using the files in the public directory.",
  examples: [],
  tier: "T1",
  envelope: { caps: ["read"], write_paths: [], network: [] },
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
      tier: fm.tier,
      envelope: { caps: fm.tools, write_paths: fm.write_paths, network: fm.network },
      timeout_s: fm.timeout_s,
      skill: body,
    });
  }
  return tasks;
}
