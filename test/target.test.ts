import { describe, expect, it } from "vitest";
import {
  describeProbeFailure,
  portOf,
  probeCdpEndpoint,
  type PortHolder,
} from "../src/target.js";

const holder: PortHolder = { pid: 4242, command: "Ulaa" };
const withHolder = { describeHolder: () => holder };
const noHolder = { describeHolder: () => null };

const jsonResponse = (body: unknown, status = 200) =>
  ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  }) as unknown as Response;

const okVersion = {
  Browser: "Chrome/141.0.7390.55",
  webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/browser/abc",
};

describe("portOf", () => {
  it("reads an explicit port", () => {
    expect(portOf("http://127.0.0.1:9222")).toBe(9222);
  });
  it("defaults by scheme", () => {
    expect(portOf("http://example.test")).toBe(80);
    expect(portOf("https://example.test")).toBe(443);
  });
  it("returns null for junk", () => {
    expect(portOf("not a url")).toBeNull();
  });
});

describe("probeCdpEndpoint — a 200 is not proof", () => {
  it("accepts a real DevTools endpoint", async () => {
    const result = await probeCdpEndpoint("http://127.0.0.1:9222", 1000, {
      fetchFn: async () => jsonResponse(okVersion),
      ...noHolder,
    });
    expect(result).toEqual({
      ok: true,
      browser: "Chrome/141.0.7390.55",
      wsUrl: okVersion.webSocketDebuggerUrl,
    });
  });

  it("tolerates a trailing slash on the base URL", async () => {
    let requested = "";
    await probeCdpEndpoint("http://127.0.0.1:9222/", 1000, {
      fetchFn: async (input) => {
        requested = String(input);
        return jsonResponse(okVersion);
      },
      ...noHolder,
    });
    expect(requested).toBe("http://127.0.0.1:9222/json/version");
  });

  it("rejects a 404 — the exact shape the squatter on 9222 returned", async () => {
    const result = await probeCdpEndpoint("http://127.0.0.1:9222", 1000, {
      fetchFn: async () => jsonResponse({}, 404),
      ...withHolder,
    });
    expect(result).toMatchObject({
      ok: false,
      reason: "NOT_CDP",
      detail: "HTTP 404",
      holder,
    });
  });

  it("rejects a 200 that is not JSON", async () => {
    const result = await probeCdpEndpoint("http://127.0.0.1:9222", 1000, {
      fetchFn: async () =>
        ({
          ok: true,
          status: 200,
          json: async () => {
            throw new Error("invalid json");
          },
        }) as unknown as Response,
      ...noHolder,
    });
    expect(result).toMatchObject({ ok: false, reason: "NOT_CDP" });
  });

  it("rejects a 200 of unrelated JSON — a squatter answering 200 is worse than one answering 404", async () => {
    const result = await probeCdpEndpoint("http://127.0.0.1:9222", 1000, {
      fetchFn: async () => jsonResponse({ hello: "world" }),
      ...noHolder,
    });
    expect(result).toMatchObject({
      ok: false,
      reason: "NOT_CDP",
      detail: "no webSocketDebuggerUrl in /json/version",
    });
  });

  it("rejects a browser it cannot drive", async () => {
    const result = await probeCdpEndpoint("http://127.0.0.1:9222", 1000, {
      fetchFn: async () =>
        jsonResponse({ ...okVersion, Browser: "Firefox/130.0" }),
      ...noHolder,
    });
    expect(result).toMatchObject({
      ok: false,
      reason: "WRONG_BROWSER",
      detail: "Browser=Firefox/130.0",
    });
  });

  it("accepts headless Chrome", async () => {
    const result = await probeCdpEndpoint("http://127.0.0.1:9222", 1000, {
      fetchFn: async () =>
        jsonResponse({ ...okVersion, Browser: "HeadlessChrome/141.0.0.0" }),
      ...noHolder,
    });
    expect(result.ok).toBe(true);
  });

  it("reports NO_LISTENER when the connection is refused", async () => {
    const result = await probeCdpEndpoint("http://127.0.0.1:9222", 1000, {
      fetchFn: async () => {
        throw new Error("connect ECONNREFUSED 127.0.0.1:9222");
      },
      ...noHolder,
    });
    expect(result).toMatchObject({ ok: false, reason: "NO_LISTENER" });
  });

  it("reports TIMEOUT when the request is aborted", async () => {
    const result = await probeCdpEndpoint("http://127.0.0.1:9222", 10, {
      fetchFn: (_input, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            const error = new Error("aborted");
            error.name = "AbortError";
            reject(error);
          });
        }),
      ...noHolder,
    });
    expect(result).toMatchObject({ ok: false, reason: "TIMEOUT" });
  });

  it("times out when a squatter sends headers then stalls mid-body", async () => {
    // The deadline must cover the BODY, not just the headers. Clearing the abort timer
    // as soon as fetch() resolved left response.json() uncovered, so a port squatter
    // that answered headers and then stalled hung doctor indefinitely.
    const result = await probeCdpEndpoint("http://127.0.0.1:9222", 20, {
      fetchFn: async (_input, init) =>
        ({
          ok: true,
          status: 200,
          json: () =>
            new Promise((_resolve, reject) => {
              init?.signal?.addEventListener("abort", () => {
                const error = new Error("aborted");
                error.name = "AbortError";
                reject(error);
              });
            }),
        }) as unknown as Response,
      ...noHolder,
    });
    expect(result).toMatchObject({
      ok: false,
      reason: "TIMEOUT",
      detail: "stalled before the body arrived",
    });
  });

  it("names the port holder on failure — 'nothing is listening' and 'Ulaa is listening' need opposite fixes", async () => {
    const result = await probeCdpEndpoint("http://127.0.0.1:9222", 1000, {
      fetchFn: async () => {
        throw new Error("ECONNREFUSED");
      },
      ...withHolder,
    });
    expect(result).toMatchObject({ holder });
  });
});

describe("describeProbeFailure", () => {
  it("always states that local CDP has no authentication", () => {
    // This is the line that kills the hallucination at its source: an agent that
    // read a bare connection failure concluded the port needed credentials.
    for (const reason of [
      "NO_LISTENER",
      "NOT_CDP",
      "WRONG_BROWSER",
      "TIMEOUT",
    ] as const) {
      const lines = describeProbeFailure("http://127.0.0.1:9222", {
        ok: false,
        reason,
      });
      expect(lines.join("\n")).toContain(
        "Local CDP has no authentication. Do not request credentials, tokens, or a ws:// URL.",
      );
    }
  });

  it("names the holder when one is known", () => {
    const lines = describeProbeFailure("http://127.0.0.1:9222", {
      ok: false,
      reason: "NOT_CDP",
      holder,
    }).join("\n");
    expect(lines).toContain("Ulaa");
    expect(lines).toContain("4242");
  });

  it("offers the let-axis-own-a-browser escape hatch when nothing is listening", () => {
    const lines = describeProbeFailure("http://127.0.0.1:9222", {
      ok: false,
      reason: "NO_LISTENER",
    }).join("\n");
    expect(lines).toContain("CHROME_DEVTOOLS_AXI_BROWSER_URL");
  });
});
