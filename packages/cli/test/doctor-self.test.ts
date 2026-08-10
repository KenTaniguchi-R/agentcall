import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Config } from "../src/config.js";
import { diagnoseSelfConfiguration } from "../src/doctor.js";
import { getPaths } from "../src/paths.js";
import { tempDir } from "./helpers.js";

const claude: Config & { agent_kind: "claude" } = {
  org: "acme", handle: "ken", token: "t", relay: "https://relay.example", agent_kind: "claude",
};

function installation() {
  const root = tempDir("agentcall-doctor-self-");
  const paths = getPaths(root, root);
  mkdirSync(paths.dir, { recursive: true });
  return paths;
}

function writeTask(paths: ReturnType<typeof installation>, id: string, contents: string) {
  const dir = join(paths.tasksDir, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), contents);
}

describe("diagnoseSelfConfiguration", () => {
  it("reports task parse failures without hiding the valid task set", () => {
    const paths = installation();
    writeTask(paths, "broken", "# no frontmatter\n");
    const report = diagnoseSelfConfiguration(claude, paths);
    expect(report.checks).toContainEqual(expect.objectContaining({ name: "task validity", ok: false }));
    expect(report.self.tasks.map((task) => task.id)).toEqual(["ask"]);
  });

  it("fails closed on an invalid effective policy", () => {
    const paths = installation();
    writeFileSync(paths.policyFile, JSON.stringify({
      tests: [{ caller: "mia", expect_access: "blocked" }],
    }));
    const report = diagnoseSelfConfiguration(claude, paths);
    expect(report.checks).toContainEqual(expect.objectContaining({
      name: "effective policy", ok: false, detail: expect.stringMatching(/assertion.*failed/i),
    }));
    expect(report.self.card.status).toBe("unavailable");
  });

  it("returns resolved named access and successful assertion count", () => {
    const paths = installation();
    writeFileSync(paths.policyFile, JSON.stringify({
      default_access: "allowed",
      callers: { mia: {}, spammer: { access: "blocked" } },
      tests: [{ caller: "spammer", expect_access: "blocked" }],
    }));
    const report = diagnoseSelfConfiguration(claude, paths);
    expect(report.self.policy).toMatchObject({
      default_access: "allowed",
      callers: [{ caller: "mia", access: "allowed" }, { caller: "spammer", access: "blocked" }],
      assertions_passed: 1,
    });
  });

  it("distinguishes current, stale, missing, and unreadable card snapshots", () => {
    const paths = installation();
    expect(diagnoseSelfConfiguration(claude, paths).self.card.status).toBe("never-published");

    const expected = {
      description: "", agent_kind: "claude",
      tasks: [{ id: "ask", name: "Ask a question", description: "Answer questions using the files in the public directory.", examples: [], keywords: [] }],
      blocked: [], offline_delivery: { enabled: false },
    };
    writeFileSync(paths.cardSnapshotFile, JSON.stringify(expected));
    expect(diagnoseSelfConfiguration(claude, paths).self.card.status).toBe("current");
    writeFileSync(paths.cardSnapshotFile, JSON.stringify({ ...expected, description: "old" }));
    expect(diagnoseSelfConfiguration(claude, paths).self.card.status).toBe("stale");
    writeFileSync(paths.cardSnapshotFile, "{corrupt");
    expect(diagnoseSelfConfiguration(claude, paths).self.card.status).toBe("unreadable");
  });

  it("states the Codex read and execution gap as a diagnostic warning", () => {
    const paths = installation();
    const report = diagnoseSelfConfiguration({ ...claude, agent_kind: "codex" }, paths);
    expect(report.checks).toContainEqual(expect.objectContaining({
      name: "Codex runtime isolation", ok: true, warn: true,
      detail: expect.stringMatching(/no per-tool restriction or read guard/i),
    }));
  });
});
