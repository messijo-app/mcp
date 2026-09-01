import { createMiddleware } from "hono/factory";
import type { Context } from "hono";
import { parseConfig, type Config, type Env } from "../env";
import { introspectToken, IntrospectionError, type GrantContext } from "./introspection";
import { TokenVerificationError, verifyMcpToken, type McpTokenClaims } from "./verify";
import { logEvent } from "../log";

export interface AuthContext {
  token: string;
  claims: McpTokenClaims;
  grant: GrantContext;
}

export type AppEnv = {
  Bindings: Env;
  Variables: {
    config: Config;
    auth: AuthContext;
    requestId: string;
  };
};

/** Parse and validate configuration once per isolate; re-validated on change. */
export const configMiddleware = createMiddleware<AppEnv>(async (c, next) => {
  c.set("requestId", c.req.header("cf-ray") ?? crypto.randomUUID());
  try {
    c.set("config", parseConfig(c.env));
  } catch (error) {
    logEvent("error", "config_invalid", {
      requestId: c.get("requestId"),
      message: error instanceof Error ? error.message : "unknown",
    });
    return c.json({ error: "server_configuration_error" }, 500);
  }
  await next();
});

/**
 * Gate /mcp: extract the bearer token, verify locally (JWKS/RS256), then
 * introspect for grant liveness. Any failure is a 401 — fail closed.
 */
export const mcpAuthMiddleware = createMiddleware<AppEnv>(async (c, next) => {
  const config = c.get("config");
  const requestId = c.get("requestId");

  const header = c.req.header("Authorization");
  if (header === undefined || !header.startsWith("Bearer ")) {
    return unauthorized(c, config, "missing_bearer");
  }
  const token = header.slice("Bearer ".length).trim();
  if (token.length === 0) {
    return unauthorized(c, config, "missing_bearer");
  }

  let claims: McpTokenClaims;
  try {
    claims = await verifyMcpToken(config, token);
  } catch (error) {
    const reason =
      error instanceof TokenVerificationError ? error.reason : ("malformed" as const);
    logEvent("info", "token_verification_failed", { requestId, reason });
    return unauthorized(c, config, "invalid_token");
  }

  let grant: GrantContext;
  try {
    grant = await introspectToken(config, token, claims);
  } catch (error) {
    const failure = error instanceof IntrospectionError ? error.failure : "unexpected";
    logEvent("info", "introspection_failed", { requestId, failure });
    return unauthorized(c, config, "invalid_token");
  }

  c.set("auth", { token, claims, grant });
  await next();
});

function unauthorized(c: Context<AppEnv>, config: Config, error: string) {
  return c.json(
    { error },
    401,
    {
      "www-authenticate": `Bearer resource_metadata="${config.mcpPublicBaseUrl}/.well-known/oauth-protected-resource"`,
    },
  );
}
