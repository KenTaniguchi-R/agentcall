import {
  DEFAULT_ORG_INVITE_EXPIRY_DAYS,
  HANDLE_RE, AgentCard, AuditExportPage, CreateOrgInviteResponse,
  ListOrgInvitesResponse, RegisterResponse, RevokeOrgInviteResponse,
  RecoveryIssueResponse, RecoveryReceipt, RecoveryStatusResponse,
  EncryptionKeyRecord, formatAddress, IdentityRecord, HPKE_SUITE, MAX_ENCRYPTION_KEY_VALIDITY_MS, parseAddress,
  encryptionKeyTranscript, encryptionKeyTranscriptHash, fromBase64Url, identityTranscript, keyIdFor, signTranscript,
  // AgentKind is ours: registerHandle takes it, and it is the shared type that
  // replaced the inline "claude" | "codex" unions.
  type AgentCardType, type AgentKind, type AuditExportPageType, type CardUploadType,
  type OrgInviteMetadataType,
  type OrgRoleType,
  type EncryptionKeyRecordType, type IdentityRecordType,
  type RecoveryIssueRequestType, type RecoveryIssueResponseType,
  type RecoveryStatusResponseType,
  type RecoveryRedeemRequestType, type RecoveryReceiptType,
} from "@benree/agentcall-shared";
import {
  choosePendingEncryptionPublication, loadKeys, loadPendingEncryptionPublication,
  rememberPublishedEncryptionKey, type StoredKeys,
} from "./keys.js";
import type { Paths } from "./paths.js";

export class ApiError extends Error {
  constructor(
    message: string,
    public code: "handle_taken" | "invite_invalid" | "invalid" | "unknown_handle" | "status_unavailable" | "unauthorized" | "network",
  ) {
    super(message);
  }
}

export type Auth = { org: string; handle: string; token: string };

// Callers hold a Config, which carries more than these three fields.
// Copying the three out — rather than passing the config straight through —
// is the point: TypeScript's excess-property check only fires on object
// literals, so a whole config would be accepted structurally and every field
// on it would be in reach of the request layer. This narrows deliberately,
// and now does it in one place instead of at 25 call sites.
export function authOf(source: Auth): Auth {
  return { org: source.org, handle: source.handle, token: source.token };
}

const CREDENTIALS_REJECTED = "Your credentials were rejected. Re-run `agentcall setup`.";

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

type RelaySchema<T> = { parse(value: unknown): T };
type RelayError = { message: string; code: ApiError["code"] };
type RelayCallOptions = {
  relay: string;
  path: string;
  method?: RequestInit["method"];
  auth?: Auth;
  headers?: Record<string, string>;
  body?: unknown;
  timeoutMs?: number;
  errors?: Partial<Record<number, RelayError>>;
  failed: string;
  failedCode?: ApiError["code"];
  failure?: (status: number) => string;
  raw?: boolean;
};

async function relayCall(opts: RelayCallOptions & { raw: true }): Promise<Response>;
async function relayCall(opts: RelayCallOptions & { response: true }): Promise<Response>;
async function relayCall<T>(opts: RelayCallOptions & { schema: RelaySchema<T>; response?: false }): Promise<T>;
async function relayCall(opts: RelayCallOptions & { schema?: undefined; response?: false }): Promise<void>;
async function relayCall<T>(opts: RelayCallOptions & { schema?: RelaySchema<T>; response?: boolean }): Promise<T | Response | void> {
  const headers = { ...(opts.auth ? authHeaders(opts.auth) : {}), ...opts.headers };
  const init: RequestInit = { method: opts.method, headers };
  if (opts.body !== undefined) {
    init.body = JSON.stringify(opts.body);
    (init.headers as Record<string, string>)["content-type"] ??= "application/json";
  }
  const res = await relayFetch(opts.relay, opts.path, init, opts.timeoutMs ?? RELAY_TIMEOUT_MS);
  if (opts.raw) return res;
  const custom = opts.errors?.[res.status];
  if (custom) throw new ApiError(custom.message, custom.code);
  if (res.status === 401) throw new ApiError(CREDENTIALS_REJECTED, "invalid");
  if (!res.ok) throw new ApiError(opts.failure?.(res.status) ?? `${opts.failed} failed (${res.status}).`, opts.failedCode ?? "network");
  if (opts.response) return res;
  if (opts.schema) return opts.schema.parse(await res.json());
  return undefined;
}

