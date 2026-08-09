import { ORG_RE, type OrgRoleType } from "@benree/agentcall-shared";
import { authenticatedHandle } from "./auth.js";

// Headers only, deliberately. This carried `url` while the hostname was a
// fallback source of the org; narrowing it to what is actually read means a
// hostname cannot reach `requestOrg` to be trusted again, which the comment in
// that function argues for and this type now enforces. Hono's `c.req` is
// wider, so it still satisfies this.
type RequestLike = { header(name: string): string | undefined };
export type DeploymentMode = "hosted" | "self-hosted";
type TenantAuthEnv = { DB: D1Database; DEPLOYMENT_MODE?: string; SELF_HOSTED_ORG?: string };
// agentId is the stable principal (#154); handle is the routing address
// currently bound to it and is reusable. Anything durable — a Durable Object
// name, card owner, policy subject, audit actor — belongs on agentId.
// Non-optional so a consumer cannot quietly keep using handle.
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

// Which org this request is claiming, or "" if the deployment does not permit
// that claim. Deciding *which* org is claimed is the only thing this adds; the
// hosted/self-hosted rule itself is `deploymentOrgAllows` and is not restated
// here, so the two cannot drift apart.
//
// Header only. The hostname used to be a fallback source of the org, which
// made the tenant boundary depend on two things that could disagree; the
// credential settles it either way, because `authenticatedHandle` scopes its
// lookup by (org, handle) and a token from one org cannot authenticate
// against another. One source, and it is the one that is actually proven.
//
// A self-hosted request may omit the header — the relay serves exactly one
// org, so silence claims that org. Sending a *different* one is a claim on
// another org, which `deploymentOrgAllows` rejects via `configuredOrg === org`
// rather than by a separate mismatch test. The fallback is inert under hosted,
// where `configuredOrg` is required to be undefined anyway.
export function requestOrg(req: RequestLike, mode?: string, configuredOrg?: string): string {
  const claimed = req.header("X-AgentCall-Org") || configuredOrg || "";
  return deploymentOrgAllows(mode, configuredOrg, claimed) ? claimed : "";
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

// The Durable Object name (#154 slice 4). Named by the stable identity, not
// by the reusable address: idFromName hashes this string, so an object named
// by handle is a different physical object the moment the handle moves, and
// its pending calls, audit outbox, and credential floor become unreachable
// with no error raised.
//
// It takes an object rather than two strings deliberately. Both arguments
// were `string`, so passing a handle where an agent_id belongs would have
// typechecked and then silently split one identity across two objects — the
// single most damaging mistake available in this refactor. Now it will not
// compile.
export function identityObjectName(identity: { org: string; agentId: string }): string {
  return `${identity.org}:${identity.agentId}`;
}
