import { SELF } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { registerHandle, wsAuth, agentIdFor} from "./helpers.js";

const card = (tasks: unknown[], blocked: string[] = []) => ({
  description: "d", agent_kind: "claude", tasks, blocked,
});
const task = (id: string, keywords: string[] = []) =>
  ({ id, name: id.toUpperCase(), description: `About ${id}.`, examples: [], keywords });

async function setup(prefix: string) {
  const ownerToken = await registerHandle(`${prefix}own`);
  const created = await (await SELF.fetch("https://relay.test/v1/roster", {
    method: "POST", headers: { "cf-connecting-ip": `test-${prefix}`, ...wsAuth(`${prefix}own`, ownerToken) },
  })).json<{ roster_id: string; join_key: string; admin_secret: string }>();
  return { ownerToken, ...created };
}

async function joinAs(id: string, handle: string, secret: string) {
  const token = await registerHandle(handle);
  await SELF.fetch(`https://relay.test/v1/roster/${id}/join`, {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": `test-${handle}`, ...wsAuth(handle, token) },
    body: JSON.stringify({ join_key: secret }),
  });
  return token;
}

async function putCard(handle: string, token: string, body: unknown) {
  return SELF.fetch("https://relay.test/v1/card", {
    method: "PUT",
    headers: { "content-type": "application/json", ...wsAuth(handle, token) },
    body: JSON.stringify(body),
  });
}

const getBundle = (id: string, handle: string, token: string, extra: Record<string, string> = {}) =>
  SELF.fetch(`https://relay.test/v1/roster/${id}/bundle`, {
    headers: { "cf-connecting-ip": `test-${handle}`, ...wsAuth(handle, token), ...extra },
  });

