import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { findOutbound, loadOutbound, rememberOutbound, type OutboundContext } from "../src/contextsOut.js";
import { getPaths } from "../src/paths.js";

const paths = () => getPaths(mkdtempSync(join(tmpdir(), "agentcall-out-")));
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
