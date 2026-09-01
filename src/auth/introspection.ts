import { GRANT_CONTEXT_EXTENSION, type Config } from "../env";
import { authServerPost, AuthServerError } from "./client";
import type { McpTokenClaims } from "./verify";

export interface GrantContext {
  grant_id: string;
  organization_ids: string[];
  original_client_id: string;
  resource: string;
  effective_scopes: string[];
  user_id: string;
}

interface CachedIntrospection {
  grant: GrantContext;
  expiresAtMs: number;
}

/**
 * Isolate-scoped introspection cache keyed by token `jti`. Entries never
 * outlive the token itself: expiry is `min(now + TTL, token exp)`. Any REST
 * 401/403 invalidates the entry for that token. The map is capped; on
 * overflow the oldest entries are evicted first.
 */
const cache = new Map<string, CachedIntrospection>();
const CACHE_MAX_ENTRIES = 500;

let now: () => number = () => Date.now();

/** Test hook: inject a deterministic clock for cache-expiry tests. */
export function setClockForTests(clock: (() => number) | null): void {
  now = clock ?? (() => Date.now());
}

/** Test hook: drop all cached introspection results. */
export function resetIntrospectionCache(): void {
  cache.clear();
}

export function invalidateIntrospection(jti: string): void {
  cache.delete(jti);
}

export class IntrospectionError extends Error {
  constructor(
    public readonly failure: "inactive" | "unexpected_status" | AuthServerError["failure"],
    message: string,
  ) {
    super(message);
    this.name = "IntrospectionError";
  }
}

/**
 * Introspect the MCP token (grant liveness) with `client_secret_basic` and
 * read the Messijo grant-context extension. Inactive tokens fail closed.
 */
export async function introspectToken(
  config: Config,
  token: string,
  claims: McpTokenClaims,
): Promise<GrantContext> {
  const cached = cache.get(claims.jti);
  if (cached !== undefined && now() < cached.expiresAtMs) {
    return cached.grant;
  }
  cache.delete(claims.jti);

  let response: Response;
  try {
    response = await authServerPost(config, {
      path: "/oauth/introspect",
      form: { token, token_type_hint: "access_token" },
    });
  } catch (error) {
    if (error instanceof AuthServerError) {
      throw new IntrospectionError(error.failure, `Introspection failed: ${error.failure}`);
    }
    throw error;
  }

  if (response.status !== 200) {
    throw new IntrospectionError("unexpected_status", `Introspection returned ${response.status}`);
  }

  const body = (await response.json()) as Record<string, unknown>;
  if (body.active !== true) {
    throw new IntrospectionError("inactive", "Token is not active");
  }

  const extension = body[GRANT_CONTEXT_EXTENSION] as Record<string, unknown> | undefined;
  if (extension === undefined || typeof extension !== "object") {
    throw new IntrospectionError(
      "inactive",
      "Introspection response missing grant-context extension",
    );
  }

  // Fail closed on a malformed extension: every required field must be
  // present with the right primitive type. Coercing absent/wrong-typed
  // fields would fabricate identifiers (e.g. grant_id "undefined") and
  // proceed to delegation with garbage grant context.
  const stringField = (name: string): string => {
    const value = extension[name];
    if (typeof value !== "string" || value.length === 0) {
      throw new IntrospectionError(
        "inactive",
        `Grant-context extension field '${name}' is missing or malformed`,
      );
    }
    return value;
  };
  const stringArrayField = (name: string): string[] => {
    const value = extension[name];
    if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
      throw new IntrospectionError(
        "inactive",
        `Grant-context extension field '${name}' is missing or malformed`,
      );
    }
    return value;
  };

  const grant: GrantContext = {
    grant_id: stringField("grant_id"),
    organization_ids: stringArrayField("organization_ids"),
    original_client_id: stringField("original_client_id"),
    resource: stringField("resource"),
    effective_scopes: stringArrayField("effective_scopes"),
    user_id: stringField("user_id"),
  };

  // `now()` is captured after I/O completes; the entry never outlives the
  // token's own exp claim.
  const fetchedAtMs = now();
  const expiresAtMs = Math.min(
    fetchedAtMs + config.introspectionCacheTtlSeconds * 1000,
    claims.exp * 1000,
  );
  cache.delete(claims.jti);
  if (cache.size >= CACHE_MAX_ENTRIES) {
    // Map preserves insertion order: drop the oldest entries until we are
    // back under the cap.
    let excess = cache.size - CACHE_MAX_ENTRIES + 1;
    for (const key of cache.keys()) {
      if (excess <= 0) break;
      cache.delete(key);
      excess -= 1;
    }
  }
  cache.set(claims.jti, { grant, expiresAtMs });

  return grant;
}
