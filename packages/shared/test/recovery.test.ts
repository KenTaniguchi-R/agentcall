import { describe, expect, it } from "vitest";
import { generateRecoveryCode, normalizeRecoveryCode, RECOVERY_PREFIX } from "../src/recovery.js";

describe("generateRecoveryCode", () => {
  it("produces a prefixed, hyphen-grouped 24-char code", () => {
    const code = generateRecoveryCode();
    expect(code.startsWith(RECOVERY_PREFIX)).toBe(true);
    const body = code.slice(RECOVERY_PREFIX.length);
    expect(body.split("-")).toHaveLength(6);
    expect(body.replaceAll("-", "")).toHaveLength(24);
  });

  it("uses only the Crockford alphabet (no I, L, O, U)", () => {
    for (let i = 0; i < 50; i++) {
      const body = generateRecoveryCode().slice(RECOVERY_PREFIX.length).replaceAll("-", "");
      expect(body).toMatch(/^[0-9ABCDEFGHJKMNPQRSTVWXYZ]{24}$/);
    }
  });

  it("does not repeat", () => {
    const seen = new Set(Array.from({ length: 200 }, () => generateRecoveryCode()));
    expect(seen.size).toBe(200);
  });
});

describe("normalizeRecoveryCode", () => {
  it("round-trips a generated code to a 24-char canonical body", () => {
    const code = generateRecoveryCode();
    const normalized = normalizeRecoveryCode(code);
    expect(normalized).toMatch(/^[0-9ABCDEFGHJKMNPQRSTVWXYZ]{24}$/);
  });

  it("accepts the code without prefix, without hyphens, and lowercased", () => {
    const code = generateRecoveryCode();
    const canonical = normalizeRecoveryCode(code);
    const body = code.slice(RECOVERY_PREFIX.length);
    expect(normalizeRecoveryCode(body)).toBe(canonical);
    expect(normalizeRecoveryCode(body.replaceAll("-", ""))).toBe(canonical);
    expect(normalizeRecoveryCode(code.toLowerCase())).toBe(canonical);
    expect(normalizeRecoveryCode(`  ${code}  `)).toBe(canonical);
  });

  it("maps Crockford's confusable characters", () => {
    // I and L read as 1; O reads as 0. This is what makes a hand-copied
    // code survive being read off a sticky note.
    expect(normalizeRecoveryCode("I".repeat(24))).toBe("1".repeat(24));
    expect(normalizeRecoveryCode("i".repeat(24))).toBe("1".repeat(24));
    expect(normalizeRecoveryCode("L".repeat(24))).toBe("1".repeat(24));
    expect(normalizeRecoveryCode("O".repeat(24))).toBe("0".repeat(24));
    // Mixed into a real code, the confusables normalize in place.
    expect(normalizeRecoveryCode("IO" + "A".repeat(22))).toBe("10" + "A".repeat(22));
  });

  it("rejects malformed input", () => {
    expect(normalizeRecoveryCode("")).toBeNull();
    expect(normalizeRecoveryCode("agcr_")).toBeNull();
    expect(normalizeRecoveryCode("A".repeat(23))).toBeNull();
    expect(normalizeRecoveryCode("A".repeat(25))).toBeNull();
    // U is excluded from Crockford entirely and is not a confusable.
    expect(normalizeRecoveryCode("U".repeat(24))).toBeNull();
    expect(normalizeRecoveryCode("!".repeat(24))).toBeNull();
  });
});
