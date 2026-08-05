import { statSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { findOutbound, loadOutbound, rememberOutbound, type OutboundContext } from "../src/contexts-out.js";
import { getLinePaths, getMachinePaths } from "../src/paths.js";
import { tempLine } from "./helpers.js";

const paths = () => tempLine("claude", "agentcall-out-");
const entry = (over: Partial<OutboundContext> = {}): OutboundContext => ({
  relay: "https://r", from: "ken", to: "sota", task: "ask",
  context_id: "ctx_AAAAAAAAAAAAAAAAAAAAAA", at: 1, ...over,
});

describe("outbound contexts", () => {
  it("round-trips", () => {
    const p = paths();
    rememberOutbound(p, entry());
    expect(loadOutbound(p)).toEqual([entry()]);
  });

  it("returns empty when missing or malformed", () => {
    expect(loadOutbound(paths())).toEqual([]);
  });

  // Same reasoning as the contacts store: an in-place rewrite has a truncation
  // window, and a truncated store parses as malformed. This one fails safe to
  // "nothing stored", so the cost is a silently dropped --continue rather than
  // an error — quieter, and worth the same atomic replace. A new inode is the
  // observable evidence that a rename, not a rewrite, happened.
  it("replaces the file rather than rewriting it in place", () => {
    const p = paths();
    rememberOutbound(p, entry());
    const before = statSync(p.contextsOutFile).ino;
    rememberOutbound(p, entry({ to: "other" }));
    expect(statSync(p.contextsOutFile).ino).not.toBe(before);
    expect(loadOutbound(p)).toHaveLength(2);
  });

  it("replaces the entry for the same relay/from/to rather than appending", () => {
    const p = paths();
    rememberOutbound(p, entry());
    rememberOutbound(p, entry({ context_id: "ctx_BBBBBBBBBBBBBBBBBBBBBB", at: 2 }));
    const all = loadOutbound(p);
    expect(all).toHaveLength(1);
    expect(all[0]!.context_id).toBe("ctx_BBBBBBBBBBBBBBBBBBBBBB");
  });

  it("keeps entries for different callees apart", () => {
    const p = paths();
    rememberOutbound(p, entry());
    rememberOutbound(p, entry({ to: "mika", context_id: "ctx_CCCCCCCCCCCCCCCCCCCCCC" }));
    expect(loadOutbound(p)).toHaveLength(2);
  });

  it("finds by relay, from and to", () => {
    const list = [entry(), entry({ to: "mika", context_id: "ctx_CCCCCCCCCCCCCCCCCCCCCC" })];
    expect(findOutbound(list, { relay: "https://r", from: "ken", to: "mika" })!.context_id)
      .toBe("ctx_CCCCCCCCCCCCCCCCCCCCCC");
    expect(findOutbound(list, { relay: "https://other", from: "ken", to: "sota" })).toBeUndefined();
  });
});
