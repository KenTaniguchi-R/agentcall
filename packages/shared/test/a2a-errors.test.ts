import { describe, expect, it } from "vitest";
import { A2A_ERRORS, A2A_ERROR_DOMAIN, a2aError, standardError } from "../src/index.js";

describe("§5.4 error table", () => {
  it("maps every A2A error to its normative HTTP status", () => {
    expect(A2A_ERRORS.TaskNotFound.http).toBe(404);
    expect(A2A_ERRORS.TaskNotCancelable.http).toBe(409);
    expect(A2A_ERRORS.PushNotificationNotSupported.http).toBe(400);
    expect(A2A_ERRORS.UnsupportedOperation.http).toBe(400);
    expect(A2A_ERRORS.ContentTypeNotSupported.http).toBe(415);
    expect(A2A_ERRORS.InvalidAgentResponse.http).toBe(502);
    expect(A2A_ERRORS.ExtendedAgentCardNotConfigured.http).toBe(400);
    expect(A2A_ERRORS.ExtensionSupportRequired.http).toBe(400);
    expect(A2A_ERRORS.VersionNotSupported.http).toBe(400);
  });

  it("maps every A2A error to its JSON-RPC code", () => {
    expect(A2A_ERRORS.TaskNotFound.jsonrpc).toBe(-32001);
    expect(A2A_ERRORS.VersionNotSupported.jsonrpc).toBe(-32009);
  });

  it("derives reason as UPPER_SNAKE_CASE without the Error suffix", () => {
    expect(A2A_ERRORS.TaskNotFound.reason).toBe("TASK_NOT_FOUND");
    expect(A2A_ERRORS.ContentTypeNotSupported.reason).toBe("CONTENT_TYPE_NOT_SUPPORTED");
  });
});

describe("a2aError", () => {
  it("builds an AIP-193 body with a numeric code", () => {
    const { status, body } = a2aError("TaskNotFound", "task abc not found");
    expect(status).toBe(404);
    expect(body.error.code).toBe(404);
    expect(typeof body.error.code).toBe("number");
    expect(body.error.message).toBe("task abc not found");
  });

  it("includes a google.rpc.ErrorInfo detail", () => {
    const { body } = a2aError("TaskNotCancelable", "too late");
    expect(body.error.details).toEqual([
      {
        "@type": "type.googleapis.com/google.rpc.ErrorInfo",
        reason: "TASK_NOT_CANCELABLE",
        domain: A2A_ERROR_DOMAIN,
      },
    ]);
  });

  it("attaches optional metadata to the ErrorInfo", () => {
    const { body } = a2aError("UnsupportedOperation", "no", { offered: "ask,triage" });
    expect((body.error.details as any[])[0].metadata).toEqual({ offered: "ask,triage" });
  });
});

describe("standardError", () => {
  it("builds an AIP-193 body with no ErrorInfo detail", () => {
    const { status, body } = standardError(401, "unauthorized");
    expect(status).toBe(401);
    expect(body.error.code).toBe(401);
    expect(body.error.details).toBeUndefined();
  });
});