const relayError = (message: string, code: ApiError["code"] = "network"): RelayError => ({ message, code });

export async function registerHandle(
  relay: string, invite: string, handle: string, agentKind?: AgentKind, opts: { timeoutMs?: number } = {},
): Promise<{ org: string; token: string }> {
  if (!invite) throw new ApiError("An organization invite is required.", "invite_invalid");
  assertValidHandle(handle);
  return relayCall({ relay, path: "/v1/register", method: "POST",
    body: { invite, handle, agent_kind: agentKind }, timeoutMs: opts.timeoutMs,
    schema: RegisterResponse, errors: {
      // The relay answers 404 "invalid invite" for four distinct conditions —
      // never existed, already redeemed, revoked, expired — and must keep doing
      // so: /v1/register is unauthenticated, and telling them apart would turn
      // it into an oracle for probing which invites exist. That makes this the
      // only place a next step can be offered, and all four branches share one.
      404: relayError(
        "This invite is invalid, expired, or already used.\n" +
          "Ask your administrator for a new one — invites are single-use and expire after " +
          `${DEFAULT_ORG_INVITE_EXPIRY_DAYS} days by default.`,
        "invite_invalid",
      ),
      // The reassurance is the point. Registration is one D1 batch: the
      // invite's used_at UPDATE is guarded by an EXISTS on the handles row
      // this request just tried to insert (apps/relay/src/index.ts), so a
      // handle collision consumes nothing. Without saying so, the owner's
      // reasonable reading of "already taken" at the end of a failed setup is
      // that they burned their one-time invite on a name they cannot have.
      409: relayError(
        `Handle "${handle}" is already taken.\n` +
          "Your invite was not used — run `agentcall setup` again with a different handle.",
        "handle_taken",
      ),
      503: relayError("Registration is temporarily unavailable. Try again shortly."),
      401: relayError("Registration failed (401).", "invalid"),
    }, failed: "Registration", failedCode: "invalid" });
}

export async function createInvite(
  relay: string, auth: Auth,
  input: { description?: string; expires_in_days?: number; role?: OrgRoleType } = {},
  opts: { timeoutMs?: number } = {},
): Promise<{ invite: string; metadata: OrgInviteMetadataType }> {
  return relayCall({ relay, path: "/v1/invites", method: "POST", auth, body: input,
    timeoutMs: opts.timeoutMs, schema: CreateOrgInviteResponse,
    errors: { 403: relayError("This line is not an organization administrator.", "invalid"), 429: relayError("Too many invites created — try again in a minute.") },
    failed: "Invite creation" });
}

export async function listInvites(
  relay: string, auth: Auth, opts: { timeoutMs?: number } = {},
): Promise<OrgInviteMetadataType[]> {
  const result = await relayCall({ relay, path: "/v1/invites/list", method: "POST", auth,
    timeoutMs: opts.timeoutMs, schema: ListOrgInvitesResponse,
    errors: { 403: relayError("This line is not an organization administrator.", "invalid"), 429: relayError("Too many invite operations — try again in a minute.") },
    failed: "Invite listing" });
  return result.invites;
}

