import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { app } from "./app";
import {
  initializeRequest,
  postMcp,
  rpcBody,
  signMcpToken,
  TEST_ENV,
  toolCallRequest,
  toolResult,
  toolsListRequest,
} from "./helpers";
import { doubles, installDoubles, resetDoubles } from "./doubles";
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

describe("health and metadata routes", () => {
  it("serves a health route at /", async () => {
    const response = await app.request("/", undefined, TEST_ENV);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, service: "mcp-worker" });
  });

  it("publishes /.well-known/oauth-protected-resource without authentication", async () => {
    const response = await app.request(
      "/.well-known/oauth-protected-resource",
      undefined,
      TEST_ENV,
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { resource: string; authorization_servers: string[] };
    expect(body.resource).toBe("https://mcp.test/mcp");
    expect(body.authorization_servers).toEqual(["https://auth.test"]);
  });
});

describe("stateless MCP endpoint at /mcp", () => {
  it("completes an initialize round trip without issuing mcp-session-id", async () => {
    const token = await signMcpToken();
    const response = await postMcp(app, token, initializeRequest());
    expect(response.status).toBe(200);
    expect(response.headers.get("mcp-session-id")).toBeNull();
    const body = await rpcBody(response);
    const result = body.result as { protocolVersion: string; serverInfo: { name: string } };
    expect(result.serverInfo.name).toBe("messijo-mcp-worker");
  });

  it("rejects unauthenticated requests with 401 before touching upstreams", async () => {
    const response = await postMcp(app, null, initializeRequest());
    expect(response.status).toBe(401);
    expect(doubles().counts.introspect).toBe(0);
    expect(doubles().counts.rest).toBe(0);
  });

  it("rejects GET and DELETE on /mcp with 405 (stateless mode)", async () => {
    const token = await signMcpToken();
    const getResponse = await postMcp(app, token, {}, "GET");
    expect(getResponse.status).toBe(405);
    const deleteResponse = await postMcp(app, token, {}, "DELETE");
    expect(deleteResponse.status).toBe(405);
  });

  it("lists exactly the seven first-release tools", async () => {
    const token = await signMcpToken();
    const response = await postMcp(app, token, toolsListRequest());
    expect(response.status).toBe(200);
    const body = await rpcBody(response);
    const tools = (body.result as { tools: { name: string; description: string }[] }).tools.map(
      (tool) => tool.name,
    );
    expect(tools.sort()).toEqual(
      [
        "me",
        "organizations",
        "keywords",
        "keyword_events",
        "lenses",
        "lens_results",
        "stats",
      ].sort(),
    );
  });
});

describe("tool calls", () => {
  it("me delegates to GET /api/me and returns the API payload", async () => {
    doubles().rest = (request) => {
      expect(request.method).toBe("GET");
      expect(request.path).toBe("/api/me");
      return { status: 200, body: { id: "user-1", email: "user@example.com" } };
    };
    const token = await signMcpToken();
    const response = await postMcp(app, token, toolCallRequest("me", { action: "me" }));
    const body = await rpcBody(response);
    const result = toolResult(body);
    expect(result?.status).toBe(200);
    expect(result?.body).toEqual({ id: "user-1", email: "user@example.com" });
    expect(result?.isError).toBe(false);
  });

  it("organizations.list delegates to GET /api/orgs with live names", async () => {
    doubles().rest = (request) => {
      expect(request.path).toBe("/api/orgs");
      return {
        status: 200,
        body: { organizations: [{ id: "org-1", name: "Acme" }, { id: "org-2", name: "Globex" }] },
      };
    };
    const token = await signMcpToken();
    const response = await postMcp(app, token, toolCallRequest("organizations", { action: "list" }));
    const result = toolResult(await rpcBody(response));
    expect(result?.status).toBe(200);
    expect((result?.body as { organizations: { name: string }[] }).organizations[0]!.name).toBe("Acme");
  });

  it("requires organization_id before making any REST call", async () => {
    const token = await signMcpToken();
    const response = await postMcp(app, token, toolCallRequest("keywords", { action: "list" }));
    const result = toolResult(await rpcBody(response));
    expect(result?.isError).toBe(true);
    expect(result?.status).toBe(400);
    expect(doubles().counts.rest).toBe(0);
    expect(doubles().counts.exchange).toBe(0);
  });

  it("requires id for actions with a resource id path parameter", async () => {
    const token = await signMcpToken();
    const response = await postMcp(
      app,
      token,
      toolCallRequest("keywords", { action: "get", organization_id: "org-1" }),
    );
    const result = toolResult(await rpcBody(response));
    expect(result?.isError).toBe(true);
    expect(result?.status).toBe(400);
    expect(doubles().counts.rest).toBe(0);
  });

  it("rejects non-scalar params at the tool level without REST calls", async () => {
    const token = await signMcpToken();
    const response = await postMcp(
      app,
      token,
      toolCallRequest("keywords", {
        action: "list",
        organization_id: "org-1",
        params: { filter: { nested: "object" } },
      }),
    );
    const result = toolResult(await rpcBody(response));
    expect(result?.isError).toBe(true);
    expect(result?.status).toBe(400);
    expect(doubles().counts.rest).toBe(0);
  });

  it("rejects unknown actions without REST calls", async () => {
    const token = await signMcpToken();
    const response = await postMcp(
      app,
      token,
      toolCallRequest("keywords", { action: "explode", organization_id: "org-1" }),
    );
    const result = toolResult(await rpcBody(response));
    expect(result?.isError).toBe(true);
    expect(doubles().counts.rest).toBe(0);
    expect(doubles().counts.exchange).toBe(0);
  });

  it("passes extra params as query strings on reads", async () => {
    doubles().rest = (request) => {
      expect(request.path).toBe("/api/orgs/org-1/keywords?limit=10&status=active");
      return { status: 200, body: { keywords: [] } };
    };
    const token = await signMcpToken();
    const response = await postMcp(
      app,
      token,
      toolCallRequest("keywords", {
        action: "list",
        organization_id: "org-1",
        params: { limit: 10, status: "active" },
      }),
    );
    const result = toolResult(await rpcBody(response));
    expect(result?.status).toBe(200);
  });

  it("passes extra params as a JSON body on mutations", async () => {
    doubles().rest = (request) => {
      expect(request.method).toBe("POST");
      expect(request.path).toBe("/api/orgs/org-1/keywords");
      expect(JSON.parse(String(request.body))).toEqual({ term: "messijo" });
      return { status: 201, body: { id: "kw-1" } };
    };
    const token = await signMcpToken();
    const response = await postMcp(
      app,
      token,
      toolCallRequest("keywords", {
        action: "create",
        organization_id: "org-1",
        params: { term: "messijo" },
      }),
    );
    const result = toolResult(await rpcBody(response));
    expect(result?.status).toBe(201);
  });

  it("surfaces a mutating tool description as non-idempotent", async () => {
    const token = await signMcpToken();
    const response = await postMcp(app, token, toolsListRequest());
    const body = await rpcBody(response);
    const tools = (body.result as { tools: { name: string; description: string }[] }).tools;
    const keywords = tools.find((tool) => tool.name === "keywords");
    expect(keywords?.description).toMatch(/non-idempotent/i);
  });
});

