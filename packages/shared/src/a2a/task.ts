import { z } from "zod";

export const A2ATaskState = z.enum([
  "TASK_STATE_SUBMITTED",
  "TASK_STATE_WORKING",
  "TASK_STATE_COMPLETED",
  "TASK_STATE_FAILED",
  "TASK_STATE_CANCELED",
  "TASK_STATE_INPUT_REQUIRED",
  "TASK_STATE_REJECTED",
  "TASK_STATE_AUTH_REQUIRED",
]);

export const A2ATaskStatus = z.object({
  state: A2ATaskState,
  timestamp: z.string().datetime(),
}).strict();

// AgentCall currently emits text-only artifacts. Keep this narrower than the
// full A2A Part union so every response we produce is validated without
// pretending the relay supports file, URL, or structured-data parts yet.
export const A2ATextPart = z.object({ text: z.string() }).strict();

export const A2AArtifact = z.object({
  artifactId: z.string().min(1),
  name: z.string().optional(),
  description: z.string().optional(),
  parts: z.array(A2ATextPart).min(1),
}).strict();

export const A2ATask = z.object({
  id: z.string().min(1),
  contextId: z.string().min(1).optional(),
  status: A2ATaskStatus,
  artifacts: z.array(A2AArtifact).optional(),
}).strict();

export const A2AListTasksResponse = z.object({
  tasks: z.array(A2ATask),
  nextPageToken: z.string(),
  pageSize: z.number().int().min(1).max(100),
  totalSize: z.number().int().nonnegative(),
}).strict();

export const A2ACancelTaskRequest = z.object({
  metadata: z.record(z.string(), z.unknown()).optional(),
}).strict();

export type A2ATaskStateType = z.infer<typeof A2ATaskState>;
export type A2ATaskType = z.infer<typeof A2ATask>;
export type A2AListTasksResponseType = z.infer<typeof A2AListTasksResponse>;
export type A2ACancelTaskRequestType = z.infer<typeof A2ACancelTaskRequest>;