export async function revokeInvite(
  relay: string, auth: Auth, id: string, opts: { timeoutMs?: number } = {},
): Promise<{ id: string; revoked_at: number }> {
  return relayCall({ relay, path: `/v1/invites/${encodeURIComponent(id)}/revoke`, method: "POST", auth,
    timeoutMs: opts.timeoutMs, schema: RevokeOrgInviteResponse,
    errors: {
      403: relayError("This line is not an organization administrator.", "invalid"),
      400: relayError("Invite ID must be the 64-character ID shown by `agentcall invite list`.", "invalid"),
      404: relayError("Invite not found or already used.", "invalid"),
      429: relayError("Too many invite operations — try again in a minute."),
    }, failed: "Invite revocation" });
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
    res = await relayCall({ relay, path: `/v1/audit/events${search.size ? `?${search}` : ""}`,
      headers: authHeaders(auth), timeoutMs: opts.timeoutMs, raw: true, failed: "Audit export" });
    if (res.status !== 429 || !opts.retryRateLimit || rateLimitRetries >= 2) break;
    rateLimitRetries += 1;
    const retryAfter = Number(res.headers.get("Retry-After"));
    const delayMs = Number.isFinite(retryAfter) && retryAfter >= 0
      ? Math.min(retryAfter * 1_000, 60_000)
      : 60_000;
    await res.body?.cancel();
    await (opts.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))))(delayMs);
  }
  if (res.status === 401) throw new ApiError(CREDENTIALS_REJECTED, "invalid");
  if (res.status === 403) throw new ApiError("This line is not an organization administrator.", "invalid");
  if (res.status === 400) throw new ApiError("The audit export cursor, filter, or time range is invalid.", "invalid");
  if (res.status === 409) throw new ApiError("The audit snapshot changed during export. Discard the partial output and retry.", "network");
  if (res.status === 429) throw new ApiError("Too many audit export requests — try again in a minute.", "network");
  if (!res.ok) throw new ApiError(`Audit export failed (${res.status}).`, "network");
  return AuditExportPage.parse(await res.json());
}

// Presence is self-only on the relay, so this always authenticates. `auth` is
// required rather than optional to make that a compile-time fact.
export async function getStatus(
  relay: string, handle: string, auth: Auth, opts: { timeoutMs?: number } = {},
): Promise<{ online: boolean }> {
  return relayCall({ relay, path: `/v1/status/${handle}`, auth, timeoutMs: opts.timeoutMs,
    schema: { parse: (value) => value as { online: boolean } },
    errors: {
      429: relayError("Too many status checks — try again in a minute."),
      404: relayError(`Status unavailable for "${handle}": only the current line may inspect its listener status.`, "status_unavailable"),
    }, failed: "Status check" });
}

// Replaces this install's relay token. The relay authenticates with the
// current token and returns a fresh one, so a leaked token stops being a
// permanent liability.
export async function rotateToken(
  relay: string, auth: Auth, opts: { timeoutMs?: number } = {},
): Promise<{ token: string }> {
  return relayCall({ relay, path: "/v1/token/rotate", method: "POST", auth, timeoutMs: opts.timeoutMs,
    schema: { parse: (value) => value as { token: string } },
    errors: { 429: relayError("Too many rotations — try again in a minute.") }, failed: "Token rotation" });
}

export async function issueRecovery(
  relay: string, auth: Auth, request: RecoveryIssueRequestType, opts: { timeoutMs?: number } = {},
): Promise<RecoveryIssueResponseType> {
  return relayCall({ relay, path: "/v1/recovery/issue", method: "POST", auth, body: request, timeoutMs: opts.timeoutMs,
    schema: RecoveryIssueResponse,
    errors: { 401: relayError("Your credentials were rejected. Re-run recovery if the token is lost.", "invalid"), 409: relayError("The online credential changed during recovery setup. Retry.", "invalid"), 429: relayError("Too many recovery operations — try again in a minute.") },
    failed: "Recovery proof issuance" });
}

export async function getRecoveryStatus(
  relay: string, auth: Auth, opts: { timeoutMs?: number } = {},
): Promise<RecoveryStatusResponseType> {
  return relayCall({ relay, path: "/v1/recovery/status", auth, timeoutMs: opts.timeoutMs,
    schema: RecoveryStatusResponse, errors: { 401: relayError("Your credentials were rejected.", "invalid") }, failed: "Recovery status" });
}

