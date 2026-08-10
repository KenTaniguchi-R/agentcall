import { statSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { getPaths } from "../src/paths.js";
import { loadContacts, saveContacts, addContact, removeContact, NAME_RE, resolveAddress } from "../src/contacts.js";
import { tempDir } from "./helpers.js";

function tempHome() { return tempDir("agentcall-ct-"); }

describe("contacts store", () => {
  it("paths derives contactsFile from home", () => {
    expect(getPaths("/tmp/fakehome").contactsFile).toBe("/tmp/fakehome/.agentcall/contacts.json");
  });

  it("missing file loads as an empty book", () => {
    expect(loadContacts(getPaths(tempHome()))).toEqual({ contacts: [] });
  });

  it("round-trips and sets 0600/0700 perms", () => {
    const p = getPaths(tempHome());
    const book = { contacts: [{ name: "ken", address: "@acme/ken", note: "coworker" }] };
    saveContacts(p, book);
    expect(loadContacts(p)).toEqual(book);
    expect(statSync(p.contactsFile).mode & 0o777).toBe(0o600);
    expect(statSync(p.dir).mode & 0o777).toBe(0o700);
  });

  // An in-place rewrite opens the destination with O_TRUNC, so a crash or a
  // full disk mid-write leaves a truncated contact book — which loadContacts
  // treats as corrupt and refuses to read, losing every saved contact. An
  // atomic replace writes a sibling temp file and renames over the target, so
  // the destination goes from old bytes to new with nothing in between. A new
  // inode is the observable evidence that a rename, not a rewrite, happened.
  it("replaces the file rather than rewriting it in place", () => {
    const p = getPaths(tempHome());
    saveContacts(p, { contacts: [{ name: "ken", address: "@acme/ken" }] });
    const before = statSync(p.contactsFile).ino;
    saveContacts(p, { contacts: [{ name: "sota", address: "@acme/sota" }] });
    expect(statSync(p.contactsFile).ino).not.toBe(before);
    expect(loadContacts(p).contacts[0]!.name).toBe("sota");
  });

  it("leaves the previous book intact when serialization fails", () => {
    const p = getPaths(tempHome());
    saveContacts(p, { contacts: [{ name: "ken", address: "@acme/ken" }] });
    const circular: { self?: unknown } = {};
    circular.self = circular;
    expect(() => saveContacts(p, { contacts: [circular] } as never)).toThrow(/circular/i);
    expect(loadContacts(p).contacts[0]!.name).toBe("ken");
  });

  it("corrupt file throws an error naming the path", () => {
    const p = getPaths(tempHome());
    mkdirSync(p.dir, { recursive: true });
    writeFileSync(p.contactsFile, "{not json");
    expect(() => loadContacts(p)).toThrow(p.contactsFile);
  });

  it("addContact adds, then upserts case-insensitively", () => {
    const p = getPaths(tempHome());
    expect(addContact(p, "Ken", "@acme/ken", "coworker")).toBe("added");
    expect(addContact(p, "ken", "@acme/ken2")).toBe("updated");
    const { contacts } = loadContacts(p);
    expect(contacts).toHaveLength(1);
    expect(contacts[0].address).toBe("@acme/ken2");
  });

  it("upsert without --note preserves the existing note", () => {
    const p = getPaths(tempHome());
    addContact(p, "ken", "@acme/ken", "coworker, owns relay infra");
    addContact(p, "ken", "@acme/ken2");
    expect(loadContacts(p).contacts[0].note).toBe("coworker, owns relay infra");
  });

  it("rejects invalid names and invalid addresses without writing", () => {
    const p = getPaths(tempHome());
    expect(() => addContact(p, "ken@home", "@acme/ken")).toThrow(/Invalid contact name/);
    expect(() => addContact(p, "-ken", "@acme/ken")).toThrow(/Invalid contact name/);
    expect(() => addContact(p, "ken", "not-an-address")).toThrow(/@org\/handle/);
    expect(loadContacts(p)).toEqual({ contacts: [] });
  });

  it("NAME_RE accepts typical names", () => {
    for (const ok of ["ken", "Ken", "my-manager", "ken_2", "a.b"]) expect(NAME_RE.test(ok)).toBe(true);
    for (const bad of ["ken@x", "", ".ken", "_ken"]) expect(NAME_RE.test(bad)).toBe(false);
  });

  it("removeContact deletes case-insensitively and rejects unknown names", () => {
    const p = getPaths(tempHome());
    addContact(p, "ken", "@acme/ken");
    removeContact(p, "KEN");
    expect(loadContacts(p)).toEqual({ contacts: [] });
    expect(() => removeContact(p, "ken")).toThrow(/No contact named "ken"/);
  });

  it("writes only fields owned by the current contacts schema", () => {
    const p = getPaths(tempHome());
    mkdirSync(p.dir, { recursive: true });
    writeFileSync(
      p.contactsFile,
      JSON.stringify({
        contacts: [{ name: "ken", address: "@acme/ken" }],
        future_field: "x",
      }),
    );
    loadContacts(p);
    addContact(p, "amy", "@acme/amy");
    const raw = JSON.parse(readFileSync(p.contactsFile, "utf8"));
    expect(raw).not.toHaveProperty("future_field");
  });
});

describe("resolveAddress", () => {
  it("passes a full address through unchanged", () => {
    const p = getPaths(tempHome());
    expect(resolveAddress(p, "@acme/ken")).toEqual({
      ok: true, org: "acme", handle: "ken", address: "@acme/ken",
    });
  });

  it("rejects a malformed address", () => {
    const r = resolveAddress(getPaths(tempHome()), "@acme/");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("@org/handle");
  });

  // A DNS-shaped address must not resolve: nothing looks it up, so accepting
  // one would promise routing this system does not implement.
  it("rejects a host-shaped address outright", () => {
    const r = resolveAddress(getPaths(tempHome()), "ken@agentcall.benree.tech");
    expect(r.ok).toBe(false);
  });

  it("resolves a saved name case-insensitively", () => {
    const p = getPaths(tempHome());
    addContact(p, "Ken", "@acme/ken", "coworker");
    expect(resolveAddress(p, "ken")).toEqual({
      ok: true, org: "acme", handle: "ken", address: "@acme/ken",
    });
  });

  it("unknown name errors and suggests contacts list", () => {
    const r = resolveAddress(getPaths(tempHome()), "nobody");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain('No contact named "nobody"');
      expect(r.error).toContain("agentcall contacts list");
    }
  });

  // #66, and still a hard REJECTION rather than a diagnostic: this is the
  // tenant boundary. It reads the org straight off the parsed address now
  // instead of matching a DNS suffix, so it no longer depends on the relay
  // host being spelled a particular way.
  it("rejects a literal address belonging to a different organization", () => {
    const p = getPaths(tempHome());
    const r = resolveAddress(p, "@other/ken", "acme");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/organization "other".*"acme"/);
  });

  it("rejects a contact-book hit belonging to a different organization", () => {
    const p = getPaths(tempHome());
    addContact(p, "ken", "@other/ken");
    const r = resolveAddress(p, "ken", "acme");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/organization "other".*"acme"/);
  });

  it("accepts an address in the caller's own organization", () => {
    const p = getPaths(tempHome());
    const r = resolveAddress(p, "@acme/ken", "acme");
    expect(r.ok).toBe(true);
  });

  it("rejects a stored contact whose address is invalid (hand-edited file)", () => {
    const p = getPaths(tempHome());
    mkdirSync(p.dir, { recursive: true });
    writeFileSync(p.contactsFile, JSON.stringify({ contacts: [{ name: "bad", address: "not-an-address" }] }));
    const r = resolveAddress(p, "bad");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.toLowerCase()).toContain("invalid address");
  });

  // Two cases used to sit here, passing a hosted relay URL alongside the same
  // two addresses the pair above already covers. They existed because the
  // tenant check read the dialled hostname, so "hosted relay" and "some other
  // relay" were genuinely different inputs. `resolveAddress` takes no relay
  // now, which made them character-for-character duplicates of those two
  // rather than weaker versions of them. Do not reintroduce a relay-shaped
  // case: there is no relay input left for it to vary.
});
