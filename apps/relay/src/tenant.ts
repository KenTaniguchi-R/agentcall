import { ORG_RE } from "@benree/agentcall-shared";
import { verifyHandleToken } from "./auth.js";

export const HOSTED_RELAY_HOST = "agentcall.benree.tech";

type RequestLike = { header(name: string): string | undefined; url: string };
export type Identity = { org: string; handle: string };

export function requestOrg(req: RequestLike): string {
  const header = req.header("X-AgentCall-Org") ?? "";
  if (ORG_RE.test(header)) return header;

  const host = new URL(req.url).hostname;
  const suffix = `.${HOSTED_RELAY_HOST}`;
  if (!host.endsWith(suffix)) return "";
  const org = host.slice(0, -suffix.length);
  return ORG_RE.test(org) ? org : "";
}

export async function authenticateRequest(db: D1Database, req: RequestLike): Promise<Identity | null> {
  const org = requestOrg(req);
  const handle = req.header("X-AgentCall-Handle") ?? "";
  const token = (req.header("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  return org && (await verifyHandleToken(db, org, handle, token)) ? { org, handle } : null;
}

export function identityKey(org: string, handle: string): string {
  return `${org}:${handle}`;
}

export function registrationAddressHost(org: string, requestUrl: string): string {
  const host = new URL(requestUrl).hostname;
  return host === HOSTED_RELAY_HOST || host.endsWith(`.${HOSTED_RELAY_HOST}`)
    ? `${org}.${HOSTED_RELAY_HOST}`
    : host;
}
