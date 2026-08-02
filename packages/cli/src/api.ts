import {
  HANDLE_RE, RESERVED_HANDLES, AgentCard, type AgentCardType, type AgentKind, type CardUploadType,
} from "@benree/agentcall-shared";

export class ApiError extends Error {
  constructor(message: string, public code: "handle_taken" | "invalid" | "unknown_handle" | "network") {
    super(message);
  }
}

// Mirrors the relay's own validation (HANDLE_RE, RESERVED_HANDLES) so a bad
// or reserved handle fails instantly with a clear message instead of a round
// trip to get back a generic 400.
export function assertValidHandle(handle: string): void {
  if (!HANDLE_RE.test(handle)) {
    throw new ApiError(
      `"${handle}" isn't a valid handle: use lowercase letters, digits, and hyphens, 2-31 characters, starting with a letter or digit.`,
      "invalid",
    );
  }
  if ((RESERVED_HANDLES as readonly string[]).includes(handle)) {
    throw new ApiError(`"${handle}" is a reserved handle and can't be registered.`, "invalid");
  }
}

// Caps how long a relay HTTP call can sit with no response: without a
// signal, Node's fetch waits ~5 minutes on a black-holed connection, which
// looks identical to a hang from the user's side.
const RELAY_TIMEOUT_MS = 10_000;

async function relayFetch(relay: string, path: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  try {
    return await fetch(`${relay}${path}`, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    if ((e as Error)?.name === "TimeoutError") {
      throw new ApiError(`Relay ${relay} did not respond within ${timeoutMs / 1000}s.`, "network");
    }
    throw new ApiError(`Cannot reach relay ${relay}: ${String(e)}`, "network");
  }
}

export async function registerHandle(
  relay: string, handle: string, agentKind?: AgentKind, opts: { timeoutMs?: number } = {},
): Promise<{ token: string; address: string }> {
  assertValidHandle(handle);
  const res = await relayFetch(
    relay,
    "/v1/register",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ handle, agent_kind: agentKind }),
    },
    opts.timeoutMs ?? RELAY_TIMEOUT_MS,
  );
  if (res.status === 409) throw new ApiError(`Handle "${handle}" is already taken.`, "handle_taken");
  if (!res.ok) throw new ApiError(`Registration failed (${res.status}).`, "invalid");
  return (await res.json()) as { token: string; address: string };
}

// Presence is caller-only on the relay now, so this always authenticates —
// `auth` is required rather than optional to make that a compile-time fact
// instead of a runtime 401.
export async function getStatus(
  relay: string, handle: string, auth: { handle: string; token: string }, opts: { timeoutMs?: number } = {},
): Promise<{ online: boolean }> {
  const res = await relayFetch(
    relay,
    `/v1/status/${handle}`,
    { headers: { Authorization: `Bearer ${auth.token}`, "X-AgentCall-Handle": auth.handle } },
    opts.timeoutMs ?? RELAY_TIMEOUT_MS,
  );
  if (res.status === 401) throw new ApiError("Your credentials were rejected. Re-run `agentcall setup`.", "invalid");
  if (res.status === 429) throw new ApiError("Too many status checks — try again in a minute.", "network");
  if (res.status === 404) throw new ApiError(`No agent registered as "${handle}".`, "unknown_handle");
  if (!res.ok) throw new ApiError(`Status check failed (${res.status}).`, "network");
  return (await res.json()) as { online: boolean };
}

// Replaces this install's relay token. The relay authenticates with the
// current token and returns a fresh one, so a leaked token stops being a
// permanent liability.
export async function rotateToken(
  relay: string, auth: { handle: string; token: string }, opts: { timeoutMs?: number } = {},
): Promise<{ token: string }> {
  const res = await relayFetch(
    relay,
    "/v1/token/rotate",
    {
      method: "POST",
      headers: { Authorization: `Bearer ${auth.token}`, "X-AgentCall-Handle": auth.handle },
    },
    opts.timeoutMs ?? RELAY_TIMEOUT_MS,
  );
  if (res.status === 401) throw new ApiError("Your credentials were rejected. Re-run `agentcall setup`.", "invalid");
  if (res.status === 429) throw new ApiError("Too many rotations — try again in a minute.", "network");
  if (!res.ok) throw new ApiError(`Token rotation failed (${res.status}).`, "network");
  return (await res.json()) as { token: string };
}

export async function pushCard(
  relay: string, auth: { handle: string; token: string }, upload: CardUploadType,
  opts: { timeoutMs?: number } = {},
): Promise<void> {
  const res = await relayFetch(
    relay,
    "/v1/card",
    {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        Authorization: `Bearer ${auth.token}`,
        "X-AgentCall-Handle": auth.handle,
      },
      body: JSON.stringify(upload),
    },
    opts.timeoutMs ?? RELAY_TIMEOUT_MS,
  );
  if (res.status === 401) throw new ApiError("Your credentials were rejected. Re-run `agentcall setup`.", "invalid");
  if (!res.ok) throw new ApiError(`Card push failed (${res.status}).`, "network");
}

export async function fetchCard(
  relay: string, handle: string, auth?: { handle: string; token: string },
  opts: { timeoutMs?: number } = {},
): Promise<AgentCardType> {
  const headers: Record<string, string> = auth
    ? { Authorization: `Bearer ${auth.token}`, "X-AgentCall-Handle": auth.handle }
    : {};
  const res = await relayFetch(relay, `/v1/card/${handle}`, { headers }, opts.timeoutMs ?? RELAY_TIMEOUT_MS);
  if (res.status === 404) throw new ApiError(`No card published for "${handle}".`, "unknown_handle");
  if (!res.ok) throw new ApiError(`Card fetch failed (${res.status}).`, "network");
  return AgentCard.parse(await res.json());
}
