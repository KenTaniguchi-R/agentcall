// Transcribed from A2A v1.0 spec §5.4 (Error Code Mappings). These values are
// normative — do not re-derive them from intuition. An earlier design draft
// guessed 501 for PushNotificationNotSupported; the spec says 400.
export const A2A_ERROR_DOMAIN = "a2a-protocol.org";

export const A2A_ERRORS = {
  TaskNotFound: { reason: "TASK_NOT_FOUND", http: 404, jsonrpc: -32001 },
  TaskNotCancelable: { reason: "TASK_NOT_CANCELABLE", http: 409, jsonrpc: -32002 },
  PushNotificationNotSupported: { reason: "PUSH_NOTIFICATION_NOT_SUPPORTED", http: 400, jsonrpc: -32003 },
  UnsupportedOperation: { reason: "UNSUPPORTED_OPERATION", http: 400, jsonrpc: -32004 },
  ContentTypeNotSupported: { reason: "CONTENT_TYPE_NOT_SUPPORTED", http: 415, jsonrpc: -32005 },
  InvalidAgentResponse: { reason: "INVALID_AGENT_RESPONSE", http: 502, jsonrpc: -32006 },
  ExtendedAgentCardNotConfigured: { reason: "EXTENDED_AGENT_CARD_NOT_CONFIGURED", http: 400, jsonrpc: -32007 },
  ExtensionSupportRequired: { reason: "EXTENSION_SUPPORT_REQUIRED", http: 400, jsonrpc: -32008 },
  VersionNotSupported: { reason: "VERSION_NOT_SUPPORTED", http: 400, jsonrpc: -32009 },
} as const;

export type A2AErrorKey = keyof typeof A2A_ERRORS;

export type Aip193Body = {
  error: { code: number; message: string; details?: unknown[] };
};

// §11.6: REST errors use AIP-193, where `code` is the HTTP status as a NUMBER.
// A string there is a conformance failure — the TCK parses it with int().
export function a2aError(
  key: A2AErrorKey,
  message: string,
  metadata?: Record<string, string>,
): { status: number; body: Aip193Body } {
  const spec = A2A_ERRORS[key];
  return {
    status: spec.http,
    body: {
      error: {
        code: spec.http,
        message,
        details: [
          {
            "@type": "type.googleapis.com/google.rpc.ErrorInfo",
            reason: spec.reason,
            domain: A2A_ERROR_DOMAIN,
            ...(metadata ? { metadata } : {}),
          },
        ],
      },
    },
  };
}

// For §3.3.2 standard categories (auth, authz, validation, resource, system).
// These carry no ErrorInfo — they are not A2A-specific error types.
export function standardError(status: number, message: string): { status: number; body: Aip193Body } {
  return { status, body: { error: { code: status, message } } };
}
