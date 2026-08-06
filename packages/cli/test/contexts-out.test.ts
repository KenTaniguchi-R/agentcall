import { statSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  forgetOutbound, loadOutbound, matchOutbound, rememberOutbound, type OutboundContext,
} from "../src/contexts-out.js";
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

  it("replaces the entry for the same relay/from/to/task rather than appending", () => {
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

  // The regression this keying exists for. Keyed on (relay, from, to) alone,
  // opening a second conversation with the same callee on a different task
  // silently discarded the first -- while the CALLEE kept its binding, since it
  // keys by task and holds MAX_CONTEXTS of them. Only the caller's half was
  // lost, so --continue then reported "no open conversation" for a thread that
  // was still perfectly live on the other side.
  it("keeps two conversations with the same callee on different tasks apart", () => {
    const p = paths();
    rememberOutbound(p, entry({ task: "review" }));
    rememberOutbound(p, entry({ task: "triage", context_id: "ctx_BBBBBBBBBBBBBBBBBBBBBB", at: 2 }));
    expect(loadOutbound(p).map((e) => e.task).sort()).toEqual(["review", "triage"]);
  });

  it("matches every conversation with a callee when no task is given, newest first", () => {
    const list = [
      entry({ task: "triage", context_id: "ctx_BBBBBBBBBBBBBBBBBBBBBB", at: 2 }),
      entry({ task: "review" }),
      entry({ to: "mika", context_id: "ctx_CCCCCCCCCCCCCCCCCCCCCC" }),
    ];
    expect(matchOutbound(list, { relay: "https://r", from: "ken", to: "sota" }).map((e) => e.task))
      .toEqual(["triage", "review"]);
  });

  it("matches only the named task when one is given", () => {
    const list = [entry({ task: "review" }), entry({ task: "triage", context_id: "ctx_BBBBBBBBBBBBBBBBBBBBBB" })];
    const found = matchOutbound(list, { relay: "https://r", from: "ken", to: "sota", task: "triage" });
    expect(found).toHaveLength(1);
    expect(found[0]!.context_id).toBe("ctx_BBBBBBBBBBBBBBBBBBBBBB");
    expect(matchOutbound(list, { relay: "https://other", from: "ken", to: "sota" })).toEqual([]);
  });

  it("forgets one task's conversation and leaves the callee's others", () => {
    const p = paths();
    rememberOutbound(p, entry({ task: "review" }));
    rememberOutbound(p, entry({ task: "triage", context_id: "ctx_BBBBBBBBBBBBBBBBBBBBBB", at: 2 }));
    forgetOutbound(p, { relay: "https://r", from: "ken", to: "sota", task: "review" });
    expect(loadOutbound(p).map((e) => e.task)).toEqual(["triage"]);
  });

  it("forgets every conversation with a callee when no task is given", () => {
    const p = paths();
    rememberOutbound(p, entry({ task: "review" }));
    rememberOutbound(p, entry({ task: "triage", context_id: "ctx_BBBBBBBBBBBBBBBBBBBBBB", at: 2 }));
    rememberOutbound(p, entry({ to: "mika", context_id: "ctx_CCCCCCCCCCCCCCCCCCCCCC" }));
    forgetOutbound(p, { relay: "https://r", from: "ken", to: "sota" });
    expect(loadOutbound(p).map((e) => e.to)).toEqual(["mika"]);
  });

  it("leaves the store alone when nothing matches", () => {
    const p = paths();
    rememberOutbound(p, entry());
    forgetOutbound(p, { relay: "https://r", from: "ken", to: "nobody" });
    expect(loadOutbound(p)).toHaveLength(1);
  });
});
