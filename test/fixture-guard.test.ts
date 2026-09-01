import { describe, expect, it } from "vitest";
import {
  EXPECTED_API_REVISION,
  EXPECTED_FIXTURE_FILE_SHA256,
  EXPECTED_FIXTURE_SHA256,
  FIXTURE,
  FIXTURE_PAYLOAD,
} from "./helpers";

/**
 * Conformance source of truth: the vendored producer fixture. The guard
 * asserts the embedded fixture digest and producer revision match the
 * recorded constants, and that the file itself is byte-identical to the
 * verified revision, so any accidental fixture edit fails loudly.
 */
describe("vendored fixture guard", () => {
  it("embeds the recorded fixture_sha256", () => {
    expect(FIXTURE.fixture_sha256).toBe(EXPECTED_FIXTURE_SHA256);
  });

  it("pins the recorded producer api_revision", () => {
    expect(FIXTURE.api_revision).toBe(EXPECTED_API_REVISION);
  });

  it("matches the recorded module-serialized digest (catches any content edit)", async () => {
    const serialized = JSON.stringify(FIXTURE);
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(serialized));
    const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
    expect(hex).toBe(EXPECTED_FIXTURE_FILE_SHA256);
  });

  it("exposes metadata, claims, introspection, worker, and route policy sections", () => {
    const payload = FIXTURE_PAYLOAD;
    expect(payload.metadata.issuer).toBe("https://auth.messijo.com");
    expect(payload.metadata.jwks_uri).toBe("https://auth.messijo.com/.well-known/jwks.json");
    expect(payload.mcp_access_token.token_use).toBe("mcp_access");
    expect(payload.mcp_access_token.aud).toBe("https://mcp.messijo.com/mcp");
    expect(payload.mcp_access_token.required_claims).toHaveLength(12);
    expect(payload.introspection.endpoint).toBe("https://auth.messijo.com/oauth/introspect");
    expect(payload.introspection.active_extension).toBe(
      "https://messijo.com/oauth/grant-context/v1",
    );
    expect(payload.worker.client_id).toBe("messijo-mcp-worker");
    expect(payload.worker.exchange.grant_type).toBe(
      "urn:ietf:params:oauth:grant-type:token-exchange",
    );
    expect(payload.route_policy.length).toBeGreaterThan(50);
    expect(payload.rest_contract_version).toBe("0.3.0");
  });
});
