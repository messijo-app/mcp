import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { app } from "./app";
import { postMcp, signMcpToken, toolCallRequest } from "./helpers";
import { doubles, installDoubles, resetDoubles } from "./doubles";
import { resetIntrospectionCache } from "../src/auth/introspection";
import { resetJwksCache } from "../src/auth/jwks";
import { ROUTE_TABLE } from "../src/mcp/route-table";

beforeAll(() => {
  installDoubles();
});

beforeEach(() => {
  resetDoubles();
  resetIntrospectionCache();
  resetJwksCache();
});

// Distinct literal identifiers so a wrong path-param mapping (e.g. substituting
// `id` for `keyword_id`) produces a mismatched URL instead of passing by luck.
const INPUTS = {
  organization_id: "org-A",
  keyword_id: "kw-B",
  lens_id: "lens-C",
  id: "res-D",
};

interface RouteExpectation {
  method: string;
  path: string;
}

/**
 * Literal `(tool, action) → method + final URL` expectations, written out
 * independently of `ROUTE_TABLE.pathTemplate`. A wrong template, method, or
 * path-param mapping fails here rather than the table asserting against itself.
 */
const CONFORMANCE: Record<string, RouteExpectation> = {
  "me.me": { method: "GET", path: "/api/users/current" },
  "organizations.list": { method: "GET", path: "/api/orgs" },
  "organizations.get": { method: "GET", path: "/api/orgs/org-A" },
  "organizations.quotas": { method: "GET", path: "/api/orgs/org-A/quotas" },
  "keywords.list": { method: "GET", path: "/api/orgs/org-A/keywords" },
  "keywords.get": { method: "GET", path: "/api/orgs/org-A/keywords/res-D" },
  "keywords.create": { method: "POST", path: "/api/orgs/org-A/keywords" },
  "keywords.update": { method: "PUT", path: "/api/orgs/org-A/keywords/res-D" },
  "keywords.delete": { method: "DELETE", path: "/api/orgs/org-A/keywords/res-D" },
  "keyword_events.list": { method: "GET", path: "/api/orgs/org-A/keywords/kw-B/events" },
  "keyword_events.get": { method: "GET", path: "/api/orgs/org-A/keywords/kw-B/events/res-D" },
  "keyword_events.totals": { method: "GET", path: "/api/orgs/org-A/keywords/kw-B/events/totals" },
  "keyword_events.full_events": { method: "GET", path: "/api/orgs/org-A/keywords/kw-B/events/full" },
  "keyword_events.mark_all_read": {
    method: "POST",
    path: "/api/orgs/org-A/keywords/kw-B/events/mark_all_as_read",
  },
  "keyword_events.update_status": {
    method: "POST",
    path: "/api/orgs/org-A/keywords/kw-B/events/res-D/status",
  },
  "lenses.list": { method: "GET", path: "/api/orgs/org-A/keywords/kw-B/lenses" },
  "lenses.get": { method: "GET", path: "/api/orgs/org-A/keywords/kw-B/lenses/res-D" },
  "lenses.create": { method: "POST", path: "/api/orgs/org-A/keywords/kw-B/lenses" },
  "lenses.update": { method: "PUT", path: "/api/orgs/org-A/keywords/kw-B/lenses/res-D" },
  "lenses.delete": { method: "DELETE", path: "/api/orgs/org-A/keywords/kw-B/lenses/res-D" },
  "lenses.start": { method: "POST", path: "/api/orgs/org-A/keywords/kw-B/lenses/res-D/start" },
  "lenses.stop": { method: "POST", path: "/api/orgs/org-A/keywords/kw-B/lenses/res-D/stop" },
  "lenses.status": { method: "GET", path: "/api/orgs/org-A/keywords/kw-B/lenses/res-D/status" },
  "lens_results.list": {
    method: "GET",
    path: "/api/orgs/org-A/keywords/kw-B/lenses/lens-C/results",
  },
  "lens_results.get": {
    method: "GET",
    path: "/api/orgs/org-A/keywords/kw-B/lenses/lens-C/results/res-D",
  },
  "lens_results.totals": {
    method: "GET",
    path: "/api/orgs/org-A/keywords/kw-B/lenses/lens-C/results/totals",
  },
  "lens_results.mark_all_read": {
    method: "POST",
    path: "/api/orgs/org-A/keywords/kw-B/lenses/lens-C/results/mark_all_as_read",
  },
  "stats.dashboard": { method: "GET", path: "/api/orgs/org-A/stats/dashboard" },
};

describe("route conformance: literal method + final URL for every route entry", () => {
  it("has a literal expectation for every route table entry", () => {
    for (const entry of ROUTE_TABLE) {
      const key = `${entry.tool}.${entry.action}`;
      expect(CONFORMANCE[key], `missing literal expectation for ${key}`).toBeDefined();
    }
  });

  it("has no literal expectations for routes absent from the route table", () => {
    const routeKeys = new Set(ROUTE_TABLE.map((entry) => `${entry.tool}.${entry.action}`));
    for (const key of Object.keys(CONFORMANCE)) {
      expect(routeKeys.has(key), `${key} has no route table entry`).toBe(true);
    }
  });

  it("delegates every action to its literal method and final URL", async () => {
    const token = await signMcpToken();
    for (const entry of ROUTE_TABLE) {
      const key = `${entry.tool}.${entry.action}`;
      const expected = CONFORMANCE[key]!;
      const args: Record<string, unknown> = { action: entry.action };
      for (const param of entry.pathParams) {
        args[param] = INPUTS[param as keyof typeof INPUTS];
      }

      doubles().seen.rest.length = 0;
      await postMcp(app, token, toolCallRequest(entry.tool, args));

      const rest = doubles().seen.rest;
      expect(rest, `${key} must make exactly one REST call`).toHaveLength(1);
      expect(rest[0]!.method, `${key} method`).toBe(expected.method);
      expect(rest[0]!.path, `${key} path`).toBe(expected.path);
    }
  });
});
