# MCP Worker Implementation Handoff

This document hands off the MCP Worker implementation to the workers
repository. It builds on the pinned producer contract in
[`docs/mcp-worker-oauth-producer-handoff.md`](./mcp-worker-oauth-producer-handoff.md)
and the machine-readable fixture
[`test/fixtures/oauth/mcp-producer-contract-v1.json`](../test/fixtures/oauth/mcp-producer-contract-v1.json).
Read those first; this document covers implementation posture: how a Hono-based
Cloudflare Worker should verify tokens, call the REST API, expose a first
release of tools, and stay inside the API's authorization boundaries.

The API repository owns the OAuth contract only. Worker implementation,
deployment, and tool design live in the workers repository.

## Pinned contracts

Everything in this document is frozen by the producer revision. Do not derive
behavior from API source code; use these artifacts:

- Producer revision: `sha256:4dca13e61ead99cff6ab6f069a4a9d6c7a6ea38b689e9ce8a96bc2f1c0ade8d1`
- Machine-readable fixture: `test/fixtures/oauth/mcp-producer-contract-v1.json`
  (fixture version 1, `fixture_sha256` embedded in the file)
- Released REST OpenAPI: `priv/static/openapi.json`, contract version `0.3.0`
- Route-policy evidence: the `route_policy` array in the fixture (full
  controller/action inventory with minimum scope and rationale)

If any of these change, the producer revision changes and the Worker must be
re-verified against the new fixture.

## System role

The Worker plays two OAuth roles simultaneously:

1. **Protected resource** for the MCP resource `https://mcp.messijo.com/mcp`.
   MCP clients present `T_mcp` access tokens; the Worker validates them before
   serving any MCP session.
2. **Confidential client** (`client_id: messijo-mcp-worker`) of the
   authorization server `https://auth.messijo.com`. It authenticates with
   `client_secret_basic` to introspect MCP tokens and to exchange them for
   short-lived backend credentials.

```
 MCP client ── T_mcp ──▶ Worker (mcp.messijo.com)
                          │ verify (JWKS) / introspect
                          │ exchange (client_secret_basic)
                          ▼ T_backend (60s)
                        REST API (api.messijo.com)
```

Hard boundaries:

- `T_mcp` is never sent to the REST API. The audience is the MCP resource only.
- `T_backend` is never exposed to MCP clients or used at the MCP endpoint.
- The Worker never re-implements domain authorization. It forwards requests and
  lets the API enforce grants, scopes, membership, quotas, and route policy
  live. A 404 from an org-scoped route means unselected or denied; do not
  special-case it.

## MCP transport

- Endpoint: `https://mcp.messijo.com/mcp` (Streamable HTTP).
- Authorization profile: MCP 2026-07-28. Clients use Authorization Code with
  PKCE (S256 only), send `resource=https://mcp.messijo.com/mcp` in
  authorization and token requests, and the issuer supports the
  `authorization_response_iss` parameter.
- Authorization server discovery: `https://auth.messijo.com/.well-known/oauth-authorization-server`.
- The Worker does not need its own protected-resource metadata document for
  the first release, but publishing
  `/.well-known/oauth-protected-resource` with
  `authorization_servers: ["https://auth.messijo.com"]` is recommended so
  clients can discover the AS from the resource.

## Verifying MCP tokens

The producer contract freezes the token shape. Verification must:

1. Fetch `https://auth.messijo.com/.well-known/jwks.json`
   (`application/jwk-set+json`; public members only, RS256) and cache it with a
   short TTL plus refresh-on-unknown-`kid`, so key rotation converges without
   waiting out a long cache.
2. Verify RS256 signature with a currently published `kid`.
3. Require exact `iss` (`https://auth.messijo.com`), `aud`
   (`https://mcp.messijo.com/mcp`), and `token_use: mcp_access`.
4. Check `exp`/`iat`. Lifetime is 300 seconds; expect frequent client refresh.
5. Treat claims as identifiers only: `organization_ids` are stable IDs for
   grant context, never display data. Names come from live REST reads.

