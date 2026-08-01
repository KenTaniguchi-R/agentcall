import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildCardReport } from "../src/lint.js";
import { publishCard } from "../src/card.js";
import { getPaths } from "../src/paths.js";
import type { Config } from "../src/config.js";

const cfg: Config = { handle: "ken", token: "t", agent_kind: "claude", relay: "https://r" };

function home() {
  const h = mkdtempSync(join(tmpdir(), "agentcall-lint-"));
  mkdirSync(join(h, ".agentcall"), { recursive: true });
  return h;
}
function writeSkill(h: string, id: string, skillMd: string) {
  const dir = join(h, "AgentCall", "tasks", id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), skillMd);
}

describe("buildCardReport", () => {
  it("renders the default menu and a never-pushed notice on a fresh install", () => {
    const p = getPaths(home());
    const r = buildCardReport(cfg, p);
    expect(r.menu.join("\n")).toContain("ask");
    expect(r.problems).toEqual([]);
    expect(r.notices.join("\n")).toContain("never been pushed");
  });

  it("surfaces skipped-manifest warnings as problems", () => {
    const h = home();
    writeSkill(h, "broken", "# no frontmatter\n");
    const r = buildCardReport(cfg, getPaths(h));
    expect(r.problems.join("\n")).toContain("broken");
  });

  it("flags policy references to tasks that do not exist", () => {
    const h = home();
    const p = getPaths(h);
    writeFileSync(p.policyFile, JSON.stringify({
      default_offer: ["ask", "gone"], callers: { mia: { offer: ["also-gone"], block: false } },
    }));
    const r = buildCardReport(cfg, p);
    expect(r.problems.join("\n")).toContain('"gone"');
    expect(r.problems.join("\n")).toContain('"also-gone"');
  });

  it("reports a malformed policy file as a problem instead of throwing", () => {
    const p = getPaths(home());
    writeFileSync(p.policyFile, "{corrupt");
    const r = buildCardReport(cfg, p);
    expect(r.problems.join("\n")).toContain("policy.json");
  });

  it("is quiet after a push and stale after a change", async () => {
    const h = home();
    const p = getPaths(h);
    await publishCard(cfg, p, async () => {});
    expect(buildCardReport(cfg, p).notices).toEqual([]);
    writeSkill(h, "intro", "---\ndescription: d\n---\nbody\n");
    writeFileSync(p.policyFile, JSON.stringify({ default_offer: ["ask", "intro"], callers: {} }));
    const r = buildCardReport(cfg, p);
    expect(r.notices.join("\n")).toContain("out of date");
  });

  it("reports an unreadable card snapshot as a notice, not a problem", () => {
    const p = getPaths(home());
    writeFileSync(p.cardSnapshotFile, "{corrupt");
    const r = buildCardReport(cfg, p);
    expect(r.notices.join("\n")).toContain("snapshot unreadable");
    expect(r.problems).toEqual([]);
  });

  it("warns that codex gives no per-tool exec restriction when a task's tools exclude exec", () => {
    const h = home();
    writeSkill(h, "intro", "---\ndescription: d\ntools: [read]\n---\n");
    const p = getPaths(h);
    writeFileSync(p.policyFile, JSON.stringify({ default_offer: ["ask", "intro"], callers: {} }));
    const codexCfg: Config = { ...cfg, agent_kind: "codex" };
    const r = buildCardReport(codexCfg, p);
    expect(r.notices.join("\n")).toMatch(/intro/);
    expect(r.notices.join("\n")).toMatch(/codex/i);
  });

  it("does not warn about the codex exec gap for a claude-backed agent", () => {
    const h = home();
    writeSkill(h, "intro", "---\ndescription: d\ntools: [read]\n---\n");
    const p = getPaths(h);
    writeFileSync(p.policyFile, JSON.stringify({ default_offer: ["ask", "intro"], callers: {} }));
    const r = buildCardReport(cfg, p);
    expect(r.notices.join("\n")).not.toMatch(/codex/i);
  });

  it("does not warn about the ask task itself, and not about a task that already declares exec", () => {
    const h = home();
    writeSkill(h, "runner", "---\ndescription: d\ntools: [read, exec]\n---\n");
    const p = getPaths(h);
    writeFileSync(p.policyFile, JSON.stringify({ default_offer: ["ask", "runner"], callers: {} }));
    const codexCfg: Config = { ...cfg, agent_kind: "codex" };
    const r = buildCardReport(codexCfg, p);
    expect(r.notices.join("\n")).not.toMatch(/codex/i);
  });

  it("lists per-caller grants and blocked callers in the menu", () => {
    const h = home();
    const p = getPaths(h);
    writeSkill(h, "intro", "---\ndescription: d\n---\n");
    writeFileSync(p.policyFile, JSON.stringify({
      default_offer: ["ask"],
      callers: { mia: { offer: ["intro"], block: false }, spammer: { offer: [], block: true } },
    }));
    const text = buildCardReport(cfg, p).menu.join("\n");
    expect(text).toContain("mia: intro");
    expect(text).toContain("Blocked: spammer");
  });
});
