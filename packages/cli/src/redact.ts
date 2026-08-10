// The answering agent runs in the owner's OS account with the owner's real
// credentials, and the reply it produces is end-to-end encrypted to the caller.
// Nothing between this process and the caller can inspect it — which is a
// deliberate property, and the reason this process is the last and only place a
// leaked credential can be caught. On a server-mediated path a missed scan still
// leaves a server-side record someone could audit later; here it leaves no
// observer anywhere.
//
// This is a floor, not a DLP system: a fixed local pass with no service, no API
// token, and no network call, so there is no condition under which it declines
// to run and waves the text through. #173 tracks the scanning-service question
// separately, and stays gated on third-party egress authorization.

/** What the caller sees in place of a redacted credential. Visible on purpose. */
export const REDACTED_MARKER = "[redacted]";

// Third-party credentials with a distinctive prefix or shape. Each is anchored
// on something that does not occur in ordinary prose, because a redactor that
// fires on normal replies is one the owner turns off.
const CREDENTIAL_SHAPES: readonly RegExp[] = [
  // Anthropic and OpenAI: sk-, sk-ant-…, sk-proj-… — one family, one pattern.
  /\bsk-[A-Za-z0-9_-]{16,}/g,
  // GitHub personal/OAuth/user/server/refresh tokens, then fine-grained PATs.
  /\bgh[pousr]_[A-Za-z0-9]{36,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{22,}/g,
  // AWS access key ids. Always 20 characters, always uppercase.
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g,
  // JWTs. A JSON header base64url-encodes to a leading "eyJ", which is what
  // separates these from an arbitrary dotted identifier.
  /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/g,
  // A bearer credential presented in a header line. The length floor keeps
  // "Authorization: Bearer" with nothing after it from matching.
  /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/g,
];

// A known secret is matched as a bare substring, so a short one is not a
// credential pattern — it is a word filter. `generateToken()` mints 43
// characters; a placeholder like "tok" in a test or a half-written config would
// otherwise redact every "token" and "Tokyo" in an ordinary reply. Below this
// length the value cannot be a real relay credential, so ignoring it loses
// nothing and mangling on it costs real replies.
const MIN_KNOWN_SECRET_LENGTH = 16;

/**
 * Remove credential material from an agent's reply before it leaves the machine.
 *
 * `knownSecrets` carries this machine's own credentials, redacted by exact
 * value rather than by shape. `generateToken()` in the relay mints 32 random
 * bytes as base64url — 43 characters with no prefix — and there is no pattern
 * that would match that without also matching ordinary base64. Matching the
 * literal value is both exact and stronger: it cannot miss and cannot
 * false-positive. Entries that are empty, whitespace, or too short to be a real
 * credential are ignored, so a missing or placeholder config field cannot turn
 * into a rule that redacts ordinary words.
 */
export function redactOutbound(text: string, knownSecrets: readonly string[] = []): string {
  let out = text;
  for (const shape of CREDENTIAL_SHAPES) out = out.replace(shape, REDACTED_MARKER);
  for (const secret of knownSecrets) {
    if (secret.trim().length < MIN_KNOWN_SECRET_LENGTH) continue;
    out = out.replaceAll(secret, REDACTED_MARKER);
  }
  return out;
}
