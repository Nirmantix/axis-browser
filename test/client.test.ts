import { describe, expect, it } from "vitest";
import { AxiError } from "axi-sdk-js";
import {
  bridgeConfigsMatch,
  CdpError,
  isLikelyAxisBridgeCommand,
  mapErrorMessage,
} from "../src/client.js";

describe("CdpError", () => {
  it("uses the shared axi-sdk-js error contract", () => {
    const error = new CdpError("boom", "UNKNOWN", ["try again"]);

    expect(error).toBeInstanceOf(AxiError);
    expect(error.code).toBe("UNKNOWN");
    expect(error.suggestions).toEqual(["try again"]);
  });
});

describe("mapErrorMessage", () => {
  it("maps bridge connectivity failures", () => {
    const error = mapErrorMessage("connect ECONNREFUSED 127.0.0.1:9224");

    expect(error.code).toBe("BRIDGE_NOT_READY");
    expect(error.message).toContain("Bridge is not running");
  });

  it("uses the longer branded startup timeout in bridge start failures", () => {
    const error = mapErrorMessage("Bridge failed to start within 90s");
    expect(error.message).toContain("90s");
  });

  it("maps element lookup failures", () => {
    const error = mapErrorMessage("element uid not found");

    expect(error.code).toBe("REF_NOT_FOUND");
  });

  it("maps JSON-encoded browser errors", () => {
    const error = mapErrorMessage(JSON.stringify({ error: "Page crashed" }));

    expect(error.code).toBe("BROWSER_ERROR");
    expect(error.message).toBe("Page crashed");
  });
});

describe("bridgeConfigsMatch", () => {
  it("matches identical bridge fingerprints", () => {
    const current = {
      browserUrl: "http://127.0.0.1:9222",
      userDataDir: null,
      headed: false,
      chromeArgs: ["--flag-a"],
    };

    expect(bridgeConfigsMatch({ ...current }, current)).toBe(true);
  });

  it("rejects stale bridge configs when the browser target changes", () => {
    const current = {
      browserUrl: "http://127.0.0.1:9222",
      userDataDir: null,
      headed: false,
      chromeArgs: [],
    };

    expect(
      bridgeConfigsMatch(
        {
          browserUrl: null,
          userDataDir: null,
          headed: false,
          chromeArgs: [],
        },
        current,
      ),
    ).toBe(false);
  });

  it("rejects pid files without saved bridge config", () => {
    const current = {
      browserUrl: null,
      userDataDir: null,
      headed: false,
      chromeArgs: [],
    };

    expect(bridgeConfigsMatch(undefined, current)).toBe(false);
  });
});

describe("isLikelyAxisBridgeCommand", () => {
  it("matches built and source bridge wrapper commands", () => {
    expect(
      isLikelyAxisBridgeCommand(
        "node /Users/test/axis-browser/dist/bin/chrome-devtools-axi-bridge.js",
      ),
    ).toBe(true);
    expect(
      isLikelyAxisBridgeCommand(
        "npx tsx /Users/test/axis-browser/bin/chrome-devtools-axi-bridge.ts",
      ),
    ).toBe(true);
  });

  it("does not match unrelated listeners on the same port", () => {
    expect(
      isLikelyAxisBridgeCommand("python3 -m http.server 9224"),
    ).toBe(false);
  });
});
