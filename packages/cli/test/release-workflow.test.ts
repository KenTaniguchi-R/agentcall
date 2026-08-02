import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const root = join(import.meta.dirname, "../../..");
const workflow = readFileSync(join(root, ".github/workflows/release.yml"), "utf8");
const ciWorkflow = readFileSync(join(root, ".github/workflows/ci.yml"), "utf8");
const workflowFiles = ["ci.yml", "invariants.yml", "release.yml", "stale-claims.yml"];

function actionReferences(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(actionReferences);
  if (value && typeof value === "object") {
    return Object.entries(value).flatMap(([key, child]) =>
      key === "uses" && typeof child === "string" && !child.startsWith("./")
        ? [child]
        : actionReferences(child));
  }
  return [];
}

describe("npm release workflow", () => {
  it("tests the packed CLI and doctor at the declared Node version floor", () => {
    expect(ciWorkflow).toContain("node: [20, 22, 24]");
    expect(ciWorkflow).toContain('"$agentcall_bin" doctor');
    expect(ciWorkflow).toContain('grep -F "No agentcall config found" "$RUNNER_TEMP/doctor-output"');
  });

  it("binds both published packages to their monorepo source", () => {
    for (const directory of ["shared", "cli"]) {
      const manifest = JSON.parse(readFileSync(join(root, "packages", directory, "package.json"), "utf8"));
      expect(manifest.repository).toEqual({
        type: "git",
        url: "git+https://github.com/KenTaniguchi-R/agentcall.git",
        directory: `packages/${directory}`,
      });
    }
  });

  it("pins every third-party action to an immutable commit", () => {
    const refs = workflowFiles.flatMap((file) => actionReferences(
      parse(readFileSync(join(root, ".github/workflows", file), "utf8")),
    ));
    expect(refs.length).toBeGreaterThan(0);
    expect(refs.every((reference) => /^[^@]+@[0-9a-f]{40}$/.test(reference))).toBe(true);
  });

  it("publishes release tags through OIDC provenance without an npm token", () => {
    expect(workflow).toContain("types: [published]");
    expect(workflow).toContain("git merge-base --is-ancestor HEAD origin/main");
    expect(workflow).toContain("environment: npm");
    expect(workflow).toContain("id-token: write");
    expect(workflow).toContain("NPM_DIST_TAG: ${{ github.event.release.prerelease && 'next' || 'latest' }}");
    expect(workflow).toContain(
      "npm publish \"$tarball\" --provenance --access public --tag \"$NPM_DIST_TAG\"",
    );
    expect(workflow).not.toMatch(/secrets\..*npm|NODE_AUTH_TOKEN:\s*\$\{\{/i);
  });

  it("keeps repository writes separate from npm publishing authority", () => {
    const publish = workflow.slice(workflow.indexOf("  publish:"), workflow.indexOf("  attach:"));
    expect(publish).toContain("id-token: write");
    expect(publish).toContain("contents: read");
    expect(publish).not.toContain("contents: write");
  });

  it("builds an SBOM and publishes the shared dependency before the CLI", () => {
    expect(workflow).toContain("--sbom-format cyclonedx");
    const shared = workflow.lastIndexOf("publish_one @benree/agentcall-shared");
    const cli = workflow.lastIndexOf("publish_one @benree/agentcall ");
    expect(shared).toBeGreaterThan(0);
    expect(cli).toBeGreaterThan(shared);
  });
});
