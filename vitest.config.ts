import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig({
  test: {
    poolOptions: {
      workers: {
        singleWorker: true,
        miniflare: {
          compatibilityFlags: ["nodejs_compat"],
          compatibilityDate: "2025-09-06",
          // Test-time upstream base URLs point at fetchMock interceptors
          // (see test/doubles.ts); secrets are throwaway test values.
          bindings: {
            AUTH_BASE_URL: "https://auth.test",
            REST_API_BASE_URL: "https://api.test",
            MCP_RESOURCE_URL: "https://mcp.test/mcp",
            MCP_PUBLIC_BASE_URL: "https://mcp.test",
            INTROSPECTION_CACHE_TTL_SECONDS: "10",
            JWKS_CACHE_TTL_SECONDS: "300",
            JWKS_COOLDOWN_MS: "0",
            MCP_WORKER_CLIENT_SECRET: "test-active-secret",
            MCP_WORKER_CLIENT_SECRET_RETIRING: "test-retiring-secret",
            MCP_WORKER_CLIENT_SECRET_RETIRING_VALID_UNTIL: "9999999999",
          },
        },
      },
    },
    // ajv (pulled in by @modelcontextprotocol/sdk) is CommonJS and requires
    // JSON files; pre-bundle it so workerd never loads it from disk.
    // At runtime the server uses CfWorkerJsonSchemaValidator instead.
    deps: {
      optimizer: {
        ssr: {
          enabled: true,
          include: ["ajv", "ajv-formats", "@cfworker/json-schema"],
        },
      },
    },
  },
  ssr: {
    noExternal: ["@modelcontextprotocol/sdk"],
  },
});
