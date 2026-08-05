import { describe, expect, it, vi } from "vitest";
import { ApiError } from "../src/api.js";
import { errorMessage, fail } from "../src/errors.js";

// These two helpers replaced three hand-rolled spellings of the same catch
// block across packages/cli/src/commands. The spellings were already
// equivalent -- ApiError extends Error, so its `instanceof ApiError` branch
// produced the same `.message` the Error branch did -- and these tests pin
// that equivalence so the consolidation can't quietly change what a failing
// command prints.
describe("errorMessage", () => {
  it("uses .message for an Error", () => {
    expect(errorMessage(new Error("boom"))).toBe("boom");
  });

  it("uses .message for an ApiError, matching the plain Error branch", () => {
    expect(errorMessage(new ApiError("relay said no", "unauthorized"))).toBe("relay said no");
  });

  it("stringifies a non-Error throw", () => {
    expect(errorMessage("just a string")).toBe("just a string");
    expect(errorMessage(42)).toBe("42");
    expect(errorMessage(undefined)).toBe("undefined");
    expect(errorMessage(null)).toBe("null");
  });

  it("stringifies a thrown object without inventing a message", () => {
    expect(errorMessage({ code: "nope" })).toBe("[object Object]");
  });
});

describe("fail", () => {
  it("prints the message to stderr and sets exit code 1", () => {
    const previous = process.exitCode;
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      fail(new Error("could not reach the relay"));
      expect(spy).toHaveBeenCalledExactlyOnceWith("could not reach the relay");
      expect(process.exitCode).toBe(1);
    } finally {
      spy.mockRestore();
      process.exitCode = previous;
    }
  });

  it("appends a hint on its own line when one is given", () => {
    const previous = process.exitCode;
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      fail(new Error("saving failed"), "Try a different name.");
      expect(spy).toHaveBeenCalledExactlyOnceWith("saving failed\nTry a different name.");
      expect(process.exitCode).toBe(1);
    } finally {
      spy.mockRestore();
      process.exitCode = previous;
    }
  });

  it("still sets exit code 1 for a non-Error throw", () => {
    const previous = process.exitCode;
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      fail("plain string");
      expect(spy).toHaveBeenCalledExactlyOnceWith("plain string");
      expect(process.exitCode).toBe(1);
    } finally {
      spy.mockRestore();
      process.exitCode = previous;
    }
  });
});
