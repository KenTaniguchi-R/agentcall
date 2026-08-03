import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ENTRY = join(process.cwd(), "dist", "tool-telemetry-entry.js");

describe("tool-telemetry-entry as a real process", () => {
  it("records a sanitized explicit failure without exporting the error or tool payload", () => {
    const dir = mkdtempSync(join(tmpdir(), "agentcall-tool-entry-"));
    const spool = join(dir, "events.jsonl");
    try {
      writeFileSync(spool, "", { mode: 0o600 });
      execFileSync(process.execPath, [ENTRY], {
        input: JSON.stringify({
          hook_event_name: "PostToolUseFailure",
          tool_name: "Bash",
          tool_use_id: "toolu_1",
          tool_input: { command: "echo private-command" },
          error: "private-error-detail",
          duration_ms: 42,
        }),
        env: {
          ...process.env,
          AGENTCALL_CALL_ID: "call-1",
          AGENTCALL_TOOL_TELEMETRY_FILE: spool,
        },
        stdio: ["pipe", "pipe", "pipe"],
      });
      const raw = readFileSync(spool, "utf8").trim();
      expect(JSON.parse(raw)).toMatchObject({
        phase: "post", call_id: "call-1", tool_use_id: "toolu_1", tool_name: "Bash",
        outcome: "error", duration_ms: 42,
      });
      expect(raw).not.toContain("private-command");
      expect(raw).not.toContain("private-error-detail");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
