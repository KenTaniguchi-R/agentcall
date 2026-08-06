import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildCardReport } from "../src/lint.js";
import { publishCard } from "../src/card.js";
import { getLinePaths, getMachinePaths } from "../src/paths.js";
import type { LineConfig } from "../src/config.js";
import { tempDir } from "./helpers.js";

const cfg: LineConfig = { org: "acme", handle: "ken", token: "t", agent_kind: "claude", relay: "https://r" };

function linePaths(h: string) {
  return getLinePaths(getMachinePaths(h, h), "line");
}
// The managed ceiling is machine-scoped and unredirectable in production, so
// tests override it on MachinePaths rather than through AGENTCALL_HOME.
function managedLinePaths(h: string) {
  const m = getMachinePaths(h, h);
  return getLinePaths({ ...m, managedPolicyFile: join(h, "managed-policy.json") }, "line");
}
function home() {
  const h = tempDir("agentcall-lint-");
  mkdirSync(linePaths(h).dir, { recursive: true });
  return h;
}
function writeSkill(h: string, id: string, skillMd: string) {
  const dir = join(h, "AgentCall", "line", "tasks", id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), skillMd);
}

describe("buildCardReport", () => {
  it("renders the default menu and a never-pushed notice on a fresh install", () => {
    const p = linePaths(home());
    const r = buildCardReport(cfg, p);
    expect(r.menu.join("\n")).toContain("ask");
    expect(r.problems).toEqual([]);
    expect(r.notices.join("\n")).toContain("never been pushed");
  });

  it("surfaces skipped-manifest warnings as problems", () => {
    const h = home();
    writeSkill(h, "broken", "# no frontmatter\n");
    const r = buildCardReport(cfg, linePaths(h));
    expect(r.problems.join("\n")).toContain("broken");
  });

  // Replaces "flags policy references to tasks that do not exist" and "flags
  // group grants to missing tasks even when an assertion accepts them". Both
  // pinned the dangling-grant check, which #379 removed along with the only
  // way policy.json could name a task at all. The failure they guarded against
  // is now unrepresentable rather than merely unreported — pinned here as a
  // parse failure, which is the stronger outcome.
  it("rejects a policy that still tries to name a task, at parse time", () => {
    const h = home();
    const p = linePaths(h);
    writeFileSync(p.policyFile, JSON.stringify({
      default_offer: ["ask", "gone"], callers: { mia: { offer: ["also-gone"], block: false } },
    }));
    const r = buildCardReport(cfg, p);
    expect(r.problems.join("\n")).toContain("policy.json");
    expect(r.menu).toEqual([]);
  });

  it("reports a malformed policy file as a problem instead of throwing", () => {
    const p = linePaths(home());
    writeFileSync(p.policyFile, "{corrupt");
    const r = buildCardReport(cfg, p);
    expect(r.problems.join("\n")).toContain("policy.json");
  });

  it("reports a broken policy assertion as a problem", () => {
    const p = linePaths(home());
    writeFileSync(p.policyFile, JSON.stringify({
      default_clearance: "public", tests: [{ caller: "mia", expect_clearance: "internal" }],
    }));
    const r = buildCardReport(cfg, p);
    expect(r.problems.join("\n")).toMatch(/assertion 1.*expected internal.*got public/i);
  });

  it("is quiet after a push and stale after a change", async () => {
    const h = home();
    const p = linePaths(h);
    await publishCard(cfg, p, async () => {});
    expect(buildCardReport(cfg, p).notices).toEqual([]);
    writeSkill(h, "intro", "---\ndescription: d\n---\nbody\n");
    writeFileSync(p.policyFile, JSON.stringify({ default_clearance: "public", callers: {} }));
    const r = buildCardReport(cfg, p);
    expect(r.notices.join("\n")).toContain("out of date");
  });

  it("reports an unreadable card snapshot as a notice, not a problem", () => {
    const p = linePaths(home());
    writeFileSync(p.cardSnapshotFile, "{corrupt");
    const r = buildCardReport(cfg, p);
    expect(r.notices.join("\n")).toContain("snapshot unreadable");
    expect(r.problems).toEqual([]);
  });

  it("warns that codex gives no per-tool exec restriction when a task's tools exclude exec", () => {
    const h = home();
    writeSkill(h, "intro", "---\ndescription: d\n---\n");
    const p = linePaths(h);
    writeFileSync(p.policyFile, JSON.stringify({ default_clearance: "public", callers: {} }));
    const codexCfg: LineConfig = { ...cfg, agent_kind: "codex" };
    const r = buildCardReport(codexCfg, p);
    expect(r.notices.join("\n")).toMatch(/intro/);
    expect(r.notices.join("\n")).toMatch(/codex/i);
  });

  it("does not warn about the codex exec gap for a claude-backed agent", () => {
    const h = home();
    writeSkill(h, "intro", "---\ndescription: d\n---\n");
    const p = linePaths(h);
    writeFileSync(p.policyFile, JSON.stringify({ default_clearance: "public", callers: {} }));
    const r = buildCardReport(cfg, p);
    expect(r.notices.join("\n")).not.toMatch(/codex/i);
  });

  it("warns for every codex task except ask, since the caveat no longer depends on a cap", () => {
    // The notice used to fire only for tasks that did NOT declare exec. With
    // capabilities deleted there is nothing to declare: codex can run shell
    // commands on any task, and --sandbox read-only stops writes but not
    // reads or execution. So the caveat applies to all of them.
    const h = home();
    writeSkill(h, "runner", "---\ndescription: d\n---\n");
    const p = linePaths(h);
    writeFileSync(p.policyFile, JSON.stringify({ default_clearance: "public", callers: {} }));
    const codexCfg: LineConfig = { ...cfg, agent_kind: "codex" };
    const r = buildCardReport(codexCfg, p);
    const notices = r.notices.join("\n");
    expect(notices).toMatch(/task "runner": codex has no per-tool restriction/);
    expect(notices).not.toMatch(/task "ask"/);
  });

  // Was "lists per-caller grants and blocked callers in the menu". The grant
  // half is gone with the menu; what the owner needs to read now is each named
  // caller's RESOLVED clearance, which is what a block actually changes.
  it("lists the task list, the default clearance, and each named caller's resolved level", () => {
    const h = home();
    const p = linePaths(h);
    writeSkill(h, "intro", "---\ndescription: d\n---\n");
    writeFileSync(p.policyFile, JSON.stringify({
      default_clearance: "public",
      callers: { mia: { clearance: "internal" }, spammer: { clearance: "internal", block: true } },
    }));
    const text = buildCardReport(cfg, p).menu.join("\n");
    expect(text).toContain("Every caller who is not blocked can request:");
    expect(text).toContain("intro — d");
    expect(text).toContain("Anyone registered can be told: public");
    expect(text).toContain("mia: internal");
    // Resolved, not stored: spammer's saved `internal` is inert under a block,
    // and printing it would tell the owner a grant is live when it is not.
    expect(text).toContain("spammer: blocked");
  });

  // Was "renders the administrator-filtered menu rather than raw user grants".
  // `allowed_tasks` became `max_clearance` in #379 — same administrator
  // ceiling, applied to how much a caller may be told rather than to which
  // tasks they may run — so this pins the same property on the new lever.
  it("renders the administrator-capped clearance rather than the raw user grant", () => {
    const h = home();
    const p = managedLinePaths(h);
    writeSkill(h, "intro", "---\ndescription: d\n---\n");
    writeFileSync(p.policyFile, JSON.stringify({
      default_clearance: "internal", callers: { mia: { clearance: "internal" } },
    }));
    writeFileSync(p.machine.managedPolicyFile, JSON.stringify({ version: 1, max_clearance: "public" }));

    const text = buildCardReport(cfg, p).menu.join("\n");
    expect(text).toContain("Anyone registered can be told: public");
    expect(text).toContain("mia: public");
    expect(text).not.toContain("internal");
  });
});
