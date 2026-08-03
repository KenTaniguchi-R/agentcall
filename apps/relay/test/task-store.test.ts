import { describe, expect, it } from "vitest";
import { RELAY_CALL_TIMEOUT_MS } from "@benree/agentcall-shared";
import {
  listCallerTasks, taskState, taskUpdatedAt, updateTask, type TaskListQuery,
  toA2ATask, type PersistedTask,
} from "../src/task-store.js";

describe("task-store mixed-version projection", () => {
  it("projects an old ringing record without requiring a migration", () => {
    const deadline = Date.UTC(2026, 7, 3, 12);
    const oldRecord: PersistedTask = {
      call_id: "old-call", from: "caller", deadline, state: "ringing",
    };

    expect(taskState(oldRecord)).toBe("TASK_STATE_SUBMITTED");
    expect(taskUpdatedAt(oldRecord)).toBe(deadline - RELAY_CALL_TIMEOUT_MS);
    expect(toA2ATask(oldRecord)).toEqual({
      id: "old-call",
      status: {
        state: "TASK_STATE_SUBMITTED",
        timestamp: new Date(deadline - RELAY_CALL_TIMEOUT_MS).toISOString(),
      },
    });
  });

  it("projects an old working record as working", () => {
    expect(taskState({
      call_id: "old-working", from: "caller", deadline: Date.now(), state: "working",
    })).toBe("TASK_STATE_WORKING");
  });

  it("does not skip an unseen task that transitions between pages", async () => {
    const query: TaskListQuery = { pageSize: 1, includeArtifacts: false };
    const first: PersistedTask = {
      call_id: "first", from: "caller", deadline: 1_000, created_at: 300, updated_at: 300,
    };
    const unseen: PersistedTask = {
      call_id: "unseen", from: "caller", deadline: 1_000, created_at: 200, updated_at: 200,
    };

    const page1 = await listCallerTasks([first, unseen], "caller", query, "cursor-key", "org:callee");
    expect(page1?.tasks.map((task) => task.id)).toEqual(["first"]);
    expect(page1?.nextPageToken).toBeTruthy();

    const transitioned = updateTask(unseen, { task_state: "TASK_STATE_WORKING" }, 400);
    const page2 = await listCallerTasks(
      [first, transitioned], "caller", { ...query, pageToken: page1!.nextPageToken },
      "cursor-key", "org:callee",
    );
    expect(page2?.tasks.map((task) => task.id)).toEqual(["unseen"]);
  });
});