Required claims: `iss`, `aud`, `sub`, `iat`, `exp`, `jti`, `scope`,
`client_id`, `original_client_id`, `grant_id`, `organization_ids`, `token_use`.

### Local verify + introspection

Use local JWKS verification as the fast path, with authenticated introspection
as the authoritative complement:

- **Fast path (every request):** local RS256/JWKS verification establishes
  cryptographic validity. This is enough to reject the overwhelming majority of
  bad traffic cheaply.
- **Introspection (grant liveness):** local verification cannot see revocation,
  grant deletion, or membership changes. Before performing delegated REST work,
  introspect the token at `https://auth.messijo.com/oauth/introspect`
  (`client_secret_basic`). The response's `https://messijo.com/oauth/grant-context/v1`
  extension supplies `grant_id`, `organization_ids`, `original_client_id`,
  `resource`, `effective_scopes`, and `user_id`. Inactive tokens return
  `{"active": false}` with no extensions.

A pragmatic pattern: introspect once per MCP session (or per tool call that
performs mutations), cache the result for a short bounded window (seconds, not
minutes), and always re-introspect on any REST 401/403 from the backend token
path. Do not cache an active introspection longer than the MCP token's own
remaining lifetime.

## Backend credential exchange

To call REST, exchange the verified `T_mcp` for `T_backend`:

- Endpoint: `https://auth.messijo.com/oauth/token`
- Grant: `urn:ietf:params:oauth:grant-type:token-exchange`
- Auth: `client_secret_basic` as `messijo-mcp-worker`
- `subject_token`: the `T_mcp` value; `subject_token_type`:
  `urn:ietf:params:oauth:token-type:access_token`;
  `issued_token_type`: `urn:ietf:params:oauth:token-type:access_token`
- Optional `scope` may only narrow the granted scopes; omit it to keep them.
- Result: `worker_backend` token, audience
  `https://api.messijo.com/oauth/worker-delegation`, lifetime 60 seconds,
  never exceeding the subject token's remaining lifetime.

Send it as a Bearer token to `https://api.messijo.com` REST routes.

### Caching T_backend: trade-offs

`T_backend` lives at most 60 seconds, and every REST call re-checks the live
grant server-side anyway, so caching is purely a latency/complexity question:

**Exchange per REST call (no cache)**

- Pros: simplest correct behavior; no invalidation logic; a revoked grant
  fails on the very next call; rotation and rollout flags take effect
  immediately; no race where a cached token outlives grant revocation.
- Cons: one extra round trip to `auth.messijo.com` before every REST call.
  Adds latency to every tool invocation; adds load to the authorization
  server's token endpoint.

**Short cache (e.g. 30–45s, always below the 60s cap)**

- Pros: amortizes the exchange across multiple REST calls in one tool
  invocation (common: list orgs, then act on one); halves-to-quarters the
  exchange traffic; better tail latency for multi-call tools.
- Cons: invalidation is approximate — a grant revoked mid-window still passes
  REST's live check on the next actual call, but the Worker may waste a call
  or briefly serve reads against stale context; needs careful clock handling
  (Workers' `Date.now()` advances only between I/O — use server `Date` headers
  or a fetched timestamp); more code to test.

**Recommendation:** start with a per-request exchange plus a small in-flight
dedupe (concurrent tool calls in one session share a single exchange promise).
That is nearly as simple as no caching, covers most of the batching benefit,
and has no expiry bookkeeping. Add a timed cache only if profiling shows the
extra hop matters. Whatever you choose, on any REST 401/403, drop all cached
credentials and re-introspect/re-exchange once before surfacing an error.

## Calling the REST API

- Base URL: `https://api.messijo.com` (staging equivalent per environment).
- Contract: `priv/static/openapi.json` v0.3.0. No MCP-specific endpoints exist.
- Scope hierarchy: `messijo:read < messijo:write < messijo:admin`.
- `GET /api/orgs` returns only organizations selected by the active grant;
  `GET /api/orgs/{id}` returns 404 for unselected or inaccessible
  organizations. Use these to resolve `organization_ids` into live names.
