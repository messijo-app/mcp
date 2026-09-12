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
  keyword_id?: string;
  lens_id?: string;
  id?: string;
  params?: Record<string, unknown>;
}

const PATH_PARAM_DESCRIPTIONS: Record<string, string> = {
  organization_id: "Organization id from the organizations tool's list action.",
  keyword_id: "Keyword id from the keywords tool's list action.",
  lens_id: "Lens id from the lenses tool's list action.",
  id: "Resource id.",
};

const TOOL_HEADERS: Record<string, string> = {
  me: "Account information for the grant user.",
  organizations:
    "Organizations selected by the active grant. Start with action `list` to resolve live organization names and organization_id values.",
  keyword_events:
    "Keyword events for one keyword. Pass `organization_id` (from the organizations tool's list action), `keyword_id` (from the keywords tool's list action), and an `action`.",
  lenses:
    "Lenses for one keyword. Pass `organization_id` (from the organizations tool's list action), `keyword_id` (from the keywords tool's list action), and an `action`. The list action's returned ids are the `lens_id` for the lens_results tool.",
  lens_results:
    "Lens results for one lens. Pass `organization_id` (from the organizations tool's list action), `keyword_id` (from the keywords tool's list action), `lens_id` (from the lenses tool's list action), and an `action`.",
};

function toolDescription(tool: string, entries: RouteEntry[]): string {
  const header =
    TOOL_HEADERS[tool] ??
    `Composable tool for the ${tool.replace(/_/g, " ")} area. Pass ` +
      "`organization_id` (from the organizations tool's list action) and an `action`.";
  const actions = entries.map((entry) => `- ${entry.action}: ${entry.description}`).join("\n");
  return `${header}\nActions:\n${actions}`;
}

function inputShape(entries: RouteEntry[]): z.ZodRawShape {
  const actions = entries.map((entry) => entry.action) as [string, ...string[]];
  const shape: z.ZodRawShape = {
    action: z.enum(actions).describe("REST operation to perform."),
  };
  const pathParams = [...new Set(entries.flatMap((entry) => entry.pathParams))];
  for (const param of pathParams) {
    // Optional at the schema level: not every action of a tool needs every
    // path parameter; per-action validation happens in the handler before any
    // REST call.
    shape[param] = z
      .string()
      .optional()
      .describe(PATH_PARAM_DESCRIPTIONS[param] ?? `Path parameter ${param}.`);
  }
  shape.params = z
      .record(z.unknown())
      .optional()
      .describe(
        "Additional parameters: query parameters for read actions, JSON body fields for mutations.",
      );
  return shape;
}

function readPathParam(input: ToolInput, param: string): string | undefined {
  const value = (input as Record<string, unknown>)[param];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function buildPath(entry: RouteEntry, input: ToolInput): string {
  let path = entry.pathTemplate;
  for (const param of entry.pathParams) {
    path = path.replaceAll(`{${param}}`, encodeURIComponent(readPathParam(input, param) ?? ""));
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
          if (readPathParam(input, param) === undefined) {
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
                  : error instanceof ExchangeError &&
                      (error.failure === "invalid_target" ||
                        error.failure === "invalid_scope" ||
                        error.failure === "invalid_request" ||
                        error.failure === "unsupported_grant_type" ||
                        error.failure === "invalid_400_response")
                    ? "Worker misconfiguration: the token endpoint rejected the exchange. Contact the operator — retrying will not help."
                    : error instanceof RestTransportError
                      ? "REST API transport failure."
                      : "Internal worker error.";
          const status =
            error instanceof ExchangeError &&
            (error.failure === "invalid_grant" || error.failure === "unauthorized")
              ? 401
              : error instanceof ExchangeError &&
                  (error.failure === "invalid_target" ||
                    error.failure === "invalid_scope" ||
                    error.failure === "invalid_request" ||
                    error.failure === "unsupported_grant_type" ||
                    error.failure === "invalid_400_response")
                ? 500
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
