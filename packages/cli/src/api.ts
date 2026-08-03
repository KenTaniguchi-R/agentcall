import {
  HANDLE_RE, AgentCard, AuditExportPage, CreateOrgInviteResponse, CreateRosterResponse, IssueRosterJoinKeyResponse,
  ListOrgInvitesResponse, ListRosterJoinKeysResponse, RegisterResponse, RevokeOrgInviteResponse,
  RecoveryIssueResponse, RecoveryReceipt, RecoveryStatusResponse,
  RevokeRosterJoinKeyResponse, RosterBundle,
  EncryptionKeyRecord, IdentityRecord, HPKE_SUITE, MAX_ENCRYPTION_KEY_VALIDITY_MS,
  encryptionKeyTranscript, encryptionKeyTranscriptHash, fromBase64Url, identityTranscript, keyIdFor, signTranscript,
  // AgentKind is ours: registerHandle takes it, and it is the shared type that
  // replaced the inline "claude" | "codex" unions.
  type AgentCardType, type AgentKind, type AuditExportPageType, type CardUploadType,
  type OrgInviteMetadataType, type RosterBundleType,
  type OrgRoleType,
  type RosterJoinKeyMetadataType,
  type EncryptionKeyRecordType, type IdentityRecordType,
  type RecoveryIssueRequestType, type RecoveryIssueResponseType,
  type RecoveryStatusResponseType,
  type RecoveryRedeemRequestType, type RecoveryReceiptType,
} from "@benree/agentcall-shared";
import {
  choosePendingEncryptionPublication, loadKeys, loadPendingEncryptionPublication,
  rememberPublishedEncryptionKey, type StoredKeys,
} from "./keys.js";
import type { LinePaths } from "./paths.js";

export class ApiError extends Error {
  constructor(
    message: string,
    public code: "handle_taken" | "invite_invalid" | "invalid" | "unknown_handle" | "status_unavailable" | "unauthorized" | "network",
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
  relay: string, invite: string, handle: string, agentKind?: AgentKind, opts: { timeoutMs?: number } = {},
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
  input: { description?: string; expires_in_days?: number; role?: OrgRoleType } = {},
  opts: { timeoutMs?: number } = {},
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
  if (res.status === 403) throw new ApiError("This line is not an organization administrator.", "invalid");
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
  if (res.status === 403) throw new ApiError("This line is not an organization administrator.", "invalid");
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
  if (res.status === 403) throw new ApiError("This line is not an organization administrator.", "invalid");
  if (res.status === 400) throw new ApiError("Invite ID must be the 64-character ID shown by `agentcall invite list`.", "invalid");
  if (res.status === 404) throw new ApiError("Invite not found or already used.", "invalid");
  if (res.status === 429) throw new ApiError("Too many invite operations — try again in a minute.", "network");
  if (!res.ok) throw new ApiError(`Invite revocation failed (${res.status}).`, "network");
  return RevokeOrgInviteResponse.parse(await res.json());
}

export async function fetchAuditExportPage(
  relay: string,
  auth: Auth,
  query: {
    after?: number;
    before?: number;
    actor?: string;
    event?: string;
    actor_ip?: string;
    page_size?: number;
    page_token?: string;
  } = {},
  opts: { timeoutMs?: number; retryRateLimit?: boolean; sleep?: (ms: number) => Promise<void> } = {},
): Promise<AuditExportPageType> {
  const search = new URLSearchParams();
  if (query.after !== undefined) search.set("after", String(query.after));
  if (query.before !== undefined) search.set("before", String(query.before));
  if (query.actor !== undefined) search.set("actor", query.actor);
  if (query.event !== undefined) search.set("event", query.event);
  if (query.actor_ip !== undefined) search.set("actor_ip", query.actor_ip);
  if (query.page_size !== undefined) search.set("page_size", String(query.page_size));
  if (query.page_token) search.set("page_token", query.page_token);
  let res: Response;
  let rateLimitRetries = 0;
  while (true) {
    res = await relayFetch(
      relay, `/v1/audit/events${search.size ? `?${search}` : ""}`,
      { headers: authHeaders(auth) }, opts.timeoutMs ?? RELAY_TIMEOUT_MS,
    );
    if (res.status !== 429 || !opts.retryRateLimit || rateLimitRetries >= 2) break;
    rateLimitRetries += 1;
    const retryAfter = Number(res.headers.get("Retry-After"));
    const delayMs = Number.isFinite(retryAfter) && retryAfter >= 0
      ? Math.min(retryAfter * 1_000, 60_000)
      : 60_000;
    await res.body?.cancel();
    await (opts.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))))(delayMs);
  }
  if (res.status === 401) throw new ApiError("Your credentials were rejected. Re-run `agentcall setup`.", "invalid");
  if (res.status === 403) throw new ApiError("This line is not an organization administrator.", "invalid");
  if (res.status === 400) throw new ApiError("The audit export cursor, filter, or time range is invalid.", "invalid");
  if (res.status === 409) throw new ApiError("The audit snapshot changed during export. Discard the partial output and retry.", "network");
  if (res.status === 429) throw new ApiError("Too many audit export requests — try again in a minute.", "network");
  if (!res.ok) throw new ApiError(`Audit export failed (${res.status}).`, "network");
  return AuditExportPage.parse(await res.json());
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

