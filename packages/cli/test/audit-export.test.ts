import { describe, expect, it } from "vitest";
import type { AuditExportEventType } from "@benree/agentcall-shared";
import { auditCsvRow, csvCell, parseAuditFilter, parseAuditTime } from "../src/commands/audit-export.js";

describe("audit export helpers", () => {
  it("parses epoch and ISO times and rejects invalid values", () => {
    expect(parseAuditTime("123", "--after")).toBe(123);
    expect(parseAuditTime("1970-01-01T00:00:01Z", "--after")).toBe(1000);
    expect(() => parseAuditTime("nope", "--after")).toThrow("--after");
  });

  it("bounds filters by UTF-8 bytes", () => {
    expect(parseAuditFilter("ok", "--actor")).toBe("ok");
    expect(() => parseAuditFilter("あ".repeat(86), "--actor")).toThrow("256 UTF-8 bytes");
  });

  it("neutralizes spreadsheet formulas and quotes CSV cells", () => {
    expect(csvCell("=SUM(A1)")).toBe("'=SUM(A1)");
    expect(csvCell("a,b")).toBe('"a,b"');
    expect(auditCsvRow({ ledger: "org", id: 1, event: "x", action_type: "C", roster_id: null, actor: "a", actor_type: "human", target_type: null, target_id: null, target_role: null, actor_ip: null, actor_country: null, description: "ok", at: 1 } as AuditExportEventType)).toContain("org,1,x,C");
  });
});
