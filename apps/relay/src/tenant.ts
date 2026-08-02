import { ORG_RE } from "@benree/agentcall-shared";

export const HOSTED_RELAY_HOST = "agentcall.benree.tech";

type RequestLike = { header(name: string): string | undefined; url: string };

export function requestOrg(req: RequestLike): string {
  const header = req.header("X-AgentCall-Org") ?? "";
  if (ORG_RE.test(header)) return header;

  const host = new URL(req.url).hostname;
  const suffix = `.${HOSTED_RELAY_HOST}`;
  if (!host.endsWith(suffix)) return "";
  const org = host.slice(0, -suffix.length);
  return ORG_RE.test(org) ? org : "";
}

export function identityKey(org: string, handle: string): string {
  return `${org}:${handle}`;
}

export function registrationAddressHost(org: string, requestUrl: string): string {
  const host = new URL(requestUrl).hostname;
  return host === HOSTED_RELAY_HOST ? `${org}.${host}` : host;
}
