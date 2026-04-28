import { describe, expect, it, beforeEach, afterEach } from "vitest";
import {
  buildTransportArgs,
  extractToolText,
  getBridgeConfigSnapshot,
  getErrorMessage,
  getTransportEnv,
  isBridgeClientConnected,
  MCP_CACHE_DIR,
  parseBridgeCallPayload,
  PRIMARY_PID_FILE,
  PRIMARY_STATE_DIR,
  resolveBridgeScript,
} from "../src/bridge.js";

describe("extractToolText", () => {
  it("joins text blocks and ignores non-text content", () => {
    const result = extractToolText([
      { type: "text", text: "first" },
      { type: "image" },
      { type: "text", text: "second" },
    ]);

    expect(result).toBe("first\nsecond");
  });
});

describe("parseBridgeCallPayload", () => {
  it("defaults missing args to an empty object", () => {
    const result = parseBridgeCallPayload('{"name":"take_snapshot"}');

    expect(result).toEqual({ name: "take_snapshot", args: {} });
  });

  it("rejects payloads without a tool name", () => {
    expect(() => parseBridgeCallPayload('{"args":{}}')).toThrow("Invalid bridge request payload");
  });

  it("normalizes malformed JSON into a validation error", () => {
    expect(() => parseBridgeCallPayload("{")).toThrow("Invalid bridge request payload");
  });
});

describe("getErrorMessage", () => {
  it("extracts the message from an Error", () => {
    expect(getErrorMessage(new Error("boom"))).toBe("boom");
  });

  it("stringifies non-Error values", () => {
    expect(getErrorMessage({ reason: "boom" })).toBe("[object Object]");
  });
});

describe("resolveBridgeScript", () => {
  it("prefers the TypeScript bridge entrypoint in the repo checkout", () => {
    expect(resolveBridgeScript(import.meta.dirname)).toMatch(/bin\/chrome-devtools-axi-bridge\.ts$/);
  });

  it("prefers the built bridge entrypoint when running from dist", () => {
    const simulatedDistDir = import.meta.dirname.replace(/\/test$/, "/dist/src");
    expect(resolveBridgeScript(simulatedDistDir)).toMatch(/bin\/chrome-devtools-axi-bridge\.js$/);
  });
});

describe("state paths", () => {
  it("uses the branded axis-browser state directory", () => {
    expect(PRIMARY_STATE_DIR).toMatch(/\.axis-browser$/);
    expect(PRIMARY_PID_FILE).toMatch(/\.axis-browser\/bridge\.pid$/);
    expect(MCP_CACHE_DIR).toMatch(/\.axis-browser\/npm-cache$/);
  });
});

describe("getTransportEnv", () => {
  it("forces a dedicated npm cache under the axis-browser state dir", () => {
    const env = getTransportEnv({ npm_config_cache: "/tmp/old-cache" });
    expect(env.npm_config_cache).toBe(MCP_CACHE_DIR);
  });
});

