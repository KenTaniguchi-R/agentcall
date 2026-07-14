export async function sha256Hex(s: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function generateToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

export async function verifyHandleToken(db: D1Database, handle: string, token: string): Promise<boolean> {
  const row = await db.prepare("SELECT token_hash FROM handles WHERE handle = ?").bind(handle).first<{ token_hash: string }>();
  if (!row) return false;
  return row.token_hash === (await sha256Hex(token));
}
