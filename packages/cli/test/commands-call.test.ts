import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import type { Deps, Io } from "../src/commands/deps.js";
import { saveConfig } from "../src/config.js";
import { addContact } from "../src/contacts.js";
import { getPaths } from "../src/paths.js";

vi.mock("../src/callClient.js", async () => {
  const actual = await vi.importActual<typeof import("../src/callClient.js")>("../src/callClient.js");
  return { ...actual, callAgent: vi.fn() };
});
vi.mock("../src/api.js", async () => {
  const actual = await vi.importActual<typeof import("../src/api.js")>("../src/api.js");
  return { ...actual, getStatus: vi.fn() };
});

import { call, status } from "../src/commands/call.js";
import { callAgent, CallError } from "../src/callClient.js";
import { getStatus, ApiError } from "../src/api.js";

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
  dir = mkdtempSync(join(tmpdir(), "agentcall-call-"));
  const paths = getPaths(dir);
  deps = { paths, io: fakeIo() };
  saveConfig(paths, { handle: "ken", token: "tok", relay: "https://r.test" });
  vi.mocked(callAgent).mockReset();
  vi.mocked(getStatus).mockReset();
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("call", () => {
  it("prints the reply text on a successful call", async () => {
    vi.mocked(callAgent).mockResolvedValue({ type: "call_reply", call_id: "c1", text: "hello back" });

    await call(deps, "sota@r.test", ["hi"], {});

    expect(deps.io.lines).toEqual(["hello back"]);
    expect(vi.mocked(callAgent).mock.calls[0][0]).toMatchObject({ to: "sota", from: "ken", token: "tok", message: "hi" });
  });

  it("resolves a saved contact by its short name before calling", async () => {
    addContact(deps.paths, "sota", "sota@r.test");
    vi.mocked(callAgent).mockResolvedValue({ type: "call_reply", call_id: "c1", text: "hello back" });

    await call(deps, "sota", ["hi"], {});

    expect(vi.mocked(callAgent).mock.calls[0][0]).toMatchObject({ to: "sota" });
  });

  it("--json prints the full reply envelope", async () => {
    vi.mocked(callAgent).mockResolvedValue({ type: "call_reply", call_id: "c1", text: "hello back", task: "ask" });

    await call(deps, "sota@r.test", ["hi"], { json: true });

    expect(JSON.parse(deps.io.lines[0])).toEqual({ type: "call_reply", call_id: "c1", text: "hello back", task: "ask" });
  });

  it("throws with the CallError's code and message rather than setting an exit code itself", async () => {
    vi.mocked(callAgent).mockRejectedValue(new CallError("That agent is offline right now.", "offline"));

    await expect(call(deps, "sota@r.test", ["hi"], {})).rejects.toThrow("Call failed (offline): That agent is offline right now.");
    expect(deps.io.lines).toEqual([]);
  });

  it("throws when the address cannot be resolved", async () => {
    await expect(call(deps, "nope", ["hi"], {})).rejects.toThrow(/No contact named "nope"/);
    expect(callAgent).not.toHaveBeenCalled();
  });
});

describe("status", () => {
  it("prints online and exits 0 when the agent is reachable", async () => {
    vi.mocked(getStatus).mockResolvedValue({ online: true });

    await status(deps, "sota@r.test");

    expect(deps.io.lines).toEqual(["online"]);
    expect(process.exitCode).toBe(0);
    process.exitCode = undefined;
  });

  it("prints offline and sets exit code 2 (not 1) when the agent is unreachable", async () => {
    vi.mocked(getStatus).mockResolvedValue({ online: false });

    await status(deps, "sota@r.test");

    expect(deps.io.lines).toEqual(["offline"]);
    expect(process.exitCode).toBe(2);
    process.exitCode = undefined;
  });

  it("throws (for run() to set exit 1) rather than swallowing an ApiError itself", async () => {
    vi.mocked(getStatus).mockRejectedValue(new ApiError("relay unreachable", "network"));

    await expect(status(deps, "sota@r.test")).rejects.toThrow("relay unreachable");
  });

  it("throws when the address cannot be resolved", async () => {
    await expect(status(deps, "nope")).rejects.toThrow(/No contact named "nope"/);
    expect(getStatus).not.toHaveBeenCalled();
  });
});
