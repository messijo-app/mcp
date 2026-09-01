import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { SignJWT, importJWK } from "jose";
import { app } from "./app";
import { GRANT_CONTEXT_KEY, initializeRequest, KEYS, postMcp, signMcpToken } from "./helpers";
import { activeIntrospection, doubles, inactiveIntrospection, installDoubles, resetDoubles } from "./doubles";
import { resetIntrospectionCache } from "../src/auth/introspection";
import { resetJwksCache } from "../src/auth/jwks";

beforeAll(() => {
  installDoubles();
});

beforeEach(() => {
  resetDoubles();
  resetIntrospectionCache();
  resetJwksCache();
});

describe("token verification matrix (POST /mcp)", () => {
  it("accepts a valid, active token and serves an MCP initialize", async () => {
    const token = await signMcpToken();
    const response = await postMcp(app, token, initializeRequest());
    expect(response.status).toBe(200);
    const body = (await response.json()) as { result?: unknown };
    expect(body.result).toBeDefined();
    expect(response.headers.get("mcp-session-id")).toBeNull();
    expect(doubles().counts.rest).toBe(0);
  });

  it("rejects a missing bearer token with 401", async () => {
    const response = await postMcp(app, null, initializeRequest());
    expect(response.status).toBe(401);
  });

  it("rejects a malformed token with 401", async () => {
    const response = await postMcp(app, "not-a-jwt", initializeRequest());
    expect(response.status).toBe(401);
  });

  it("rejects a wrong audience without introspection or REST", async () => {
    const token = await signMcpToken({ audience: "https://other.example/resource" });
    const response = await postMcp(app, token, initializeRequest());
    expect(response.status).toBe(401);
    expect(doubles().counts.introspect).toBe(0);
    expect(doubles().counts.rest).toBe(0);
  });

  it("rejects a wrong issuer with 401", async () => {
    const token = await signMcpToken({ issuer: "https://evil.example" });
    const response = await postMcp(app, token, initializeRequest());
    expect(response.status).toBe(401);
  });

  it("rejects a token missing a required claim (grant_id)", async () => {
    const token = await signMcpToken({ omit: ["grant_id"] });
    const response = await postMcp(app, token, initializeRequest());
    expect(response.status).toBe(401);
    expect(doubles().counts.introspect).toBe(0);
  });

  it("rejects a token missing organization_ids", async () => {
    const token = await signMcpToken({ omit: ["organization_ids"] });
    const response = await postMcp(app, token, initializeRequest());
    expect(response.status).toBe(401);
  });

  it("rejects a token with the wrong token_use", async () => {
    const token = await signMcpToken({ tokenUse: "worker_backend" });
    const response = await postMcp(app, token, initializeRequest());
    expect(response.status).toBe(401);
  });

  it("rejects an expired token", async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = await signMcpToken({ issuedAtSeconds: now - 600, expiresInSeconds: 300 });
    const response = await postMcp(app, token, initializeRequest());
    expect(response.status).toBe(401);
  });

  it("rejects a non-RS256 token (HS256 signed with public-key material)", async () => {
    // Classic algorithm-confusion probe: sign with the RSA public JWK
    // serialized as an HMAC secret. jose must refuse the HS256 alg.
    const secret = new TextEncoder().encode(JSON.stringify(KEYS.key1Public));
    const now = Math.floor(Date.now() / 1000);
    const claims = {
      iss: "https://auth.test",
      aud: "https://mcp.test/mcp",
      sub: "user-1",
      iat: now,
      exp: now + 300,
      jti: "jti-hs256-probe",
      scope: "messijo:read",
      client_id: "messijo-mcp-worker",
      original_client_id: "claude",
      grant_id: "grant-1",
      organization_ids: ["org-1"],
      token_use: "mcp_access",
    };
    const token = await new SignJWT(claims)
      .setProtectedHeader({ alg: "HS256", kid: KEYS.key1Public.kid, typ: "JWT" })
      .sign(secret);
    const response = await postMcp(app, token, initializeRequest());
    expect(response.status).toBe(401);
    expect(doubles().counts.introspect).toBe(0);
  });

  it("rejects an RS256 token whose header has no kid", async () => {
    const privateKey = await importJWK(KEYS.key1Private, "RS256");
    const now = Math.floor(Date.now() / 1000);
    const claims = {
      iss: "https://auth.test",
      aud: "https://mcp.test/mcp",
      sub: "user-1",
      iat: now,
      exp: now + 300,
      jti: "jti-nokid-probe",
      scope: "messijo:read",
      client_id: "messijo-mcp-worker",
      original_client_id: "claude",
      grant_id: "grant-1",
      organization_ids: ["org-1"],
      token_use: "mcp_access",
    };
    const token = await new SignJWT(claims)
      .setProtectedHeader({ alg: "RS256", typ: "JWT" })
      .sign(privateKey);
    const response = await postMcp(app, token, initializeRequest());
    expect(response.status).toBe(401);
    expect(doubles().counts.introspect).toBe(0);
  });

  it("fails closed on a malformed grant-context extension (missing grant_id)", async () => {
    const good = activeIntrospection();
    const extension = { ...(good[GRANT_CONTEXT_KEY] as Record<string, unknown>) };
    delete extension.grant_id;
    doubles().introspection = () => ({ active: true, [GRANT_CONTEXT_KEY]: extension });
    const token = await signMcpToken();
    const response = await postMcp(app, token, initializeRequest());
    expect(response.status).toBe(401);
    expect(doubles().counts.rest).toBe(0);
    expect(doubles().counts.exchange).toBe(0);
  });

  it("fails closed on a malformed grant-context extension (non-array organization_ids)", async () => {
    const good = activeIntrospection();
    const extension = {
      ...(good[GRANT_CONTEXT_KEY] as Record<string, unknown>),
      organization_ids: "org-1",
    };
    doubles().introspection = () => ({ active: true, [GRANT_CONTEXT_KEY]: extension });
    const token = await signMcpToken();
    const response = await postMcp(app, token, initializeRequest());
    expect(response.status).toBe(401);
  });

  it("rejects an unknown kid after a JWKS refresh", async () => {
    const token = await signMcpToken({ key: "unknown" });
    const response = await postMcp(app, token, initializeRequest());
    expect(response.status).toBe(401);
    expect(doubles().counts.jwks).toBeGreaterThan(0);
    expect(doubles().counts.introspect).toBe(0);
  });

  it("accepts a newly published key after refresh-on-unknown-kid", async () => {
    const state = doubles();
    state.jwks = { keys: [KEYS.key1Public] };

    const first = await signMcpToken({ key: "key1" });
    expect((await postMcp(app, first, initializeRequest())).status).toBe(200);

    const rotated = await signMcpToken({ key: "key2" });
    expect((await postMcp(app, rotated, initializeRequest())).status).toBe(401);

    state.jwks = { keys: [KEYS.key1Public, KEYS.key2Public] };
    const accepted = await postMcp(app, rotated, initializeRequest());
    expect(accepted.status).toBe(200);
  });

  it("fails closed when introspection reports the token inactive", async () => {
    doubles().introspection = inactiveIntrospection;
    const token = await signMcpToken();
    const response = await postMcp(app, token, initializeRequest());
    expect(response.status).toBe(401);
    expect(doubles().counts.rest).toBe(0);
  });

  it("fails closed when the authorization server conceals OAuth routes (kill switch)", async () => {
    doubles().concealOAuthRoutes = true;
    const token = await signMcpToken();
    const response = await postMcp(app, token, initializeRequest());
    expect(response.status).toBe(401);
    // No retry storm: a single introspection attempt.
    expect(doubles().counts.introspect).toBe(1);
  });
});
