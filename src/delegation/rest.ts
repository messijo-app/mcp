import type { DelegationContext, ExchangeError } from "./exchange";

export interface RestCallOptions {
  method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  path: string;
  query?: Record<string, string>;
  body?: unknown;
  /** Mutations are never retried; reads may retry once on transport failure. */
  isMutation: boolean;
  /** Internal: marks the single re-authenticated retry after a REST 401/403. */
  isRetry?: boolean;
}

export interface RestResult {
  status: number;
  body: unknown;
}

export class RestTransportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RestTransportError";
  }
}

export type RestDelegate = (
  ctx: DelegationContext,
  options: RestCallOptions,
) => Promise<RestResult>;

/**
 * Perform a delegated REST call with the exchanged `worker_backend` token.
 *
 * - The MCP access token is never sent to the REST API (token isolation).
 * - On REST 401/403: cached credentials and introspection are dropped, the
 *   request re-authenticates once (fresh exchange), and the retried response is
 *   surfaced even if it still fails.
 * - On transport failure: reads retry at most once; mutations never retry.
 * - Non-2xx responses (402 quota, 404 hidden, 422 validation) are returned
 *   faithfully with the API's own payload.
 */
export async function restCall(
  ctx: DelegationContext,
  options: RestCallOptions,
): Promise<RestResult> {
  const token = await ctx.getBackendToken();

  let result: RestResult;
  try {
    result = await performFetch(ctx, token, options);
  } catch (error) {
    if (error instanceof RestTransportError) {
      if (options.isMutation) throw error;
      // Read: single retry on transport failure.
      const retryToken = await ctx.getBackendToken();
      return await performFetch(ctx, retryToken, options);
    }
    throw error;
  }

  // Spec tension, resolved deliberately: the token-verification spec requires
  // "drop credentials, re-authenticate once, then surface the error if the
  // retry fails" on any REST 401/403, while the mcp-server spec forbids
  // retrying failed mutations. A 401/403 guarantees the server did NOT apply
  // the mutation (authentication/authorization happens before handler logic),
  // so re-sending once after re-authentication is safe and required; retries
  // after other failures (e.g. 5xx, transport) remain forbidden for
  // mutations. Do not "fix" this in either direction without updating both
  // specs.
  if ((result.status === 401 || result.status === 403) && !options.isRetry) {
    // Drop cached auth state and re-authenticate once.
    ctx.dropCredentials();
    const freshToken = await ctx.getBackendToken();
    return await performFetch(ctx, freshToken, { ...options, isRetry: true });
  }

  return result;
}

async function performFetch(
  ctx: DelegationContext,
  backendToken: string,
  options: RestCallOptions & { isRetry?: boolean },
): Promise<RestResult> {
  const url = new URL(options.path, ctxRestBase(ctx));
  if (options.query !== undefined) {
    for (const [key, value] of Object.entries(options.query)) {
      if (value !== undefined) url.searchParams.set(key, value);
    }
  }

  const headers: Record<string, string> = {
    authorization: `Bearer ${backendToken}`,
    accept: "application/json",
  };
  const hasBody = options.body !== undefined && options.method !== "GET" && options.method !== "DELETE";
  if (hasBody) headers["content-type"] = "application/json";

  let response: Response;
  try {
    response = await fetch(url.toString(), {
      method: options.method,
      headers,
      body: hasBody ? JSON.stringify(options.body) : undefined,
    });
  } catch {
    throw new RestTransportError(`REST transport failure on ${options.method} ${options.path}`);
  }

  const body = await parseBody(response);
  return { status: response.status, body };
}

function ctxRestBase(ctx: DelegationContext): string {
  return ctx.restBaseUrl;
}

async function parseBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text.length === 0) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export type { ExchangeError };
