import { statSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { getMachinePaths } from "../src/paths.js";
import { loadContacts, saveContacts, addContact, removeContact, NAME_RE, resolveAddress } from "../src/contacts.js";
import { tempDir } from "./helpers.js";

function tempHome() { return tempDir("agentcall-ct-"); }

describe("contacts store", () => {
  it("paths derives contactsFile from home", () => {
    expect(getMachinePaths("/tmp/fakehome").contactsFile).toBe("/tmp/fakehome/.agentcall/contacts.json");
  });

  it("missing file loads as an empty book", () => {
    expect(loadContacts(getMachinePaths(tempHome()))).toEqual({ contacts: [] });
  });

  it("round-trips and sets 0600/0700 perms", () => {
    const p = getMachinePaths(tempHome());
    const book = { contacts: [{ name: "ken", address: "ken@agent-call.app", note: "coworker" }] };
    saveContacts(p, book);
    expect(loadContacts(p)).toEqual(book);
    expect(statSync(p.contactsFile).mode & 0o777).toBe(0o600);
    expect(statSync(p.dir).mode & 0o777).toBe(0o700);
  });

  it("corrupt file throws an error naming the path", () => {
    const p = getMachinePaths(tempHome());
    mkdirSync(p.dir, { recursive: true });
    writeFileSync(p.contactsFile, "{not json");
    expect(() => loadContacts(p)).toThrow(p.contactsFile);
  });

  it("addContact adds, then upserts case-insensitively", () => {
    const p = getMachinePaths(tempHome());
    expect(addContact(p, "Ken", "ken@agent-call.app", "coworker")).toBe("added");
    expect(addContact(p, "ken", "ken2@agent-call.app")).toBe("updated");
    const { contacts } = loadContacts(p);
    expect(contacts).toHaveLength(1);
    expect(contacts[0].address).toBe("ken2@agent-call.app");
  });

  it("upsert without --note preserves the existing note", () => {
    const p = getMachinePaths(tempHome());
    addContact(p, "ken", "ken@agent-call.app", "coworker, owns relay infra");
    addContact(p, "ken", "ken2@agent-call.app");
    expect(loadContacts(p).contacts[0].note).toBe("coworker, owns relay infra");
  });

  it("rejects invalid names and invalid addresses without writing", () => {
    const p = getMachinePaths(tempHome());
    expect(() => addContact(p, "ken@home", "ken@agent-call.app")).toThrow(/Invalid contact name/);
    expect(() => addContact(p, "-ken", "ken@agent-call.app")).toThrow(/Invalid contact name/);
    expect(() => addContact(p, "ken", "not-an-address")).toThrow(/handle@host/);
    expect(loadContacts(p)).toEqual({ contacts: [] });
  });

  it("NAME_RE accepts typical names", () => {
    for (const ok of ["ken", "Ken", "my-manager", "ken_2", "a.b"]) expect(NAME_RE.test(ok)).toBe(true);
    for (const bad of ["ken@x", "", ".ken", "_ken"]) expect(NAME_RE.test(bad)).toBe(false);
  });

  it("removeContact deletes case-insensitively and rejects unknown names", () => {
    const p = getMachinePaths(tempHome());
    addContact(p, "ken", "ken@agent-call.app");
    removeContact(p, "KEN");
    expect(loadContacts(p)).toEqual({ contacts: [] });
    expect(() => removeContact(p, "ken")).toThrow(/No contact named "ken"/);
  });

  it("writes only fields owned by the current contacts schema", () => {
    const p = getMachinePaths(tempHome());
    mkdirSync(p.dir, { recursive: true });
    writeFileSync(
      p.contactsFile,
      JSON.stringify({
        contacts: [{ name: "ken", address: "ken@agent-call.app" }],
        future_field: "x",
      }),
    );
    loadContacts(p);
    addContact(p, "amy", "amy@agent-call.app");
    const raw = JSON.parse(readFileSync(p.contactsFile, "utf8"));
    expect(raw).not.toHaveProperty("future_field");
  });
});

describe("resolveAddress", () => {
  it("passes a full address through unchanged", () => {
    const p = getMachinePaths(tempHome());
    expect(resolveAddress(p, "ken@agent-call.app")).toEqual({
      ok: true, handle: "ken", host: "agent-call.app", address: "ken@agent-call.app",
    });
  });

  it("rejects a malformed @-containing address", () => {
    const r = resolveAddress(getMachinePaths(tempHome()), "ken@");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("handle@host");
  });

  it("resolves a saved name case-insensitively", () => {
    const p = getMachinePaths(tempHome());
    addContact(p, "Ken", "ken@agent-call.app", "coworker");
    expect(resolveAddress(p, "ken")).toEqual({
      ok: true, handle: "ken", host: "agent-call.app", address: "ken@agent-call.app",
    });
  });

  it("unknown name errors and suggests contacts list", () => {
    const r = resolveAddress(getMachinePaths(tempHome()), "nobody");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain('No contact named "nobody"');
      expect(r.error).toContain("agentcall contacts list");
    }
  });

  // The host half of an address was parsed and then dropped: a call is dialled
  // on the calling line's relay regardless of what the address says, so a
  // custom AGENTCALL_RELAY silently sends the call somewhere else. It stays a
  // warning rather than a rejection because the relay hands out a hardcoded
  // RELAY_HOST, so a self-hosted or local-dev relay can never match. The merge
  // of origin/main briefly reinstated the rejection; see relayHostWarning.
  it("warns when the address host is not the relay the call will actually go to", () => {
    const p = getMachinePaths(tempHome());
    const r = resolveAddress(p, "ken@agent-call.app", "https://relay.example.com");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.warning).toMatch(/agent-call\.app.*relay\.example\.com/);
  });

  // From origin/main (#66): on the real relay a tenant's addresses are
  // <handle>@<org>.agent-call.app, so the host we compare against has
  // to carry the calling line's org or the warning names the wrong host.
  it("expects the org-prefixed host when the relay is the real one", () => {
    const p = getMachinePaths(tempHome());
    const same = resolveAddress(p, "ken@acme.agent-call.app", "https://agent-call.app", "acme");
    expect(same.ok).toBe(true);
    if (same.ok) expect(same.warning).toBeUndefined();
  });

  it("does not warn when the address host matches the relay", () => {
    const p = getMachinePaths(tempHome());
    const r = resolveAddress(p, "ken@agent-call.app", "https://agent-call.app");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.warning).toBeUndefined();
  });

  it("does not warn when no relay is supplied", () => {
    const p = getMachinePaths(tempHome());
    const r = resolveAddress(p, "ken@agent-call.app");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.warning).toBeUndefined();
  });

  // From origin/main (#66). Unlike the host mismatch above this is a hard
  // REJECTION and must stay one: it is the tenant boundary, not a diagnostic.
  // The literal-address half is covered by "rejects a hosted address belonging
  // to another tenant" below; this is the contact-book half.
  it("rejects a contact-book hit belonging to a different organization", () => {
    const p = getMachinePaths(tempHome());
    addContact(p, "ken", "ken@other.agent-call.app");
    const r = resolveAddress(p, "ken", "https://agent-call.app", "acme");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/organization "other".*"acme"/);
  });

  it("warns for a contact-book hit too, naming the contact's address", () => {
    const p = getMachinePaths(tempHome());
    addContact(p, "ken", "ken@agent-call.app");
    const r = resolveAddress(p, "ken", "http://127.0.0.1:8787");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.warning).toMatch(/ken.*127\.0\.0\.1:8787/);
  });

  it("an unparseable relay URL is ignored rather than blocking the call", () => {
    const p = getMachinePaths(tempHome());
    const r = resolveAddress(p, "ken@agent-call.app", "not a url");
    expect(r.ok).toBe(true);
  });

  it("rejects a stored contact whose address is invalid (hand-edited file)", () => {
    const p = getMachinePaths(tempHome());
    mkdirSync(p.dir, { recursive: true });
    writeFileSync(p.contactsFile, JSON.stringify({ contacts: [{ name: "bad", address: "not-an-address" }] }));
    const r = resolveAddress(p, "bad");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.toLowerCase()).toContain("invalid address");
  });

  it("rejects a hosted address belonging to another tenant", () => {
    const r = resolveAddress(
      getMachinePaths(tempHome()),
      "ken@beta.agent-call.app",
      "https://agent-call.app",
      "acme",
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/beta.*acme/);
  });

  it("accepts a hosted address in the install's tenant", () => {
    const r = resolveAddress(
      getMachinePaths(tempHome()),
      "ken@acme.agent-call.app",
      "https://agent-call.app",
      "acme",
    );
    expect(r.ok).toBe(true);
  });
});
