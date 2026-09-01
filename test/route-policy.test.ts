import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { FIXTURE_PAYLOAD } from "./helpers";
import { ROUTE_TABLE, requiresOrganizationId } from "../src/mcp/route-table";

interface PolicyEntry {
  controller: string;
  action: string;
  decision: "allowed" | "denied";
  minimum_scope: string | null;
}

const policy = FIXTURE_PAYLOAD.route_policy as PolicyEntry[];

function findPolicy(controller: string, action: string): PolicyEntry | undefined {
  return policy.find((entry) => entry.controller === controller && entry.action === action);
}

const SCOPE_RANK: Record<string, number> = { "messijo:read": 1, "messijo:write": 2, "messijo:admin": 3 };

beforeEach(() => {
  // Sanity: the route-policy assertions only mean something against the
  // pinned fixture.
  expect(FIXTURE_PAYLOAD.route_policy).toBeDefined();
});

describe("route-table conformance against the fixture's route_policy", () => {
  it("every delegated route maps to an allowed fixture entry with sufficient scope", () => {
    expect(ROUTE_TABLE.length).toBeGreaterThan(20);
    for (const entry of ROUTE_TABLE) {
      const policyEntry = findPolicy(entry.controller, entry.policyAction);
      expect(policyEntry, `${entry.controller}#${entry.policyAction} (${entry.tool}.${entry.action})`).toBeDefined();
      expect(policyEntry!.decision, `${entry.tool}.${entry.action} must be allowed`).toBe("allowed");
      expect(
        SCOPE_RANK[entry.minScope]! >= SCOPE_RANK[policyEntry!.minimum_scope!]!,
        `${entry.tool}.${entry.action} needs at least ${policyEntry!.minimum_scope}`,
      ).toBe(true);
    }
  });

  it("covers at least one allowed route per first-release tool area", () => {
    const toolAreas = [
      "me",
      "organizations",
      "keywords",
      "keyword_events",
      "lenses",
      "lens_results",
      "stats",
    ];
    for (const tool of toolAreas) {
      const entries = ROUTE_TABLE.filter((entry) => entry.tool === tool);
      expect(entries.length, `tool ${tool} must have at least one route`).toBeGreaterThan(0);
      for (const entry of entries) {
        expect(findPolicy(entry.controller, entry.policyAction)?.decision).toBe("allowed");
      }
    }
  });

  it("exposes no superadmin surfaces (admin routes are denied and absent)", () => {
    const adminPolicies = policy.filter(
      (entry) => entry.controller.startsWith("MessijoWeb.Admin.") && entry.decision === "denied",
    );
    expect(adminPolicies.length).toBeGreaterThan(0);

    for (const denied of adminPolicies) {
      const exposed = ROUTE_TABLE.find(
        (entry) => entry.controller === denied.controller && entry.policyAction === denied.action,
      );
      expect(exposed, `denied ${denied.controller}#${denied.action} must not be exposed`).toBeUndefined();
    }
  });

  it("exposes no categorically-denied ordinary actions (keyword-event update)", () => {
    const denied = policy.filter((entry) => entry.decision === "denied");
    expect(denied.length).toBeGreaterThan(0);
    for (const entry of denied) {
      const exposed = ROUTE_TABLE.find(
        (route) => route.controller === entry.controller && route.policyAction === entry.action,
      );
      expect(exposed, `denied ${entry.controller}#${entry.action} must not be exposed`).toBeUndefined();
    }
  });

  it("does not delegate any route absent from the fixture's route_policy", () => {
    for (const entry of ROUTE_TABLE) {
      expect(findPolicy(entry.controller, entry.policyAction)).toBeDefined();
    }
  });
});

describe("first-release surface shape", () => {
  it("requires organization_id on every tool action except me and organizations.list", () => {
    expect(requiresOrganizationId("me", "me")).toBe(false);
    expect(requiresOrganizationId("organizations", "list")).toBe(false);
    expect(requiresOrganizationId("organizations", "get")).toBe(true);
    expect(requiresOrganizationId("organizations", "quotas")).toBe(true);
    for (const entry of ROUTE_TABLE) {
      if (entry.tool === "me") continue;
      if (entry.tool === "organizations" && entry.action === "list") continue;
      expect(
        requiresOrganizationId(entry.tool, entry.action),
        `${entry.tool}.${entry.action}`,
      ).toBe(true);
    }
  });

  it("marks every mutating action non-idempotent in its description", () => {
    for (const entry of ROUTE_TABLE.filter((route) => route.isMutation)) {
      expect(entry.description, `${entry.tool}.${entry.action}`).toMatch(/non-idempotent/i);
    }
    expect(ROUTE_TABLE.filter((route) => route.isMutation).length).toBeGreaterThan(5);
  });

  it("keeps the expected action sets per tool", () => {
    const actions = (tool: string) =>
      ROUTE_TABLE.filter((entry) => entry.tool === tool)
        .map((entry) => entry.action)
        .sort();
    expect(actions("organizations")).toEqual(["get", "list", "quotas"]);
    expect(actions("keywords")).toEqual(["create", "delete", "get", "list", "update"]);
    expect(actions("keyword_events")).toEqual([
      "full_events",
      "get",
      "list",
      "mark_all_read",
      "totals",
      "update_status",
    ]);
    expect(actions("lenses")).toEqual([
      "create",
      "delete",
      "get",
      "list",
      "start",
      "status",
      "stop",
      "update",
    ]);
    expect(actions("lens_results")).toEqual(["get", "list", "mark_all_read", "totals"]);
    expect(actions("stats")).toEqual(["dashboard"]);
    expect(actions("me")).toEqual(["me"]);
  });

  it("fixture error shapes are pinned (402 quota, 404 hidden, 400 invalid_scope/target)", () => {
    const errors = FIXTURE_PAYLOAD.errors as Record<string, { status: number } | undefined>;
    const statusOf = (name: string) => {
      const entry = errors[name];
      expect(entry, name).toBeDefined();
      return entry!.status;
    };
    expect(statusOf("quota_exceeded")).toBe(402);
    expect(statusOf("superadmin_rest_route")).toBe(404);
    expect(statusOf("unselected_or_unclassified_rest_route")).toBe(404);
    expect(statusOf("invalid_scope")).toBe(400);
    expect(statusOf("invalid_target")).toBe(400);
    expect(statusOf("invalid_grant")).toBe(400);
    expect(statusOf("invalid_client")).toBe(401);
  });
});
