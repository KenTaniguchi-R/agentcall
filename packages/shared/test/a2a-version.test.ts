import { describe, expect, it } from "vitest";
import { A2A_PROTOCOL_VERSION, A2A_VERSION_HEADER, isSupportedA2AVersion } from "../src/index.js";

describe("A2A version negotiation", () => {
  it("advertises 1.0", () => {
    expect(A2A_PROTOCOL_VERSION).toBe("1.0");
    expect(A2A_VERSION_HEADER).toBe("A2A-Version");
  });

  it("accepts an absent header", () => {
    expect(isSupportedA2AVersion(undefined)).toBe(true);
    expect(isSupportedA2AVersion(null)).toBe(true);
    expect(isSupportedA2AVersion("")).toBe(true);
  });

  it("accepts the advertised version", () => {
    expect(isSupportedA2AVersion("1.0")).toBe(true);
  });

  it("tolerates surrounding whitespace", () => {
    expect(isSupportedA2AVersion("  1.0 ")).toBe(true);
  });

  it("rejects any other version", () => {
    for (const v of ["0.3", "1.1", "2.0", "banana"]) {
      expect(isSupportedA2AVersion(v)).toBe(false);
    }
  });
});
