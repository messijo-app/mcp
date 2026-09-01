# messijo MCP Worker

Hono-based Cloudflare Worker that exposes the Messijo REST API as a
Model Context Protocol (MCP) server at `https://mcp.messijo.com/mcp`
(Streamable HTTP, stateless sessions).

The Worker plays two OAuth roles simultaneously:

1. **Protected resource** for the MCP resource `https://mcp.messijo.com/mcp` —
   it verifies MCP access tokens locally (RS256/JWKS) and introspects them for
   grant liveness.
2. **Confidential OAuth client** (`messijo-mcp-worker`) of
   `https://auth.messijo.com` — it authenticates with `client_secret_basic` to
   introspect MCP tokens and to exchange them for short-lived
   `worker_backend` tokens (RFC 8693) used against `https://api.messijo.com`.

## Pinned contracts

All behavior is derived from the producer contract, never from API source code:

- Producer revision: `sha256:4dca13e61ead99cff6ab6f069a4a9d6c7a6ea38b689e9ce8a96bc2f1c0ade8d1`
- Fixture: `test/fixtures/oauth/mcp-producer-contract-v1.json`
  (fixture version 1, `fixture_sha256`
  `ed4ca73176ccf84e22c0a8c664b60145b9a867c87fbb283eaeddd00801796f27`)
- REST contract: `0.3.0` (`https://api.messijo.com`)
- Handoff docs: `docs/mcp-worker-oauth-producer-handoff.md`,
  `docs/mcp-worker-implementation-handoff.md`

A guard test (`test/fixture-guard.test.ts`) fails if the vendored fixture is
edited. If the producer revision changes, the Worker must be re-verified
against the new fixture before deployment.

## Requirements

- Node 20+
- pnpm 9+
- Wrangler 4 (installed as a dev dependency)

## Setup

```bash
pnpm install
```

## Development

```bash
pnpm dev          # wrangler dev on http://127.0.0.1:8787
```

Create a `.dev.vars` file (git-ignored) for local secrets:

```
MCP_WORKER_CLIENT_SECRET=<256-bit secret>
# Optional rotation window:
# MCP_WORKER_CLIENT_SECRET_RETIRING=<previous secret>
# MCP_WORKER_CLIENT_SECRET_RETIRING_VALID_UNTIL=<unix seconds deadline>
```

Base URLs (auth server, MCP resource, REST API) come from `vars` in
`wrangler.jsonc`; adjust them for your local environment as needed.

### Routes

| Route | Purpose |
| --- | --- |
| `GET /` | Health check |
| `GET /.well-known/oauth-protected-resource` | RFC 9728 metadata pointing at the authorization server |
| `POST /mcp` | Streamable HTTP MCP endpoint (stateless; requires a valid MCP access token) |

## Testing

```bash
pnpm test         # Vitest on the Workers runtime (vitest-pool-workers)
pnpm test:watch
pnpm typecheck
```

Tests execute inside workerd. Upstream HTTP (authorization server + REST API)
is routed to in-test doubles via `fetchMock` (`test/doubles.ts`), so no network
access is required. The suite covers:

- Fixture guard (pinned `fixture_sha256`, producer revision, file digest)
- Token verification matrix (wrong audience/issuer, missing claims,
  non-RS256, unknown kid after refresh, expired, revoked, kill switch)
- JWKS rotation convergence (refresh-on-unknown-kid)
- Introspection cache (jti-keyed, TTL, bounded by token exp, REST-401
  invalidation)
- Token exchange (RFC 8693 shape, no scope narrowing, in-flight dedupe)
- Token isolation (T_mcp never sent to REST)
- Secret rotation drill (retiring-secret fallback, post-deadline rejection)
- Kill-switch drill (OAuth routes concealed, backend tokens rejected)
- Tool surface conformance against the fixture route policy
- Faithful error surfacing (402/404/422), no mutation retries
- Logging discipline (no token/secret material in logs)

## Deployment

Wrangler 4 no longer supports `environments` in a single config, so each
deployment target has its own config:

| Target | Config | Domain |
| --- | --- | --- |
| Production | `wrangler.jsonc` | `mcp.messijo.com` |
| Staging | `wrangler.staging.jsonc` | `staging.mcp.messijo.com` |

```bash
pnpm deploy          # production
pnpm deploy:staging  # staging
```

Both assume DNS for the custom domain is managed in the same Cloudflare
account (Wrangler creates the custom-domain route on first deploy).

## Secrets and configuration

Worker secrets (set per environment with `wrangler secret put`, or via your
secrets manager such as Doppler):

| Secret | Purpose |
| --- | --- |
| `MCP_WORKER_CLIENT_SECRET` | Active 256-bit client secret for `client_secret_basic` (generate with the API repo's `scripts/generate-mcp-worker-secret.sh`) |
| `MCP_WORKER_CLIENT_SECRET_RETIRING` | Previous secret, accepted only during the rotation overlap |
| `MCP_WORKER_CLIENT_SECRET_RETIRING_VALID_UNTIL` | Absolute Unix-seconds deadline for the retiring secret |

Vars (in the wrangler configs): `AUTH_BASE_URL`, `REST_API_BASE_URL`,
`MCP_RESOURCE_URL`, `MCP_PUBLIC_BASE_URL`, `INTROSPECTION_CACHE_TTL_SECONDS`
(default 10), `JWKS_CACHE_TTL_SECONDS` (default 300), `JWKS_COOLDOWN_MS`
(default 30000).

### Rotation runbook

1. Generate the new secret on the API side and record it.
2. In the Worker: set `MCP_WORKER_CLIENT_SECRET_RETIRING` to the current
   active secret and `MCP_WORKER_CLIENT_SECRET_RETIRING_VALID_UNTIL` to
   now + 15 minutes.
3. Set `MCP_WORKER_CLIENT_SECRET` to the new secret and deploy.
4. The Worker always sends the active secret first and falls back to the
   retiring one only when rejected and before the deadline.
5. After the deadline, remove the retiring secret variables and deploy again.

### Rollback / kill switch

The API's `OAUTH_SYSTEM_ENABLED=false` hard-disables the OAuth surface: OAuth
routes are concealed (404) and worker-backend tokens are rejected by REST.
This Worker fails closed with clear MCP-level errors and does not retry-storm.
Full rollback: disable the Worker route and set `OAUTH_SYSTEM_ENABLED=false`
on the API.

## Compatibility gate

Discovery stays gated until an operator records the exact producer revision in
the API's `OAUTH_MCP_COMPATIBILITY_REVISION` after the deployed Worker passes
the fixture, REST-artifact, selected-organization, and route-policy tests.
