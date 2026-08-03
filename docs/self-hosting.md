# Self-hosting the relay on customer-owned Cloudflare

AgentCall provides an experimental reference artifact for one
customer-operated relay per organization in the customer's own Cloudflare
account. It is limited to internal, pre-production evaluation while the
security gates in issues #1–#8 remain incomplete; public and enterprise
production deployment is not supported yet. This is a
bring-your-own-Cloudflare (BYOC) deployment: the customer owns the Worker, D1
database, Durable Objects,
Analytics Engine dataset, custom domain, secrets, billing, logs, backups, and
upgrade schedule.

This is not an on-premises package, a generic container image, or relay
federation. Two deployments are two isolated organizations; they do not
discover, trust, or route to one another. Moving the Worker into a customer
account changes operator ownership, but does not by itself create a regional
data-residency claim. Review [the data map](security/data-residency.md) before
making one.

## Why the reference artifact is Wrangler

The relay is entirely Cloudflare-native. Wrangler is already the source of
truth for D1, SQLite Durable Object exports, Analytics Engine, native rate
limits, the custom domain, and Worker deployment. The reference artifact is
therefore a versioned Wrangler configuration plus this runbook. A Terraform
module would duplicate that state and is not shipped; customers may wrap the
documented commands in their own infrastructure automation.

Pin an exact AgentCall tag or commit for an internal evaluation, not a moving
branch. Do not promote it to public or enterprise production until issues
#1–#8 close. You need a Cloudflare account with a zone for the relay hostname,
Node.js, and pnpm. Review the Cloudflare plan and account limits for Workers,
D1, Durable Objects, Analytics Engine, and Workers Rate Limiting before setting
evaluation expectations.

## 1. Create the customer configuration

From the repository root:

```bash
pnpm install --frozen-lockfile
pnpm -r build
cd apps/relay
cp wrangler.self-host.example.jsonc wrangler.self-host.jsonc
pnpm exec wrangler d1 create acme-agentcall
```

`wrangler.self-host.jsonc` is gitignored because it contains customer resource
identifiers. Edit it and replace every `replace-with-...` value and the all-zero
D1 UUID:

- `name`: a unique Worker name in the customer account;
- `DEPLOYMENT_MODE`: keep this exactly `self-hosted`; missing or unknown modes
  fail tenant authentication, bootstrap, and enrollment closed;
- `SELF_HOSTED_ORG`: the one organization slug served by this relay (2–63
  lowercase letters, digits, or hyphens, starting with a letter or digit);
- `database_name` and `database_id`: the values returned by `wrangler d1
  create`;
- the Analytics Engine dataset name;
- three distinct, unused rate-limit namespace IDs. Cloudflare requires each to
  be a positive integer encoded as a string (for example `"1001"`); replace
  the example values if those IDs are already used in the customer account; and
- `routes[0].pattern`: the customer-owned relay hostname.

Do not remove `DEPLOYMENT_MODE`, `workers_dev: false`, or
`preview_urls: false`. The custom domain
must be the only route to the Worker; an alternate public origin would bypass
controls attached to that hostname. Keep all binding names unchanged because
they are the Worker's runtime API.

The `SELF_HOSTED_ORG` binding is an application boundary, not just a label. The
relay rejects a conflicting tenant header, bootstrap request, or invite
redemption, which prevents a single-host address such as
`ken@agents.acme.example` from becoming ambiguous across tenants.

## 2. Validate, migrate, and deploy

Run the commands from `apps/relay` and always pass the customer config
explicitly:

```bash
pnpm exec wrangler deploy --dry-run --config wrangler.self-host.jsonc
pnpm exec wrangler d1 migrations apply acme-agentcall --remote \
  --config wrangler.self-host.jsonc
pnpm exec wrangler deploy --config wrangler.self-host.jsonc
pnpm exec wrangler secret put BOOTSTRAP_TOKEN \
  --config wrangler.self-host.jsonc
```

