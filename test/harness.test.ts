import { beforeAll, describe, expect, it } from "vitest";
import { fetchMock } from "cloudflare:test";

beforeAll(() => {
  fetchMock.activate();
});

describe("vitest workers harness", () => {
  it("runs tests inside the Workers runtime (workerd)", () => {
    expect(typeof caches).toBe("object");
    expect(typeof Request).toBe("function");
  });

  it("intercepts outbound fetch via fetchMock", async () => {
    fetchMock
      .get("https://harness.test")
      .intercept({ path: "/ping", method: "GET" })
      .reply(200, "body");
    const response = await fetch("https://harness.test/ping");
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("body");
  });
});