export async function redeemRecovery(
  relay: string, request: RecoveryRedeemRequestType, opts: { timeoutMs?: number } = {},
): Promise<RecoveryReceiptType> {
  return relayCall({ relay, path: "/v1/recovery/redeem", method: "POST", body: request, timeoutMs: opts.timeoutMs,
    schema: RecoveryReceipt, errors: {
      401: relayError("Recovery failed. Check the identity, generation, proofs, and pending operation.", "invalid"),
      429: relayError("Too many recovery attempts — try again in a minute."),
    }, failed: "Recovery" });
}

export async function pushCard(
  relay: string, auth: Auth, upload: CardUploadType,
  opts: { timeoutMs?: number } = {},
): Promise<void> {
  await relayCall({ relay, path: "/v1/card", method: "PUT", auth, body: upload,
    timeoutMs: opts.timeoutMs, failed: "Card push" });
}

export async function fetchCard(
  relay: string, handle: string, auth: Auth,
  opts: { timeoutMs?: number } = {},
): Promise<AgentCardType> {
  return relayCall({ relay, path: `/v1/card/${handle}`, auth, timeoutMs: opts.timeoutMs,
    schema: AgentCard, errors: { 404: relayError(`No card published for "${handle}".`, "unknown_handle") }, failed: "Card fetch" });
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
  relay: string, auth: Auth, keys: StoredKeys,
): Promise<void> {
  const record: IdentityRecordType = IdentityRecord.parse({
    // Both bindings are derived, never passed in pre-composed: the address is
    // a registry key over (org, handle), and the relay origin is the endpoint.
    v: 1, relay_origin: new URL(relay).hostname,
    address: formatAddress(auth.org, auth.handle),
    identity_pub: keys.identity_pub,
  });
  // Self-signed: the record is signed by the very key it publishes. The relay
  // has no way to check an identity key against anything else, so possession of
  // the private half is the only thing that can be proven at publish time.
  const signature = await signTranscript(
    await importIdentityPrivateKey(keys.identity_pkcs8),
    identityTranscript(record),
  );
  await relayCall({ relay, path: "/v1/keys/identity", method: "PUT", auth,
    body: { record, signature }, failed: "identity key", failure: (status) => `Could not publish the identity key (HTTP ${status}).`,
    errors: { 401: relayError("Could not publish the identity key (HTTP 401)."), 409: relayError("A different identity key is already published for this handle. It cannot be replaced.", "invalid") } });
}

export async function publishEncryptionKey(
  relay: string, auth: Auth, paths: Paths, now: number = Date.now(),
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
      relay_origin: new URL(relay).hostname,
      address: formatAddress(auth.org, auth.handle),
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
  await relayCall({ relay, path: "/v1/keys/encryption", method: "PUT", auth, body: publication,
    failed: "encryption key", failure: (status) => `Could not publish the encryption key (HTTP ${status}).`,
    errors: { 401: relayError("Could not publish the encryption key (HTTP 401).") } });
  rememberPublishedEncryptionKey(paths, keys, await encryptionKeyTranscriptHash(record));
}

export async function fetchKeys(
  relay: string, auth: Auth, handle: string,
): Promise<{ identity: IdentityRecordType; encryption: { record: EncryptionKeyRecordType; signature: string } }> {
  assertValidHandle(handle);
  const res = await relayCall({ relay, path: `/v1/keys/${handle}`, auth, response: true,
    errors: {
      404: relayError(`${handle} has no published key. They need a newer agentcall.`, "unknown_handle"),
      401: relayError(CREDENTIALS_REJECTED, "unauthorized"),
    }, failed: `Could not fetch keys for ${handle}`, failure: (status) => `Could not fetch keys for ${handle} (HTTP ${status}).`, failedCode: "status_unavailable" });
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
  // Was `address.split("@")[0]`, which only worked while an address was
  // `handle@host`. Parsing it also binds the organization, so a relay cannot
  // answer with a same-named handle from another tenant.
  const served = parseAddress(identity.data.address);
  if (!served || served.handle !== handle || served.org !== auth.org) {
    throw new ApiError(
      `The relay returned keys for ${identity.data.address} when asked for ${formatAddress(auth.org, handle)}.`,
      "invalid",
    );
  }
  return { identity: identity.data, encryption: { record: record.data, signature: body.encryption.signature } };
}
