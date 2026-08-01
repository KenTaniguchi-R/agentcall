import { describe, expect, it } from "vitest";
import { SerialQueue } from "../src/queue.js";

const never = () => new Promise<void>(() => {});

describe("SerialQueue keyed cancellation", () => {
  it("reports unknown for a key it never saw", () => {
    expect(new SerialQueue(1).cancel("nope")).toBe("unknown");
  });

  it("removes a pending job without ever running it", async () => {
    const q = new SerialQueue(1);
    let secondRan = false;
    q.tryEnqueue("a", never);
    q.tryEnqueue("b", async () => { secondRan = true; });
    expect(q.cancel("b")).toBe("pending");
    await new Promise((r) => setTimeout(r, 10));
    expect(secondRan).toBe(false);
  });

  it("aborts a running job through its signal", async () => {
    const q = new SerialQueue(1);
    let aborted = false;
    q.tryEnqueue("a", (signal) =>
      new Promise<void>((resolve) => {
        signal.addEventListener("abort", () => { aborted = true; resolve(); }, { once: true });
      }));
    await new Promise((r) => setTimeout(r, 5));
    expect(q.cancel("a")).toBe("running");
    await q.onIdle();
    expect(aborted).toBe(true);
  });

  it("reports unknown once a job has finished", async () => {
    const q = new SerialQueue(1);
    q.tryEnqueue("a", async () => {});
    await q.onIdle();
    expect(q.cancel("a")).toBe("unknown");
  });

  it("refuses a second job when maxPending is 0", () => {
    const q = new SerialQueue(0);
    expect(q.tryEnqueue("a", never)).toBe(true);
    expect(q.tryEnqueue("b", never)).toBe(false);
  });

  it("still drains in order when capacity allows", async () => {
    const q = new SerialQueue(5);
    const order: string[] = [];
    for (const k of ["a", "b", "c"]) q.tryEnqueue(k, async () => { order.push(k); });
    await q.onIdle();
    expect(order).toEqual(["a", "b", "c"]);
  });
});