describe("buildTransportArgs", () => {
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    savedEnv.CHROME_DEVTOOLS_AXI_HEADED = process.env.CHROME_DEVTOOLS_AXI_HEADED;
    savedEnv.CHROME_DEVTOOLS_AXI_CHROME_ARGS = process.env.CHROME_DEVTOOLS_AXI_CHROME_ARGS;
    savedEnv.CHROME_DEVTOOLS_AXI_BROWSER_URL = process.env.CHROME_DEVTOOLS_AXI_BROWSER_URL;
    savedEnv.CHROME_DEVTOOLS_AXI_USER_DATA_DIR = process.env.CHROME_DEVTOOLS_AXI_USER_DATA_DIR;
    savedEnv.CHROME_DEVTOOLS_AXI_AUTO_CONNECT = process.env.CHROME_DEVTOOLS_AXI_AUTO_CONNECT;
    savedEnv.CHROME_DEVTOOLS_AXI_WS_HEADERS = process.env.CHROME_DEVTOOLS_AXI_WS_HEADERS;
    delete process.env.CHROME_DEVTOOLS_AXI_HEADED;
    delete process.env.CHROME_DEVTOOLS_AXI_CHROME_ARGS;
    delete process.env.CHROME_DEVTOOLS_AXI_BROWSER_URL;
    delete process.env.CHROME_DEVTOOLS_AXI_USER_DATA_DIR;
    delete process.env.CHROME_DEVTOOLS_AXI_AUTO_CONNECT;
    delete process.env.CHROME_DEVTOOLS_AXI_WS_HEADERS;
  });

  afterEach(() => {
    process.env.CHROME_DEVTOOLS_AXI_HEADED = savedEnv.CHROME_DEVTOOLS_AXI_HEADED;
    process.env.CHROME_DEVTOOLS_AXI_CHROME_ARGS = savedEnv.CHROME_DEVTOOLS_AXI_CHROME_ARGS;
    process.env.CHROME_DEVTOOLS_AXI_BROWSER_URL = savedEnv.CHROME_DEVTOOLS_AXI_BROWSER_URL;
    process.env.CHROME_DEVTOOLS_AXI_USER_DATA_DIR = savedEnv.CHROME_DEVTOOLS_AXI_USER_DATA_DIR;
    process.env.CHROME_DEVTOOLS_AXI_AUTO_CONNECT = savedEnv.CHROME_DEVTOOLS_AXI_AUTO_CONNECT;
    process.env.CHROME_DEVTOOLS_AXI_WS_HEADERS = savedEnv.CHROME_DEVTOOLS_AXI_WS_HEADERS;
  });

  it("defaults to headless and isolated", () => {
    const args = buildTransportArgs();
    expect(args).toEqual(["-y", "chrome-devtools-mcp@latest", "--isolated", "--headless"]);
  });

  it("omits --headless when CHROME_DEVTOOLS_AXI_HEADED=1", () => {
    process.env.CHROME_DEVTOOLS_AXI_HEADED = "1";
    const args = buildTransportArgs();
    expect(args).toEqual(["-y", "chrome-devtools-mcp@latest", "--isolated"]);
  });

  it("forwards chrome args via --chrome-arg=", () => {
    process.env.CHROME_DEVTOOLS_AXI_CHROME_ARGS = "--enable-gpu --ignore-gpu-blocklist";
    const args = buildTransportArgs();
    expect(args).toContain("--chrome-arg=--enable-gpu");
    expect(args).toContain("--chrome-arg=--ignore-gpu-blocklist");
  });

  it("handles tabs, newlines, and extra whitespace in chrome args", () => {
    process.env.CHROME_DEVTOOLS_AXI_CHROME_ARGS = "  --flag-a\t--flag-b\n--flag-c  ";
    const args = buildTransportArgs();
    expect(args).toContain("--chrome-arg=--flag-a");
    expect(args).toContain("--chrome-arg=--flag-b");
    expect(args).toContain("--chrome-arg=--flag-c");
    expect(args.filter((a) => a.startsWith("--chrome-arg="))).toHaveLength(3);
  });

  it("combines headed mode with chrome args", () => {
    process.env.CHROME_DEVTOOLS_AXI_HEADED = "1";
    process.env.CHROME_DEVTOOLS_AXI_CHROME_ARGS = "--enable-unsafe-webgpu";
    const args = buildTransportArgs();
    expect(args).not.toContain("--headless");
    expect(args).toContain("--chrome-arg=--enable-unsafe-webgpu");
  });

  it("uses --browserUrl when CHROME_DEVTOOLS_AXI_BROWSER_URL is set", () => {
    process.env.CHROME_DEVTOOLS_AXI_BROWSER_URL = "http://127.0.0.1:9222";
    const args = buildTransportArgs();
    expect(args).toContain("--browserUrl=http://127.0.0.1:9222");
    expect(args).not.toContain("--isolated");
    expect(args).not.toContain("--headless");
  });

  it("passes chrome args alongside --browserUrl", () => {
    process.env.CHROME_DEVTOOLS_AXI_BROWSER_URL = "http://127.0.0.1:9222";
    process.env.CHROME_DEVTOOLS_AXI_CHROME_ARGS = "--some-flag";
    const args = buildTransportArgs();
    expect(args).toContain("--browserUrl=http://127.0.0.1:9222");
    expect(args).toContain("--chrome-arg=--some-flag");
  });

  it("uses --userDataDir when CHROME_DEVTOOLS_AXI_USER_DATA_DIR is set", () => {
    process.env.CHROME_DEVTOOLS_AXI_USER_DATA_DIR = "/path/to/.chrome-profile";
    const args = buildTransportArgs();
    expect(args).toContain("--userDataDir=/path/to/.chrome-profile");
    expect(args).not.toContain("--isolated");
    expect(args).toContain("--headless");
  });

  it("respects headed mode with --userDataDir", () => {
    process.env.CHROME_DEVTOOLS_AXI_USER_DATA_DIR = "/path/to/.chrome-profile";
    process.env.CHROME_DEVTOOLS_AXI_HEADED = "1";
    const args = buildTransportArgs();
    expect(args).toContain("--userDataDir=/path/to/.chrome-profile");
    expect(args).not.toContain("--headless");
  });

  it("--browserUrl takes precedence over --userDataDir", () => {
    process.env.CHROME_DEVTOOLS_AXI_BROWSER_URL = "http://127.0.0.1:9222";
    process.env.CHROME_DEVTOOLS_AXI_USER_DATA_DIR = "/path/to/.chrome-profile";
    const args = buildTransportArgs();
    expect(args).toContain("--browserUrl=http://127.0.0.1:9222");
    expect(args).not.toContain("--userDataDir=/path/to/.chrome-profile");
  });

  it("uses --autoConnect when CHROME_DEVTOOLS_AXI_AUTO_CONNECT=1", () => {
    process.env.CHROME_DEVTOOLS_AXI_AUTO_CONNECT = "1";
    const args = buildTransportArgs();
    expect(args).toContain("--autoConnect");
    expect(args).not.toContain("--isolated");
    expect(args).not.toContain("--headless");
  });

  it("--autoConnect takes precedence over --browserUrl and --userDataDir", () => {
    process.env.CHROME_DEVTOOLS_AXI_AUTO_CONNECT = "1";
    process.env.CHROME_DEVTOOLS_AXI_BROWSER_URL = "http://127.0.0.1:9222";
    process.env.CHROME_DEVTOOLS_AXI_USER_DATA_DIR = "/path/to/.chrome-profile";
    const args = buildTransportArgs();
    expect(args).toContain("--autoConnect");
    expect(args).not.toContain("--browserUrl=http://127.0.0.1:9222");
    expect(args).not.toContain("--userDataDir=/path/to/.chrome-profile");
  });

  it("ignores AUTO_CONNECT when not set to '1'", () => {
    process.env.CHROME_DEVTOOLS_AXI_AUTO_CONNECT = "true";
    const args = buildTransportArgs();
    expect(args).not.toContain("--autoConnect");
    expect(args).toContain("--isolated");
  });

  it("routes ws:// BROWSER_URL to --wsEndpoint", () => {
    process.env.CHROME_DEVTOOLS_AXI_BROWSER_URL = "ws://127.0.0.1:9222/devtools/browser/abc123";
    const args = buildTransportArgs();
    expect(args).toContain("--wsEndpoint=ws://127.0.0.1:9222/devtools/browser/abc123");
    expect(args).not.toContain("--browserUrl=ws://127.0.0.1:9222/devtools/browser/abc123");
    expect(args).not.toContain("--isolated");
    expect(args).not.toContain("--headless");
  });

  it("routes wss:// BROWSER_URL to --wsEndpoint", () => {
    process.env.CHROME_DEVTOOLS_AXI_BROWSER_URL = "wss://our.cluster.io/launch";
    const args = buildTransportArgs();
    expect(args).toContain("--wsEndpoint=wss://our.cluster.io/launch");
    expect(args).not.toContain("--browserUrl=wss://our.cluster.io/launch");
  });

  it("passes --wsHeaders when CHROME_DEVTOOLS_AXI_WS_HEADERS is set with ws endpoint", () => {
    process.env.CHROME_DEVTOOLS_AXI_BROWSER_URL = "wss://our.cluster.io/launch";
    process.env.CHROME_DEVTOOLS_AXI_WS_HEADERS = '{"Authorization":"Bearer token"}';
    const args = buildTransportArgs();
    expect(args).toContain("--wsEndpoint=wss://our.cluster.io/launch");
    expect(args).toContain('--wsHeaders={"Authorization":"Bearer token"}');
  });

  it("rejects malformed ws headers before launching the transport", () => {
    process.env.CHROME_DEVTOOLS_AXI_BROWSER_URL = "wss://our.cluster.io/launch";
    process.env.CHROME_DEVTOOLS_AXI_WS_HEADERS = "{";

    expect(() => buildTransportArgs()).toThrow("CHROME_DEVTOOLS_AXI_WS_HEADERS must be valid JSON");
  });

  it("rejects ws headers JSON that is not an object", () => {
    process.env.CHROME_DEVTOOLS_AXI_BROWSER_URL = "wss://our.cluster.io/launch";
    process.env.CHROME_DEVTOOLS_AXI_WS_HEADERS = '["Authorization: Bearer token"]';

    expect(() => buildTransportArgs()).toThrow("CHROME_DEVTOOLS_AXI_WS_HEADERS must be a JSON object");
  });

  it("ignores --wsHeaders without a ws endpoint", () => {
    process.env.CHROME_DEVTOOLS_AXI_BROWSER_URL = "http://127.0.0.1:9222";
    process.env.CHROME_DEVTOOLS_AXI_WS_HEADERS = '{"Authorization":"Bearer token"}';
    const args = buildTransportArgs();
    expect(args).toContain("--browserUrl=http://127.0.0.1:9222");
    expect(args.some((a) => a.startsWith("--wsHeaders="))).toBe(false);
  });
});