- Errors to handle distinctly: 402 quota exceeded; 404 unselected/unclassified
  route (hidden, not denied — do not enumerate alternatives); 400
  invalid_scope/invalid_target shapes from the fixture.
- **Do not automatically retry mutations.** The contract adds no idempotency
  persistence or retry guarantees. Read retries are fine; a failed create/
  update/delete surfaces the error to the client.

## Curated first-release tool surface

Start with the read-heavy monitoring surface plus essential mutations. All are
`allowed` in the route policy with these minimum scopes:

| Tool area | REST routes | Min scope |
| --- | --- | --- |
| Organizations | `GET /api/orgs`, `GET /api/orgs/{id}`, `GET /api/orgs/{id}/quotas` | `messijo:read` |
| Keywords CRUD | `GET/POST /api/orgs/{org_id}/keywords`, `GET/PATCH/DELETE .../{id}` | `read` / `write` |
| Keyword events | `GET .../keyword_events`, `GET .../{id}`, totals, full-events, mark-read, update_status | `read` / `write` |
| Lenses (read + run) | lens CRUD, start/stop/status, results index/show/totals, mark-read | `read` / `write` |
| Stats | `GET .../stats/dashboard` | `messijo:read` |
| Account | `GET /api/me` (identify the grant user) | `messijo:read` |

Explicitly out of the first release: billing, API-key management, org
mutation/deletion, memberships/invitations, notification connections, and all
superadmin surfaces. `MessijoWeb.KeywordEventController.update` and every
`/admin` route are categorically denied to Worker delegation — attempting them
returns 404 regardless of the user's real authority.

Tool design guidance:

- Require an `organization_id` parameter on org-scoped tools. Resolve the
  selectable set from `GET /api/orgs` (grant-filtered) and present live names
  in tool descriptions, never cached ones.
- Surface backend errors (402 quota, 404, 422 validation) faithfully with the
  API's error payload rather than generic failures — the client needs them to
  self-correct.
- Mutating tools should describe themselves as non-idempotent unless the
  underlying route documents otherwise.

## Secrets and configuration

Worker-side Doppler/environment secrets:

- `MCP_WORKER_CLIENT_SECRET` — the active 256-bit shared secret (operator
  generated via the API repo's `scripts/generate-mcp-worker-secret.sh` and
  README runbook).
- `MCP_WORKER_CLIENT_SECRET_RETIRING` and
  `MCP_WORKER_CLIENT_SECRET_RETIRING_VALID_UNTIL` — during rotation, accept the
  retiring secret in `client_secret_basic` only before the absolute Unix
  deadline; on the Worker side, send the active secret and fall back to the
  retiring one only if the active one was rejected mid-rollout. Simplest
  correct behavior: always send the active secret; the API tolerates the
  retiring one for the 15-minute overlap.
- Authorization-server base URL, MCP resource URL, and API base URL per
  environment.

Never log tokens, codes, client secrets, or authorization headers. Emit
correlated telemetry (request id, user id, grant id, org id, route, outcome).

## Rollout and kill-switch behavior

- Discovery in production stays gated until the deployed Worker passes the
  fixture, REST artifact, selected-organization, and route-policy tests, and
  an operator records the exact producer revision in
  `OAUTH_MCP_COMPATIBILITY_REVISION`.
- `OAUTH_SYSTEM_ENABLED=false` on the API hard-disables the OAuth surface:
  Worker-backend tokens are rejected by REST and OAuth routes are concealed.
  Expect this and fail closed with a clear MCP-level error.
- The Worker should treat auth-server 401s on exchange/introspection as
  "credentials unusable now," not retry storms.

## Verification checklist for the Worker repo

1. Conformance tests against the pinned fixture: metadata endpoints, JWKS
   shape, token claims, introspection extensions, exchange narrowing,
   revocation behavior, error shapes.
2. Selected-organization behavior: list filtered, show 404 for unselected.
3. Route-policy spot tests: at least one allowed route per tool area, a
   superadmin denial (404), and an unclassified-route denial.
4. Rotation drill: retiring-secret acceptance and post-deadline rejection.
5. Kill-switch drill: behavior with `OAUTH_SYSTEM_ENABLED=false`.
