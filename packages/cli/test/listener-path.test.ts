import { describe, expect, it } from "vitest";
import { listenerPathDirs, resolveExtraPathDirs } from "../src/listener-path.js";

describe("listener PATH", () => {
  it("resolves the configured agent and npx once", () => {
    const seen: string[] = [];
    const dirs = listenerPathDirs("claude", (name) => {
      seen.push(name);
      return `/opt/${name}/bin/${name}`;
    });
    expect(seen).toEqual(["claude", "npx"]);
    expect(dirs).toEqual(["/opt/claude/bin", "/opt/npx/bin"]);
  });

  it("deduplicates directories and drops ephemeral paths", () => {
    expect(resolveExtraPathDirs(["a", "b", "c"], (name) =>
      name === "c" ? "/tmp/session/c" : `/usr/local/bin/${name}`,
    )).toEqual(["/usr/local/bin"]);
  });
});
