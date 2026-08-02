import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, afterEach, describe, expect, it } from "vitest";
import { contactsAdd, contactsList, contactsRemove } from "../src/commands/contacts.js";
import type { Deps, Io } from "../src/commands/deps.js";
import { getPaths } from "../src/paths.js";

function fakeIo(): Io & { lines: string[]; errors: string[] } {
  const lines: string[] = [];
  const errors: string[] = [];
  return {
    lines, errors,
    log: (s) => lines.push(s),
    error: (s) => errors.push(s),
    ask: async () => "",
  };
}

let dir: string;
let deps: Deps & { io: ReturnType<typeof fakeIo> };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "agentcall-contacts-"));
  deps = { paths: getPaths(dir), io: fakeIo() };
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("contactsAdd + contactsList", () => {
  it("round-trips: adding then listing shows the saved contact", () => {
    contactsAdd(deps, "ken", "ken@agentcall.benree.tech", { note: "coworker" });
    expect(deps.io.lines).toEqual(["Added ken -> ken@agentcall.benree.tech"]);

    deps.io.lines.length = 0;
    contactsList(deps, {});
    expect(deps.io.lines).toEqual(["ken  ken@agentcall.benree.tech  — coworker"]);
  });

  it("--json emits parseable JSON whose fields match the human output", () => {
    contactsAdd(deps, "ken", "ken@agentcall.benree.tech", { note: "coworker" });
    deps.io.lines.length = 0;
    contactsList(deps, { json: true });
    expect(deps.io.lines).toHaveLength(1);
    const parsed = JSON.parse(deps.io.lines[0]);
    expect(parsed).toEqual([{ name: "ken", address: "ken@agentcall.benree.tech", note: "coworker" }]);
  });
});

describe("contactsRemove", () => {
  it("removes a saved contact", () => {
    contactsAdd(deps, "ken", "ken@agentcall.benree.tech", {});
    contactsRemove(deps, "ken");
    deps.io.lines.length = 0;
    contactsList(deps, {});
    expect(deps.io.lines.join("\n")).toContain("No contacts yet");
  });

  it("throws rather than setting an exit code when the name is unknown", () => {
    // The command's contract: throw. index.ts's run() wrapper owns exit codes.
    expect(() => contactsRemove(deps, "nope")).toThrow(/No contact named "nope"/);
    expect(deps.io.errors).toEqual([]);
  });
});
