import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { agentIdFor, registerHandle, wsAuth } from "./helpers.js";

// #154 slice 6: roster membership and the group grants derived from it are
// keyed by the stable agent_id, not by the reusable `@org/handle` address.
//
// These are the acceptance tests the issue is written around — "prove no card,
// roster, policy, task/context, Durable Object, credential, signing-key, or
// audit authority transfers when the same handle is assigned to a different
// agent_id". Membership was the last of those still keyed by address.
//
// There is no rename or reclaim endpoint yet (that is slice 7), so both are
// simulated at the storage boundary. That is not a weaker test: the endpoint
// will do exactly these two row operations, and pinning the property here means
// slice 7 inherits a guarantee rather than having to establish one.

async function create(handle: string) {
  const token = await registerHandle(handle);
  const res = await SELF.fetch(new Request("https://relay.test/v1/roster", {
    method: "POST", headers: { "cf-connecting-ip": handle, ...wsAuth(handle, token) },
  }));
  return { token, ...(await res.json<{ roster_id: string; join_key: string }>()) };
}

async function join(id: string, handle: string, token: string, joinKey: string) {
  return SELF.fetch(new Request(`https://relay.test/v1/roster/${id}/join`, {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": `join-${handle}`, ...wsAuth(handle, token) },
    body: JSON.stringify({ join_key: joinKey }),
  }));
}

/** Membership rows for one roster, as stable identities. */
async function memberIds(rosterId: string): Promise<string[]> {
  const { results } = await env.DB.prepare(
    "SELECT agent_id FROM roster_members WHERE roster_id = ? ORDER BY agent_id",
  ).bind(rosterId).all<{ agent_id: string }>();
  return (results ?? []).map((r) => r.agent_id);
}

/** A rename: same identity, new address. `handles.agent_id` is immutable. */
async function rename(from: string, to: string, org = "acme") {
  await env.DB.prepare("UPDATE handles SET handle = ? WHERE org = ? AND handle = ?")
    .bind(to, org, from).run();
}

describe("roster membership is keyed by identity", () => {
  it("stores the joining identity, not the address it joined under", async () => {
    const r = await create("ri-owner");
    const token = await registerHandle("ri-member");
    await join(r.roster_id, "ri-member", token, r.join_key);

    expect(await memberIds(r.roster_id)).toEqual(
      [await agentIdFor("ri-owner"), await agentIdFor("ri-member")].sort(),
    );
  });

  // The whole point of a stable identity: an address is a label, and changing
  // it must not look like leaving and rejoining.
  it("keeps membership across a rename", async () => {
    const r = await create("ri-rn-owner");
    const token = await registerHandle("ri-rn-member");
    await join(r.roster_id, "ri-rn-member", token, r.join_key);
    const memberId = await agentIdFor("ri-rn-member");

    await rename("ri-rn-member", "ri-rn-renamed");

    expect(await memberIds(r.roster_id)).toContain(memberId);
    expect(await agentIdFor("ri-rn-renamed")).toBe(memberId);
  });

  // The failure this issue exists to prevent. Under the old (org, handle) key
  // this test would PASS a stranger into the roster: they register the freed
  // address and inherit every membership row naming it.
  it("does not transfer membership when a released address is reclaimed", async () => {
    const r = await create("ri-rc-owner");
    const token = await registerHandle("ri-rc-member");
    await join(r.roster_id, "ri-rc-member", token, r.join_key);
    const original = await agentIdFor("ri-rc-member");

    // Release, then a different principal claims the same address.
    await env.DB.prepare("DELETE FROM handles WHERE org = 'acme' AND handle = ?")
      .bind("ri-rc-member").run();
    await registerHandle("ri-rc-member");
    const reclaimer = await agentIdFor("ri-rc-member");
    expect(reclaimer).not.toBe(original);

    const members = await memberIds(r.roster_id);
    expect(members).not.toContain(reclaimer);
    // The row still names the ORIGINAL identity. Membership belongs to whoever
    // joined; releasing an address does not resign on their behalf, and that
    // cleanup is roster lifecycle rather than a side effect of name reuse.
    expect(members).toContain(original);
  });

  // sharedRosterIds drives call admission and card projection, so an address
  // key here would hand a reclaimer the previous owner's group grants — the
  // same transfer as above, one layer up.
  it("does not grant a reclaimer the previous owner's shared rosters", async () => {
    const r = await create("ri-sr-owner");
    const token = await registerHandle("ri-sr-member");
    await join(r.roster_id, "ri-sr-member", token, r.join_key);

    // The owner and the member share this roster, so the owner's card shows
    // group-granted tasks to the member. That is the authority under test.
    const { sharedRosterIds } = await import("../src/groups.js");
    const before = await sharedRosterIds(
      env.DB, "acme", await agentIdFor("ri-sr-member"), await agentIdFor("ri-sr-owner"),
    );
    expect(before).toContain(r.roster_id);

    await env.DB.prepare("DELETE FROM handles WHERE org = 'acme' AND handle = ?")
      .bind("ri-sr-member").run();
    await registerHandle("ri-sr-member");

    const after = await sharedRosterIds(
      env.DB, "acme", await agentIdFor("ri-sr-member"), await agentIdFor("ri-sr-owner"),
    );
    expect(after).toEqual([]);
  });
});
