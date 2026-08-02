import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ASK_TASK, deriveThreadable, FULL_ACCESS_ENVELOPE, loadTasks, scaffoldTask, SkillFrontmatter, splitFrontmatter } from "../src/tasks.js";
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
  it("does not treat a mid-frontmatter line like '---- separator' as the closing fence", () => {
    const r = splitFrontmatter([
      "---",
      "description: d",
      "notes: ---- separator",
      "examples:",
      "  - example after the dashes",
      "---",
      "# Body",
      "",
    ].join("\n"));
    expect(r).not.toBeNull();
    expect(r!.meta).toContain("notes: ---- separator");
    expect(r!.meta).toContain("example after the dashes");
    expect(r!.body).toBe("# Body\n");
  });
  it("splits a CRLF-fenced file", () => {
    const r = splitFrontmatter("---\r\ndescription: d\r\n---\r\n# Body\r\ntext\r\n");
    expect(r).toEqual({ meta: "description: d", body: "# Body\r\ntext\r\n" });
  });
  it("parses with an empty body when there is no trailing newline after the closing fence", () => {
    const r = splitFrontmatter("---\ndescription: d\n---");
    expect(r).toEqual({ meta: "description: d", body: "" });
  });
});

describe("SkillFrontmatter", () => {
  it("applies defaults (read-only)", () => {
    const m = SkillFrontmatter.parse({ description: "Introduce the owner." });
    expect(m).toMatchObject({ tools: ["read"], examples: [] });
    expect(m.name).toBeUndefined();
  });
  it("requires description", () => {
    expect(SkillFrontmatter.safeParse({ name: "X" }).success).toBe(false);
  });
  it("rejects timeouts above 300", () => {
    expect(SkillFrontmatter.safeParse({ description: "d", timeout_s: 999 }).success).toBe(false);
  });
  // write_paths/network were srt allowWrite/allowedDomains inputs. With the
  // sandbox gone they grant nothing, so they're no longer part of the
  // frontmatter contract — an unknown key is ignored rather than honoured.
  it("ignores the removed write_paths and network keys", () => {
    const m = SkillFrontmatter.parse({ description: "d", write_paths: ["public/inbox"], network: ["evil.com"] }) as
      Record<string, unknown>;
    expect(m.write_paths).toBeUndefined();
    expect(m.network).toBeUndefined();
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
    expect(t.envelope).toEqual({ caps: ["read", "fetch"] });
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

describe("deriveThreadable", () => {
  it("threads read-only envelopes", () => {
    expect(deriveThreadable(["read"])).toBe(true);
    expect(deriveThreadable(["read", "fetch"])).toBe(true);
  });

  // Across turns the caller's earlier text lives in context as conversation,
  // not as fenced input, so a premise planted on turn 1 can be cashed on turn
  // 5. Tolerable against read; not against exec.
  it("refuses to thread write or exec envelopes", () => {
    expect(deriveThreadable(["read", "write"])).toBe(false);
    expect(deriveThreadable(["read", "exec"])).toBe(false);
  });

  it("lets an explicit value win either way", () => {
    expect(deriveThreadable(["read", "exec"], true)).toBe(true);
    expect(deriveThreadable(["read"], false)).toBe(false);
  });
});

describe("loadTasks threadable", () => {
  it("derives threadable from tools when frontmatter omits it", () => {
    const home = tempHome();
    writeSkill(home, "readonly-task", "---\ndescription: d\ntools: [read]\n---\nbody");
    expect(loadTasks(getPaths(home)).find((t) => t.id === "readonly-task")!.threadable).toBe(true);
  });

  it("derives false for an exec task", () => {
    const home = tempHome();
    writeSkill(home, "exec-task", "---\ndescription: d\ntools: [read, exec]\n---\nbody");
    expect(loadTasks(getPaths(home)).find((t) => t.id === "exec-task")!.threadable).toBe(false);
  });

  it("honours an explicit override", () => {
    const home = tempHome();
    writeSkill(home, "opt-in", "---\ndescription: d\ntools: [read, exec]\nthreadable: true\n---\nbody");
    expect(loadTasks(getPaths(home)).find((t) => t.id === "opt-in")!.threadable).toBe(true);
  });

  it("makes the built-in ask task threadable", () => {
    expect(loadTasks(getPaths(tempHome())).find((t) => t.id === "ask")!.threadable).toBe(true);
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
    expect(t.envelope).toEqual({ caps: ["read"] });
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
  it("is every capability", () => {
    expect(FULL_ACCESS_ENVELOPE).toEqual({ caps: ["read", "write", "fetch", "exec"] });
  });
});

describe("keywords frontmatter", () => {
  it("loads keywords from SKILL.md", () => {
    const home = tempHome();
    writeSkill(home, "adr", [
      "---",
      "description: Why past architecture decisions were made.",
      "keywords: [auth, migration, adr]",
      "---",
      "body",
    ].join("\n"));
    const task = loadTasks(getPaths(home)).find((t) => t.id === "adr")!;
    expect(task.keywords).toEqual(["auth", "migration", "adr"]);
  });

  it("defaults keywords to [] when the frontmatter omits them", () => {
    const home = tempHome();
    writeSkill(home, "plain", ["---", "description: A task.", "---", "body"].join("\n"));
    expect(loadTasks(getPaths(home)).find((t) => t.id === "plain")!.keywords).toEqual([]);
  });

  it("skips a task whose keywords exceed the cap, without killing others", () => {
    const home = tempHome();
    writeSkill(home, "bad", [
      "---", "description: A task.",
      `keywords: [${Array.from({ length: 21 }, (_, i) => `k${i}`).join(", ")}]`,
      "---", "body",
    ].join("\n"));
    const ids = loadTasks(getPaths(home), () => {}).map((t) => t.id);
    expect(ids).toContain("ask");     // built-in survives
    expect(ids).not.toContain("bad"); // one broken manifest never takes the rest offline
  });
});
