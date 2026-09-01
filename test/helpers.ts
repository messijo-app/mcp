import { SignJWT, importJWK } from "jose";
import fixtureJson from "./fixtures/oauth/mcp-producer-contract-v1.json";
import key1Public from "./fixtures/keys/key1-public.json";
import key1Private from "./fixtures/keys/key1-private.json";
import key2Public from "./fixtures/keys/key2-public.json";
import key2Private from "./fixtures/keys/key2-private.json";
import key3Private from "./fixtures/keys/key3-private.json";
import type { Env } from "../src/env";

export const FIXTURE = fixtureJson;
export const FIXTURE_PAYLOAD = fixtureJson.payload;
export const EXPECTED_FIXTURE_SHA256 =
  "ed4ca73176ccf84e22c0a8c664b60145b9a867c87fbb283eaeddd00801796f27";
export const EXPECTED_API_REVISION =
  "sha256:4dca13e61ead99cff6ab6f069a4a9d6c7a6ea38b689e9ce8a96bc2f1c0ade8d1";
export const EXPECTED_FIXTURE_FILE_SHA256 =
  "9cab52835a116b311992b97adfdd4bcb8a9ead88f426f65ad2edf15c5ac3b354";

export const KEYS = {
  key1Public: key1Public as Record<string, unknown> & { kid: string },
  key2Public: key2Public as Record<string, unknown> & { kid: string },
  key1Private: key1Private as Record<string, unknown> & { kid: string },
  key2Private: key2Private as Record<string, unknown> & { kid: string },
  key3Private: key3Private as Record<string, unknown> & { kid: string },
};

export const AUTH_BASE = "https://auth.test";
export const REST_BASE = "https://api.test";
export const MCP_RESOURCE = "https://mcp.test/mcp";

export const CLIENT_ID = "messijo-mcp-worker";
export const ACTIVE_SECRET = "test-active-secret";
export const RETIRING_SECRET = "test-retiring-secret";

export const GRANT_CONTEXT_KEY = "https://messijo.com/oauth/grant-context/v1";

export const TEST_ENV: Env = {
  AUTH_BASE_URL: AUTH_BASE,
  REST_API_BASE_URL: REST_BASE,
  MCP_RESOURCE_URL: MCP_RESOURCE,
  MCP_PUBLIC_BASE_URL: "https://mcp.test",
  MCP_WORKER_CLIENT_SECRET: ACTIVE_SECRET,
  MCP_WORKER_CLIENT_SECRET_RETIRING: RETIRING_SECRET,
  MCP_WORKER_CLIENT_SECRET_RETIRING_VALID_UNTIL: "9999999999",
  INTROSPECTION_CACHE_TTL_SECONDS: "10",
  JWKS_CACHE_TTL_SECONDS: "300",
  JWKS_COOLDOWN_MS: "0",
};

export interface TestGrant {
  grant_id?: string;
  organization_ids?: string[];
  user_id?: string;
  effective_scopes?: string[];
}

export interface SignTokenOptions {
  key?: "key1" | "key2" | "unknown";
  audience?: string;
  issuer?: string;
  omit?: string[];
  expiresInSeconds?: number;
  issuedAtSeconds?: number;
  tokenUse?: string;
  grant?: TestGrant;
}

export async function signMcpToken(options: SignTokenOptions = {}): Promise<string> {
  const keyJwk = options.key === "key2" ? KEYS.key2Private : options.key === "unknown" ? KEYS.key3Private : KEYS.key1Private;
  const privateKey = await importJWK(keyJwk, "RS256");

  const nowSeconds = Math.floor(Date.now() / 1000);
  const iat = options.issuedAtSeconds ?? nowSeconds;
  const exp = iat + (options.expiresInSeconds ?? 300);

  const grant = options.grant ?? {};
  const claims: Record<string, unknown> = {
    iss: options.issuer ?? AUTH_BASE,
    aud: options.audience ?? MCP_RESOURCE,
    sub: "user-1",
    iat,
    exp,
    jti: `jti-${Math.random().toString(36).slice(2, 10)}`,
    scope: "messijo:read",
    client_id: CLIENT_ID,
    original_client_id: "claude",
    grant_id: grant.grant_id ?? "grant-1",
    organization_ids: grant.organization_ids ?? ["org-1", "org-2"],
    token_use: options.tokenUse ?? "mcp_access",
  };
  for (const claim of options.omit ?? []) delete claims[claim];

  return new SignJWT(claims)
    .setProtectedHeader({ alg: "RS256", kid: keyJwk.kid, typ: "JWT" })
    .sign(privateKey);
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number | string | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

type RequestApp = {
  request: (path: string, init: RequestInit, env: Env) => Response | Promise<Response>;
};

export async function postMcp(app: RequestApp, token: string | null, body: unknown, method = "POST"): Promise<Response> {
  const headers: Record<string, string> = { "content-type": "application/json", accept: "application/json, text/event-stream" };
  if (token !== null) headers.authorization = `Bearer ${token}`;
  const hasBody = method !== "GET" && method !== "DELETE";
  const init: RequestInit = { method, headers, body: hasBody ? JSON.stringify(body) : undefined };
  return app.request("/mcp", init, TEST_ENV);
}

export function initializeRequest(id = 1) {
  return {
    jsonrpc: "2.0" as const,
    id,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "test-client", version: "0.0.0" },
    },
  };
}

export function toolCallRequest(name: string, args: Record<string, unknown>, id = 2) {
  return {
    jsonrpc: "2.0" as const,
    id,
    method: "tools/call",
    params: { name, arguments: args },
  };
}

export function toolsListRequest(id = 3) {
  return { jsonrpc: "2.0" as const, id, method: "tools/list", params: {} };
}

export async function rpcBody(response: Response): Promise<JsonRpcResponse> {
  return (await response.json()) as JsonRpcResponse;
}

export function toolResult(result: JsonRpcResponse): { status: number; body: unknown; isError: boolean } | null {
  const r = result.result as
    | { content?: { type: string; text?: string }[]; structuredContent?: { status: number; body: unknown }; isError?: boolean }
    | undefined;
  if (r === undefined) return null;
  const structured = r.structuredContent;
  if (structured !== undefined) {
    return { status: structured.status, body: structured.body, isError: r.isError === true };
  }
  const text = r.content?.find((part) => part.type === "text")?.text;
  if (text !== undefined) {
    try {
      return JSON.parse(text);
    } catch {
      // SDK-level error text (e.g. input validation): surface as a tool error.
      return { status: 400, body: text, isError: r.isError === true };
    }
  }
  return null;
}

export { GRANT_CONTEXT_KEY as GRANT_EXTENSION };
