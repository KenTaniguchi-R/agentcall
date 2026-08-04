import { HOSTED_RELAY_HOST, ORG_RE, type OrgRoleType } from "@benree/agentcall-shared";
import { authenticatedHandle } from "./auth.js";

type RequestLike = { header(name: string): string | undefined; url: string };
export type DeploymentMode = "hosted" | "self-hosted";
type TenantAuthEnv = { DB: D1Database; DEPLOYMENT_MODE?: string; SELF_HOSTED_ORG?: string };
// agentId is the stable principal (#154); handle is the routing address
// currently bound to it and is reusable. Anything durable — a Durable Object
// name, card owner, roster member, policy subject, audit actor — belongs on
// agentId. Non-optional so a consumer cannot quietly keep using handle.
export type Identity = {
  org: string; handle: string; agentId: string; role: OrgRoleType; recoveryGeneration: number;
};

export function deploymentOrgAllows(
  mode: string | undefined, configuredOrg: string | undefined, org: string,
): boolean {
  if (mode === "hosted") return configuredOrg === undefined && ORG_RE.test(org);
  return mode === "self-hosted" && configuredOrg !== undefined &&
    ORG_RE.test(configuredOrg) && configuredOrg === org;
}

export function requestOrg(req: RequestLike, mode?: string, configuredOrg?: string): string {
  const header = req.header("X-AgentCall-Org") ?? "";
  if (mode === "self-hosted") {
    if (configuredOrg === undefined || !ORG_RE.test(configuredOrg) ||
      (header !== "" && header !== configuredOrg)) return "";
    return configuredOrg;
  }
  if (mode !== "hosted" || configuredOrg !== undefined) return "";
  if (ORG_RE.test(header)) return header;

  const host = new URL(req.url).hostname;
  const suffix = `.${HOSTED_RELAY_HOST}`;
  if (!host.endsWith(suffix)) return "";
  const org = host.slice(0, -suffix.length);
  return ORG_RE.test(org) ? org : "";
}

export async function authenticateRequest(
  env: TenantAuthEnv, req: RequestLike,
): Promise<Identity | null> {
  const org = requestOrg(req, env.DEPLOYMENT_MODE, env.SELF_HOSTED_ORG);
  const handle = req.header("X-AgentCall-Handle") ?? "";
  const token = (req.header("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!org) return null;
  const authenticated = await authenticatedHandle(env.DB, org, handle, token);
  return authenticated ? { org, handle, ...authenticated } : null;
}

export function requireOrgAdmin(identity: Identity): boolean {
  return identity.role === "admin";
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
