import { describe, expect, it } from "vitest";
import { A2ACancelTaskRequest, A2AListTasksResponse, A2ATask, A2ATaskState } from "../src/index.js";

const task = {
  id: "task-1",
  status: { state: "TASK_STATE_COMPLETED", timestamp: "2026-08-03T00:00:00.000Z" },
  artifacts: [{ artifactId: "task-1:result", parts: [{ text: "done" }] }],
} as const;

describe("A2A task schemas", () => {
  it("accepts the task subset AgentCall emits", () => {
    expect(A2ATask.parse(task)).toEqual(task);
    expect(A2AListTasksResponse.parse({
      tasks: [task], nextPageToken: "", pageSize: 50, totalSize: 1,
    }).tasks).toHaveLength(1);
  });

  it("accepts only concrete A2A lifecycle states", () => {
    expect(A2ATaskState.safeParse("TASK_STATE_WORKING").success).toBe(true);
    expect(A2ATaskState.safeParse("TASK_STATE_UNSPECIFIED").success).toBe(false);
    expect(A2ATaskState.safeParse("working").success).toBe(false);
  });

  it("rejects missing required fields and undeclared output", () => {
    expect(A2ATask.safeParse({ id: "task-1" }).success).toBe(false);
    expect(A2ATask.safeParse({ ...task, from: "private-caller" }).success).toBe(false);
    expect(A2ATask.safeParse({
      ...task,
      artifacts: [{ artifactId: "empty", parts: [] }],
    }).success).toBe(false);
  });

  it("validates CancelTask metadata as a strict protobuf Struct-shaped object", () => {
    expect(A2ACancelTaskRequest.safeParse({}).success).toBe(true);
    expect(A2ACancelTaskRequest.safeParse({ metadata: { reason: "user request", attempt: 2 } }).success).toBe(true);
    expect(A2ACancelTaskRequest.safeParse({ metadata: "not-an-object" }).success).toBe(false);
    expect(A2ACancelTaskRequest.safeParse({ unexpected: true }).success).toBe(false);
  });

  it("carries encrypted outcomes as raw artifacts and exposes strict terminal reasons", () => {
    const encrypted = A2ATask.parse({
      id: "task-2",
      status: { state: "TASK_STATE_FAILED", timestamp: "2026-08-03T00:00:00.000Z" },
      metadata: { "agentcall.dev/terminalReason": "expired" },
      artifacts: [{
        artifactId: "task-2:result",
        parts: [{ raw: "eyJjdCI6IkIifQ==", mediaType: "application/vnd.agentcall.hpke+json" }],
      }],
    });
    expect(encrypted.metadata).toEqual({ "agentcall.dev/terminalReason": "expired" });
    expect(encrypted.artifacts?.[0]?.parts[0]).toEqual({
      raw: "eyJjdCI6IkIifQ==", mediaType: "application/vnd.agentcall.hpke+json",
    });
    expect(A2ATask.safeParse({
      ...encrypted, metadata: { "agentcall.dev/terminalReason": "invented" },
    }).success).toBe(false);
  });
});
