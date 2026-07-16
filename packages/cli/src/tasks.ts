import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
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

// write_paths are relative to ~/AgentCall; the character set forbids "." so
// "../" traversal can't be expressed at all, and a leading "/" is rejected
// by the first-character class.
const WRITE_PATH_RE = /^[a-z0-9][a-z0-9/_-]*$/;
// Hostnames for srt allowedDomains ("*.example.com" wildcards allowed).
const DOMAIN_RE = /^(\*\.)?[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/;

export const TaskManifest = z.object({
  id: z.string().regex(TASK_ID_RE),
  name: z.string().min(1).max(100),
  description: z.string().min(1).max(1000),
  examples: z.array(z.string().max(500)).max(10).default([]),
  tier: z.enum(["T1", "T2"]).default("T1"),
  envelope: z
    .object({
      tools: z.array(z.enum(CAPS)).default(["read"]),
      write_paths: z.array(z.string().regex(WRITE_PATH_RE)).default([]),
      network: z.array(z.string().regex(DOMAIN_RE)).default([]),
    })
    .default({ tools: ["read"], write_paths: [], network: [] }),
  timeout_s: z.number().int().positive().max(300).optional(),
});
export type TaskManifestType = z.infer<typeof TaskManifest>;

export interface Task {
  id: string;
  name: string;
  description: string;
  examples: string[];
  tier: "T1" | "T2";
  envelope: Envelope;
  timeout_s?: number;
  skill: string; // SKILL.md content, embedded into the spawn prompt
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

// Reads ~/AgentCall/tasks/<id>/{task.json,SKILL.md}. Invalid or duplicate
// entries are skipped with a warning rather than failing the whole listener:
// one broken manifest must not take every other task offline.
export function loadTasks(p: Paths, warn: (msg: string) => void = console.error): Task[] {
  const tasks: Task[] = [ASK_TASK];
  if (!existsSync(p.tasksDir)) return tasks;
  for (const entry of readdirSync(p.tasksDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = join(p.tasksDir, entry.name);
    const manifestFile = join(dir, "task.json");
    if (!existsSync(manifestFile)) {
      warn(`agentcall: task "${entry.name}": missing task.json, skipped`);
      continue;
    }
    let m: TaskManifestType;
    try {
      m = TaskManifest.parse(JSON.parse(readFileSync(manifestFile, "utf8")));
    } catch (e) {
      warn(`agentcall: task "${entry.name}": invalid task.json, skipped (${String(e).slice(0, 200)})`);
      continue;
    }
    if (m.id !== entry.name) {
      warn(`agentcall: task "${entry.name}": directory name must equal manifest id "${m.id}", skipped`);
      continue;
    }
    if (tasks.some((t) => t.id === m.id)) {
      warn(`agentcall: task "${m.id}": duplicate or reserved id, skipped`);
      continue;
    }
    const skillFile = join(dir, "SKILL.md");
    tasks.push({
      id: m.id,
      name: m.name,
      description: m.description,
      examples: m.examples,
      tier: m.tier,
      envelope: { caps: m.envelope.tools, write_paths: m.envelope.write_paths, network: m.envelope.network },
      timeout_s: m.timeout_s,
      skill: existsSync(skillFile) ? readFileSync(skillFile, "utf8") : "",
    });
  }
  return tasks;
}