The migration must finish before the first request reaches new code. The dry
run validates and bundles the Worker but cannot compare live Durable Object
state. Read the real deployment's reconciliation report: an unexpected class
create, delete, rename, or transfer is an incident, not a routine warning.

`BOOTSTRAP_TOKEN` is entered through Wrangler's prompt and must come from the
customer's secret manager. Do not put it in the Wrangler file, shell history,
CI logs, or the AgentCall line config. The bootstrap endpoint remains a 404
until the secret is installed.

Verify that the custom domain is live and the public directory card responds:

```bash
curl --fail-with-body \
  --header 'A2A-Version: 1.0' \
  https://agents.acme.example/.well-known/agent-card.json
```

Then use the bootstrap token to call `POST /v1/admin/invite` with the exact
configured organization slug. This command prompts without echoing the secret
or placing it in shell history, passes it to curl over stdin configuration, and
extracts the one-time invite from the response using the already-required Node
runtime:

```bash
relay_url=https://agents.acme.example
org=acme
printf 'Bootstrap token: ' >&2
IFS= read -r -s bootstrap_token && printf '\n' >&2
bootstrap_response="$(
  printf 'header = "Authorization: Bearer %s"\n' "$bootstrap_token" |
    curl --silent --show-error --fail-with-body --config - \
      --header 'content-type: application/json' \
      --data "{\"org\":\"$org\"}" \
      "$relay_url/v1/admin/invite"
)"
unset bootstrap_token
invite="$(printf '%s' "$bootstrap_response" | node -e \
  'let s=""; process.stdin.on("data", d => s += d).on("end", () => console.log(JSON.parse(s).invite))')"
unset bootstrap_response
```

Enroll the first line with that invite:

```bash
agentcall setup \
  --relay "$relay_url" \
  --invite "$invite" \
  --handle <handle>
unset invite
```

The returned and locally stored address uses the customer hostname. Every line
that participates in this organization must use the same relay URL.

## CI deployment

For noninteractive deployment, provide `CLOUDFLARE_ACCOUNT_ID` and a narrowly
scoped `CLOUDFLARE_API_TOKEN` through the customer's CI secret manager. Follow
Cloudflare's current Wrangler CI/CD guidance when selecting permissions; do not
copy an account-wide token into the repository. Keep `BOOTSTRAP_TOKEN` separate
from the deployment credential.

CI should run the repository build, typecheck, and test gates, then the same
dry-run, D1 migration, and deploy commands above. Protect the deployment
environment with customer review rules and retain the Wrangler output as
change evidence without retaining secrets.

## Upgrades, rollback, and ownership

For each tagged upgrade:

1. compare `wrangler.self-host.example.jsonc` with the customer file for new or
   changed bindings;
2. run build, typecheck, tests, and the customer-config dry run;
3. back up according to the customer's D1/Cloudflare policy;
4. apply new D1 migrations; and
5. deploy and inspect the Durable Object reconciliation report.

D1 migrations are append-only and have no automatic down migration. Rolling
back Worker code does not roll back D1 or Durable Object state. Test restoration
and recovery in the customer account before relying on them for an incident or
compliance commitment.

The customer is also responsible for Cloudflare account access, domain and
certificate ownership, API-token rotation, `BOOTSTRAP_TOKEN` rotation,
Workers/Access logs, alerts, cost controls, backups, retention, and incident
response. Cloudflare Access is not placed in front of the machine relay API and
is not implemented as an AgentCall authorization layer; a future human admin
hostname has a separate acceptance contract.

Current Cloudflare references:

- [Wrangler configuration](https://developers.cloudflare.com/workers/wrangler/configuration/)
- [D1 Wrangler commands](https://developers.cloudflare.com/d1/wrangler-commands/)
- [Workers secrets](https://developers.cloudflare.com/workers/configuration/secrets/)
- [Workers CI/CD](https://developers.cloudflare.com/workers/ci-cd/external-cicd/)
- [Custom Domains](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/)
