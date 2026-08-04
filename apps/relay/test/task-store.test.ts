import { describe, expect, it } from "vitest";
import {
  listCallerTasks, taskState, taskUpdatedAt, updateTask, type TaskListQuery,
  toA2ATask, type PersistedTask,
} from "../src/task-store.js";

// @ts-expect-error Current task records require correlation, audit-routing,
// lifecycle, and timestamp fields at creation.
const incompleteTask: PersistedTask = {
  call_id: "old-call", from: "caller", deadline: 1_000,
};
void incompleteTask;

const task = (overrides: Partial<PersistedTask> = {}): PersistedTask => ({
  call_id: "task", correlation_id: "a".repeat(32), from: "caller", org: "acme", to: "callee",
  deadline: 1_000, state: "ringing", task_state: "TASK_STATE_SUBMITTED",
  created_at: 100, updated_at: 100, ...overrides,
});

describe("task-store projection", () => {
  it("projects a current submitted record", () => {
    expect(taskState(task())).toBe("TASK_STATE_SUBMITTED");
    expect(taskUpdatedAt(task())).toBe(100);
    expect(toA2ATask(task())).toEqual({
      id: "task",
      status: {
        state: "TASK_STATE_SUBMITTED",
        timestamp: new Date(100).toISOString(),
      },
    });
  });

  it("does not skip an unseen task that transitions between pages", async () => {
    const query: TaskListQuery = { pageSize: 1, includeArtifacts: false };
    const first = task({ call_id: "first", created_at: 300, updated_at: 300 });
    const unseen = task({ call_id: "unseen", created_at: 200, updated_at: 200 });

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
