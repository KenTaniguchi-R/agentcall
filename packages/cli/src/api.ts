export class ApiError extends Error {
  constructor(message: string, public code: "handle_taken" | "invalid" | "unknown_handle" | "network") {
    super(message);
  }
}

export async function registerHandle(
  relay: string, handle: string, agentKind: "claude" | "codex",
): Promise<{ token: string; address: string }> {
  let res: Response;
  try {
    res = await fetch(`${relay}/v1/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ handle, agent_kind: agentKind }),
    });
  } catch (e) {
    throw new ApiError(`Cannot reach relay ${relay}: ${String(e)}`, "network");
  }
  if (res.status === 409) throw new ApiError(`Handle "${handle}" is already taken.`, "handle_taken");
  if (!res.ok) throw new ApiError(`Registration failed (${res.status}).`, "invalid");
  return (await res.json()) as { token: string; address: string };
}

export async function getStatus(relay: string, handle: string): Promise<{ online: boolean }> {
  let res: Response;
  try {
    res = await fetch(`${relay}/v1/status/${handle}`);
  } catch (e) {
    throw new ApiError(`Cannot reach relay ${relay}: ${String(e)}`, "network");
  }
  if (res.status === 404) throw new ApiError(`No agent registered as "${handle}".`, "unknown_handle");
  if (!res.ok) throw new ApiError(`Status check failed (${res.status}).`, "network");
  return (await res.json()) as { online: boolean };
}
