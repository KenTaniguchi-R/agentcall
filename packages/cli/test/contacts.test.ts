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
    const book = { contacts: [{ name: "ken", address: "@acme/ken", note: "coworker" }] };
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
    expect(addContact(p, "Ken", "@acme/ken", "coworker")).toBe("added");
    expect(addContact(p, "ken", "@acme/ken2")).toBe("updated");
    const { contacts } = loadContacts(p);
    expect(contacts).toHaveLength(1);
    expect(contacts[0].address).toBe("@acme/ken2");
  });

  it("upsert without --note preserves the existing note", () => {
    const p = getMachinePaths(tempHome());
    addContact(p, "ken", "@acme/ken", "coworker, owns relay infra");
    addContact(p, "ken", "@acme/ken2");
    expect(loadContacts(p).contacts[0].note).toBe("coworker, owns relay infra");
  });

  it("rejects invalid names and invalid addresses without writing", () => {
    const p = getMachinePaths(tempHome());
    expect(() => addContact(p, "ken@home", "@acme/ken")).toThrow(/Invalid contact name/);
    expect(() => addContact(p, "-ken", "@acme/ken")).toThrow(/Invalid contact name/);
    expect(() => addContact(p, "ken", "not-an-address")).toThrow(/handle@host/);
    expect(loadContacts(p)).toEqual({ contacts: [] });
  });

  it("NAME_RE accepts typical names", () => {
    for (const ok of ["ken", "Ken", "my-manager", "ken_2", "a.b"]) expect(NAME_RE.test(ok)).toBe(true);
    for (const bad of ["ken@x", "", ".ken", "_ken"]) expect(NAME_RE.test(bad)).toBe(false);
  });

  it("removeContact deletes case-insensitively and rejects unknown names", () => {
    const p = getMachinePaths(tempHome());
    addContact(p, "ken", "@acme/ken");
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
    const p = getMachinePaths(tempHome());
    expect(resolveAddress(p, "@acme/ken")).toEqual({
      ok: true, org: "acme", handle: "ken", address: "@acme/ken",
    });
  });

  it("rejects a malformed address", () => {
    const r = resolveAddress(getMachinePaths(tempHome()), "@acme/");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("@org/handle");
  });

  // A DNS-shaped address must not resolve: nothing looks it up, so accepting
  // one would promise routing this system does not implement.
  it("rejects a host-shaped address outright", () => {
    const r = resolveAddress(getMachinePaths(tempHome()), "ken@agentcall.benree.tech");
    expect(r.ok).toBe(false);
  });

  it("resolves a saved name case-insensitively", () => {
    const p = getMachinePaths(tempHome());
    addContact(p, "Ken", "@acme/ken", "coworker");
    expect(resolveAddress(p, "ken")).toEqual({
      ok: true, org: "acme", handle: "ken", address: "@acme/ken",
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

  // #66, and still a hard REJECTION rather than a diagnostic: this is the
  // tenant boundary. It reads the org straight off the parsed address now
  // instead of matching a DNS suffix, so it no longer depends on the relay
  // host being spelled a particular way.
  it("rejects a literal address belonging to a different organization", () => {
    const p = getMachinePaths(tempHome());
    const r = resolveAddress(p, "@other/ken", undefined, "acme");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/organization "other".*"acme"/);
  });

  it("rejects a contact-book hit belonging to a different organization", () => {
    const p = getMachinePaths(tempHome());
    addContact(p, "ken", "@other/ken");
    const r = resolveAddress(p, "ken", undefined, "acme");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/organization "other".*"acme"/);
  });

  it("accepts an address in the caller's own organization", () => {
    const p = getMachinePaths(tempHome());
    const r = resolveAddress(p, "@acme/ken", undefined, "acme");
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
      "@other/ken",
      "https://agentcall.benree.tech",
      "acme",
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/other.*acme/);
  });

  it("accepts a hosted address in the install's tenant", () => {
    const r = resolveAddress(
      getMachinePaths(tempHome()),
      "@acme/ken",
      "https://agentcall.benree.tech",
      "acme",
    );
    expect(r.ok).toBe(true);
  });
});
