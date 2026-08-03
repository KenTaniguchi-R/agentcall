import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const root = join(import.meta.dirname, "../../..");

describe("container listener deployment", () => {
  it("runs the foreground listener as a non-root process without an in-container service manager", () => {
    const dockerfile = readFileSync(join(root, "Dockerfile.listener"), "utf8");

    expect(dockerfile).toContain("ARG AGENT_PACKAGE");
    expect(dockerfile).toMatch(/USER agentcall\s*\nENTRYPOINT \["agentcall", "listen"\]/);
    expect(dockerfile).not.toContain("systemctl");
    expect(dockerfile).not.toContain("launchctl");
  });

  it("isolates container credentials and mounts the selected workdir read-only by default", () => {
    const compose = parse(readFileSync(join(root, "compose.listener.yaml"), "utf8")) as {
      services: { listener: { init: boolean; restart: string; volumes: string[] } };
    };
    const listener = compose.services.listener;

    expect(listener.init).toBe(true);
    expect(listener.restart).toBe("unless-stopped");
    expect(listener.volumes).toEqual([
      "agentcall-listener-home:/home/agentcall",
      "${AGENTCALL_WORKDIR}:${AGENTCALL_WORKDIR}:ro",
    ]);
  });
});
