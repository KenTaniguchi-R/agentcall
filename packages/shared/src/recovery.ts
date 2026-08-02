// Crockford base32: no I, L, O or U. I/L/O are decoded as their digit
// lookalikes so a hand-transcribed code survives; U is excluded outright
// (Crockford drops it to avoid accidental obscenities) and is therefore a
// hard rejection rather than a confusable.
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const CONFUSABLES: Record<string, string> = { I: "1", L: "1", O: "0" };

// 15 bytes = 120 bits = exactly 24 base32 characters, no padding.
const CODE_BYTES = 15;
const CODE_CHARS = 24;
const GROUP = 4;

/** Distinguishes a recovery code from the base64url handle token on sight,
 *  and gives secret-scanning a pattern to match. */
export const RECOVERY_PREFIX = "agcr_";

/** Display form: `agcr_XXXX-XXXX-XXXX-XXXX-XXXX-XXXX`. */
export function generateRecoveryCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(CODE_BYTES));
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  const groups = [];
  for (let i = 0; i < out.length; i += GROUP) groups.push(out.slice(i, i + GROUP));
  return RECOVERY_PREFIX + groups.join("-");
}

/**
 * Canonical 24-char body, or null if the input isn't a well-formed code.
 * THIS is what gets hashed — presentation (prefix, hyphens, case) is
 * cosmetic, so a code typed back in any of those forms still verifies.
 */
export function normalizeRecoveryCode(input: string): string | null {
  let body = input.trim().toUpperCase().replaceAll("-", "").replaceAll(" ", "");
  const prefix = RECOVERY_PREFIX.toUpperCase();
  if (body.startsWith(prefix)) body = body.slice(prefix.length);
  if (body.length !== CODE_CHARS) return null;
  let out = "";
  for (const ch of body) {
    const mapped = CONFUSABLES[ch] ?? ch;
    if (!ALPHABET.includes(mapped)) return null;
    out += mapped;
  }
  return out;
}
