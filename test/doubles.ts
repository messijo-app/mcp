import { fetchMock } from "cloudflare:test";
import {
  ACTIVE_SECRET,
  AUTH_BASE,
  CLIENT_ID,
  GRANT_CONTEXT_KEY,
  KEYS,
  REST_BASE,
  RETIRING_SECRET,
} from "./helpers";

export interface RestUpstreamRequest {
  method: string;
  path: string;
  authorization: string;
  body?: unknown;
}

export interface AuthUpstreamRequest {
  path: string;
  authorization: string;
  body: string;
}

export interface DoublesState {
  /** JWKS document served at /.well-known/jwks.json. */
  jwks: { keys: unknown[] };
  /** Introspection outcome per call; default active grant. */
  introspection: () => Record<string, unknown>;
  /** Exchange outcome per call; default 200 with a fixed backend token. */
  exchange: () => { status: number; body: Record<string, unknown> };
  /** REST outcome per request; default 200 {"ok": true}. */
  rest: (request: RestUpstreamRequest) => { status: number; body: unknown };
  /** When false, the active secret is rejected (401 invalid_client) once per flow. */
  activeSecretAccepted: boolean;
  /** When true, OAuth routes (introspect/token) return 404 (kill switch). */
  concealOAuthRoutes: boolean;
  /** REST responses when OAuth system disabled: reject backend tokens (401). */
  restRejectsBackendTokens: boolean;
  counts: { jwks: number; introspect: number; exchange: number; rest: number };
  seen: {
    introspect: AuthUpstreamRequest[];
    exchange: AuthUpstreamRequest[];
    rest: RestUpstreamRequest[];
    jwks: number;
  };
}

export const BACKEND_TOKEN = "T-backend-test-1";

export function freshState(): DoublesState {
  return {
    jwks: { keys: [KEYS.key1Public, KEYS.key2Public] },
    introspection: () => activeIntrospection(),
    exchange: () => ({ status: 200, body: { access_token: BACKEND_TOKEN, token_type: "Bearer", expires_in: 60 } }),
    rest: () => ({ status: 200, body: { ok: true } }),
    activeSecretAccepted: true,
    concealOAuthRoutes: false,
    restRejectsBackendTokens: false,
    counts: { jwks: 0, introspect: 0, exchange: 0, rest: 0 },
    seen: { introspect: [], exchange: [], rest: [], jwks: 0 },
  };
}

export function activeIntrospection(): Record<string, unknown> {
  return {
    active: true,
    [GRANT_CONTEXT_KEY]: {
      grant_id: "grant-1",
      organization_ids: ["org-1", "org-2"],
      original_client_id: "claude",
      resource: "https://mcp.test/mcp",
      effective_scopes: ["messijo:read"],
      user_id: "user-1",
    },
  };
}

export function inactiveIntrospection(): Record<string, unknown> {
  return { active: false };
}

let installed = false;
let state: DoublesState = freshState();

/** Install persistent fetchMock interceptors (once per test file). */
export function installDoubles(): DoublesState {
  state = freshState();
  fetchMock.activate();
  if (!installed) {
    installed = true;

    const auth = fetchMock.get(AUTH_BASE);

    auth
      .intercept({ path: "/.well-known/jwks.json", method: "GET" })
      .reply(() => {
        state.counts.jwks += 1;
        state.seen.jwks += 1;
        return {
          statusCode: 200,
          data: JSON.stringify(state.jwks),
          responseOptions: { headers: { "content-type": "application/jwk-set+json" } },
        };
      })
      .persist();

    auth
      .intercept({ path: "/oauth/introspect", method: "POST" })
      .reply((opts) => {
        state.counts.introspect += 1;
        const headers = headersOf(opts.headers);
        state.seen.introspect.push({
          path: opts.path,
          authorization: headers.authorization ?? "",
          body: String(opts.body ?? ""),
        });
        if (state.concealOAuthRoutes) {
          return { statusCode: 404, data: JSON.stringify({ error: "not found" }) };
        }
        const accepted = isAcceptedAuth(headers.authorization);
        if (!accepted) {
          return {
            statusCode: 401,
            data: JSON.stringify({ error: "invalid_client" }),
            responseOptions: { headers: { "www-authenticate": 'Basic realm="oauth-worker"' } },
          };
        }
        return {
          statusCode: 200,
          data: JSON.stringify(state.introspection()),
          responseOptions: { headers: { "content-type": "application/json" } },
        };
      })
      .persist();

    auth
      .intercept({ path: "/oauth/token", method: "POST" })
      .reply((opts) => {
        state.counts.exchange += 1;
        const headers = headersOf(opts.headers);
        state.seen.exchange.push({
          path: opts.path,
          authorization: headers.authorization ?? "",
          body: String(opts.body ?? ""),
        });
        if (state.concealOAuthRoutes) {
          return { statusCode: 404, data: JSON.stringify({ error: "not found" }) };
        }
        const accepted = isAcceptedAuth(headers.authorization);
        if (!accepted) {
          return {
            statusCode: 401,
            data: JSON.stringify({ error: "invalid_client" }),
            responseOptions: { headers: { "www-authenticate": 'Basic realm="oauth-worker"' } },
          };
        }
        const outcome = state.exchange();
        return {
          statusCode: outcome.status,
          data: JSON.stringify(outcome.body),
          responseOptions: { headers: { "content-type": "application/json" } },
        };
      })
      .persist();

    const rest = fetchMock.get(REST_BASE);
    rest
      .intercept({
        path: () => true,
        method: () => true,
      })
      .reply((opts) => {
        state.counts.rest += 1;
        const headers = headersOf(opts.headers);
        state.seen.rest.push({
          method: opts.method,
          path: opts.path,
          authorization: headers.authorization ?? "",
          body: typeof opts.body === "string" ? opts.body : undefined,
        });
        const outcome = state.rest({
          method: opts.method,
          path: opts.path,
          authorization: headers.authorization ?? "",
          body: opts.body,
        });
        let finalOutcome = outcome;
        if (state.restRejectsBackendTokens && headers.authorization === `Bearer ${BACKEND_TOKEN}`) {
          finalOutcome = { status: 401, body: { error: "unauthorized" } };
        }
        return {
          statusCode: finalOutcome.status,
          data: typeof finalOutcome.body === "string" ? finalOutcome.body : JSON.stringify(finalOutcome.body),
          responseOptions: { headers: { "content-type": "application/json" } },
        };
      })
      .persist();
  }
  return state;
}

/** Reset behavior/counters between tests within a file. */
export function resetDoubles(): DoublesState {
  state = freshState();
  return state;
}

export function doubles(): DoublesState {
  return state;
}

function headersOf(headers: Headers | Record<string, string>): Record<string, string> {
  if (headers instanceof Headers) {
    const record: Record<string, string> = {};
    headers.forEach((value, key) => {
      record[key.toLowerCase()] = value;
    });
    return record;
  }
  const record: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers ?? {})) record[key.toLowerCase()] = value;
  return record;
}

function isAcceptedAuth(authorization: string | undefined): boolean {
  const active = `Basic ${btoa(`${CLIENT_ID}:${ACTIVE_SECRET}`)}`;
  const retiring = `Basic ${btoa(`${CLIENT_ID}:${RETIRING_SECRET}`)}`;
  if (authorization === active) return state.activeSecretAccepted;
  if (authorization === retiring) return true;
  return false;
}