export async function issueRecovery(
  relay: string, auth: Auth, request: RecoveryIssueRequestType, opts: { timeoutMs?: number } = {},
): Promise<RecoveryIssueResponseType> {
  const res = await relayFetch(relay, "/v1/recovery/issue", {
    method: "POST",
    headers: { ...authHeaders(auth), "content-type": "application/json" },
    body: JSON.stringify(request),
  }, opts.timeoutMs ?? RELAY_TIMEOUT_MS);
  if (res.status === 401) throw new ApiError("Your credentials were rejected. Re-run recovery if the token is lost.", "invalid");
  if (res.status === 409) throw new ApiError("The online credential changed during recovery setup. Retry.", "invalid");
  if (res.status === 429) throw new ApiError("Too many recovery operations — try again in a minute.", "network");
  if (!res.ok) throw new ApiError(`Recovery proof issuance failed (${res.status}).`, "network");
  return RecoveryIssueResponse.parse(await res.json());
}

export async function getRecoveryStatus(
  relay: string, auth: Auth, opts: { timeoutMs?: number } = {},
): Promise<RecoveryStatusResponseType> {
  const res = await relayFetch(relay, "/v1/recovery/status", {
    method: "GET", headers: authHeaders(auth),
  }, opts.timeoutMs ?? RELAY_TIMEOUT_MS);
  if (res.status === 401) throw new ApiError("Your credentials were rejected.", "invalid");
  if (!res.ok) throw new ApiError(`Recovery status failed (${res.status}).`, "network");
  return RecoveryStatusResponse.parse(await res.json());
}

export async function redeemRecovery(
  relay: string, request: RecoveryRedeemRequestType, opts: { timeoutMs?: number } = {},
): Promise<RecoveryReceiptType> {
  const res = await relayFetch(relay, "/v1/recovery/redeem", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(request),
  }, opts.timeoutMs ?? RELAY_TIMEOUT_MS);
  if (res.status === 401) throw new ApiError("Recovery failed. Check the identity, generation, proofs, and pending operation.", "invalid");
  if (res.status === 429) throw new ApiError("Too many recovery attempts — try again in a minute.", "network");
  if (!res.ok) throw new ApiError(`Recovery failed (${res.status}).`, "network");
  return RecoveryReceipt.parse(await res.json());
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

// Uses fromBase64Url from @benree/agentcall-shared (Task 3) rather than
// re-implementing the decode: one base64url implementation in the codebase.
async function importIdentityPrivateKey(pkcs8B64url: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "pkcs8", fromBase64Url(pkcs8B64url) as BufferSource,
    { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"],
  );
}

export async function publishIdentityKey(
  relay: string, auth: Auth, keys: StoredKeys, host: string,
): Promise<void> {
  const record: IdentityRecordType = IdentityRecord.parse({
    v: 1, address: `${auth.handle}@${host}`, identity_pub: keys.identity_pub,
  });
  // Self-signed: the record is signed by the very key it publishes. The relay
  // has no way to check an identity key against anything else, so possession of
  // the private half is the only thing that can be proven at publish time.
  const signature = await signTranscript(
    await importIdentityPrivateKey(keys.identity_pkcs8),
    identityTranscript(record),
  );
  const res = await relayFetch(
    relay, "/v1/keys/identity",
    {
      method: "PUT",
      headers: { "content-type": "application/json", ...authHeaders(auth) },
      body: JSON.stringify({ record, signature }),
    },
    RELAY_TIMEOUT_MS,
  );
  if (res.status === 409) {
    throw new ApiError(
      "A different identity key is already published for this handle. It cannot be replaced.",
      "invalid",
    );
  }
  if (!res.ok) throw new ApiError(`Could not publish the identity key (HTTP ${res.status}).`, "network");
}

