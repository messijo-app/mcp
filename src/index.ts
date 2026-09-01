import { Hono } from "hono";
import { WebStandardStreamableHTTPServerTransport as StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { AppEnv } from "./auth/middleware";
import { configMiddleware, mcpAuthMiddleware } from "./auth/middleware";
import { DelegationContext } from "./delegation/exchange";
import { buildMcpServer } from "./mcp/server";
import { logEvent } from "./log";

const app = new Hono<AppEnv>();

app.use("*", configMiddleware);

/** Health route. */
app.get("/", (c) => c.json({ ok: true, service: "mcp-worker" }));

/**
 * RFC 9728 protected-resource metadata so MCP clients can discover the
 * authorization server from the resource. Unauthenticated by design.
 */
app.get("/.well-known/oauth-protected-resource", (c) => {
  const config = c.get("config");
  return c.json({
    resource: config.mcpResourceUrl,
    authorization_servers: [config.authBaseUrl],
  });
});

/**
 * Stateless Streamable HTTP MCP endpoint. Each request is authenticated
 * independently (local JWKS verification + introspection) and gets a fresh
 * McpServer + transport pair; no `mcp-session-id` is ever issued.
 */
app.on(["POST", "GET", "DELETE"], "/mcp", mcpAuthMiddleware, async (c) => {
  if (c.req.method !== "POST") {
    // Stateless mode: no server-initiated streams (GET) and no sessions to
    // terminate (DELETE).
    return c.json(
      { jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed." }, id: null },
      405,
      { allow: "POST" },
    );
  }

  const config = c.get("config");
  const auth = c.get("auth");
  const requestId = c.get("requestId");

  const delegation = new DelegationContext(config, auth.claims, auth.grant, auth.token);
  const server = buildMcpServer(delegation, {
    requestId,
    userId: auth.grant.user_id,
    grantId: auth.grant.grant_id,
  });

  try {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    await server.connect(transport);
    const response = await transport.handleRequest(c.req.raw);

    logEvent("info", "mcp_request", {
      requestId,
      userId: auth.grant.user_id,
      grantId: auth.grant.grant_id,
      outcome: "ok",
    });

    // Release per-request SDK state after the response is produced
    // (per the SDK's stateless-mode guidance). Failures here are
    // inconsequential cleanup errors. When no ExecutionContext is
    // available (e.g. direct app.request() in tests), close inline.
    try {
      c.executionCtx.waitUntil(
        Promise.resolve(transport.close())
          .then(() => server.close())
          .catch(() => {}),
      );
    } catch {
      void Promise.resolve(transport.close())
        .then(() => server.close())
        .catch(() => {});
    }

    return response;
  } catch (error) {
    logEvent("error", "mcp_request", {
      requestId,
      userId: auth.grant.user_id,
      grantId: auth.grant.grant_id,
      outcome: "transport_error",
    });
    return c.json(
      {
        jsonrpc: "2.0",
        error: {
          code: -32603,
          message: "Internal error handling MCP request.",
        },
        id: null,
      },
      500,
    );
  }
});

export default app;
