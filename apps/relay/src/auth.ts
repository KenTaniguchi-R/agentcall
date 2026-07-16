export async function sha256Hex(s: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function generateToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

// Workers runtime doesn't expose Node's crypto.timingSafeEqual, so this
// compares two same-length hex digests byte-by-byte with no early exit on
// content (only on length, which reveals nothing since both sides are
// always 64-char SHA-256 hex here).
export function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function verifyHandleToken(db: D1Database, handle: string, token: string): Promise<boolean> {
  const row = await db.prepare("SELECT token_hash FROM handles WHERE handle = ?").bind(handle).first<{ token_hash: string }>();
  if (!row) return false;
  return constantTimeEqual(row.token_hash, await sha256Hex(token));
}
