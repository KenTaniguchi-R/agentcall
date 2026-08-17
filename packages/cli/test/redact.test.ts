import { describe, expect, it } from "vitest";
import { REDACTED_MARKER, redactOutbound } from "../src/redact.js";

// Every fixture below is assembled from parts at runtime rather than written as
// a literal. A credential-shaped literal in a tracked file is flagged by every
// secret scanner, forever — including the one #173 proposes adding, which
// failed this very PR on its first push. The test for a redactor is the worst
// possible place to be arguing about a scanner false positive, and assembling
// the fixture costs nothing.
const ALPHA = "abcdefghijklmnopqrstuvwxyz";
const cred = (prefix: string, body: string): string => prefix + body;

// The reply transport is E2EE, so the callee's own process is the last and only
// place a leaked credential can be caught. These cases are the floor, not a DLP
// system — see #173 for the scanning-service question.
describe("redactOutbound — third-party credential shapes", () => {
  it.each([
    [cred("sk-", `ant-api03-${ALPHA}0123456789`), "Anthropic key"],
    [cred("sk-", `proj-${ALPHA}012345`), "OpenAI project key"],
    [cred("ghp", `_${ALPHA}0123456789AB`), "GitHub personal token"],
    [cred("gho", `_${ALPHA}0123456789AB`), "GitHub OAuth token"],
    [cred("ghs", `_${ALPHA}0123456789AB`), "GitHub server token"],
    [cred("github", `_pat_11ABCDEFG0abcdefghij_kLmNoPqRsTuVwXyZ0123456789`), "fine-grained PAT"],
    [cred("AKI", "AIOSFODNN7EXAMPLE"), "AWS access key id"],
    [cred("ASI", "AIOSFODNN7EXAMPLE"), "AWS temporary key id"],
  ])("redacts %s (%s)", (secret) => {
    const out = redactOutbound(`here it is: ${secret} — use it`);
    expect(out).not.toContain(secret);
    expect(out).toContain(REDACTED_MARKER);
  });

  it("redacts a JWT", () => {
    // Header, payload, signature — the leading "eyJ" is what the pattern
    // anchors on, since a JSON object always base64url-encodes to it.
    const jwt = ["eyJ", "hbGciOiJIUzI1NiJ9"].join("")
      + "." + ["eyJ", "zdWIiOiIxMjM0NTY3ODkwIn0"].join("")
      + "." + `${ALPHA}0123456789_-`;
    expect(redactOutbound(jwt)).not.toContain(jwt);
  });

  it("redacts a bearer credential in a header line", () => {
    const body = `${ALPHA}123456`;
    expect(redactOutbound(`Authorization: Bearer ${body}`)).not.toContain(body);
  });

  it("redacts every occurrence, not just the first", () => {
    const a = cred("ghp", `_${"a".repeat(40)}`);
    const b = cred("ghp", `_${"b".repeat(40)}`);
    expect(redactOutbound(`${a} and ${b}`)).not.toMatch(/ghp_/);
  });
});

describe("redactOutbound — AgentCall's own credentials", () => {
  // generateToken() is 32 random bytes as base64url — 43 characters with no
  // prefix. There is no shape to match that would not also match ordinary
  // base64, so the machine's own secrets are redacted by exact value instead.
  it("redacts a known secret passed in by value", () => {
    const token = ["Zm9vYmFy", "YmF6cXV4", "Zm9vYmFy", "YmF6cXV4", "Zm9vYmFy"].join("");
    const out = redactOutbound(`the token is ${token}`, [token]);
    expect(out).toBe(`the token is ${REDACTED_MARKER}`);
  });

  it("redacts a known secret wherever it appears, including mid-word", () => {
    const token = ["Zm9vYmFy", "YmF6cXV4", "Zm9vYmFy", "YmF6cXV4", "Zm9vYmFy"].join("");
    expect(redactOutbound(`x${token}y`, [token])).toBe(`x${REDACTED_MARKER}y`);
  });

  it("ignores empty or whitespace known secrets instead of redacting everything", () => {
    expect(redactOutbound("perfectly fine reply", ["", "   "])).toBe("perfectly fine reply");
  });

  // A known secret is matched as a bare substring, so a short placeholder is a
  // word filter rather than a credential pattern.
  it("ignores a known secret too short to be a real credential", () => {
    expect(redactOutbound("the token is in Tokyo", ["tok"])).toBe("the token is in Tokyo");
  });

  it("still redacts a known secret at the length floor", () => {
    const secret = "a".repeat(16);
    expect(redactOutbound(`x ${secret} y`, [secret])).toBe(`x ${REDACTED_MARKER} y`);
  });

  it("treats a known secret as a literal, not a pattern", () => {
    // A secret containing regex metacharacters must not be compiled as one:
    // the dots match dots, not any character.
    const secret = "a.c+d(e)f[g]h.i*j";
    expect(redactOutbound(secret, [secret])).toBe(REDACTED_MARKER);
    expect(redactOutbound("axc+d(e)f[g]h.i*j", [secret])).toBe("axc+d(e)f[g]h.i*j");
  });
});

// A redactor that mangles ordinary replies is one the owner turns off.
describe("redactOutbound — leaves ordinary text alone", () => {
  it.each([
    "The retry in src/index.ts looks correct to me.",
    "CI failed at commit a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0.",
    "See https://example.com/some/path?query=value&other=thing",
    "The sketch is fine, but sk- prefixes are worth watching.",
    // `sk-` is anchored on a word boundary. Without that anchor every
    // hyphenated word containing "sk-" would be redacted — and this repo
    // already has one: "owner-task-with-unbounded-name" in telemetry.test.ts.
    "owner-task-with-unbounded-name",
    "a risk-assessment-framework-for-review",
    "desk-organization-strategies-and-notes",
    "Base64 of 'hello world' is aGVsbG8gd29ybGQ=",
    "Authorization: Bearer",
    "npm install -g @benree/agentcall",
    "```\nconst x = 1;\n```",
  ])("passes through %j unchanged", (text) => {
    expect(redactOutbound(text)).toBe(text);
  });

  it("returns the empty string unchanged", () => {
    expect(redactOutbound("")).toBe("");
  });
});

describe("redactOutbound — the marker is visible, not silent", () => {
  it("replaces rather than deletes", () => {
    expect(redactOutbound(cred("ghp", `_${ALPHA}0123456789AB`))).toBe(REDACTED_MARKER);
  });
});