export async function publishEncryptionKey(
  relay: string, auth: Auth, paths: LinePaths, host: string, now: number = Date.now(),
): Promise<void> {
  let keys = loadKeys(paths);
  let publication = loadPendingEncryptionPublication(paths, keys);
  if (keys.published_encryption_transcript_hash) {
    if (publication) {
      const pendingHash = await encryptionKeyTranscriptHash(publication.record);
      if (pendingHash !== keys.published_encryption_transcript_hash) {
        throw new Error("The acknowledged encryption key does not match its pending publication.");
      }
    }
    return;
  }

  if (!publication) {
    const pub = keys.encryption_pub;
    const record: EncryptionKeyRecordType = EncryptionKeyRecord.parse({
      v: 1,
      address: `${auth.handle}@${host}`,
      key_id: await keyIdFor(pub),
      suite: HPKE_SUITE,
      pub,
      epoch: keys.epoch,
      not_before: now,
      not_after: now + MAX_ENCRYPTION_KEY_VALIDITY_MS,
      prev: keys.previous_encryption_transcript_hash,
    });
    const candidate = {
      record,
      signature: await signTranscript(
        await importIdentityPrivateKey(keys.identity_pkcs8),
        encryptionKeyTranscript(record),
      ),
    };
    const chosen = choosePendingEncryptionPublication(paths, candidate);
    keys = chosen.keys;
    publication = chosen.publication;
    if (!publication) return;
  }

  const { record } = publication;
  const res = await relayFetch(
    relay, "/v1/keys/encryption",
    { method: "PUT", headers: { "content-type": "application/json", ...authHeaders(auth) }, body: JSON.stringify(publication) },
    RELAY_TIMEOUT_MS,
  );
  if (!res.ok) throw new ApiError(`Could not publish the encryption key (HTTP ${res.status}).`, "network");
  rememberPublishedEncryptionKey(paths, keys, await encryptionKeyTranscriptHash(record));
}

export async function fetchKeys(
  relay: string, auth: Auth, handle: string,
): Promise<{ identity: IdentityRecordType; encryption: { record: EncryptionKeyRecordType; signature: string } }> {
  assertValidHandle(handle);
  const res = await relayFetch(
    relay, `/v1/keys/${handle}`, { headers: authHeaders(auth) }, RELAY_TIMEOUT_MS,
  );
  if (res.status === 404) {
    throw new ApiError(`${handle} has no published key. They need a newer agentcall.`, "unknown_handle");
  }
  if (res.status === 401) {
    throw new ApiError("Your credentials were rejected. Re-run `agentcall setup`.", "unauthorized");
  }
  if (!res.ok) throw new ApiError(`Could not fetch keys for ${handle} (HTTP ${res.status}).`, "status_unavailable");
  let body: { identity?: unknown; encryption?: { record?: unknown; signature?: unknown } };
  try {
    body = await res.json() as typeof body;
  } catch {
    throw new ApiError(`The relay returned malformed JSON for ${handle}.`, "invalid");
  }
  const identity = IdentityRecord.safeParse(body.identity);
  const record = EncryptionKeyRecord.safeParse(body.encryption?.record);
  if (!identity.success || !record.success || typeof body.encryption?.signature !== "string") {
    throw new ApiError(`The relay returned a malformed key record for ${handle}.`, "invalid");
  }
  // Bind the answer to the question. Both records parse fine with any address
  // in them, so without this a relay asked for `ken` could return Sarah's
  // records — well-formed, correctly signed by Sarah, and about to be used to
  // encrypt to the wrong person. The two records must also agree with each
  // other, or a caller pins one address and encrypts to another.
  if (identity.data.address !== record.data.address) {
    throw new ApiError(
      `The relay returned key records for two different addresses when asked for ${handle}.`,
      "invalid",
    );
  }
  if (identity.data.address.split("@")[0] !== handle) {
    throw new ApiError(
      `The relay returned keys for ${identity.data.address} when asked for ${handle}.`,
      "invalid",
    );
  }
  return { identity: identity.data, encryption: { record: record.data, signature: body.encryption.signature } };
}
