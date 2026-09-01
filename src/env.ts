export interface Env {
  /** Active confidential-client secret for `client_secret_basic` as `messijo-mcp-worker`. */
  MCP_WORKER_CLIENT_SECRET: string;
  /** Retiring secret, accepted only before the rotation deadline. */
  MCP_WORKER_CLIENT_SECRET_RETIRING?: string;
  /** Absolute Unix seconds deadline for the retiring secret. */
  MCP_WORKER_CLIENT_SECRET_RETIRING_VALID_UNTIL?: string;
  /** Authorization server base URL, e.g. `https://auth.messijo.com`. */
  AUTH_BASE_URL: string;
  /** REST API base URL, e.g. `https://api.messijo.com`. */
  REST_API_BASE_URL: string;
  /** This Worker's MCP resource identifier, e.g. `https://mcp.messijo.com/mcp`. */
  MCP_RESOURCE_URL: string;
  /** Public origin used in the protected-resource metadata document. */
  MCP_PUBLIC_BASE_URL: string;
  /** Bounded introspection cache TTL in seconds (default 10). */
  INTROSPECTION_CACHE_TTL_SECONDS?: string;
  /** JWKS cache TTL in seconds (default 300). */
  JWKS_CACHE_TTL_SECONDS?: string;
  /** JWKS unknown-kid refresh cooldown in milliseconds (default 30000). */
  JWKS_COOLDOWN_MS?: string;
}

export const WORKER_CLIENT_ID = "messijo-mcp-worker";
export const GRANT_CONTEXT_EXTENSION = "https://messijo.com/oauth/grant-context/v1";

export interface Config {
  authBaseUrl: string;
  restApiBaseUrl: string;
  mcpResourceUrl: string;
  mcpPublicBaseUrl: string;
  clientSecret: string;
  retiringSecret?: string;
  retiringValidUntilMs?: number;
  introspectionCacheTtlSeconds: number;
  jwksCacheTtlSeconds: number;
  jwksCooldownMs: number;
}

function parseIntOption(value: string | undefined, fallback: number): number {
  const parsed = value === undefined ? NaN : Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

export function parseConfig(env: Env): Config {
  const missing: string[] = [];
  if (!env.AUTH_BASE_URL) missing.push("AUTH_BASE_URL");
  if (!env.REST_API_BASE_URL) missing.push("REST_API_BASE_URL");
  if (!env.MCP_RESOURCE_URL) missing.push("MCP_RESOURCE_URL");
  if (!env.MCP_PUBLIC_BASE_URL) missing.push("MCP_PUBLIC_BASE_URL");
  if (!env.MCP_WORKER_CLIENT_SECRET) missing.push("MCP_WORKER_CLIENT_SECRET");
  if (missing.length > 0) {
    throw new Error(`Invalid Worker configuration: missing ${missing.join(", ")}`);
  }

  let retiringValidUntilMs: number | undefined;
  if (env.MCP_WORKER_CLIENT_SECRET_RETIRING_VALID_UNTIL !== undefined) {
    const deadline = Number.parseInt(env.MCP_WORKER_CLIENT_SECRET_RETIRING_VALID_UNTIL, 10);
    if (Number.isFinite(deadline)) retiringValidUntilMs = deadline * 1000;
  }

  return {
    authBaseUrl: env.AUTH_BASE_URL.replace(/\/+$/, ""),
    restApiBaseUrl: env.REST_API_BASE_URL.replace(/\/+$/, ""),
    mcpResourceUrl: env.MCP_RESOURCE_URL,
    mcpPublicBaseUrl: env.MCP_PUBLIC_BASE_URL.replace(/\/+$/, ""),
    clientSecret: env.MCP_WORKER_CLIENT_SECRET,
    retiringSecret:
      env.MCP_WORKER_CLIENT_SECRET_RETIRING && retiringValidUntilMs !== undefined
        ? env.MCP_WORKER_CLIENT_SECRET_RETIRING
        : undefined,
    retiringValidUntilMs,
    introspectionCacheTtlSeconds: parseIntOption(env.INTROSPECTION_CACHE_TTL_SECONDS, 10),
    jwksCacheTtlSeconds: parseIntOption(env.JWKS_CACHE_TTL_SECONDS, 300),
    jwksCooldownMs: parseIntOption(env.JWKS_COOLDOWN_MS, 30_000),
  };
}
