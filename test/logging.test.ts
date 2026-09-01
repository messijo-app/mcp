import { beforeAll, beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { app } from "./app";
import { postMcp, signMcpToken, toolCallRequest } from "./helpers";
import { doubles, installDoubles, resetDoubles } from "./doubles";
import { resetIntrospectionCache } from "../src/auth/introspection";
import { resetJwksCache } from "../src/auth/jwks";

beforeAll(() => {
  installDoubles();
});

beforeEach(() => {
  resetDoubles();
  resetIntrospectionCache();
  resetJwksCache();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("structured logging discipline", () => {
  it("logs correlated non-sensitive fields on the happy path", async () => {
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((line?: unknown) => {
      logs.push(String(line));
    });

    const token = await signMcpToken();
    const response = await postMcp(app, token, toolCallRequest("me", { action: "me" }));
    expect(response.status).toBe(200);

    expect(logs.length).toBeGreaterThan(0);
    const parsed = logs.map((line) => JSON.parse(line) as Record<string, unknown>);
    const toolCall = parsed.find((entry) => entry.event === "tool_call" && entry.outcome === "ok");
    expect(toolCall).toBeDefined();
    // user/grant ids come from the introspected grant context (the doubles).
    expect(toolCall!.userId).toBe("user-1");
    expect(toolCall!.grantId).toBe("grant-1");
    expect(toolCall!.route).toBe("GET /api/me");
    expect(toolCall!.outcome).toBe("ok");
  });

  it("never logs token or secret material on error paths", async () => {
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((line?: unknown) => {
      logs.push(String(line));
    });
    vi.spyOn(console, "warn").mockImplementation((line?: unknown) => {
      logs.push(String(line));
    });
    vi.spyOn(console, "error").mockImplementation((line?: unknown) => {
      logs.push(String(line));
    });

    // Error path 1: failed verification (bad signature).
    await postMcp(app, "not-a-jwt", toolCallRequest("me", { action: "me" }));

    // Error path 2: token exchange failure with a live MCP token.
    const token = await signMcpToken();
    doubles().concealOAuthRoutes = true;
    const response = await postMcp(app, token, toolCallRequest("me", { action: "me" }));
    expect(response.status).toBe(401);

    // Error path 3: REST failure surfaced through a tool call.
    doubles().concealOAuthRoutes = false;
    doubles().rest = () => ({ status: 402, body: { error: "quota_exceeded" } });
    await postMcp(app, token, toolCallRequest("me", { action: "me" }));

    expect(logs.length).toBeGreaterThan(0);
    const allLogs = logs.join("\n");
    expect(allLogs).not.toContain(token);
    expect(allLogs).not.toContain("Basic ");
    expect(allLogs).not.toContain("Bearer ");
    expect(allLogs).not.toContain("test-active-secret");
    expect(allLogs).not.toContain("test-retiring-secret");
    // Every line is structured JSON.
    for (const line of logs) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });
});
