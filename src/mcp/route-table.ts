/**
 * Declarative route table mapping (tool, action) → REST operation.
 *
 * Derived from the vendored producer fixture
 * (`test/fixtures/oauth/mcp-producer-contract-v1.json`, producer revision
 * sha256:4dca13e6…) and the first-release tool table in
 * `docs/mcp-worker-implementation-handoff.md`. The `controller`/`policyAction`
 * pair identifies the fixture's route_policy entry so conformance tests can
 * cross-check every delegated route against the producer's decisions.
 */

export type RestMethod = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
export type MinScope = "messijo:read" | "messijo:write" | "messijo:admin";

export interface RouteEntry {
  tool: string;
  action: string;
  method: RestMethod;
  /** REST path with `{param}` placeholders, e.g. `/api/orgs/{organization_id}/keywords/{id}`. */
  pathTemplate: string;
  /** Input parameters substituted into the path (all required when present). */
  pathParams: string[];
  minScope: MinScope;
  isMutation: boolean;
  /** Fixture route_policy entry this route is derived from. */
  controller: string;
  policyAction: string;
  description: string;
}

export const ROUTE_TABLE: readonly RouteEntry[] = [
  {
    tool: "me",
    action: "me",
    method: "GET",
    pathTemplate: "/api/users/current",
    pathParams: [],
    minScope: "messijo:read",
    isMutation: false,
    controller: "MessijoWeb.UserController",
    policyAction: "current",
    description: "Identify the grant user behind the current authorization.",
  },
  {
    tool: "organizations",
    action: "list",
    method: "GET",
    pathTemplate: "/api/orgs",
    pathParams: [],
    minScope: "messijo:read",
    isMutation: false,
    controller: "MessijoWeb.OrgController",
    policyAction: "index",
    description:
      "List organizations selected by the active grant (live names from the REST response). Call this first to resolve organization_id values.",
  },
  {
    tool: "organizations",
    action: "get",
    method: "GET",
    pathTemplate: "/api/orgs/{organization_id}",
    pathParams: ["organization_id"],
    minScope: "messijo:read",
    isMutation: false,
    controller: "MessijoWeb.OrgController",
    policyAction: "show",
    description: "Get one selected organization. Unselected organizations return 404.",
  },
  {
    tool: "organizations",
    action: "quotas",
    method: "GET",
    pathTemplate: "/api/orgs/{organization_id}/quotas",
    pathParams: ["organization_id"],
    minScope: "messijo:read",
    isMutation: false,
    controller: "MessijoWeb.OrgController",
    policyAction: "quotas",
    description: "Get quota usage for one selected organization.",
  },
  {
    tool: "keywords",
    action: "list",
    method: "GET",
    pathTemplate: "/api/orgs/{organization_id}/keywords",
    pathParams: ["organization_id"],
    minScope: "messijo:read",
    isMutation: false,
    controller: "MessijoWeb.KeywordController",
    policyAction: "index",
    description: "List keywords for an organization.",
  },
  {
    tool: "keywords",
    action: "get",
    method: "GET",
    pathTemplate: "/api/orgs/{organization_id}/keywords/{id}",
    pathParams: ["organization_id", "id"],
    minScope: "messijo:read",
    isMutation: false,
    controller: "MessijoWeb.KeywordController",
    policyAction: "show",
    description: "Get one keyword.",
  },
  {
    tool: "keywords",
    action: "create",
    method: "POST",
    pathTemplate: "/api/orgs/{organization_id}/keywords",
    pathParams: ["organization_id"],
    minScope: "messijo:write",
    isMutation: true,
    controller: "MessijoWeb.KeywordController",
    policyAction: "create",
    description: "Create a keyword. Non-idempotent: do not automatically retry on failure.",
  },
  {
    tool: "keywords",
    action: "update",
    method: "PUT",
    pathTemplate: "/api/orgs/{organization_id}/keywords/{id}",
    pathParams: ["organization_id", "id"],
    minScope: "messijo:write",
    isMutation: true,
    controller: "MessijoWeb.KeywordController",
    policyAction: "update",
    description: "Update a keyword. Non-idempotent: do not automatically retry on failure.",
  },
  {
    tool: "keywords",
    action: "delete",
    method: "DELETE",
    pathTemplate: "/api/orgs/{organization_id}/keywords/{id}",
    pathParams: ["organization_id", "id"],
    minScope: "messijo:write",
    isMutation: true,
    controller: "MessijoWeb.KeywordController",
    policyAction: "delete",
    description: "Delete a keyword. Non-idempotent: do not automatically retry on failure.",
  },
  {
    tool: "keyword_events",
    action: "list",
    method: "GET",
    pathTemplate: "/api/orgs/{organization_id}/keywords/{keyword_id}/events",
    pathParams: ["organization_id", "keyword_id"],
    minScope: "messijo:read",
    isMutation: false,
    controller: "MessijoWeb.KeywordEventController",
    policyAction: "index",
    description:
      "List keyword events for a keyword. Query params: per_page, page, status (unread|read), platform.",
  },
  {
    tool: "keyword_events",
    action: "get",
    method: "GET",
    pathTemplate: "/api/orgs/{organization_id}/keywords/{keyword_id}/events/{id}",
    pathParams: ["organization_id", "keyword_id", "id"],
    minScope: "messijo:read",
    isMutation: false,
    controller: "MessijoWeb.KeywordEventController",
    policyAction: "show",
    description: "Get one keyword event for a keyword.",
  },
  {
    tool: "keyword_events",
    action: "totals",
    method: "GET",
    pathTemplate: "/api/orgs/{organization_id}/keywords/{keyword_id}/events/totals",
    pathParams: ["organization_id", "keyword_id"],
    minScope: "messijo:read",
    isMutation: false,
    controller: "MessijoWeb.KeywordEventController",
    policyAction: "totals",
    description: "Keyword event totals for a keyword.",
  },
  {
    tool: "keyword_events",
    action: "full_events",
    method: "GET",
    pathTemplate: "/api/orgs/{organization_id}/keywords/{keyword_id}/events/full",
    pathParams: ["organization_id", "keyword_id"],
    minScope: "messijo:read",
    isMutation: false,
    controller: "MessijoWeb.KeywordEventController",
    policyAction: "index_full_events",
    description:
      "Full keyword event payload listing for a keyword. Query params: per_page, page, status (unread|read), platform.",
  },
  {
    tool: "keyword_events",
    action: "mark_all_read",
    method: "POST",
    pathTemplate: "/api/orgs/{organization_id}/keywords/{keyword_id}/events/mark_all_as_read",
    pathParams: ["organization_id", "keyword_id"],
    minScope: "messijo:write",
    isMutation: true,
    controller: "MessijoWeb.KeywordEventController",
    policyAction: "mark_all_keyword_events_as_read",
    description:
      "Mark all keyword events for a keyword as read. Body: include_lenses (required boolean; true also marks the keyword's lens results read). Non-idempotent: do not automatically retry on failure.",
  },
  {
    tool: "keyword_events",
    action: "update_status",
    method: "POST",
    pathTemplate: "/api/orgs/{organization_id}/keywords/{keyword_id}/events/{id}/status",
    pathParams: ["organization_id", "keyword_id", "id"],
    minScope: "messijo:write",
    isMutation: true,
    controller: "MessijoWeb.KeywordEventController",
    policyAction: "update_status",
    description:
      "Update one keyword event's read status. Body: status (required; unread|read). Non-idempotent: do not automatically retry on failure.",
  },
  {
    tool: "lenses",
    action: "list",
    method: "GET",
    pathTemplate: "/api/orgs/{organization_id}/keywords/{keyword_id}/lenses",
    pathParams: ["organization_id", "keyword_id"],
    minScope: "messijo:read",
    isMutation: false,
    controller: "MessijoWeb.KeywordLensController",
    policyAction: "index",
    description: "List lenses for a keyword. Use the returned ids as lens_id for lens_results.",
  },
  {
    tool: "lenses",
    action: "get",
    method: "GET",
    pathTemplate: "/api/orgs/{organization_id}/keywords/{keyword_id}/lenses/{id}",
    pathParams: ["organization_id", "keyword_id", "id"],
    minScope: "messijo:read",
    isMutation: false,
    controller: "MessijoWeb.KeywordLensController",
    policyAction: "show",
    description: "Get one lens for a keyword.",
  },
  {
    tool: "lenses",
    action: "create",
    method: "POST",
    pathTemplate: "/api/orgs/{organization_id}/keywords/{keyword_id}/lenses",
    pathParams: ["organization_id", "keyword_id"],
    minScope: "messijo:write",
    isMutation: true,
    controller: "MessijoWeb.KeywordLensController",
    policyAction: "create",
    description: "Create a lens for a keyword. Non-idempotent: do not automatically retry on failure.",
  },
  {
    tool: "lenses",
    action: "update",
    method: "PUT",
    pathTemplate: "/api/orgs/{organization_id}/keywords/{keyword_id}/lenses/{id}",
    pathParams: ["organization_id", "keyword_id", "id"],
    minScope: "messijo:write",
    isMutation: true,
    controller: "MessijoWeb.KeywordLensController",
    policyAction: "update",
    description: "Update a lens. Non-idempotent: do not automatically retry on failure.",
  },
  {
    tool: "lenses",
    action: "delete",
    method: "DELETE",
    pathTemplate: "/api/orgs/{organization_id}/keywords/{keyword_id}/lenses/{id}",
    pathParams: ["organization_id", "keyword_id", "id"],
    minScope: "messijo:write",
    isMutation: true,
    controller: "MessijoWeb.KeywordLensController",
    policyAction: "delete",
    description: "Delete a lens. Non-idempotent: do not automatically retry on failure.",
  },
  {
    tool: "lenses",
    action: "start",
    method: "POST",
    pathTemplate: "/api/orgs/{organization_id}/keywords/{keyword_id}/lenses/{id}/start",
    pathParams: ["organization_id", "keyword_id", "id"],
    minScope: "messijo:write",
    isMutation: true,
    controller: "MessijoWeb.KeywordLensController",
    policyAction: "start",
    description: "Start a lens run. Non-idempotent: do not automatically retry on failure.",
  },
  {
    tool: "lenses",
    action: "stop",
    method: "POST",
    pathTemplate: "/api/orgs/{organization_id}/keywords/{keyword_id}/lenses/{id}/stop",
    pathParams: ["organization_id", "keyword_id", "id"],
    minScope: "messijo:write",
    isMutation: true,
    controller: "MessijoWeb.KeywordLensController",
    policyAction: "stop",
    description: "Stop a lens run. Non-idempotent: do not automatically retry on failure.",
  },
  {
    tool: "lenses",
    action: "status",
    method: "GET",
    pathTemplate: "/api/orgs/{organization_id}/keywords/{keyword_id}/lenses/{id}/status",
    pathParams: ["organization_id", "keyword_id", "id"],
    minScope: "messijo:read",
    isMutation: false,
    controller: "MessijoWeb.KeywordLensController",
    policyAction: "status",
    description: "Get lens run status.",
  },
  {
    tool: "lens_results",
    action: "list",
    method: "GET",
    pathTemplate: "/api/orgs/{organization_id}/keywords/{keyword_id}/lenses/{lens_id}/results",
    pathParams: ["organization_id", "keyword_id", "lens_id"],
    minScope: "messijo:read",
    isMutation: false,
    controller: "MessijoWeb.KeywordLensResultController",
    policyAction: "index",
    description: "List lens results for a lens. Query params: status (unread|read), platform.",
  },
  {
    tool: "lens_results",
    action: "get",
    method: "GET",
    pathTemplate: "/api/orgs/{organization_id}/keywords/{keyword_id}/lenses/{lens_id}/results/{id}",
    pathParams: ["organization_id", "keyword_id", "lens_id", "id"],
    minScope: "messijo:read",
    isMutation: false,
    controller: "MessijoWeb.KeywordLensResultController",
    policyAction: "show",
    description: "Get one lens result.",
  },
  {
    tool: "lens_results",
    action: "totals",
    method: "GET",
    pathTemplate: "/api/orgs/{organization_id}/keywords/{keyword_id}/lenses/{lens_id}/results/totals",
    pathParams: ["organization_id", "keyword_id", "lens_id"],
    minScope: "messijo:read",
    isMutation: false,
    controller: "MessijoWeb.KeywordLensResultController",
    policyAction: "totals",
    description: "Lens result totals for a lens.",
  },
  {
    tool: "lens_results",
    action: "mark_all_read",
    method: "POST",
    pathTemplate:
      "/api/orgs/{organization_id}/keywords/{keyword_id}/lenses/{lens_id}/results/mark_all_as_read",
    pathParams: ["organization_id", "keyword_id", "lens_id"],
    minScope: "messijo:write",
    isMutation: true,
    controller: "MessijoWeb.KeywordLensResultController",
    policyAction: "mark_all_keyword_lens_results_as_read",
    description: "Mark all lens results for a lens as read. Non-idempotent: do not automatically retry on failure.",
  },
  {
    tool: "stats",
    action: "dashboard",
    method: "GET",
    pathTemplate: "/api/orgs/{organization_id}/stats/dashboard",
    pathParams: ["organization_id"],
    minScope: "messijo:read",
    isMutation: false,
    controller: "MessijoWeb.StatsController",
    policyAction: "dashboard",
    description: "Organization statistics dashboard.",
  },
];

export function findRoute(tool: string, action: string): RouteEntry | undefined {
  return ROUTE_TABLE.find((entry) => entry.tool === tool && entry.action === action);
}

export function routesForTool(tool: string): RouteEntry[] {
  return ROUTE_TABLE.filter((entry) => entry.tool === tool);
}

/** Tools that always require organization_id (everything except me and organizations.list). */
export function requiresOrganizationId(tool: string, action: string): boolean {
  if (tool === "me") return false;
  if (tool === "organizations" && action === "list") return false;
  return true;
}
