import { mkdtempSync, statSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { getPaths } from "../src/paths.js";
import { loadContacts, saveContacts, addContact, removeContact, NAME_RE, resolveAddress } from "../src/contacts.js";

function tempHome() { return mkdtempSync(join(tmpdir(), "agentcall-ct-")); }

describe("contacts store", () => {
  it("paths derives contactsFile from home", () => {
    expect(getPaths("/tmp/fakehome").contactsFile).toBe("/tmp/fakehome/.agentcall/contacts.json");
  });

  it("missing file loads as an empty book", () => {
    expect(loadContacts(getPaths(tempHome()))).toEqual({ contacts: [] });
  });

  it("round-trips and sets 0600/0700 perms", () => {
    const p = getPaths(tempHome());
    const book = { contacts: [{ name: "ken", address: "ken@agentcall.benree.tech", note: "coworker" }] };
    saveContacts(p, book);
    expect(loadContacts(p)).toEqual(book);
    expect(statSync(p.contactsFile).mode & 0o777).toBe(0o600);
    expect(statSync(p.dir).mode & 0o777).toBe(0o700);
  });

  it("corrupt file throws an error naming the path", () => {
    const p = getPaths(tempHome());
    mkdirSync(p.dir, { recursive: true });
    writeFileSync(p.contactsFile, "{not json");
    expect(() => loadContacts(p)).toThrow(p.contactsFile);
  });

  it("addContact adds, then upserts case-insensitively", () => {
    const p = getPaths(tempHome());
    expect(addContact(p, "Ken", "ken@agentcall.benree.tech", "coworker")).toBe("added");
    expect(addContact(p, "ken", "ken2@agentcall.benree.tech")).toBe("updated");
    const { contacts } = loadContacts(p);
    expect(contacts).toHaveLength(1);
    expect(contacts[0].address).toBe("ken2@agentcall.benree.tech");
  });

  it("upsert without --note preserves the existing note", () => {
    const p = getPaths(tempHome());
    addContact(p, "ken", "ken@agentcall.benree.tech", "coworker, owns relay infra");
    addContact(p, "ken", "ken2@agentcall.benree.tech");
    expect(loadContacts(p).contacts[0].note).toBe("coworker, owns relay infra");
  });

  it("rejects invalid names and invalid addresses without writing", () => {
    const p = getPaths(tempHome());
    expect(() => addContact(p, "ken@home", "ken@agentcall.benree.tech")).toThrow(/Invalid contact name/);
    expect(() => addContact(p, "-ken", "ken@agentcall.benree.tech")).toThrow(/Invalid contact name/);
    expect(() => addContact(p, "ken", "not-an-address")).toThrow(/handle@host/);
    expect(loadContacts(p)).toEqual({ contacts: [] });
  });

  it("NAME_RE accepts typical names", () => {
    for (const ok of ["ken", "Ken", "my-manager", "ken_2", "a.b"]) expect(NAME_RE.test(ok)).toBe(true);
    for (const bad of ["ken@x", "", ".ken", "_ken"]) expect(NAME_RE.test(bad)).toBe(false);
  });

  it("removeContact deletes case-insensitively and rejects unknown names", () => {
    const p = getPaths(tempHome());
    addContact(p, "ken", "ken@agentcall.benree.tech");
    removeContact(p, "KEN");
    expect(loadContacts(p)).toEqual({ contacts: [] });
    expect(() => removeContact(p, "ken")).toThrow(/No contact named "ken"/);
  });

  it("preserves unknown top-level keys across a load + save round-trip", () => {
    const p = getPaths(tempHome());
    mkdirSync(p.dir, { recursive: true });
    writeFileSync(
      p.contactsFile,
      JSON.stringify({
        contacts: [{ name: "ken", address: "ken@agentcall.benree.tech" }],
        future_field: "x",
      }),
    );
    loadContacts(p);
    addContact(p, "amy", "amy@agentcall.benree.tech");
    const raw = JSON.parse(readFileSync(p.contactsFile, "utf8"));
    expect(raw.future_field).toBe("x");
  });
});

describe("resolveAddress", () => {
  it("passes a full address through unchanged", () => {
    const p = getPaths(tempHome());
    expect(resolveAddress(p, "ken@agentcall.benree.tech")).toEqual({
      ok: true, handle: "ken", host: "agentcall.benree.tech", address: "ken@agentcall.benree.tech",
    });
  });

  it("rejects a malformed @-containing address", () => {
    const r = resolveAddress(getPaths(tempHome()), "ken@");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("handle@host");
  });

  it("resolves a saved name case-insensitively", () => {
    const p = getPaths(tempHome());
    addContact(p, "Ken", "ken@agentcall.benree.tech", "coworker");
    expect(resolveAddress(p, "ken")).toEqual({
      ok: true, handle: "ken", host: "agentcall.benree.tech", address: "ken@agentcall.benree.tech",
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

  it("rejects a stored contact whose address is invalid (hand-edited file)", () => {
    const p = getPaths(tempHome());
    mkdirSync(p.dir, { recursive: true });
    writeFileSync(p.contactsFile, JSON.stringify({ contacts: [{ name: "bad", address: "not-an-address" }] }));
    const r = resolveAddress(p, "bad");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.toLowerCase()).toContain("invalid address");
  });
});
