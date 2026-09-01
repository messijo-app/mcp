import { createRemoteJWKSet, type RemoteJWKSet } from "jose";
import type { Config } from "../env";

/**
 * Isolate-scoped JWKS resolvers keyed by JWKS URL. Each resolver is backed by
 * jose's `createRemoteJWKSet`, which provides the short-TTL cache plus
 * refresh-on-unknown-`kid` behavior (bounded by the cooldown window) required
 * for rotation convergence.
 */
const resolvers = new Map<string, RemoteJWKSet>();

export function getJwksResolver(config: Config): RemoteJWKSet {
  const url = new URL("/.well-known/jwks.json", `${config.authBaseUrl}/`);
  const key = url.toString();
  let resolver = resolvers.get(key);
  if (resolver === undefined) {
    resolver = createRemoteJWKSet(url, {
      cooldownDuration: config.jwksCooldownMs,
      cacheMaxAge: config.jwksCacheTtlSeconds * 1000,
      headers: { accept: "application/jwk-set+json, application/json" },
    });
    resolvers.set(key, resolver);
  }
  return resolver;
}

/** Test hook: drop cached resolvers so a fresh JWKS fetch is forced. */
export function resetJwksCache(): void {
  resolvers.clear();
}
