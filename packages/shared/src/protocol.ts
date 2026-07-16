import { z } from "zod";

export const HANDLE_RE = /^[a-z0-9][a-z0-9-]{1,30}$/;
export const RESERVED_HANDLES = [
  "admin", "www", "relay", "api", "install", "help", "support", "root",
  "agentcall", "system", "status", "info",
] as const;
export const MAX_MESSAGE_BYTES = 64_000;
export const MAX_REPLY_BYTES = 256_000;
export const RELAY_CALL_TIMEOUT_MS = 360_000;
export const AGENT_TIMEOUT_MS = 300_000;
export const RATE_LIMIT_PER_HOUR = 10;

export const ErrorCode = z.enum([
  "unknown_handle", "offline", "busy", "timeout", "agent_error",
  "unauthorized", "rate_limited", "message_too_large", "protocol_error",
]);

export const CallRequest = z.object({
  type: z.literal("call_request"),
  to: z.string().regex(HANDLE_RE),
  message: z.string().min(1),
  session_id: z.string().optional(),
});
export const CallStatus = z.object({
  type: z.literal("call_status"),
  state: z.enum(["ringing", "answered", "working"]),
});
export const CallReply = z.object({
  type: z.literal("call_reply"),
  call_id: z.string(),
  text: z.string(),
  session_id: z.string().optional(),
});
export const CallError = z.object({
  type: z.literal("call_error"),
  code: ErrorCode,
  detail: z.string().optional(),
});
export const IncomingCall = z.object({
  type: z.literal("incoming_call"),
  call_id: z.string(),
  from: z.string(),
  message: z.string(),
  session_id: z.string().optional(),
});
export const CallAnswer = z.object({ type: z.literal("call_answer"), call_id: z.string() });
export const CallResult = z.object({
  type: z.literal("call_result"),
  call_id: z.string(),
  text: z.string(),
  session_id: z.string().optional(),
});
export const CallFailed = z.object({
  type: z.literal("call_failed"),
  call_id: z.string(),
  code: ErrorCode,
  detail: z.string().optional(),
});

export const CallerFrame = z.discriminatedUnion("type", [CallRequest]);
export const ListenerToRelayFrame = z.discriminatedUnion("type", [CallAnswer, CallResult, CallFailed]);
export const RelayToCallerFrame = z.discriminatedUnion("type", [CallStatus, CallReply, CallError]);
export const RelayToListenerFrame = z.discriminatedUnion("type", [IncomingCall]);

export const RegisterRequest = z.object({
  handle: z.string().regex(HANDLE_RE),
  // Absent = caller-only: the handle can call others but is not callable.
  agent_kind: z.enum(["claude", "codex"]).optional(),
});
export const RegisterResponse = z.object({ token: z.string(), address: z.string() });

export type ErrorCodeType = z.infer<typeof ErrorCode>;
export type CallRequestType = z.infer<typeof CallRequest>;
export type CallStatusType = z.infer<typeof CallStatus>;
export type CallReplyType = z.infer<typeof CallReply>;
export type CallErrorType = z.infer<typeof CallError>;
export type IncomingCallType = z.infer<typeof IncomingCall>;
export type CallAnswerType = z.infer<typeof CallAnswer>;
export type CallResultType = z.infer<typeof CallResult>;
export type CallFailedType = z.infer<typeof CallFailed>;
export type RegisterRequestType = z.infer<typeof RegisterRequest>;
export type RegisterResponseType = z.infer<typeof RegisterResponse>;
export type CallerFrameType = z.infer<typeof CallerFrame>;
export type ListenerToRelayFrameType = z.infer<typeof ListenerToRelayFrame>;
export type RelayToCallerFrameType = z.infer<typeof RelayToCallerFrame>;
export type RelayToListenerFrameType = z.infer<typeof RelayToListenerFrame>;

export function parseAddress(addr: string): { handle: string; host: string } | null {
  const at = addr.indexOf("@");
  if (at <= 0) return null;
  const handle = addr.slice(0, at);
  const host = addr.slice(at + 1);
  if (!HANDLE_RE.test(handle)) return null;
  if (!/^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/.test(host)) return null;
  return { handle, host };
}

export function safeParseFrame<S extends z.ZodTypeAny>(schema: S, raw: string): z.infer<S> | null {
  try {
    const parsed = schema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
