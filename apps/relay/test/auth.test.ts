import { describe, expect, it } from "vitest";
import { constantTimeEqual } from "../src/auth.js";

describe("constantTimeEqual", () => {
  it("matches equal strings", () => {
    expect(constantTimeEqual("a".repeat(64), "a".repeat(64))).toBe(true);
  });

  it("does not match a single-character difference", () => {
    const a = "0123456789abcdef".repeat(4);
    const b = "0123456789abcdee".repeat(4);
    expect(constantTimeEqual(a, b)).toBe(false);
  });

  it("does not match strings of different lengths", () => {
    expect(constantTimeEqual("abc", "abcd")).toBe(false);
    expect(constantTimeEqual("", "a")).toBe(false);
  });
});
