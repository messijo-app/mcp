import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CfWorkerJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/cfworker";
import { z } from "zod";
import type { DelegationContext } from "../delegation/exchange";
import { ExchangeError } from "../delegation/exchange";
import { restCall, RestTransportError } from "../delegation/rest";
import { logEvent } from "../log";
import { findRoute, requiresOrganizationId, routesForTool, ROUTE_TABLE, type RouteEntry } from "./route-table";

interface ToolInput {
  action?: string;
  organization_id?: string;
  id?: string;
  params?: Record<string, unknown>;
}

function toolDescription(tool: string, entries: RouteEntry[]): string {
  const header =
    tool === "me"
      ? "Account information for the grant user."
      : tool === "organizations"
        ? "Organizations selected by the active grant. Start with action `list` to resolve live organization names and organization_id values."
        : `Composable tool for the ${tool.replace(/_/g, " ")} area. Pass ` +
          "`organization_id` (from the organizations tool's list action) and an `action`.";
  const actions = entries.map((entry) => `- ${entry.action}: ${entry.description}`).join("\n");
  return `${header}\nActions:\n${actions}`;
}

function inputShape(entries: RouteEntry[]): z.ZodRawShape {
  const actions = entries.map((entry) => entry.action) as [string, ...string[]];
  const shape: z.ZodRawShape = {
    action: z.enum(actions).describe("REST operation to perform."),
  };
  if (entries.some((entry) => entry.pathParams.includes("organization_id"))) {
    // Optional at the schema level: `organizations.list` and `me` do not need
    // it; per-action validation happens in the handler before any REST call.
    shape.organization_id = z
      .string()
      .optional()
      .describe("Organization id from the organizations tool's list action.");
  }
  if (entries.some((entry) => entry.pathParams.includes("id"))) {
    shape.id = z.string().optional().describe("Resource id.");
  }
  shape.params = z
      .record(z.unknown())
      .optional()
      .describe(
        "Additional parameters: query parameters for read actions, JSON body fields for mutations.",
      );
  return shape;
}

function buildPath(entry: RouteEntry, input: ToolInput): string {
  let path = entry.pathTemplate;
  for (const param of entry.pathParams) {
    const value = param === "organization_id" ? input.organization_id : input.id;
    path = path.replaceAll(`{${param}}`, encodeURIComponent(value ?? ""));
  }
  return path;
}

export function buildMcpServer(
  delegation: DelegationContext,
  baseLogFields: Record<string, string> = {},
): McpServer {
  const server = new McpServer(
    { name: "messijo-mcp-worker", version: "0.1.0" },
    {
      capabilities: { tools: {} },
      // Edge-safe interpretive validator: no eval/new Function (ajv default is
      // unavailable in the Workers runtime).
      jsonSchemaValidator: new CfWorkerJsonSchemaValidator(),
    },
  );

  const toolNames = listToolNames();
  for (const tool of toolNames) {
    const entries = routesForTool(tool);
    server.registerTool(
      tool,
      {
        description: toolDescription(tool, entries),
        inputSchema: inputShape(entries),
      },
      async (rawArgs: ToolInput) => {
        const input = rawArgs ?? {};
        const action = input.action;
        if (typeof action !== "string") {
          return toolError(400, { error: "Missing action parameter" });
        }

        const entry = findRoute(tool, action);
        if (entry === undefined) {
          return toolError(400, { error: `Unknown action '${action}' for tool '${tool}'` });
        }

        if (requiresOrganizationId(tool, action) && !input.organization_id) {
          return toolError(400, {
            error: "organization_id is required. Use the organizations tool with action 'list' to find it.",
          });
        }

        for (const param of entry.pathParams) {
          const value = param === "organization_id" ? input.organization_id : input.id;
          if (!value) {
            return toolError(400, { error: `Missing required parameter: ${param}` });
          }
        }

        const path = buildPath(entry, input);
        const params = input.params ?? {};
        const query: Record<string, string> = {};
        const body: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(params)) {
          if (value === undefined || value === null) continue;
          // Only scalars are accepted: stringifying nested objects would
          // produce garbage like "filter=[object Object]" upstream. Reject
          // at the tool level so the client can self-correct.
          if (typeof value === "object") {
            return toolError(400, {
              error: `Parameter '${key}' must be a scalar value (string, number, or boolean).`,
            });
          }
          if (entry.method === "GET" || entry.method === "DELETE") {
            query[key] = String(value);
          } else {
            body[key] = value;
          }
        }

        logEvent("info", "tool_call", {
          ...baseLogFields,
          tool,
          action,
          route: `${entry.method} ${entry.pathTemplate}`,
          organizationId: input.organization_id ?? null,
          outcome: "started",
        });

        try {
          const result = await restCall(delegation, {
            method: entry.method,
            path,
            query: Object.keys(query).length > 0 ? query : undefined,
            body: Object.keys(body).length > 0 ? body : undefined,
            isMutation: entry.isMutation,
          });

          logEvent("info", "tool_call", {
            ...baseLogFields,
            tool,
            action,
            route: `${entry.method} ${entry.pathTemplate}`,
            organizationId: input.organization_id ?? null,
            outcome: result.status < 400 ? "ok" : `rest_${result.status}`,
          });

          return {
            content: [
              { type: "text" as const, text: JSON.stringify({ status: result.status, body: result.body }, null, 2) },
            ],
            structuredContent: { status: result.status, body: result.body },
            isError: result.status >= 400,
          };
        } catch (error) {
          const failure =
            error instanceof ExchangeError
              ? `exchange_${error.failure}`
              : error instanceof RestTransportError
                ? "rest_transport"
                : "internal";
          logEvent("error", "tool_call", {
            ...baseLogFields,
            tool,
            action,
            route: `${entry.method} ${entry.pathTemplate}`,
            organizationId: input.organization_id ?? null,
            outcome: failure,
          });
          const message =
            error instanceof ExchangeError && error.failure === "concealed"
              ? "Authorization system is currently unavailable (OAuth routes concealed). Try again later."
              : error instanceof ExchangeError && error.failure === "unauthorized"
                ? "Worker client credentials were rejected by the authorization server. Try again later."
                : error instanceof ExchangeError && error.failure === "invalid_grant"
                  ? "The authorization grant is no longer valid (revoked or expired). Re-authorize and try again."
                  : error instanceof RestTransportError
                    ? "REST API transport failure."
                    : "Internal worker error.";
          const status =
            error instanceof ExchangeError &&
            (error.failure === "invalid_grant" || error.failure === "unauthorized")
              ? 401
              : 503;
          return toolError(status, { error: message, failure });
        }
      },
    );
  }

  return server;
}

function toolError(status: number, payload: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify({ status, body: payload }, null, 2) }],
    structuredContent: { status, body: payload },
    isError: true,
  };
}

function listToolNames(): string[] {
  // Derived from the route table so the surface stays declarative.
  const names: string[] = [];
  for (const entry of ROUTE_TABLE) {
    if (!names.includes(entry.tool)) names.push(entry.tool);
  }
  return names;
}
