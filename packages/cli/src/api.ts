import {
  HANDLE_RE, AgentCard, CreateOrgInviteResponse, CreateRosterResponse, IssueRosterJoinKeyResponse,
  ListOrgInvitesResponse, ListRosterJoinKeysResponse, RegisterResponse, RevokeOrgInviteResponse,
  RevokeRosterJoinKeyResponse, RosterBundle,
  type AgentCardType, type CardUploadType, type OrgInviteMetadataType, type RosterBundleType,
  type RosterJoinKeyMetadataType,
} from "@benree/agentcall-shared";

export class ApiError extends Error {
  constructor(
    message: string,
    public code: "handle_taken" | "invite_invalid" | "invalid" | "unknown_handle" | "status_unavailable" | "network",
  ) {
    super(message);
  }
}

export type Auth = { org: string; handle: string; token: string };

function authHeaders(auth: Auth): Record<string, string> {
  return {
    Authorization: `Bearer ${auth.token}`,
    "X-AgentCall-Org": auth.org,
    "X-AgentCall-Handle": auth.handle,
  };
}

// Mirrors the relay's handle-shape validation so malformed input fails before
// a network round trip. Availability and namespacing remain relay-authoritative.
export function assertValidHandle(handle: string): void {
  if (!HANDLE_RE.test(handle)) {
    throw new ApiError(
      `"${handle}" isn't a valid handle: use lowercase letters, digits, and hyphens, 2-31 characters, starting with a letter or digit.`,
      "invalid",
    );
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
  relay: string, invite: string, handle: string, agentKind?: "claude" | "codex", opts: { timeoutMs?: number } = {},
): Promise<{ org: string; token: string; address: string }> {
  if (!invite) throw new ApiError("An organization invite is required.", "invite_invalid");
  assertValidHandle(handle);
  const res = await relayFetch(
    relay,
    "/v1/register",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ invite, handle, agent_kind: agentKind }),
    },
    opts.timeoutMs ?? RELAY_TIMEOUT_MS,
  );
  if (res.status === 404) throw new ApiError("This invite is invalid, expired, or already used.", "invite_invalid");
  if (res.status === 409) throw new ApiError(`Handle "${handle}" is already taken.`, "handle_taken");
  if (res.status === 503) {
    throw new ApiError("Registration is temporarily unavailable. Try again shortly.", "network");
  }
  if (!res.ok) throw new ApiError(`Registration failed (${res.status}).`, "invalid");
  return RegisterResponse.parse(await res.json());
}

export async function createInvite(
  relay: string, auth: Auth,
  input: { description?: string; expires_in_days?: number } = {}, opts: { timeoutMs?: number } = {},
): Promise<{ invite: string; metadata: OrgInviteMetadataType }> {
  const res = await relayFetch(
    relay,
    "/v1/invites",
    {
      method: "POST", headers: { ...authHeaders(auth), "content-type": "application/json" },
      body: JSON.stringify(input),
    },
    opts.timeoutMs ?? RELAY_TIMEOUT_MS,
  );
  if (res.status === 401) throw new ApiError("Your credentials were rejected. Re-run `agentcall setup`.", "invalid");
  if (res.status === 429) throw new ApiError("Too many invites created — try again in a minute.", "network");
  if (!res.ok) throw new ApiError(`Invite creation failed (${res.status}).`, "network");
  return CreateOrgInviteResponse.parse(await res.json());
}

export async function listInvites(
  relay: string, auth: Auth, opts: { timeoutMs?: number } = {},
): Promise<OrgInviteMetadataType[]> {
  const res = await relayFetch(
    relay, "/v1/invites/list", { method: "POST", headers: authHeaders(auth) },
    opts.timeoutMs ?? RELAY_TIMEOUT_MS,
  );
  if (res.status === 401) throw new ApiError("Your credentials were rejected. Re-run `agentcall setup`.", "invalid");
  if (res.status === 429) throw new ApiError("Too many invite operations — try again in a minute.", "network");
  if (!res.ok) throw new ApiError(`Invite listing failed (${res.status}).`, "network");
  return ListOrgInvitesResponse.parse(await res.json()).invites;
}

export async function revokeInvite(
  relay: string, auth: Auth, id: string, opts: { timeoutMs?: number } = {},
): Promise<{ id: string; revoked_at: number }> {
  const res = await relayFetch(
    relay, `/v1/invites/${encodeURIComponent(id)}/revoke`, { method: "POST", headers: authHeaders(auth) },
    opts.timeoutMs ?? RELAY_TIMEOUT_MS,
  );
  if (res.status === 401) throw new ApiError("Your credentials were rejected. Re-run `agentcall setup`.", "invalid");
  if (res.status === 400) throw new ApiError("Invite ID must be the 64-character ID shown by `agentcall invite list`.", "invalid");
  if (res.status === 404) throw new ApiError("Invite not found or already used.", "invalid");
  if (res.status === 429) throw new ApiError("Too many invite operations — try again in a minute.", "network");
  if (!res.ok) throw new ApiError(`Invite revocation failed (${res.status}).`, "network");
  return RevokeOrgInviteResponse.parse(await res.json());
}

