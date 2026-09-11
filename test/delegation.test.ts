import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { parseConfig, type Env } from "../src/env";
import { authServerPost, AuthServerError } from "../src/auth/client";
import { DelegationContext } from "../src/delegation/exchange";
import { restCall, RestTransportError } from "../src/delegation/rest";
import {
  ACTIVE_SECRET,
  CLIENT_ID,
  RETIRING_SECRET,
  REST_BASE,
  rpcBody,
  signMcpToken,
  TEST_ENV,
  postMcp,
  toolCallRequest,
  toolResult,
} from "./helpers";
import { app } from "./app";
import { BACKEND_TOKEN, doubles, installDoubles, resetDoubles, type DoublesState } from "./doubles";
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

function parseBody(body: string): URLSearchParams {
  return new URLSearchParams(body);
}

async function makeDelegationContext(env: Env = TEST_ENV): Promise<{
  ctx: DelegationContext;
  token: string;
}> {
  const config = parseConfig(env);
  const token = await signMcpToken();
  const { verifyMcpToken } = await import("../src/auth/verify");
  const claims = await verifyMcpToken(config, token);
  const { introspectToken } = await import("../src/auth/introspection");
  const grant = await introspectToken(config, token, claims);
  return { ctx: new DelegationContext(config, claims, grant, token), token };
}

