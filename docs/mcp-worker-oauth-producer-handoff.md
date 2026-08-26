# MCP Worker OAuth Producer Handoff

This document is the API-owned integration contract for the separately
deployed MCP authorization and Worker consumer. It describes observable
behavior; it does not assign Worker implementation work or import API source.

## Pinned producer contracts

- API producer revision:
  `sha256:4dca13e61ead99cff6ab6f069a4a9d6c7a6ea38b689e9ce8a96bc2f1c0ade8d1`
- OAuth fixture version: `1`
- Public REST contract version: `0.3.0`
- Machine-readable fixture:
  [`test/fixtures/oauth/mcp-producer-contract-v1.json`](../test/fixtures/oauth/mcp-producer-contract-v1.json)
- Released REST artifact: [`priv/static/openapi.json`](../priv/static/openapi.json)
- Route-policy source evidence:
  [`lib/messijo/oauth/rest_route_policy.ex`](../lib/messijo/oauth/rest_route_policy.ex)
- Producer verification:
  `MIX_ENV=test mix test test/messijo/oauth/producer_contract_test.exs test/messijo/oauth/worker_delegation_test.exs test/messijo/oauth/rest_route_policy_test.exs test/messijo_web/worker_delegation_routes_test.exs`

The producer revision is a deterministic SHA-256 identity of both consumer
payloads. The fixture also carries its own payload digest. Any changed metadata,
claims, endpoint, route classification, or REST contract version changes the
revision and requires fresh consumer evidence.

## OAuth and Worker boundary

The fixture freezes discovery metadata, JWKS public-member rules, RS256 token
verification, MCP access-token claims, authenticated introspection extensions,
Worker `client_secret_basic` authentication, RFC 8693 exchange parameters,
backend-token claims, lifetimes, revocation, and error shapes. MCP access tokens
are only for the MCP resource and are never accepted directly by REST. The
confidential Worker exchanges one for a short-lived `worker_backend` token with
the REST delegation audience. Exchange may narrow scopes and never extends the
subject token's remaining lifetime.

The Worker secret generation, 15-minute rotation overlap, absolute
`VALID_UNTIL`, and emergency procedure are documented in the repository
[README](../README.md#mcp-worker-client-secret-operations).

## Selected organizations and live authorization

Authenticated introspection returns the versioned Messijo grant-context
extension only for an active MCP token. `organization_ids` are stable IDs, not
cached authorization or display data. The Worker reads live names through
`GET /api/orgs` or `GET /api/orgs/{id}`. The list endpoint returns only active
grant-selected organizations, and an unselected or inaccessible organization
is hidden with `404`.

Every delegated REST call rechecks the Worker actor, backend token use, live
grant, bound user/client/resource, exact selected organizations, OAuth scope,
current membership and role, route policy, quota, and existing controller
rules. Revocation or membership downgrade therefore takes effect without
waiting for token expiry.

## Route policy

Worker delegation may use the ordinary authenticated REST surface. The exact
controller/action inventory, minimum scope, decision, and adjacent rationale
are embedded in the machine-readable fixture. There are two categorical
constraints:

- every new authenticated route is unclassified and fails closed until reviewed;
- superadmin authority is never delegable, even when the grant user is a live
  superadmin.

The denied inventory is both `/admin` controller actions and the ordinary
keyword-event update action whose existing permission is `superadmin`. OAuth
scope tops out at organization `admin` and cannot synthesize platform
`superadmin`.

## Deferred REST semantics

The OAuth integration adds no MCP-specific confirmation protocol, idempotency
persistence, automatic retry guarantee, or cursor semantics. Allowed calls
inherit the released REST contract and existing business behavior. The Worker
and its callers must not automatically retry a mutation unless that particular
REST operation documents safe retry behavior. Existing pagination and cursors,
where present, remain authoritative.

## Compatibility evidence and rollout

MCP compatibility evidence is the exact producer revision emitted by a
deployed MCP/Worker release after tests pass the OAuth fixture, released REST
artifact, selected-organization behavior, and route-policy inventory. The
operator places it in `OAUTH_MCP_COMPATIBILITY_REVISION`.

Discovery remains closed until dashboard and MCP evidence both equal the exact
current producer revision, signing keys are ready, protocol and authorization
are enabled, the master OAuth system control is enabled, and an operator
explicitly sets `OAUTH_DISCOVERY_ENABLED=true`.

The initial testing rollout uses a hard rollback rather than graceful draining.
Operators disable the MCP Worker and set `OAUTH_SYSTEM_ENABLED=false`. Every
OAuth route is then concealed and existing Worker-backend tokens are rejected
by REST authentication; revocation, introspection, exchange, JWKS, and retiring
key verification are not promised through the HTTP surface while disabled.
This intentionally breaks the testing cohort. Because the flag does not destroy
durable grants or refresh families, credentials that must not resume are
explicitly revoked before a later re-enable.

## Producer verification record

The API producer verified this revision on 2026-08-24 with:

```bash
MIX_ENV=test mix compile --force --warnings-as-errors
MIX_ENV=test mix ecto.migrate
MIX_ENV=test mix test
MIX_ENV=test mix test test/messijo/oauth/producer_contract_test.exs test/messijo/oauth/rollout_test.exs test/messijo/oauth/rest_route_policy_test.exs test/messijo/oauth/telemetry_test.exs test/messijo_web/worker_delegation_routes_test.exs
MIX_ENV=test mix api.contract.generate
./scripts/api-contract-validate.sh priv/static/openapi.json
mix format --check-formatted
git diff --check
```

Results: clean warnings-as-errors compilation; migrations already current; 232
full-suite tests passed; 24 change-specific tests passed; REST contract `0.3.0`
regenerated and validated; formatting and whitespace checks passed. Existing
Webhook OpenAPI warnings and Firehose/Quantum SQL-sandbox task noise were
present, but did not produce an ExUnit failure.