// Presence is self-or-shared-roster on the relay, so this always authenticates.
// `auth` is required rather than optional to make that a compile-time fact.
export async function getStatus(
  relay: string, handle: string, auth: Auth, opts: { timeoutMs?: number } = {},
): Promise<{ online: boolean }> {
  const res = await relayFetch(
    relay,
    `/v1/status/${handle}`,
    { headers: authHeaders(auth) },
    opts.timeoutMs ?? RELAY_TIMEOUT_MS,
  );
  if (res.status === 401) throw new ApiError("Your credentials were rejected. Re-run `agentcall setup`.", "invalid");
  if (res.status === 429) throw new ApiError("Too many status checks — try again in a minute.", "network");
  if (res.status === 404) {
    throw new ApiError(
      `Status unavailable for "${handle}": the target does not exist or does not share a roster with you.`,
      "status_unavailable",
    );
  }
  if (!res.ok) throw new ApiError(`Status check failed (${res.status}).`, "network");
  return (await res.json()) as { online: boolean };
}

// Replaces this install's relay token. The relay authenticates with the
// current token and returns a fresh one, so a leaked token stops being a
// permanent liability.
export async function rotateToken(
  relay: string, auth: Auth, opts: { timeoutMs?: number } = {},
): Promise<{ token: string }> {
  const res = await relayFetch(
    relay,
    "/v1/token/rotate",
    {
      method: "POST",
      headers: authHeaders(auth),
    },
    opts.timeoutMs ?? RELAY_TIMEOUT_MS,
  );
  if (res.status === 401) throw new ApiError("Your credentials were rejected. Re-run `agentcall setup`.", "invalid");
  if (res.status === 429) throw new ApiError("Too many rotations — try again in a minute.", "network");
  if (!res.ok) throw new ApiError(`Token rotation failed (${res.status}).`, "network");
  return (await res.json()) as { token: string };
}

export async function pushCard(
  relay: string, auth: Auth, upload: CardUploadType,
  opts: { timeoutMs?: number } = {},
): Promise<void> {
  const res = await relayFetch(
    relay,
    "/v1/card",
    {
      method: "PUT",
      headers: { "content-type": "application/json", ...authHeaders(auth) },
      body: JSON.stringify(upload),
    },
    opts.timeoutMs ?? RELAY_TIMEOUT_MS,
  );
  if (res.status === 401) throw new ApiError("Your credentials were rejected. Re-run `agentcall setup`.", "invalid");
  if (!res.ok) throw new ApiError(`Card push failed (${res.status}).`, "network");
}

export async function createRoster(
  relay: string, auth: Auth, opts: { timeoutMs?: number } = {},
): Promise<{ roster_id: string; join_key: string; admin_secret: string }> {
  const res = await relayFetch(
    relay, "/v1/roster",
    { method: "POST", headers: authHeaders(auth) },
    opts.timeoutMs ?? RELAY_TIMEOUT_MS,
  );
  if (res.status === 401) throw new ApiError("Your credentials were rejected. Re-run `agentcall setup`.", "invalid");
  if (res.status === 429) throw new ApiError("Too many rosters created — try again in a minute.", "network");
  if (!res.ok) throw new ApiError(`Roster creation failed (${res.status}).`, "network");
  return CreateRosterResponse.parse(await res.json());
}

export async function joinRoster(
  relay: string, auth: Auth, rosterId: string, joinKey: string,
  opts: { timeoutMs?: number } = {},
): Promise<void> {
  const res = await relayFetch(
    relay, `/v1/roster/${rosterId}/join`,
    {
      method: "POST",
      headers: { "content-type": "application/json", ...authHeaders(auth) },
      body: JSON.stringify({ join_key: joinKey }),
    },
    opts.timeoutMs ?? RELAY_TIMEOUT_MS,
  );
  if (res.status === 401) throw new ApiError("Your credentials were rejected. Re-run `agentcall setup`.", "invalid");
  if (res.status === 429) throw new ApiError("Too many join attempts — try again in a minute.", "network");
  // The relay deliberately cannot tell these apart, and neither can this
  // message: distinguishing them would make roster ids enumerable.
  if (res.status === 404) {
    throw new ApiError("No such roster, or the join key is invalid, expired, used, or revoked.", "unknown_handle");
  }
  if (res.status === 409) throw new ApiError("That roster is full.", "invalid");
  if (!res.ok) throw new ApiError(`Joining the roster failed (${res.status}).`, "network");
}

