import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { app } from "./app";
import { initializeRequest, postMcp, signMcpToken } from "./helpers";
import { doubles, installDoubles, resetDoubles } from "./doubles";
import { resetIntrospectionCache, setClockForTests } from "../src/auth/introspection";
import { resetJwksCache } from "../src/auth/jwks";

beforeAll(() => {
  installDoubles();
});

beforeEach(() => {
  resetDoubles();
  resetIntrospectionCache();
  resetJwksCache();
  setClockForTests(null);
});

describe("introspection cache (jti-keyed, bounded by token exp)", () => {
  it("caches an active result keyed by jti", async () => {
    const token = await signMcpToken();
    await postMcp(app, token, initializeRequest());
    await postMcp(app, token, initializeRequest());
    expect(doubles().counts.introspect).toBe(1);
  });

  it("re-introspects for a different token (different jti)", async () => {
    await postMcp(app, await signMcpToken(), initializeRequest());
    await postMcp(app, await signMcpToken(), initializeRequest());
    expect(doubles().counts.introspect).toBe(2);
  });

  it("treats a cached entry as expired once the TTL elapses", async () => {
    let fakeNow = Date.now();
    setClockForTests(() => fakeNow);

    const token = await signMcpToken();
    await postMcp(app, token, initializeRequest());
    expect(doubles().counts.introspect).toBe(1);

    // Same token again within TTL: cache hit.
    await postMcp(app, token, initializeRequest());
    expect(doubles().counts.introspect).toBe(1);

    // Advance past the configured TTL (10s in the test environment).
    fakeNow += 11_000;
    await postMcp(app, token, initializeRequest());
    expect(doubles().counts.introspect).toBe(2);
  });

  it("never lets a cache entry outlive the token's own exp", async () => {
    const fakeStart = Date.now();
    let fakeNow = fakeStart;
    setClockForTests(() => fakeNow);

    // Token valid for 15 more seconds; cache TTL is 10s, so the entry is
    // bounded by exp at +15s. At +16s the entry must be gone even though a
    // pure TTL read would still allow it (10s < 16s since fetch is false
    // here: TTL would have expired too, so use a shorter window: token exp
    // +4s, TTL 10s → entry must expire at +4s, before the TTL).
    const token = await signMcpToken({
      issuedAtSeconds: Math.floor(fakeStart / 1000) - 296,
      expiresInSeconds: 300,
    });
    // iat = now-296, exp = now+4s.
    await postMcp(app, token, initializeRequest());
    expect(doubles().counts.introspect).toBe(1);

    // +3s: still inside both TTL and token lifetime → cache hit.
    fakeNow += 3_000;
    await postMcp(app, token, initializeRequest());
    expect(doubles().counts.introspect).toBe(1);

    // +5s: within TTL (10s) but past token exp → entry treated as expired.
    fakeNow += 2_000;
    await postMcp(app, token, initializeRequest());
    expect(doubles().counts.introspect).toBe(2);
  });

  it("invalidates the cached entry after a REST 401 and re-authenticates once", async () => {
    const state = doubles();
    let restCalls = 0;
    state.rest = () => {
      restCalls += 1;
      return { status: 401, body: { error: "unauthorized" } };
    };

    const token = await signMcpToken();
    const callMe = { jsonrpc: "2.0" as const, id: 9, method: "tools/call", params: { name: "me", arguments: { action: "me" } } };
    const result = await postMcp(app, token, callMe);
    expect(result.status).toBe(200);
    expect(doubles().counts.introspect).toBe(1);
    expect(restCalls).toBe(2); // original + one re-authenticated retry

    // The REST 401 dropped the introspection cache entry: the next request
    // re-introspects.
    await postMcp(app, token, callMe);
    expect(doubles().counts.introspect).toBe(2);
  });
});
