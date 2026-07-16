import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ASK_TASK, FULL_ACCESS_ENVELOPE, loadTasks, TaskManifest } from "../src/tasks.js";
import { getPaths } from "../src/paths.js";

function tempHome() { return mkdtempSync(join(tmpdir(), "agentcall-tasks-")); }

function writeTask(home: string, id: string, manifest: object, skill = "# How to do it\n") {
  const dir = join(home, "AgentCall", "tasks", id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "task.json"), JSON.stringify(manifest));
  writeFileSync(join(dir, "SKILL.md"), skill);
}

describe("paths", () => {
  it("exposes tasksDir and policyFile", () => {
    const p = getPaths("/tmp/fakehome");
    expect(p.tasksDir).toBe("/tmp/fakehome/AgentCall/tasks");
    expect(p.policyFile).toBe("/tmp/fakehome/.agentcall/policy.json");
  });
});

describe("TaskManifest", () => {
  it("applies envelope defaults (read-only, no writes, no network)", () => {
    const m = TaskManifest.parse({ id: "intro", name: "Intro", description: "Introduce the owner." });
    expect(m.envelope).toEqual({ tools: ["read"], write_paths: [], network: [] });
    expect(m.tier).toBe("T1");
  });
  it("rejects write_paths that try to escape ~/AgentCall", () => {
    const bad = TaskManifest.safeParse({
      id: "x", name: "X", description: "d", envelope: { tools: ["write"], write_paths: ["../.ssh"], network: [] },
    });
    expect(bad.success).toBe(false);
  });
  it("rejects a timeout above the 300s cap", () => {
    const bad = TaskManifest.safeParse({ id: "x", name: "X", description: "d", timeout_s: 999 });
    expect(bad.success).toBe(false);
  });
});

describe("loadTasks", () => {
  it("always includes the built-in ask task, even with no tasks dir", () => {
    const tasks = loadTasks(getPaths(tempHome()), () => {});
    expect(tasks.map((t) => t.id)).toEqual(["ask"]);
    expect(ASK_TASK.envelope).toEqual({ caps: ["read"], write_paths: [], network: [] });
  });
  it("loads a task dir with manifest + SKILL.md, mapping tools -> caps", () => {
    const home = tempHome();
    writeTask(home, "schedule-meeting", {
      id: "schedule-meeting", name: "Schedule", description: "Book a time.",
      envelope: { tools: ["read", "fetch"], write_paths: [], network: ["calendar.google.com"] },
      timeout_s: 120,
    }, "# Check the calendar first\n");
    const tasks = loadTasks(getPaths(home), () => {});
    const t = tasks.find((x) => x.id === "schedule-meeting")!;
    expect(t.envelope).toEqual({ caps: ["read", "fetch"], write_paths: [], network: ["calendar.google.com"] });
    expect(t.skill).toContain("Check the calendar");
    expect(t.timeout_s).toBe(120);
  });
  it("skips a dir whose name doesn't match the manifest id, with a warning", () => {
    const home = tempHome();
    writeTask(home, "wrong-dir", { id: "other-id", name: "X", description: "d" });
    const warnings: string[] = [];
    const tasks = loadTasks(getPaths(home), (m) => warnings.push(m));
    expect(tasks.map((t) => t.id)).toEqual(["ask"]);
    expect(warnings.some((w) => w.includes("wrong-dir"))).toBe(true);
  });
  it("skips invalid manifests and a task trying to shadow the built-in ask", () => {
    const home = tempHome();
    writeTask(home, "bad", { id: "bad" }); // missing name/description
    writeTask(home, "ask", { id: "ask", name: "Evil", description: "override" });
    const warnings: string[] = [];
    const tasks = loadTasks(getPaths(home), (m) => warnings.push(m));
    expect(tasks.map((t) => t.id)).toEqual(["ask"]);
    expect(tasks[0]!.name).toBe(ASK_TASK.name);
    expect(warnings).toHaveLength(2);
  });
});

describe("FULL_ACCESS_ENVELOPE", () => {
  it("matches today's single-tier behavior", () => {
    expect(FULL_ACCESS_ENVELOPE).toEqual({
      caps: ["read", "write", "fetch", "exec"], write_paths: ["public"], network: [],
    });
  });
});
