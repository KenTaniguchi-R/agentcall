import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { createPrompter } from "../src/tty.js";

function fakeTty() {
  const input = new PassThrough();
  const output = new PassThrough();
  let opens = 0;
  const chunks: string[] = [];
  output.on("data", (d) => chunks.push(String(d)));
  return {
    input,
    open: () => {
      opens++;
      return { input, output };
    },
    opens: () => opens,
    written: () => chunks.join(""),
  };
}

describe("createPrompter", () => {
  // Regression: setup used to open a fresh /dev/tty stream per question, and
  // the first stream's pending read swallowed the line typed into the second
  // prompt, hanging setup forever. Sequential questions must share one open.
  it("opens the terminal once and answers sequential questions in order", async () => {
    const t = fakeTty();
    const ask = createPrompter(t.open);

    const first = ask("Which agent? [claude/codex]: ");
    t.input.write("claude\n");
    expect(await first).toBe("claude");

    const second = ask("Choose a handle (e.g. ken): ");
    t.input.write("ken\n");
    expect(await second).toBe("ken");

    expect(t.opens()).toBe(1);
  });

  it("writes each question to the shared output", async () => {
    const t = fakeTty();
    const ask = createPrompter(t.open);

    const first = ask("Which agent? [claude/codex]: ");
    t.input.write("claude\n");
    await first;
    const second = ask("Choose a handle (e.g. ken): ");
    t.input.write("ken\n");
    await second;

    expect(t.written()).toContain("Which agent?");
    expect(t.written()).toContain("Choose a handle");
  });

  it("does not open the terminal until the first question is asked", () => {
    const t = fakeTty();
    createPrompter(t.open);
    expect(t.opens()).toBe(0);
  });
});