describe("faithful backend error surfacing", () => {
  it("surfaces 402 quota errors with the API's payload", async () => {
    doubles().rest = () => ({
      status: 402,
      body: { error: "quota_exceeded", detail: "keyword limit reached" },
    });
    const token = await signMcpToken();
    const response = await postMcp(
      app,
      token,
      toolCallRequest("keywords", { action: "create", organization_id: "org-1", params: { term: "x" } }),
    );
    const result = toolResult(await rpcBody(response));
    expect(result?.status).toBe(402);
    expect(result?.body).toEqual({ error: "quota_exceeded", detail: "keyword limit reached" });
    expect(result?.isError).toBe(true);
  });

  it("surfaces 404 hidden routes without editorializing", async () => {
    doubles().rest = () => ({ status: 404, body: { error: "not_found" } });
    const token = await signMcpToken();
    const response = await postMcp(
      app,
      token,
      toolCallRequest("organizations", { action: "get", organization_id: "org-9" }),
    );
    const result = toolResult(await rpcBody(response));
    expect(result?.status).toBe(404);
    expect(result?.body).toEqual({ error: "not_found" });
    expect(JSON.stringify(result)).not.toMatch(/inaccessible|unselected|denied/i);
  });

  it("surfaces 422 validation errors and never retries the mutation", async () => {
    let restCalls = 0;
    doubles().rest = () => {
      restCalls += 1;
      return { status: 422, body: { errors: { term: ["is invalid"] } } };
    };
    const token = await signMcpToken();
    const response = await postMcp(
      app,
      token,
      toolCallRequest("keywords", { action: "update", organization_id: "org-1", id: "kw-1", params: { term: "" } }),
    );
    const result = toolResult(await rpcBody(response));
    expect(result?.status).toBe(422);
    expect(restCalls).toBe(1);
  });

  it("surfaces a read-only grant's scope failure from the backend untouched", async () => {
    doubles().rest = () => ({ status: 403, body: { error: "insufficient_scope" } });
    const token = await signMcpToken({ grant: { effective_scopes: ["messijo:read"] } });
    const response = await postMcp(
      app,
      token,
      toolCallRequest("keywords", { action: "delete", organization_id: "org-1", id: "kw-1" }),
    );
    const result = toolResult(await rpcBody(response));
    expect(result?.status).toBe(403);
    expect(result?.body).toEqual({ error: "insufficient_scope" });
  });
});

describe("exchange failure surfacing", () => {
  it("maps a 400 invalid_target exchange rejection to 500 with the operator message", async () => {
    doubles().exchange = () => ({
      status: 400,
      body: { error: "invalid_target", error_description: "resource mismatch" },
    });
    const token = await signMcpToken();
    const response = await postMcp(app, token, toolCallRequest("me", { action: "me" }));
    const result = toolResult(await rpcBody(response));
    expect(result?.isError).toBe(true);
    expect(result?.status).toBe(500);
    expect(result?.body).toMatchObject({ failure: "exchange_invalid_target" });
    expect(JSON.stringify(result)).toMatch(/misconfiguration/i);
    // No retry storm: a single exchange attempt, no REST calls.
    expect(doubles().counts.exchange).toBe(1);
    expect(doubles().counts.rest).toBe(0);
  });

  it("keeps mapping a 400 invalid_grant exchange rejection to 401", async () => {
    doubles().exchange = () => ({
      status: 400,
      body: { error: "invalid_grant", error_description: "subject token revoked" },
    });
    const token = await signMcpToken();
    const response = await postMcp(app, token, toolCallRequest("me", { action: "me" }));
    const result = toolResult(await rpcBody(response));
    expect(result?.isError).toBe(true);
    expect(result?.status).toBe(401);
    expect(result?.body).toMatchObject({ failure: "exchange_invalid_grant" });
    expect(JSON.stringify(result)).toMatch(/revoke|re-authorize/i);
    expect(doubles().counts.exchange).toBe(1);
    expect(doubles().counts.rest).toBe(0);
  });
});
