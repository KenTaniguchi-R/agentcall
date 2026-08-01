export const A2A_PROTOCOL_VERSION = "1.0";
export const A2A_VERSION_HEADER = "A2A-Version";

/**
 * An absent or empty header means the client did not negotiate, so we serve
 * the version we advertise. Anything else must match exactly — the spec
 * requires VersionNotSupportedError (400) otherwise, and silently processing
 * a request under a version we did not agree to is the failure mode that rule
 * exists to prevent.
 */
export function isSupportedA2AVersion(header: string | undefined | null): boolean {
  if (header === undefined || header === null) return true;
  const trimmed = header.trim();
  if (trimmed === "") return true;
  return trimmed === A2A_PROTOCOL_VERSION;
}