describe("token exchange (RFC 8693)", () => {
  it("sends the fixture-mandated parameters and omits scope", async () => {
    const { ctx, token } = await makeDelegationContext();
    await ctx.getBackendToken();

    const seen = doubles().seen.exchange;
    expect(seen).toHaveLength(1);
    const body = parseBody(seen[0]!.body);
    expect(body.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:token-exchange");
    expect(body.get("subject_token_type")).toBe("urn:ietf:params:oauth:token-type:access_token");
    expect(body.get("issued_token_type")).toBe("urn:ietf:params:oauth:token-type:access_token");
    expect(body.get("resource")).toBe(`${REST_BASE}/oauth/worker-delegation`);
    // Exchange narrowing is not requested: granted scopes are kept.
    expect(body.has("scope")).toBe(false);
    expect(body.get("subject_token")).toBe(token);

    const auth = seen[0]!.authorization;
    expect(auth).toBe(`Basic ${btoa(`${CLIENT_ID}:${ACTIVE_SECRET}`)}`);
  });

  it("dedupes concurrent exchanges for the same MCP token into one request", async () => {
    const { ctx } = await makeDelegationContext();
    const [a, b, c] = await Promise.all([
      ctx.getBackendToken(),
      ctx.getBackendToken(),
      ctx.getBackendToken(),
    ]);
    expect(a).toBe(BACKEND_TOKEN);
    expect(b).toBe(BACKEND_TOKEN);
    expect(c).toBe(BACKEND_TOKEN);
    expect(doubles().counts.exchange).toBe(1);
  });

  it("performs a fresh exchange after credentials are dropped (REST 401)", async () => {
    const { ctx } = await makeDelegationContext();
    await ctx.getBackendToken();
    expect(doubles().counts.exchange).toBe(1);

    ctx.dropCredentials();
    await ctx.getBackendToken();
    expect(doubles().counts.exchange).toBe(2);
  });

  it("maps a 400 invalid_grant rejection to a 401 re-authorize error, with no retry", async () => {
    doubles().exchange = () => ({
      status: 400,
      body: { error: "invalid_grant", error_description: "subject token revoked" },
    });
    const token = await signMcpToken();
    const response = await postMcp(app, token, toolCallRequest("me", { action: "me" }));
    expect(response.status).toBe(200); // JSON-RPC envelope; tool result carries the error
    const result = toolResult(await rpcBody(response));
    expect(result?.isError).toBe(true);
    expect(result?.status).toBe(401);
    expect(JSON.stringify(result)).toMatch(/revoke|re-authorize/i);
    // No retry storm: exactly one exchange attempt, no REST calls.
    expect(doubles().counts.exchange).toBe(1);
    expect(doubles().counts.rest).toBe(0);
  });

  it("maps a 400 invalid_target rejection to exchange_invalid_target, with no retry", async () => {
    doubles().exchange = () => ({
      status: 400,
      body: { error: "invalid_target", error_description: "resource mismatch" },
    });
    const token = await signMcpToken();
    const response = await postMcp(app, token, toolCallRequest("me", { action: "me" }));
    const result = toolResult(await rpcBody(response));
    expect(result?.isError).toBe(true);
    expect(result?.body).toMatchObject({ failure: "exchange_invalid_target" });
    expect(doubles().counts.exchange).toBe(1);
    expect(doubles().counts.rest).toBe(0);
  });

  it("maps a 400 with an unknown error code to the generic invalid_400_response fallback", async () => {
    doubles().exchange = () => ({
      status: 400,
      body: { error: "something_unexpected" },
    });
    const { ctx } = await makeDelegationContext();
    await expect(ctx.getBackendToken()).rejects.toMatchObject({
      failure: "invalid_400_response",
    });
    expect(doubles().counts.exchange).toBe(1);
  });

  it("falls back to invalid_400_response when the 400 body has no usable error field", async () => {
    doubles().exchange = () =>
      ({ status: 400, body: { error: 123 } }) as ReturnType<DoublesState["exchange"]>;
    const { ctx } = await makeDelegationContext();
    await expect(ctx.getBackendToken()).rejects.toMatchObject({
      failure: "invalid_400_response",
    });
    expect(doubles().counts.exchange).toBe(1);
  });
});

describe("REST delegation", () => {
  it("sends only the backend token to the REST API (token isolation)", async () => {
    const { ctx, token } = await makeDelegationContext();
    const result = await restCall(ctx, {
      method: "GET",
      path: "/api/me",
      isMutation: false,
    });
    expect(result.status).toBe(200);
    expect(doubles().seen.rest).toHaveLength(1);
    const auth = doubles().seen.rest[0]!.authorization;
    expect(auth).toBe(`Bearer ${BACKEND_TOKEN}`);
    expect(auth).not.toContain(token);
  });

  it("retries a read once on transport failure but never a mutation", async () => {
    const { ctx } = await makeDelegationContext();
    let restCalls = 0;
    doubles().rest = () => {
      restCalls += 1;
      throw new Error("transport");
    };

    await expect(
      restCall(ctx, { method: "GET", path: "/api/orgs", isMutation: false }),
    ).rejects.toBeInstanceOf(RestTransportError);
    expect(restCalls).toBe(2);

    restCalls = 0;
    await expect(
      restCall(ctx, { method: "POST", path: "/api/orgs/o1/keywords", isMutation: true }),
    ).rejects.toBeInstanceOf(RestTransportError);
    expect(restCalls).toBe(1);
  });

  it("re-authenticates once on REST 401 and surfaces the final error", async () => {
    const { ctx } = await makeDelegationContext();
    let restCalls = 0;
    doubles().rest = () => {
      restCalls += 1;
      return { status: 401, body: { error: "unauthorized" } };
    };
    const result = await restCall(ctx, {
      method: "GET",
      path: "/api/me",
      isMutation: false,
    });
    expect(result.status).toBe(401);
    expect(result.body).toEqual({ error: "unauthorized" });
    expect(restCalls).toBe(2);
    expect(doubles().counts.exchange).toBe(2);
  });

  it("retries once on 403 as well", async () => {
    const { ctx } = await makeDelegationContext();
    let restCalls = 0;
    doubles().rest = () => {
      restCalls += 1;
      return { status: 403, body: { error: "forbidden" } };
    };
    const result = await restCall(ctx, { method: "GET", path: "/api/me", isMutation: false });
    expect(result.status).toBe(403);
    expect(restCalls).toBe(2);
  });
});

describe("secret rotation drill", () => {
  it("falls back to the retiring secret when the active one is rejected", async () => {
    const state = doubles();
    state.activeSecretAccepted = false;

    const token = await signMcpToken();
    const response = await postMcp(app, token, toolCallRequest("me", { action: "me" }));
    expect(response.status).toBe(200);

    const active = `Basic ${btoa(`${CLIENT_ID}:${ACTIVE_SECRET}`)}`;
    const retiring = `Basic ${btoa(`${CLIENT_ID}:${RETIRING_SECRET}`)}`;

    // Introspection: active rejected once, retiring accepted.
    expect(doubles().seen.introspect.map((r) => r.authorization)).toEqual([active, retiring]);
    // Exchange: active rejected once, retiring accepted.
    expect(doubles().seen.exchange.map((r) => r.authorization)).toEqual([active, retiring]);
  });

  it("does not attempt the retiring secret after its deadline", async () => {
    doubles().activeSecretAccepted = false;
    const env: Env = {
      ...TEST_ENV,
      MCP_WORKER_CLIENT_SECRET_RETIRING_VALID_UNTIL: String(Math.floor(Date.now() / 1000) - 60),
    };
    const config = parseConfig(env);
    await expect(
      authServerPost(config, { path: "/oauth/introspect", form: { token: "x" } }),
    ).rejects.toMatchObject({ failure: "unauthorized" });

    const seen = doubles().seen.introspect;
    expect(seen).toHaveLength(1);
    expect(seen[0]!.authorization).toBe(`Basic ${btoa(`${CLIENT_ID}:${ACTIVE_SECRET}`)}`);
  });
});

describe("kill-switch drill (OAUTH_SYSTEM_ENABLED=false)", () => {
  it("returns a clear MCP-level error, not a retry storm, when OAuth routes are concealed", async () => {
    doubles().concealOAuthRoutes = true;
    const token = await signMcpToken();
    const response = await postMcp(app, token, toolCallRequest("me", { action: "me" }));
    // Introspection concealed → fail closed at the gate.
    expect(response.status).toBe(401);
    expect(doubles().counts.introspect).toBe(1);
  });

  it("surfaces a clear error when backend tokens are rejected by REST", async () => {
    doubles().restRejectsBackendTokens = true;
    const token = await signMcpToken();
    const response = await postMcp(app, token, toolCallRequest("me", { action: "me" }));
    expect(response.status).toBe(200);
    const body = (await response.json()) as { result: unknown };
    const result = body.result as { isError: boolean; structuredContent: { status: number; body: unknown } };
    expect(result.isError).toBe(true);
    expect(result.structuredContent.status).toBe(401);
    // One re-authentication attempt only: 2 REST calls, 2 exchanges.
    expect(doubles().counts.rest).toBe(2);
    expect(doubles().counts.exchange).toBe(2);
  });

  it("treats auth-server 401 on exchange as credentials-unusable, without retrying", async () => {
    const { ctx } = await makeDelegationContext();
    doubles().activeSecretAccepted = false;
    // Deadline passed → no retiring fallback → single attempt.
    const env: Env = {
      ...TEST_ENV,
      MCP_WORKER_CLIENT_SECRET_RETIRING_VALID_UNTIL: String(Math.floor(Date.now() / 1000) - 60),
    };
    const config = parseConfig(env);
    const claims = { ...ctx.claims };
    const grant = ctx.grant;
    const failing = new DelegationContext(config, claims, grant, "unused");
    await expect(failing.getBackendToken()).rejects.toMatchObject({
      failure: "unauthorized",
    });
    expect(doubles().counts.exchange).toBe(1);
  });
});

describe("AuthServerError classification", () => {
  it("classifies a 404 as concealed (kill switch)", async () => {
    doubles().concealOAuthRoutes = true;
    const config = parseConfig(TEST_ENV);
    try {
      await authServerPost(config, { path: "/oauth/introspect", form: { token: "x" } });
      expect.unreachable("should throw");
    } catch (error) {
      expect(error).toBeInstanceOf(AuthServerError);
      expect((error as AuthServerError).failure).toBe("concealed");
    }
  });
});
