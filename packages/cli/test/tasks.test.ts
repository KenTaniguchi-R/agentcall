import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ASK_TASK, FULL_ACCESS_ENVELOPE, loadTasks, scaffoldTask, SkillFrontmatter, splitFrontmatter } from "../src/tasks.js";
import { getPaths } from "../src/paths.js";

function tempHome() { return mkdtempSync(join(tmpdir(), "agentcall-tasks-")); }

function writeSkill(home: string, id: string, skillMd: string) {
  const dir = join(home, "AgentCall", "tasks", id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), skillMd);
}

describe("paths", () => {
  it("exposes tasksDir and policyFile", () => {
    const p = getPaths("/tmp/fakehome");
    expect(p.tasksDir).toBe("/tmp/fakehome/AgentCall/tasks");
    expect(p.policyFile).toBe("/tmp/fakehome/.agentcall/policy.json");
  });
});

describe("splitFrontmatter", () => {
  it("splits meta and body", () => {
    const r = splitFrontmatter("---\ndescription: d\n---\n# Body\ntext\n");
    expect(r).toEqual({ meta: "description: d", body: "# Body\ntext\n" });
  });
  it("returns null without a leading fence", () => {
    expect(splitFrontmatter("# Just markdown\n")).toBeNull();
  });
  it("returns null without a closing fence", () => {
    expect(splitFrontmatter("---\ndescription: d\n")).toBeNull();
  });
});

describe("SkillFrontmatter", () => {
  it("applies defaults (read-only, no writes, no network, T1)", () => {
    const m = SkillFrontmatter.parse({ description: "Introduce the owner." });
    expect(m).toMatchObject({ tier: "T1", tools: ["read"], write_paths: [], network: [], examples: [] });
    expect(m.name).toBeUndefined();
  });
  it("requires description", () => {
    expect(SkillFrontmatter.safeParse({ name: "X" }).success).toBe(false);
  });
  it("rejects write_paths outside public and timeouts above 300", () => {
    expect(SkillFrontmatter.safeParse({ description: "d", write_paths: ["inbox"] }).success).toBe(false);
    expect(SkillFrontmatter.safeParse({ description: "d", timeout_s: 999 }).success).toBe(false);
  });
});

describe("loadTasks", () => {
  it("always includes the built-in ask task, even with no tasks dir", () => {
    const tasks = loadTasks(getPaths(tempHome()), () => {});
    expect(tasks.map((t) => t.id)).toEqual(["ask"]);
  });
  it("loads a frontmatter SKILL.md; dir name is the id; name defaults to id", () => {
    const home = tempHome();
    writeSkill(home, "schedule-meeting", [
      "---",
      "description: Book a time.",
      "tools: [read, fetch]",
      "network: [calendar.google.com]",
      "timeout_s: 120",
      "---",
      "# Check the calendar first",
      "",
    ].join("\n"));
    const tasks = loadTasks(getPaths(home), () => {});
    const t = tasks.find((x) => x.id === "schedule-meeting")!;
    expect(t.name).toBe("schedule-meeting");
    expect(t.envelope).toEqual({ caps: ["read", "fetch"], write_paths: [], network: ["calendar.google.com"] });
    expect(t.skill).toContain("Check the calendar");
    expect(t.timeout_s).toBe(120);
  });
  it("uses an explicit name when given", () => {
    const home = tempHome();
    writeSkill(home, "intro", "---\nname: Owner introduction\ndescription: d\n---\nbody\n");
    expect(loadTasks(getPaths(home), () => {}).find((t) => t.id === "intro")!.name).toBe("Owner introduction");
  });
  it("skips missing SKILL.md, missing frontmatter, bad YAML, and schema violations — each with a warning", () => {
    const home = tempHome();
    mkdirSync(join(home, "AgentCall", "tasks", "empty-dir"), { recursive: true });
    writeSkill(home, "no-fm", "# bare markdown, no frontmatter\n");
    writeSkill(home, "bad-yaml", "---\ndescription: [unclosed\n---\nbody\n");
    writeSkill(home, "bad-schema", "---\nname: X\n---\nbody\n"); // missing description
    const warnings: string[] = [];
    const tasks = loadTasks(getPaths(home), (m) => warnings.push(m));
    expect(tasks.map((t) => t.id)).toEqual(["ask"]);
    expect(warnings).toHaveLength(4);
    expect(warnings.some((w) => w.includes("no-fm"))).toBe(true);
  });
  it("skips a dir whose name is not a valid task id, and a task shadowing ask", () => {
    const home = tempHome();
    writeSkill(home, "Bad_Name", "---\ndescription: d\n---\n");
    writeSkill(home, "ask", "---\ndescription: override\n---\n");
    const warnings: string[] = [];
    const tasks = loadTasks(getPaths(home), (m) => warnings.push(m));
    expect(tasks.map((t) => t.id)).toEqual(["ask"]);
    expect(tasks[0]!.name).toBe(ASK_TASK.name);
    expect(warnings).toHaveLength(2);
  });
});

describe("scaffoldTask", () => {
  it("creates a SKILL.md that loadTasks accepts as a valid task", () => {
    const home = tempHome();
    const p = getPaths(home);
    const file = scaffoldTask(p, "schedule-meeting");
    expect(file).toBe(join(p.tasksDir, "schedule-meeting", "SKILL.md"));
    const warnings: string[] = [];
    const tasks = loadTasks(p, (m) => warnings.push(m));
    expect(warnings).toEqual([]);
    const t = tasks.find((x) => x.id === "schedule-meeting")!;
    expect(t.description).toContain("TODO");
    expect(t.envelope).toEqual({ caps: ["read"], write_paths: [], network: [] });
  });
  it("refuses invalid ids, the reserved ask id, and existing directories", () => {
    const p = getPaths(tempHome());
    expect(() => scaffoldTask(p, "Bad_Id")).toThrow(/valid task id/i);
    expect(() => scaffoldTask(p, "ask")).toThrow(/reserved/i);
    scaffoldTask(p, "twice");
    expect(() => scaffoldTask(p, "twice")).toThrow(/already exists/i);
  });
});

describe("FULL_ACCESS_ENVELOPE", () => {
  it("matches today's single-tier behavior", () => {
    expect(FULL_ACCESS_ENVELOPE).toEqual({
      caps: ["read", "write", "fetch", "exec"], write_paths: ["public"], network: [],
    });
  });
});