describe("getBridgeConfigSnapshot", () => {
  it("normalizes the current bridge configuration from env", () => {
    const config = getBridgeConfigSnapshot({
      CHROME_DEVTOOLS_AXI_BROWSER_URL: "http://127.0.0.1:9222",
      CHROME_DEVTOOLS_AXI_USER_DATA_DIR: "/tmp/profile",
      CHROME_DEVTOOLS_AXI_HEADED: "1",
      CHROME_DEVTOOLS_AXI_CHROME_ARGS: "  --flag-a\t--flag-b\n--flag-c  ",
    });

    expect(config).toEqual({
      autoConnect: false,
      browserUrl: "http://127.0.0.1:9222",
      userDataDir: null,
      headed: false,
      chromeArgs: ["--flag-a", "--flag-b", "--flag-c"],
      wsHeaders: null,
    });
  });

  it("normalizes websocket headers only for websocket browser endpoints", () => {
    const config = getBridgeConfigSnapshot({
      CHROME_DEVTOOLS_AXI_BROWSER_URL: "wss://cluster.example/launch",
      CHROME_DEVTOOLS_AXI_WS_HEADERS: '{"Authorization":"Bearer token"}',
      CHROME_DEVTOOLS_AXI_HEADED: "1",
    });

    expect(config).toEqual({
      autoConnect: false,
      browserUrl: "wss://cluster.example/launch",
      userDataDir: null,
      headed: false,
      chromeArgs: [],
      wsHeaders: '{"Authorization":"Bearer token"}',
    });
  });

  it("normalizes auto-connect as the effective connection mode", () => {
    const config = getBridgeConfigSnapshot({
      CHROME_DEVTOOLS_AXI_AUTO_CONNECT: "1",
      CHROME_DEVTOOLS_AXI_BROWSER_URL: "http://127.0.0.1:9222",
      CHROME_DEVTOOLS_AXI_USER_DATA_DIR: "/tmp/profile",
      CHROME_DEVTOOLS_AXI_HEADED: "1",
    });

    expect(config).toEqual({
      autoConnect: true,
      browserUrl: null,
      userDataDir: null,
      headed: false,
      chromeArgs: [],
      wsHeaders: null,
    });
  });

  it("defaults optional bridge config to null / false / empty list", () => {
    const config = getBridgeConfigSnapshot({});

    expect(config).toEqual({
      autoConnect: false,
      browserUrl: null,
      userDataDir: null,
      headed: false,
      chromeArgs: [],
      wsHeaders: null,
    });
  });
});

describe("bridge health", () => {
  it("reports disconnected clients as unhealthy", async () => {
    const healthy = await isBridgeClientConnected({
      listTools: async () => {
        throw new Error("Not connected");
      },
      callTool: async () => ({}),
      close: async () => {},
    });

    expect(healthy).toBe(false);
  });

  it("reports connected clients as healthy", async () => {
    const healthy = await isBridgeClientConnected({
      listTools: async () => ({ tools: [] }),
      callTool: async () => ({}),
      close: async () => {},
    });

    expect(healthy).toBe(true);
  });
});
