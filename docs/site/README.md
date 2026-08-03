# AgentCall documentation site

This directory is the complete Mintlify publishing root. It intentionally does
not inherit content from the repository's other `docs/` directories.

## Local preview

From this directory, run:

```bash
npx mint dev
```

Before committing CLI or protocol changes, build the workspace and regenerate
the references:

```bash
pnpm build
pnpm docs:generate
pnpm docs:check
```

The CLI page is generated from Commander help and the protocol page from the
built Zod schemas. Hand-written setup and security pages point to the repository
README, which remains the authority on current behavior.

## Publish from GitHub

1. Install the Mintlify GitHub App for `KenTaniguchi-R/agentcall`.
2. Set the documentation path to `docs/site` and the production branch to `main`.
3. Use the default Mintlify URL for the first release. A custom domain can be
   added later without changing this repository.
4. On the Assistant page in the Mintlify dashboard, keep the AI assistant
   disabled. Assistant enablement is a dashboard setting, not a `docs.json`
   property.

Mintlify publishes commits from `main`; pull-request previews are for review.
The site validator rejects navigation or Markdown links that expose files above
this directory, including `docs/superpowers/` and dated security reviews.