async function rosterMutation(
  relay: string, auth: Auth, rosterId: string, operation: string, body: unknown,
  opts: { timeoutMs?: number } = {},
): Promise<Response> {
  const res = await relayFetch(relay, `/v1/roster/${rosterId}/${operation}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...authHeaders(auth) },
    body: JSON.stringify(body),
  }, opts.timeoutMs ?? RELAY_TIMEOUT_MS);
  if (res.status === 401) throw new ApiError("Your credentials were rejected. Re-run `agentcall setup`.", "invalid");
  if (res.status === 429) throw new ApiError(`Too many roster ${operation} attempts — try again in a minute.`, "network");
  if (res.status === 404) throw new ApiError("That roster, member, or administrative secret was not found.", "unknown_handle");
  if (!res.ok) throw new ApiError(`Roster ${operation} failed (${res.status}).`, "network");
  return res;
}

export async function leaveRoster(relay: string, auth: Auth, rosterId: string): Promise<void> {
  await rosterMutation(relay, auth, rosterId, "leave", {});
}

export async function expelRosterMember(
  relay: string, auth: Auth, rosterId: string, handle: string, adminSecret: string,
): Promise<void> {
  await rosterMutation(relay, auth, rosterId, "expel", { handle, admin_secret: adminSecret });
}

export async function issueRosterJoinKey(
  relay: string, auth: Auth, rosterId: string, adminSecret: string,
  options: { description?: string; expiresInDays?: number; reusable?: boolean } = {},
): Promise<{ join_key: string; key: RosterJoinKeyMetadataType }> {
  const res = await rosterMutation(relay, auth, rosterId, "keys", {
    admin_secret: adminSecret,
    description: options.description,
    expires_in_days: options.expiresInDays,
    reusable: options.reusable,
  });
  return IssueRosterJoinKeyResponse.parse(await res.json());
}

export async function listRosterJoinKeys(
  relay: string, auth: Auth, rosterId: string, adminSecret: string,
): Promise<RosterJoinKeyMetadataType[]> {
  const res = await rosterMutation(relay, auth, rosterId, "keys/list", { admin_secret: adminSecret });
  return ListRosterJoinKeysResponse.parse(await res.json()).keys;
}

export async function revokeRosterJoinKey(
  relay: string, auth: Auth, rosterId: string, prefix: string, adminSecret: string, evict = false,
): Promise<{ prefix: string; revoked_at: number; evicted: number }> {
  const res = await rosterMutation(relay, auth, rosterId, `keys/${prefix}/revoke`, {
    admin_secret: adminSecret, evict,
  });
  return RevokeRosterJoinKeyResponse.parse(await res.json());
}

export async function deleteRoster(
  relay: string, auth: Auth, rosterId: string, adminSecret: string,
): Promise<void> {
  await rosterMutation(relay, auth, rosterId, "delete", { admin_secret: adminSecret });
}

// Returns "not-modified" rather than a bundle when the relay 304s, so the
// caller keeps its cached entries instead of parsing an empty body.
export async function fetchRosterBundle(
  relay: string, auth: Auth, rosterId: string, etag?: string,
  opts: { timeoutMs?: number } = {},
): Promise<{ bundle: RosterBundleType; etag?: string } | "not-modified"> {
  const headers: Record<string, string> = authHeaders(auth);
  if (etag) headers["If-None-Match"] = etag;
  const res = await relayFetch(relay, `/v1/roster/${rosterId}/bundle`, { headers }, opts.timeoutMs ?? RELAY_TIMEOUT_MS);
  if (res.status === 304) return "not-modified";
  if (res.status === 401) throw new ApiError("Your credentials were rejected. Re-run `agentcall setup`.", "invalid");
  if (res.status === 429) throw new ApiError("Too many roster refreshes — try again in a minute.", "network");
  if (res.status === 404) {
    throw new ApiError("That roster is gone, or you are no longer a member.", "unknown_handle");
  }
  if (!res.ok) throw new ApiError(`Roster refresh failed (${res.status}).`, "network");
  return { bundle: RosterBundle.parse(await res.json()), etag: res.headers.get("ETag") ?? undefined };
}

export async function fetchCard(
  relay: string, handle: string, auth: Auth,
  opts: { timeoutMs?: number } = {},
): Promise<AgentCardType> {
  const res = await relayFetch(relay, `/v1/card/${handle}`, { headers: authHeaders(auth) }, opts.timeoutMs ?? RELAY_TIMEOUT_MS);
  if (res.status === 401) throw new ApiError("Your credentials were rejected. Re-run `agentcall setup`.", "invalid");
  if (res.status === 404) throw new ApiError(`No card published for "${handle}".`, "unknown_handle");
  if (!res.ok) throw new ApiError(`Card fetch failed (${res.status}).`, "network");
  return AgentCard.parse(await res.json());
}
