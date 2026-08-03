import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const root = join(import.meta.dirname, "../../..");
const workflow = readFileSync(join(root, ".github/workflows/release.yml"), "utf8");
const ciWorkflow = readFileSync(join(root, ".github/workflows/ci.yml"), "utf8");
const pagesWorkflow = readFileSync(join(root, ".github/workflows/pages.yml"), "utf8");
const workflowFiles = ["ci.yml", "invariants.yml", "pages.yml", "release.yml", "stale-claims.yml"];

type WorkflowStep = { name?: string; env?: Record<string, unknown>; run?: string };

function publishStep(source: string): WorkflowStep {
  const parsed = parse(source) as { jobs?: { publish?: { steps?: WorkflowStep[] } } };
  const step = parsed.jobs?.publish?.steps?.find((candidate) => candidate.name === "Publish with keyless provenance");
  if (!step) throw new Error("publish step not found");
  return step;
}

function keylessPublishGuardErrors(source: string): string[] {
  const publish = publishStep(source);
  const errors: string[] = [];
  if (publish.env?.NODE_AUTH_TOKEN !== "") errors.push("NODE_AUTH_TOKEN must be pinned empty");
  const firstRegistryCall = publish.run?.indexOf('npm view "$package_name@$version"') ?? -1;
  for (const guard of [
    'test -z "${NODE_AUTH_TOKEN:-}"',
    'test -n "${ACTIONS_ID_TOKEN_REQUEST_URL:-}"',
    'test -n "${ACTIONS_ID_TOKEN_REQUEST_TOKEN:-}"',
  ]) {
    const position = publish.run?.indexOf(guard) ?? -1;
    if (position < 0 || firstRegistryCall < 0 || position >= firstRegistryCall) {
      errors.push(`${guard} must run before the first registry call`);
    }
  }
  return errors;
}

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
  it("publishes the CLI for both supported listener platforms", () => {
    const manifest = JSON.parse(readFileSync(join(root, "packages/cli/package.json"), "utf8"));
    expect(manifest.os).toEqual(["darwin", "linux"]);
  });

  it("tests the packed CLI and doctor at the declared Node version floor", () => {
    expect(ciWorkflow).toContain("node: [20, 22, 24]");
    expect(ciWorkflow).toContain('"$agentcall_bin" doctor');
    expect(ciWorkflow).toContain('grep -F "No agentcall config found" "$RUNNER_TEMP/doctor-output"');
  });

  it("installs the packed CLI on macOS and Linux", () => {
    expect(ciWorkflow).toContain("os: [macos-latest, ubuntu-latest]");
    expect(ciWorkflow).toContain("runs-on: ${{ matrix.os }}");
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

  it("uses the Node 24 GitHub Pages action releases", () => {
    expect(actionReferences(parse(pagesWorkflow))).toEqual([
      "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
      "actions/configure-pages@45bfe0192ca1faeb007ade9deae92b16b8254a0d",
      "actions/upload-pages-artifact@fc324d3547104276b827a68afc52ff2a11cc49c9",
      "actions/deploy-pages@cd2ce8fcbc39b97be8ca5fce6e763baed58fa128",
    ]);
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

  it("asserts keyless authentication inside the exact process that publishes", () => {
    const publish = publishStep(workflow);
    expect(publish.env?.NODE_AUTH_TOKEN).toBe("");
    expect(publish.run).toContain('test -z "${NODE_AUTH_TOKEN:-}"');
    expect(publish.run).toContain('test -n "${ACTIONS_ID_TOKEN_REQUEST_URL:-}"');
    expect(publish.run).toContain('test -n "${ACTIONS_ID_TOKEN_REQUEST_TOKEN:-}"');
    expect(keylessPublishGuardErrors(workflow)).toEqual([]);

    const deliberateRegression = workflow.replace('NODE_AUTH_TOKEN: ""', 'NODE_AUTH_TOKEN: synthetic-token');
    expect(keylessPublishGuardErrors(deliberateRegression)).toContain("NODE_AUTH_TOKEN must be pinned empty");
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
