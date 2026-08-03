import { describe, expect, it } from "vitest";
import { canonicalEncode } from "../src/canonical.js";

describe("canonicalEncode", () => {
  it("is deterministic for the same input", () => {
    const a = canonicalEncode(["ken", 7, null]);
    const b = canonicalEncode(["ken", 7, null]);
    expect(Array.from(a)).toEqual(Array.from(b));
  });

  it("distinguishes values that concatenate identically", () => {
    // Without length prefixes, ["ab","c"] and ["a","bc"] would both be "abc".
    const a = canonicalEncode(["ab", "c"]);
    const b = canonicalEncode(["a", "bc"]);
    expect(Array.from(a)).not.toEqual(Array.from(b));
  });

  it("distinguishes a null from the string 'null'", () => {
    expect(Array.from(canonicalEncode([null]))).not.toEqual(
      Array.from(canonicalEncode(["null"])),
    );
  });

  it("distinguishes a number from its decimal string", () => {
    expect(Array.from(canonicalEncode([7]))).not.toEqual(
      Array.from(canonicalEncode(["7"])),
    );
  });

  it("encodes multi-byte characters by UTF-8 byte length", () => {
    // "あ" is 3 UTF-8 bytes: tag(1) + length(4) + 3 = 8.
    expect(canonicalEncode(["あ"]).byteLength).toBe(8);
  });

  it("rejects a non-integer number", () => {
    expect(() => canonicalEncode([1.5])).toThrow(/integer/i);
  });

  it("rejects a number outside the safe integer range", () => {
    expect(() => canonicalEncode([Number.MAX_SAFE_INTEGER + 2])).toThrow(/integer/i);
  });
});
