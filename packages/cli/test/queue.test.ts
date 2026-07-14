import { describe, expect, it } from "vitest";
import { SerialQueue } from "../src/queue.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("SerialQueue", () => {
  it("runs jobs one at a time, in order", async () => {
    const q = new SerialQueue(5);
    const order: number[] = [];
    let concurrent = 0, maxConcurrent = 0;
    for (let i = 0; i < 3; i++) {
      q.tryEnqueue(async () => {
        concurrent++; maxConcurrent = Math.max(maxConcurrent, concurrent);
        await sleep(20); order.push(i); concurrent--;
      });
    }
    await q.onIdle();
    expect(order).toEqual([0, 1, 2]);
    expect(maxConcurrent).toBe(1);
  });
  it("rejects beyond maxPending while busy", async () => {
    const q = new SerialQueue(2);
    q.tryEnqueue(() => sleep(100));            // running
    expect(q.tryEnqueue(() => sleep(1))).toBe(true);  // pending 1
    expect(q.tryEnqueue(() => sleep(1))).toBe(true);  // pending 2
    expect(q.tryEnqueue(() => sleep(1))).toBe(false); // over cap
    await q.onIdle();
  });
});