describe("GET /v1/roster/:id/bundle", () => {
  it("returns members' tasks to a member", async () => {
    const r = await setup("b1");
    const tanaka = await joinAs(r.roster_id, "b1tanaka", r.join_key);
    await putCard("b1tanaka", tanaka, card([task("adr", ["auth"])]));
    const body = await (await getBundle(r.roster_id, "b1own", r.ownerToken)).json<any>();
    expect(body.entries.map((e: any) => e.handle)).toEqual(["b1tanaka"]);
    expect(body.entries[0].tasks[0].keywords).toEqual(["auth"]);
  });

  // Replaces the three tests that pinned per-caller grants, roster-attested
  // group grants, and the windowed shared-roster cap that kept the bundle and
  // the direct card view agreeing about them. #379 deleted all three from the
  // card, so the bundle cannot vary by viewer at all — and the two views
  // agreeing is now structural rather than something a cap has to enforce.
  // Both halves are still worth pinning: a reintroduced per-viewer filter here
  // would silently narrow a member's discoverability.
  it("shows every member the same tasks, and the same list the direct card serves", async () => {
    const r = await setup("b2");
    const tanaka = await joinAs(r.roster_id, "b2tanaka", r.join_key);
    const mia = await joinAs(r.roster_id, "b2mia", r.join_key);
    await putCard("b2tanaka", tanaka, card([task("ask"), task("payroll")]));
    const ids = (b: any, h: string) => b.entries.find((e: any) => e.handle === h).tasks.map((t: any) => t.id);
    for (const [handle, token] of [["b2mia", mia], ["b2own", r.ownerToken]] as const) {
      const bundle = await (await getBundle(r.roster_id, handle, token)).json<any>();
      expect(ids(bundle, "b2tanaka")).toEqual(["ask", "payroll"]);
      const direct = await (await SELF.fetch("https://relay.test/v1/card/b2tanaka", {
        headers: wsAuth(handle, token),
      })).json<any>();
      expect(direct.tasks.map((t: any) => t.id)).toEqual(["ask", "payroll"]);
    }
  });

  // The claim the first design draft got wrong: an entry carrying a handle
  // still discloses membership even with zero tasks. Omission is what makes
  // a member invisible. This endpoint is a search index, not a directory.
  //
  // A block is now the only way a member has no visible tasks for a given
  // viewer — the case this test used to reach through an ungranted task.
  it("omits a member with no visible tasks entirely", async () => {
    const r = await setup("b3");
    const quiet = await joinAs(r.roster_id, "b3quiet", r.join_key);
    await putCard("b3quiet", quiet, card([task("payroll")], ["b3own"]));
    const body = await (await getBundle(r.roster_id, "b3own", r.ownerToken)).json<any>();
    expect(body.entries.map((e: any) => e.handle)).not.toContain("b3quiet");
  });

  it("omits a member who has published no card at all", async () => {
    const r = await setup("b4");
    await joinAs(r.roster_id, "b4nocard", r.join_key);
    const body = await (await getBundle(r.roster_id, "b4own", r.ownerToken)).json<any>();
    expect(body.entries.map((e: any) => e.handle)).not.toContain("b4nocard");
  });

  it("makes a non-member byte-identical to an unknown roster", async () => {
    const r = await setup("b5");
    const outsider = await registerHandle("b5out");
    const denied = await getBundle(r.roster_id, "b5out", outsider);
    const missing = await getBundle("A".repeat(22), "b5out", outsider);
    expect(denied.status).toBe(missing.status);
    expect(await denied.text()).toBe(await missing.text());
    expect(denied.status).toBe(404);
  });

  it("401s without credentials", async () => {
    const r = await setup("b6");
    expect((await SELF.fetch(`https://relay.test/v1/roster/${r.roster_id}/bundle`)).status).toBe(401);
  });

  it("caps tasks per member and flags the entry as truncated", async () => {
    const r = await setup("b7");
    const many = await joinAs(r.roster_id, "b7many", r.join_key);
    const ids = Array.from({ length: 15 }, (_, i) => `t${i}`);
    await putCard("b7many", many, card(ids.map((id) => task(id))));
    const body = await (await getBundle(r.roster_id, "b7own", r.ownerToken)).json<any>();
    const entry = body.entries.find((e: any) => e.handle === "b7many");
    expect(entry.tasks).toHaveLength(10);
    expect(entry.truncated).toBe(true);
  });

  it("skips a malformed stored card without 500ing the whole bundle", async () => {
    const r = await setup("b8");
    const good = await joinAs(r.roster_id, "b8good", r.join_key);
    await joinAs(r.roster_id, "b8bad", r.join_key);
    await putCard("b8good", good, card([task("adr")]));
    const db = (await import("cloudflare:test")).env.DB;
    await db.prepare("INSERT INTO cards (org, agent_id, card_json, updated_at) VALUES (?, ?, ?, ?)")
      .bind("acme", await agentIdFor("b8bad"), "{not json", Date.now()).run();
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const res = await getBundle(r.roster_id, "b8own", r.ownerToken);
      expect(res.status).toBe(200);
      const body = await res.json<any>();
      expect(body.entries.map((e: any) => e.handle)).toEqual(["b8good"]);
      expect(body.skipped).toBe(1);
      expect(log).toHaveBeenCalledWith("invalid stored card", {
        org: "acme", handle: "b8bad", error: "SyntaxError",
      });
    } finally {
      log.mockRestore();
    }
  });

  it("304s an unchanged bundle and forbids shared caching", async () => {
    const r = await setup("b9");
    const t = await joinAs(r.roster_id, "b9t", r.join_key);
    await putCard("b9t", t, card([task("adr")]));
    const first = await getBundle(r.roster_id, "b9own", r.ownerToken);
    expect(first.headers.get("Cache-Control")).toContain("private");
    const etag = first.headers.get("ETag")!;
    expect(etag).toBeTruthy();
    const second = await getBundle(r.roster_id, "b9own", r.ownerToken, { "If-None-Match": etag });
    expect(second.status).toBe(304);
  });

  // Was "changes its ETag when membership changes visible group-granted
  // tasks". Group grants are gone, but the property that test existed to
  // protect is not: a conditional request must never retain stale
  // authorization. A block is now what changes a viewer's projection without
  // changing the entry count, so it is what this drives instead.
  it("changes its ETag when a card starts blocking the viewer", async () => {
    const r = await setup("betag");
    const target = await joinAs(r.roster_id, "betagtarget", r.join_key);
    const viewer = await joinAs(r.roster_id, "betagviewer", r.join_key);
    await putCard("betagtarget", target, card([task("ask"), task("payroll")]));

    const first = await getBundle(r.roster_id, "betagviewer", viewer);
    const firstEtag = first.headers.get("ETag")!;
    const firstBody = await first.json<any>();
    expect(firstBody.entries.find((entry: any) => entry.handle === "betagtarget")
      .tasks.map((candidate: any) => candidate.id)).toEqual(["ask", "payroll"]);

    await putCard("betagtarget", target, card([task("ask"), task("payroll")], ["betagviewer"]));
    const changed = await getBundle(r.roster_id, "betagviewer", viewer, { "If-None-Match": firstEtag });
    const changedBody = await changed.json<any>();

    expect(changed.status).toBe(200);
    expect(changed.headers.get("ETag")).not.toBe(firstEtag);
    expect(changedBody.entries.map((entry: any) => entry.handle)).not.toContain("betagtarget");
  });

  it("gives two different callers different ETags", async () => {
    const r = await setup("b10");
    const t = await joinAs(r.roster_id, "b10t", r.join_key);
    const mia = await joinAs(r.roster_id, "b10mia", r.join_key);
    await putCard("b10t", t, card([task("ask")]));
    const a = await getBundle(r.roster_id, "b10own", r.ownerToken);
    const b = await getBundle(r.roster_id, "b10mia", mia);
    expect(a.headers.get("ETag")).not.toBe(b.headers.get("ETag"));
  });
});
