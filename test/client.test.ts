import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { AxiError } from "axi-sdk-js";
import {
  BRIDGE_PORT_IN_USE_EXIT_CODE,
  createBridgeServer,
  PAGE_IDENTITY_CHANGED_ERROR,
  setBridgeTokenForTest,
  type BridgeClient,
} from "../src/bridge.js";
import { setSelectedPageId } from "../src/selected-page.js";
import {
  buildBridgeEarlyExitError,
  callTool,
  CdpError,
  checkBridgeHealth,
  collectRootDirs,
  ensureBridge,
  getSessionSnapshotIfRunning,
  mapErrorMessage,
  readBridgeEndpoint,
  resolveBridgeTimeoutMs,
  type SpawnedBridge,
  stopBridge,
  terminateBridgeProcess,
  waitForProcessExit,
} from "../src/client.js";
import {
  BRIDGE_TOKEN_HEADER,
  DEFAULT_SESSION_NAME,
  resolveSessionPidFile,
} from "../src/sessions.js";
import * as processIdentity from "../src/process-identity.js";
import {
  BRIDGE_COMMAND_MARKER,
  readProcessIdentity,
} from "../src/process-identity.js";

/**
 * Spawn a long-lived node process whose command line carries the bridge
 * marker, so `readProcessIdentity` accepts it as a stand-in bridge. The marker
 * is appended as an unused argv entry because `-e` scripts would otherwise
 * look like a bare `node -e …` to `ps`.
 */
function spawnMarkedBridge(script: string, detached = false): ChildProcess {
  const child = spawn(process.execPath, ["-e", script, BRIDGE_COMMAND_MARKER], {
    stdio: "ignore",
    detached,
  });
  child.unref();
  return child;
}

/**
 * The recorded start time a bridge record would carry for `pid`, read through
 * the same probe production uses. Retried briefly: the process table entry
 * exists at fork, but `ps` may need a tick before `command=` shows the `-e`
 * argv (and therefore the marker).
 */
function startedAtOf(pid: number): string {
  for (let attempt = 0; attempt < 10; attempt++) {
    const identity = readProcessIdentity(pid);
    if (identity && identity.command.includes(BRIDGE_COMMAND_MARKER)) {
      return identity.startedAt;
    }
    // ~10ms busy wait; a sleep(0) via timers is not reliably short enough here.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  }
  const last = readProcessIdentity(pid);
  throw new Error(
    `test fixture: pid ${pid} is not a marked bridge (command: ${last?.command ?? "<unreadable>"})`,
  );
}

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

  it("maps element lookup failures", () => {
    const error = mapErrorMessage("element uid not found");

    expect(error.code).toBe("REF_NOT_FOUND");
  });

  it("maps JSON-encoded browser errors", () => {
    const error = mapErrorMessage(JSON.stringify({ error: "Page crashed" }));

    expect(error.code).toBe("BROWSER_ERROR");
    expect(error.message).toBe("Page crashed");
  });

  it("translates missing MCP page identities without leaking dependency text", () => {
    const error = mapErrorMessage("Error: No page found");

    expect(error.code).toBe("BROWSER_ERROR");
    expect(error.message).toBe("The selected page is no longer available");
    expect(error.suggestions).toContain(
      "Run `axis-browser pages` to list the remaining tabs",
    );
  });

  it("does not translate a body that merely mentions the missing-page phrase", () => {
    const error = mapErrorMessage(
      'Error: Evaluation failed: Error: No page found for slug "x"',
    );

    expect(error.message).toContain("Evaluation failed");
    expect(error.message).not.toBe("The selected page is no longer available");
  });
});

describe("unsafe session names are rejected on action entry points", () => {
  const saved = process.env.CHROME_DEVTOOLS_AXI_SESSION;

  afterEach(() => {
    if (saved === undefined) {
      delete process.env.CHROME_DEVTOOLS_AXI_SESSION;
    } else {
      process.env.CHROME_DEVTOOLS_AXI_SESSION = saved;
    }
  });

  it("stopBridge rejects a dot-only session instead of killing the default bridge", async () => {
    process.env.CHROME_DEVTOOLS_AXI_SESSION = "..";
    await expect(stopBridge()).rejects.toThrow(/Invalid/);
  });

  it("ensureBridge rejects a dot-only session instead of targeting the default bridge", async () => {
    process.env.CHROME_DEVTOOLS_AXI_SESSION = "..";
    await expect(ensureBridge()).rejects.toThrow(/Invalid/);
  });

  it("getSessionSnapshotIfRunning degrades an invalid session to null instead of throwing", async () => {
    process.env.CHROME_DEVTOOLS_AXI_SESSION = "..";
    await expect(getSessionSnapshotIfRunning()).resolves.toBeNull();
  });
});

describe("resolveBridgeTimeoutMs", () => {
  let savedTimeout: string | undefined;

  beforeEach(() => {
    savedTimeout = process.env.CHROME_DEVTOOLS_AXI_BRIDGE_TIMEOUT_MS;
    delete process.env.CHROME_DEVTOOLS_AXI_BRIDGE_TIMEOUT_MS;
  });

  afterEach(() => {
    if (savedTimeout === undefined) {
      delete process.env.CHROME_DEVTOOLS_AXI_BRIDGE_TIMEOUT_MS;
    } else {
      process.env.CHROME_DEVTOOLS_AXI_BRIDGE_TIMEOUT_MS = savedTimeout;
    }
  });

  it("defaults to 30s when env var is unset", () => {
    expect(resolveBridgeTimeoutMs()).toBe(30_000);
  });

  it("honors a numeric env value", () => {
    process.env.CHROME_DEVTOOLS_AXI_BRIDGE_TIMEOUT_MS = "60000";
    expect(resolveBridgeTimeoutMs()).toBe(60_000);
  });

  it("clamps tiny values to a 1s floor (avoids pathological retries)", () => {
    process.env.CHROME_DEVTOOLS_AXI_BRIDGE_TIMEOUT_MS = "10";
    expect(resolveBridgeTimeoutMs()).toBe(1_000);
  });

  it("falls back to default when value is non-numeric", () => {
    process.env.CHROME_DEVTOOLS_AXI_BRIDGE_TIMEOUT_MS = "soon";
    expect(resolveBridgeTimeoutMs()).toBe(30_000);
  });

  it("falls back to default when value is zero or negative", () => {
    process.env.CHROME_DEVTOOLS_AXI_BRIDGE_TIMEOUT_MS = "0";
    expect(resolveBridgeTimeoutMs()).toBe(30_000);
    process.env.CHROME_DEVTOOLS_AXI_BRIDGE_TIMEOUT_MS = "-100";
    expect(resolveBridgeTimeoutMs()).toBe(30_000);
  });
});

interface FakeBridgeOptions {
  shallow: "ok" | "error";
  deep: "ok" | "error";
  deepDelayMs?: number;
  session?: string;
  /**
   * Whether healthy answers carry `auth: "capability-v1"`. Real bridges only
   * emit the marker after validating the request token; `auth: false` stands
   * in for a pre-auth bridge or an unrelated server that ignores the header.
   */
  auth?: boolean;
  /** When set, every request must present this token or gets a 401. */
  requireToken?: string;
}

function startFakeBridgeServer(opts: FakeBridgeOptions): Promise<{
  port: number;
  server: Server;
  /** `x-axis-bridge-token` header seen on each request, in order. */
  tokens: (string | undefined)[];
  close: () => Promise<void>;
}> {
  const tokens: (string | undefined)[] = [];
  return new Promise((resolveStart, rejectStart) => {
    const server = createServer((req, res) => {
      const presented = req.headers[BRIDGE_TOKEN_HEADER];
      tokens.push(typeof presented === "string" ? presented : undefined);
      if (opts.requireToken && presented !== opts.requireToken) {
        res.statusCode = 401;
        res.end(JSON.stringify({ error: "unauthorized" }));
        return;
      }
      if (req.method === "GET" && req.url?.startsWith("/health")) {
        const wantsDeep = req.url.includes("deep=1");
        const outcome = wantsDeep ? opts.deep : opts.shallow;
        res.setHeader("Content-Type", "application/json");
        const sendResponse = () => {
          if (outcome === "ok") {
            res.statusCode = 200;
            res.end(
              JSON.stringify({
                status: "ok",
                session: opts.session,
                ...(opts.auth === false ? {} : { auth: "capability-v1" }),
              }),
            );
          } else {
            res.statusCode = 503;
            res.end(JSON.stringify({ status: "error" }));
          }
        };
        if (wantsDeep && opts.deepDelayMs) {
          setTimeout(sendResponse, opts.deepDelayMs);
        } else {
          sendResponse();
        }
        return;
      }
      res.statusCode = 404;
      res.end();
    });
    server.on("error", rejectStart);
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      resolveStart({
        port,
        server,
        tokens,
        close: () =>
          new Promise<void>((closeResolve) => {
            server.close(() => closeResolve());
          }),
      });
    });
  });
}

describe("checkBridgeHealth (deep probe)", () => {
  it("returns true on a shallow probe when /health responds 200 ok", async () => {
    const fake = await startFakeBridgeServer({ shallow: "ok", deep: "error" });
    try {
      expect(await checkBridgeHealth(fake.port)).toBe(true);
    } finally {
      await fake.close();
    }
  });

  it("returns false on the deep probe when the bridge reports CDP target unreachable", async () => {
    // This is the exact stale-bridge scenario from issue #43: the local MCP
    // server still answers /health, but the attached browser is gone, so the
    // deep probe correctly reports unhealthy.
    const fake = await startFakeBridgeServer({ shallow: "ok", deep: "error" });
    try {
      expect(await checkBridgeHealth(fake.port)).toBe(true);
      expect(await checkBridgeHealth(fake.port, { deep: true })).toBe(false);
    } finally {
      await fake.close();
    }
  });

  it("returns true on the deep probe when the bridge reports both layers healthy", async () => {
    const fake = await startFakeBridgeServer({ shallow: "ok", deep: "ok" });
    try {
      expect(await checkBridgeHealth(fake.port, { deep: true })).toBe(true);
    } finally {
      await fake.close();
    }
  });

  it("allows a slower deep probe to complete successfully", async () => {
    const fake = await startFakeBridgeServer({
      shallow: "ok",
      deep: "ok",
      deepDelayMs: 2200,
    });
    try {
      expect(await checkBridgeHealth(fake.port, { deep: true })).toBe(true);
    } finally {
      await fake.close();
    }
  }, 10_000);

  it("returns false when nothing is listening on the port", async () => {
    // Port 1 is privileged and unbound — connection should be refused immediately.
    expect(await checkBridgeHealth(1)).toBe(false);
    expect(await checkBridgeHealth(1, { deep: true })).toBe(false);
  });

  it("treats a session-name mismatch as unhealthy (another session's bridge)", async () => {
    const fake = await startFakeBridgeServer({
      shallow: "ok",
      deep: "ok",
      session: "worker-1",
    });
    try {
      expect(
        await checkBridgeHealth(fake.port, { expectedSession: "worker-2" }),
      ).toBe(false);
      expect(
        await checkBridgeHealth(fake.port, {
          deep: true,
          expectedSession: "worker-2",
        }),
      ).toBe(false);
      expect(
        await checkBridgeHealth(fake.port, { expectedSession: "worker-1" }),
      ).toBe(true);
    } finally {
      await fake.close();
    }
  });

  it("accepts a bridge that omits the session field (older version)", async () => {
    // Pre-session-field, not pre-auth: a bridge old enough to lack `session`
    // can still carry the capability marker, which is what adoption keys on.
    const fake = await startFakeBridgeServer({
      shallow: "ok",
      deep: "ok",
    });
    try {
      expect(
        await checkBridgeHealth(fake.port, { expectedSession: "worker-1" }),
      ).toBe(true);
    } finally {
      await fake.close();
    }
  });

  it("rejects a healthy response that lacks the capability marker", async () => {
    // A 200 `{status:"ok"}` alone proves nothing: an unrelated local server or
    // a pre-token bridge answers exactly that while ignoring the token header.
    const fake = await startFakeBridgeServer({
      shallow: "ok",
      deep: "ok",
      auth: false,
    });
    try {
      expect(await checkBridgeHealth(fake.port)).toBe(false);
      expect(await checkBridgeHealth(fake.port, { deep: true })).toBe(false);
    } finally {
      await fake.close();
    }
  });

  it("sends the capability token and requires the bridge to honour it", async () => {
    const token = "test-capability-token";
    const fake = await startFakeBridgeServer({
      shallow: "ok",
      deep: "ok",
      requireToken: token,
    });
    try {
      // No token, and the wrong token, both fail closed — exactly as a real
      // bridge treats them, since the record's token is the only credential.
      expect(await checkBridgeHealth(fake.port)).toBe(false);
      expect(await checkBridgeHealth(fake.port, { token: "wrong-token" })).toBe(
        false,
      );
      expect(await checkBridgeHealth(fake.port, { token })).toBe(true);
      expect(await checkBridgeHealth(fake.port, { deep: true, token })).toBe(
        true,
      );
      expect(fake.tokens).toEqual([undefined, "wrong-token", token, token]);
    } finally {
      await fake.close();
    }
  });
});

describe("buildBridgeEarlyExitError", () => {
  const savedMcpPath = process.env.CHROME_DEVTOOLS_AXI_MCP_PATH;
  const savedMcpServerUrl = process.env.CHROME_DEVTOOLS_AXI_MCP_SERVER_URL;

  afterEach(() => {
    const restore = (key: string, value: string | undefined) => {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    };
    restore("CHROME_DEVTOOLS_AXI_MCP_PATH", savedMcpPath);
    restore("CHROME_DEVTOOLS_AXI_MCP_SERVER_URL", savedMcpServerUrl);
  });

  it("names the session, port, exit code, and the port-in-use remedy on the EADDRINUSE code", () => {
    const err = buildBridgeEarlyExitError(
      "worker-2",
      9231,
      BRIDGE_PORT_IN_USE_EXIT_CODE,
      null,
    );

    expect(err).toBeInstanceOf(CdpError);
    expect(err.code).toBe("BRIDGE_NOT_READY");
    expect(err.message).toContain("worker-2");
    expect(err.message).toContain("9231");
    expect(err.message).toContain(
      `exited with code ${BRIDGE_PORT_IN_USE_EXIT_CODE}`,
    );
    const suggestions = err.suggestions.join("\n");
    expect(suggestions).toContain("9231");
    expect(suggestions).toContain("CHROME_DEVTOOLS_AXI_PORT");
    // Balanced wording: not over-attributed to a session collision - also
    // names stale/crashed bridges and unrelated processes, with the
    // free-the-port remedy stated directly.
    expect(suggestions).toContain("unrelated process");
    expect(suggestions).toMatch(/stale|crashed/);
    expect(suggestions).toContain("free");
  });

  it("gives generic startup guidance (not port collision) for a non-EADDRINUSE early exit", () => {
    delete process.env.CHROME_DEVTOOLS_AXI_MCP_PATH;
    // Mode is stated explicitly: the guidance below is launch-mode guidance, and
    // leaving it to be inferred would make this test depend on whatever
    // CHROME_DEVTOOLS_AXI_* the ambient shell happens to export.
    const err = buildBridgeEarlyExitError(
      "worker-2",
      9231,
      1,
      null,
      "ephemeral",
    );

    expect(err.code).toBe("BRIDGE_NOT_READY");
    expect(err.message).toContain("exited with code 1");
    const suggestions = err.suggestions.join("\n");
    expect(suggestions).toContain("chrome-devtools-mcp");
    expect(suggestions).not.toContain("hashed-port collision");
    expect(suggestions).not.toContain("another session's bridge");
  });
  it("gives direct endpoint guidance for a shared MCP startup failure", () => {
    process.env.CHROME_DEVTOOLS_AXI_MCP_SERVER_URL =
      "http://127.0.0.1:9333/mcp";
    delete process.env.CHROME_DEVTOOLS_AXI_MCP_PATH;

    const err = buildBridgeEarlyExitError("worker-2", 9231, 1, null);

    const suggestions = err.suggestions.join("\n");
    expect(suggestions).toContain("CHROME_DEVTOOLS_AXI_MCP_SERVER_URL");
    expect(suggestions).toContain("absolute http(s)");
    expect(suggestions).toContain("reachable");
    expect(suggestions).not.toContain("CHROME_DEVTOOLS_AXI_MCP_PATH");
    expect(suggestions).not.toContain("--serverUrl");
    expect(suggestions).not.toContain("chrome-devtools-mcp@latest");
  });

  it("gives proxy prerequisites for a shared MCP startup failure", () => {
    process.env.CHROME_DEVTOOLS_AXI_MCP_SERVER_URL =
      "http://127.0.0.1:9333/mcp";
    process.env.CHROME_DEVTOOLS_AXI_MCP_PATH = "/opt/mcp.js";

    const err = buildBridgeEarlyExitError("worker-2", 9231, 1, null);

    const suggestions = err.suggestions.join("\n");
    expect(suggestions).toContain("CHROME_DEVTOOLS_AXI_MCP_SERVER_URL");
    expect(suggestions).toContain("CHROME_DEVTOOLS_AXI_MCP_PATH");
    expect(suggestions).toContain("--serverUrl");
    expect(suggestions).not.toContain("absolute http(s)");
    expect(suggestions).not.toContain("Chrome failed to launch");
    expect(suggestions).not.toContain("chrome-devtools-mcp@latest");
  });

  it("points at CHROME_DEVTOOLS_AXI_MCP_PATH when an explicit path is set", () => {
    process.env.CHROME_DEVTOOLS_AXI_MCP_PATH = "/opt/mcp.js";
    const err = buildBridgeEarlyExitError(
      "worker-2",
      9231,
      1,
      null,
      "ephemeral",
    );

    const suggestions = err.suggestions.join("\n");
    expect(suggestions).toContain("CHROME_DEVTOOLS_AXI_MCP_PATH");
    expect(suggestions).not.toContain("npm prefix -g");
  });

  it("reports the terminating signal when the bridge was killed", () => {
    const err = buildBridgeEarlyExitError("worker-2", 9231, null, "SIGKILL");

    expect(err.message).toContain("was killed by SIGKILL");
  });
});

describe("ensureBridge early-exit fast-fail", () => {
  const savedSession = process.env.CHROME_DEVTOOLS_AXI_SESSION;
  const savedHome = process.env.HOME;
  const savedTimeout = process.env.CHROME_DEVTOOLS_AXI_BRIDGE_TIMEOUT_MS;
  const savedPort = process.env.CHROME_DEVTOOLS_AXI_PORT;
  const savedMode = process.env.CHROME_DEVTOOLS_AXI_MODE;
  let tmpHome: string;

  const restore = (key: string, value: string | undefined) => {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  };

  beforeEach(() => {
    // Isolate state under a throwaway HOME so no real bridge.pid is found and
    // ensureBridge is forced down the spawn-a-new-bridge path.
    tmpHome = mkdtempSync(join(tmpdir(), "axi-ensure-bridge-"));
    process.env.HOME = tmpHome;
    process.env.CHROME_DEVTOOLS_AXI_SESSION = "early-exit-worker";
    delete process.env.CHROME_DEVTOOLS_AXI_PORT;
    // Pin the mode: the guidance asserted below is launch-mode guidance, and an
    // ambient CHROME_DEVTOOLS_AXI_BROWSER_URL in the developer's shell would
    // otherwise put these through the attach-mode branch instead.
    process.env.CHROME_DEVTOOLS_AXI_MODE = "ephemeral";
    // A long deadline so the assertion proves the *early-exit* path returns
    // fast, not that it merely hit the timeout.
    process.env.CHROME_DEVTOOLS_AXI_BRIDGE_TIMEOUT_MS = "20000";
  });

  afterEach(() => {
    restore("CHROME_DEVTOOLS_AXI_SESSION", savedSession);
    restore("HOME", savedHome);
    restore("CHROME_DEVTOOLS_AXI_BRIDGE_TIMEOUT_MS", savedTimeout);
    restore("CHROME_DEVTOOLS_AXI_PORT", savedPort);
    restore("CHROME_DEVTOOLS_AXI_MODE", savedMode);
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it("fails fast with a port-collision error when the bridge exits with the EADDRINUSE code", async () => {
    const start = Date.now();
    let caught: unknown;
    try {
      await ensureBridge(() => {
        const fake = new EventEmitter();
        // Emit *after* ensureBridge attaches its exit listener.
        setImmediate(() =>
          fake.emit("exit", BRIDGE_PORT_IN_USE_EXIT_CODE, null),
        );
        return fake as unknown as SpawnedBridge;
      });
    } catch (error) {
      caught = error;
    }
    const elapsed = Date.now() - start;

    expect(caught).toBeInstanceOf(CdpError);
    expect((caught as CdpError).code).toBe("BRIDGE_NOT_READY");
    expect((caught as CdpError).message).toContain("before becoming ready");
    expect((caught as CdpError).suggestions.join("\n")).toContain(
      "CHROME_DEVTOOLS_AXI_PORT",
    );
    // The whole point: detecting the early exit must beat the 20s deadline.
    expect(elapsed).toBeLessThan(5000);
  });

  it("fails fast with generic startup guidance for a non-EADDRINUSE early exit", async () => {
    const start = Date.now();
    let caught: unknown;
    try {
      await ensureBridge(() => {
        const fake = new EventEmitter();
        setImmediate(() => fake.emit("exit", 1, null));
        return fake as unknown as SpawnedBridge;
      });
    } catch (error) {
      caught = error;
    }
    const elapsed = Date.now() - start;

    expect(caught).toBeInstanceOf(CdpError);
    const suggestions = (caught as CdpError).suggestions.join("\n");
    expect(suggestions).toContain("chrome-devtools-mcp");
    expect(suggestions).not.toContain("hashed-port collision");
    expect(elapsed).toBeLessThan(5000);
  });

  it("reuses a healthy same-session bridge that won the bind race instead of failing on the loser's early exit", async () => {
    // A concurrent same-session bridge owns the port and reports healthy only on
    // the *second* deep probe, so the loser's first in-loop check fails and the
    // pre-throw final deep check is what catches the winner.
    let deepProbes = 0;
    const winner = createServer((req, res) => {
      if (req.method === "GET" && req.url?.startsWith("/health")) {
        const wantsDeep = req.url.includes("deep=1");
        if (wantsDeep) deepProbes++;
        res.setHeader("Content-Type", "application/json");
        const healthy = !wantsDeep || deepProbes >= 2;
        res.statusCode = healthy ? 200 : 503;
        res.end(
          JSON.stringify(
            healthy
              ? {
                  status: "ok",
                  session: "early-exit-worker",
                  auth: "capability-v1",
                }
              : { status: "error" },
          ),
        );
        return;
      }
      res.statusCode = 404;
      res.end();
    });
    await new Promise<void>((r) => winner.listen(0, "127.0.0.1", () => r()));
    const winnerPort = (winner.address() as AddressInfo).port;
    process.env.CHROME_DEVTOOLS_AXI_PORT = String(winnerPort);

    try {
      const port = await ensureBridge(() => {
        const loser = new EventEmitter();
        setImmediate(() =>
          loser.emit("exit", BRIDGE_PORT_IN_USE_EXIT_CODE, null),
        );
        return loser as unknown as SpawnedBridge;
      });
      expect(port).toBe(winnerPort);
      expect(deepProbes).toBeGreaterThanOrEqual(2);
    } finally {
      await new Promise<void>((r) => winner.close(() => r()));
    }
  });
});

describe("waitForProcessExit", () => {
  it("returns true once the process is gone", async () => {
    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 200)"], {
      stdio: "ignore",
    });
    expect(child.pid).toBeDefined();
    const pid = child.pid as number;
    child.unref();

    // Process is alive at first
    expect(await waitForProcessExit(pid, 50)).toBe(false);

    // After it exits naturally, the wait should succeed
    expect(await waitForProcessExit(pid, 2000)).toBe(true);
  });

  it("returns false when the process outlives the timeout", async () => {
    const child = spawn(
      process.execPath,
      ["-e", "setTimeout(() => {}, 5000)"],
      {
        stdio: "ignore",
      },
    );
    const pid = child.pid as number;
    try {
      expect(await waitForProcessExit(pid, 100)).toBe(false);
    } finally {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Already gone.
      }
    }
  });
});

describe("terminateBridgeProcess", () => {
  function waitForFile(path: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const deadline = Date.now() + 2000;
      const poll = () => {
        try {
          resolve(readFileSync(path, "utf-8").trim());
          return;
        } catch (err) {
          if (Date.now() >= deadline) {
            reject(err);
            return;
          }
          setTimeout(poll, 25);
        }
      };
      poll();
    });
  }

  function isAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  afterEach(() => {
    // The fail-closed tests spy on process.kill and readProcessIdentity;
    // a leaked spy would corrupt the next fixture's signal or identity reads.
    vi.restoreAllMocks();
  });

  it("waits for the bridge process to actually exit, and never signals a dead leader's group", async () => {
    // Mimics a well-behaved bridge: exits cleanly on SIGTERM.
    const killSpy = vi.spyOn(process, "kill");
    const child = spawnMarkedBridge(
      "process.on('SIGTERM', () => process.exit(0)); setTimeout(() => {}, 30000);",
      true,
    );
    const pid = child.pid as number;
    const startedAt = startedAtOf(pid);

    // Give the listener a moment to register before we send the signal.
    await new Promise((r) => setTimeout(r, 50));
    await terminateBridgeProcess(pid, startedAt, { killProcessGroup: true });

    expect(isAlive(pid)).toBe(false);
    // The production comment is the contract: once the leader is gone the OS
    // may recycle its pid — and pgid — for an unrelated process, so there is
    // deliberately no `kill(-pid)` after the exit is observed.
    expect(
      killSpy.mock.calls.filter(
        ([target]) => typeof target === "number" && target < 0,
      ),
    ).toEqual([]);
  });

  it("escalates to SIGKILL, group-first, when a group-leading bridge ignores SIGTERM", async () => {
    // Mimics a stuck bridge: ignores SIGTERM. Without escalation, stop +
    // start can't recover (issue #43). The 2s SIGTERM grace window means
    // the test takes ~2s to drive the escalation path. `detached` makes the
    // child lead its own group, so the trusted path takes kill(-pid) first.
    const killSpy = vi.spyOn(process, "kill");
    const child = spawnMarkedBridge(
      "process.on('SIGTERM', () => {}); setTimeout(() => {}, 30000);",
      true,
    );
    const pid = child.pid as number;
    const startedAt = startedAtOf(pid);

    await new Promise((r) => setTimeout(r, 50));
    await terminateBridgeProcess(pid, startedAt, { killProcessGroup: true });

    expect(killSpy).toHaveBeenCalledWith(-pid, "SIGKILL");
    expect(await waitForProcessExit(pid, 3000)).toBe(true);
  }, 15_000);

  it("is a no-op when the pid is already gone", async () => {
    // Pick a likely-unused pid by spawning + waiting for it to exit. The
    // recorded start time is only consulted for a live process, so any value
    // is a valid stand-in for a record whose bridge already exited.
    const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
    const pid = child.pid as number;
    await new Promise<void>((r) => child.on("exit", () => r()));

    await expect(
      terminateBridgeProcess(pid, "irrelevant-for-a-dead-pid"),
    ).resolves.toBeUndefined();
  });

  it("never group-signals a bridge that does not lead its own group, even when asked", async () => {
    // Without `detached` the child shares our process group: readProcessGroupId
    // returns the runner's pgid, not the bridge pid, so the trusted-group check
    // must refuse kill(-pid) — sending it would SIGKILL this very test process
    // tree. The plain SIGKILL still retires the stuck bridge.
    const dir = mkdtempSync(join(tmpdir(), "chrome-devtools-axi-test-"));
    const childPidFile = join(dir, "child.pid");
    const killSpy = vi.spyOn(process, "kill");
    const parent = spawn(
      process.execPath,
      [
        "-e",
        [
          "const { spawn } = require('node:child_process');",
          "const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore' });",
          `require('node:fs').writeFileSync(${JSON.stringify(childPidFile)}, String(child.pid));`,
          "process.on('SIGTERM', () => {});",
          "setTimeout(() => {}, 30000);",
        ].join(""),
        BRIDGE_COMMAND_MARKER,
      ],
      { stdio: "ignore" },
    );
    const parentPid = parent.pid as number;
    parent.unref();
    const startedAt = startedAtOf(parentPid);

    const childPid = Number.parseInt(await waitForFile(childPidFile), 10);
    try {
      await terminateBridgeProcess(parentPid, startedAt, {
        killProcessGroup: true,
      });

      expect(isAlive(parentPid)).toBe(false);
      expect(
        killSpy.mock.calls.filter(
          ([target]) => typeof target === "number" && target < 0,
        ),
      ).toEqual([]);
      expect(isAlive(childPid)).toBe(true);
    } finally {
      try {
        process.kill(childPid, "SIGKILL");
      } catch {
        // Already gone.
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses to signal a pid whose live start time does not match the record", async () => {
    // A recycled pid can keep the bridge marker (another Axis bridge) while
    // being a different process instance; start time is what tells them apart.
    const killSpy = vi.spyOn(process, "kill");
    const child = spawnMarkedBridge("setTimeout(() => {}, 30000);");
    const pid = child.pid as number;
    try {
      const wrongStartedAt = "Mon Jan  1 00:00:00 1990";
      await expect(
        terminateBridgeProcess(pid, wrongStartedAt),
      ).rejects.toMatchObject({
        code: "BRIDGE_NOT_READY",
        message: expect.stringContaining(
          "does not match the recorded identity",
        ),
      });
      // Nothing but liveness probes (signal 0) may reach that pid.
      expect(killSpy).not.toHaveBeenCalledWith(pid, "SIGTERM");
      expect(killSpy).not.toHaveBeenCalledWith(pid, "SIGKILL");
      expect(
        killSpy.mock.calls.filter(
          ([target]) => typeof target === "number" && target < 0,
        ),
      ).toEqual([]);
      expect(isAlive(pid)).toBe(true);
    } finally {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Already gone.
      }
    }
  });

  it("refuses to signal a live process that is not a marked bridge", async () => {
    const killSpy = vi.spyOn(process, "kill");
    const child = spawn(
      process.execPath,
      ["-e", "setTimeout(() => {}, 30000)"],
      {
        stdio: "ignore",
      },
    );
    const pid = child.pid as number;
    try {
      const startedAt = readProcessIdentity(pid)?.startedAt ?? "unreadable";
      await expect(
        terminateBridgeProcess(pid, startedAt),
      ).rejects.toMatchObject({ code: "BRIDGE_NOT_READY" });
      expect(killSpy).not.toHaveBeenCalledWith(pid, "SIGTERM");
      expect(killSpy).not.toHaveBeenCalledWith(pid, "SIGKILL");
      expect(isAlive(pid)).toBe(true);
    } finally {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Already gone.
      }
    }
  });

  it("refuses to signal when the live identity cannot be read at all", async () => {
    // `ps` returning nothing is "do not signal", not "unverified but try
    // anyway": an access-denied or platform-failed probe must fail closed.
    const killSpy = vi.spyOn(process, "kill");
    const child = spawnMarkedBridge("setTimeout(() => {}, 30000);");
    const pid = child.pid as number;
    try {
      vi.spyOn(processIdentity, "readProcessIdentity").mockReturnValue(null);
      await expect(
        terminateBridgeProcess(pid, "irrelevant"),
      ).rejects.toMatchObject({ code: "BRIDGE_NOT_READY" });
      expect(killSpy).not.toHaveBeenCalledWith(pid, "SIGTERM");
      expect(killSpy).not.toHaveBeenCalledWith(pid, "SIGKILL");
      expect(isAlive(pid)).toBe(true);
    } finally {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Already gone.
      }
    }
  });
});

interface FakeCallBridgeOptions {
  session: string;
  listPages?: string;
  result?: string;
  toolResults?: Record<string, string>;
  /**
   * Tool names that should respond with an `{ error }` body, mirroring how the
   * real bridge surfaces an MCP `isError` result. Used to assert the CLI turns
   * a tool failure into a thrown error rather than silent success (issue #96).
   */
  toolErrors?: Record<string, string>;
}

interface FakeCallBridge {
  port: number;
  calls: { name: string; args: Record<string, unknown> }[];
  /** The `roots` field seen on each `/call`, in lockstep with `calls`. */
  roots: (string[] | undefined)[];
  /** `x-axis-bridge-token` header seen on each request, in order. */
  tokens: (string | undefined)[];
  close: () => Promise<void>;
}

function startFakeCallBridge(
  opts: FakeCallBridgeOptions,
): Promise<FakeCallBridge> {
  return new Promise((resolveStart, rejectStart) => {
    const calls: { name: string; args: Record<string, unknown> }[] = [];
    const roots: (string[] | undefined)[] = [];
    const tokens: (string | undefined)[] = [];
    const server = createServer((req, res) => {
      const presented = req.headers[BRIDGE_TOKEN_HEADER];
      tokens.push(typeof presented === "string" ? presented : undefined);
      if (req.method === "GET" && req.url?.startsWith("/health")) {
        res.setHeader("Content-Type", "application/json");
        res.statusCode = 200;
        res.end(
          JSON.stringify({
            status: "ok",
            session: opts.session,
            // Mirrors the real bridge: healthy answers carry the auth marker,
            // which is what the CLI requires before treating the port as ours.
            auth: "capability-v1",
          }),
        );
        return;
      }
      if (req.method === "POST" && req.url === "/call") {
        let body = "";
        req.on("data", (chunk) => {
          body += chunk;
        });
        req.on("end", () => {
          const payload = JSON.parse(body) as {
            name: string;
            args?: Record<string, unknown>;
            roots?: string[];
          };
          calls.push({ name: payload.name, args: payload.args ?? {} });
          roots.push(payload.roots);
          res.setHeader("Content-Type", "application/json");
          const error = opts.toolErrors?.[payload.name];
          if (error !== undefined) {
            res.end(JSON.stringify({ error }));
            return;
          }
          if (payload.name === "list_pages") {
            res.end(
              JSON.stringify({
                result: opts.listPages ?? "## Pages",
              }),
            );
            return;
          }
          const named = opts.toolResults?.[payload.name];
          res.end(JSON.stringify({ result: named ?? opts.result ?? "ok" }));
        });
        return;
      }
      res.statusCode = 404;
      res.end();
    });
    server.on("error", rejectStart);
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      resolveStart({
        port,
        calls,
        roots,
        tokens,
        close: () =>
          new Promise<void>((closeResolve) => {
            server.close(() => closeResolve());
          }),
      });
    });
  });
}

describe("callTool pageId routing", () => {
  const savedSession = process.env.CHROME_DEVTOOLS_AXI_SESSION;
  const savedHome = process.env.HOME;
  const savedPort = process.env.CHROME_DEVTOOLS_AXI_PORT;
  let tmpHome = "";

  // Arbitrary but fixed: the fake bridge records rather than validates the
  // token, so the value only needs to be checkable for presence on requests.
  const FAKE_TOKEN = "fake-session-capability-token";

  const restore = (key: string, value: string | undefined) => {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  };

  async function withFakeBridge(
    run: (fake: FakeCallBridge) => Promise<void>,
    opts: Omit<FakeCallBridgeOptions, "session"> = {},
  ): Promise<void> {
    tmpHome = mkdtempSync(join(tmpdir(), "axi-pageid-"));
    process.env.HOME = tmpHome;
    process.env.CHROME_DEVTOOLS_AXI_SESSION = "pageid-worker";
    const fake = await startFakeCallBridge({
      session: "pageid-worker",
      ...opts,
    });
    process.env.CHROME_DEVTOOLS_AXI_PORT = String(fake.port);
    const pidFile = resolveSessionPidFile("pageid-worker");
    mkdirSync(dirname(pidFile), { recursive: true });
    // An authenticated record: pid/port plus the capability token and start
    // time that readBridgeEndpoint/ensureBridge now require. The pid is this
    // test process's — nothing in callTool ever signals it (only stop does).
    writeFileSync(
      pidFile,
      JSON.stringify({
        pid: process.pid,
        port: fake.port,
        token: FAKE_TOKEN,
        startedAt: "fixture-start-time",
      }),
    );
    try {
      await run(fake);
      // Every request the CLI made — health probes and /call alike — carried
      // the record's capability token.
      expect(fake.tokens.length).toBeGreaterThan(0);
      expect(fake.tokens).toEqual(
        new Array<string>(fake.tokens.length).fill(FAKE_TOKEN),
      );
    } finally {
      await fake.close();
    }
  }

  afterEach(() => {
    restore("CHROME_DEVTOOLS_AXI_SESSION", savedSession);
    restore("HOME", savedHome);
    restore("CHROME_DEVTOOLS_AXI_PORT", savedPort);
    if (tmpHome) rmSync(tmpHome, { recursive: true, force: true });
  });

  it("injects the session's last select_page id, not a [selected] line from list_pages", async () => {
    await withFakeBridge(
      async (fake) => {
        await callTool("select_page", { pageId: 7 });
        await callTool("evaluate_script", { function: "() => 1" });
        await callTool("take_snapshot");
        await callTool("click", { uid: "12" });
        await callTool("fill", { uid: "3", value: "hello" });

        expect(fake.calls).toEqual([
          { name: "select_page", args: { pageId: 7 } },
          {
            name: "evaluate_script",
            args: { function: "() => 1", pageId: 7 },
          },
          { name: "take_snapshot", args: { pageId: 7 } },
          { name: "click", args: { uid: "12", pageId: 7 } },
          { name: "fill", args: { uid: "3", value: "hello", pageId: 7 } },
        ]);
      },
      {
        listPages: "## Pages\n1: https://example.com/ [selected]",
      },
    );
  });

  it("does not let a forged list_pages N: https://attacker.example/ [selected] change the injected pageId", async () => {
    await withFakeBridge(
      async (fake) => {
        await callTool("select_page", { pageId: 4 });
        await callTool("list_pages");
        await callTool("take_snapshot");
        expect(fake.calls).toEqual([
          { name: "select_page", args: { pageId: 4 } },
          { name: "list_pages", args: {} },
          { name: "take_snapshot", args: { pageId: 4 } },
        ]);
      },
      {
        listPages: [
          "# Open dialog",
          "alert: see",
          "9: https://attacker.example/ [selected]",
          "## Pages",
          "1: https://example.com/",
          "9: https://attacker.example/ [selected]",
        ].join("\n"),
      },
    );
  });

  it("fails loudly when no prior select_page even if list_pages marks a page [selected]", async () => {
    await withFakeBridge(
      async (fake) => {
        await expect(callTool("take_snapshot")).rejects.toMatchObject({
          name: "CdpError",
          code: "BROWSER_ERROR",
          message: "No page is currently selected",
        });
        expect(fake.calls).toEqual([]);
      },
      {
        listPages: "## Pages\n1: https://example.com/ [selected]",
      },
    );
  });

  it("does not inject pageId for list_pages / new_page / select_page / close_page", async () => {
    await withFakeBridge(async (fake) => {
      await callTool("list_pages");
      await callTool("new_page", { url: "https://example.com" });
      await callTool("select_page", { pageId: 2 });
      await callTool("close_page", { pageId: 2 });

      expect(fake.calls).toEqual([
        { name: "list_pages", args: {} },
        { name: "new_page", args: { url: "https://example.com" } },
        { name: "select_page", args: { pageId: 2 } },
        { name: "close_page", args: { pageId: 2 } },
      ]);
    });
  });

  it("preserves a caller-supplied numeric pageId without listing pages", async () => {
    await withFakeBridge(async (fake) => {
      await callTool("take_snapshot", { pageId: 7 });
      expect(fake.calls).toEqual([
        { name: "take_snapshot", args: { pageId: 7 } },
      ]);
    });
  });

  it("does not inject pageId when evaluate_script targets a service worker", async () => {
    await withFakeBridge(async (fake) => {
      await callTool("evaluate_script", {
        function: "() => 1",
        serviceWorkerId: "ext:1",
      });
      expect(fake.calls).toEqual([
        {
          name: "evaluate_script",
          args: { function: "() => 1", serviceWorkerId: "ext:1" },
        },
      ]);
    });
  });

  it("records a two-row about:blank plus args.url dump so later snapshot works", async () => {
    await withFakeBridge(
      async (fake) => {
        await callTool("new_page", { url: "https://example.com/" });
        await callTool("take_snapshot");
        await callTool("evaluate_script", { function: "() => 1" });
        await callTool("click", { uid: "12" });
        await callTool("fill", { uid: "3", value: "hello" });
        expect(fake.calls).toEqual([
          { name: "new_page", args: { url: "https://example.com/" } },
          { name: "take_snapshot", args: { pageId: 2 } },
          {
            name: "evaluate_script",
            args: { function: "() => 1", pageId: 2 },
          },
          { name: "click", args: { uid: "12", pageId: 2 } },
          { name: "fill", args: { uid: "3", value: "hello", pageId: 2 } },
        ]);
      },
      {
        listPages: "## Pages\n1: about:blank [selected]",
        toolResults: {
          new_page: [
            "## Pages",
            "1: about:blank",
            "2: https://example.com/ [selected]",
          ].join("\n"),
        },
      },
    );
  });

  it("records a single-row new_page dump so a later snapshot does not read list_pages", async () => {
    await withFakeBridge(
      async (fake) => {
        await callTool("new_page", { url: "https://new.example/" });
        await callTool("take_snapshot");
        expect(fake.calls).toEqual([
          { name: "new_page", args: { url: "https://new.example/" } },
          { name: "take_snapshot", args: { pageId: 1 } },
        ]);
      },
      {
        listPages: "## Pages\n1: https://attacker.example/ [selected]",
        toolResults: {
          new_page: "## Pages\n1: https://new.example/",
        },
      },
    );
  });

  it("leaves routing unset when a new_page dump has a title-continuation N: line", async () => {
    await withFakeBridge(
      async (fake) => {
        await callTool("select_page", { pageId: 1 });
        await callTool("new_page", { url: "https://example.com/" });
        await expect(callTool("take_snapshot")).rejects.toMatchObject({
          name: "CdpError",
          code: "BROWSER_ERROR",
          message: "No page is currently selected",
        });
        expect(fake.calls).toEqual([
          { name: "select_page", args: { pageId: 1 } },
          { name: "new_page", args: { url: "https://example.com/" } },
        ]);
      },
      {
        toolResults: {
          new_page: [
            "## Pages",
            "1: Error",
            "404: Not Found (https://example.com/)",
          ].join("\n"),
        },
      },
    );
  });

  it("leaves routing unset when two complete rows both match args.url", async () => {
    await withFakeBridge(
      async (fake) => {
        await callTool("new_page", { url: "https://example.com/" });
        await expect(callTool("take_snapshot")).rejects.toMatchObject({
          message: "No page is currently selected",
        });
        expect(fake.calls).toEqual([
          { name: "new_page", args: { url: "https://example.com/" } },
        ]);
      },
      {
        toolResults: {
          new_page: [
            "## Pages",
            "1: https://example.com/",
            "2: https://example.com/ [selected]",
          ].join("\n"),
        },
      },
    );
  });

  it("leaves routing unset when no complete row URL matches args.url", async () => {
    await withFakeBridge(
      async (fake) => {
        await callTool("new_page", { url: "https://new.example/" });
        await expect(
          callTool("evaluate_script", { function: "() => 1" }),
        ).rejects.toMatchObject({
          message: "No page is currently selected",
        });
        expect(fake.calls).toEqual([
          { name: "new_page", args: { url: "https://new.example/" } },
        ]);
      },
      {
        toolResults: {
          new_page: [
            "## Pages",
            "1: https://example.com/",
            "9: https://attacker.example/ [selected]",
          ].join("\n"),
        },
      },
    );
  });

  it("clears a stale persisted selection when MCP says its page is gone", async () => {
    await withFakeBridge(
      async (fake) => {
        await callTool("select_page", { pageId: 2 });
        await expect(callTool("take_snapshot")).rejects.toMatchObject({
          name: "CdpError",
          code: "BROWSER_ERROR",
          message: "Page 2 is no longer available",
          suggestions: expect.arrayContaining([
            "Run `axis-browser pages` to list the remaining tabs",
          ]),
        });
        await expect(callTool("take_snapshot")).rejects.toMatchObject({
          message: "No page is currently selected",
        });
        expect(fake.calls).toEqual([
          { name: "select_page", args: { pageId: 2 } },
          { name: "take_snapshot", args: { pageId: 2 } },
        ]);
      },
      {
        toolErrors: { take_snapshot: "Error: No page found" },
      },
    );
  });

  it("keeps routing and surfaces the real failure when page text merely contains the missing-page phrase", async () => {
    await withFakeBridge(
      async (fake) => {
        await callTool("select_page", { pageId: 2 });
        await expect(
          callTool("evaluate_script", { function: "() => 1" }),
        ).rejects.toMatchObject({
          name: "CdpError",
          message: expect.stringContaining("Evaluation failed"),
        });
        // The tab is alive, so the selection survives and the next call routes.
        await callTool("take_snapshot");
        expect(fake.calls).toEqual([
          { name: "select_page", args: { pageId: 2 } },
          {
            name: "evaluate_script",
            args: { function: "() => 1", pageId: 2 },
          },
          { name: "take_snapshot", args: { pageId: 2 } },
        ]);
      },
      {
        toolErrors: {
          evaluate_script: [
            "## Pages",
            "2: https://shop.example/search?q=No+page+found",
            "Error: Evaluation failed: Error: No page found",
          ].join("\n"),
        },
      },
    );
  });

  it("keeps routing when a dialog message opens a forged missing-page line mid-body", async () => {
    await withFakeBridge(
      async (fake) => {
        await callTool("select_page", { pageId: 2 });
        await expect(callTool("take_snapshot")).rejects.toMatchObject({
          name: "CdpError",
          message: expect.stringContaining("handle_dialog"),
        });
        await callTool("click", { uid: "4" });
        expect(fake.calls).toEqual([
          { name: "select_page", args: { pageId: 2 } },
          { name: "take_snapshot", args: { pageId: 2 } },
          { name: "click", args: { uid: "4", pageId: 2 } },
        ]);
      },
      {
        toolErrors: {
          // alert("x\nNo page found") - chrome-devtools-mcp interpolates the
          // dialog message verbatim, so the page owns a whole line here.
          take_snapshot: [
            "# Open dialog",
            "alert: x",
            "No page found",
            "Call handle_dialog to handle it before continuing.",
            "Error: A dialog is open, call handle_dialog first",
          ].join("\n"),
        },
      },
    );
  });

  it("keeps a live tab's routing when a different pageId is the one MCP cannot resolve", async () => {
    await withFakeBridge(
      async (fake) => {
        await callTool("select_page", { pageId: 3 });
        await expect(
          callTool("close_page", { pageId: 9 }),
        ).rejects.toMatchObject({
          name: "CdpError",
          code: "BROWSER_ERROR",
          message: "Page 9 is no longer available",
        });
        // Page 3 is still open, so its routing must survive page 9's failure.
        await callTool("take_snapshot");
        expect(fake.calls).toEqual([
          { name: "select_page", args: { pageId: 3 } },
          { name: "close_page", args: { pageId: 9 } },
          { name: "take_snapshot", args: { pageId: 3 } },
        ]);
      },
      {
        toolErrors: { close_page: "Error: No page found" },
      },
    );
  });

  it("clears the selection when MCP reports the selected page was closed", async () => {
    await withFakeBridge(
      async (fake) => {
        await callTool("select_page", { pageId: 5 });
        await expect(callTool("take_snapshot")).rejects.toMatchObject({
          name: "CdpError",
          code: "BROWSER_ERROR",
          message: "Page 5 is no longer available",
        });
        await expect(callTool("take_snapshot")).rejects.toMatchObject({
          message: "No page is currently selected",
        });
        expect(fake.calls).toEqual([
          { name: "select_page", args: { pageId: 5 } },
          { name: "take_snapshot", args: { pageId: 5 } },
        ]);
      },
      {
        toolErrors: {
          // Upstream interpolates the list_pages tool name into this sentence.
          take_snapshot:
            "Error: The selected page has been closed. Call browser_list_pages to see the open tabs.",
        },
      },
    );
  });

  it("reports a reconnect-invalidated call as an actionable BROWSER_ERROR", async () => {
    await withFakeBridge(
      async () => {
        await callTool("select_page", { pageId: 1 });
        await expect(callTool("take_snapshot")).rejects.toMatchObject({
          name: "CdpError",
          code: "BROWSER_ERROR",
          message: PAGE_IDENTITY_CHANGED_ERROR,
          suggestions: expect.arrayContaining([
            "Run `axis-browser pages` to list the current tabs and their new ids",
          ]),
        });
      },
      { toolErrors: { take_snapshot: PAGE_IDENTITY_CHANGED_ERROR } },
    );
  });

  it("clears routing when close_page targets the selected id", async () => {
    await withFakeBridge(async (fake) => {
      await callTool("select_page", { pageId: 3 });
      await callTool("close_page", { pageId: 3 });
      await expect(callTool("take_snapshot")).rejects.toMatchObject({
        message: "No page is currently selected",
      });
      expect(fake.calls).toEqual([
        { name: "select_page", args: { pageId: 3 } },
        { name: "close_page", args: { pageId: 3 } },
      ]);
    });
  });

  it("keeps routing when close_page targets a different id", async () => {
    await withFakeBridge(async (fake) => {
      await callTool("select_page", { pageId: 1 });
      await callTool("close_page", { pageId: 2 });
      await callTool("click", { uid: "1" });
      expect(fake.calls).toEqual([
        { name: "select_page", args: { pageId: 1 } },
        { name: "close_page", args: { pageId: 2 } },
        { name: "click", args: { uid: "1", pageId: 1 } },
      ]);
    });
  });

  it("getSessionSnapshotIfRunning snapshots the session selected pageId", async () => {
    await withFakeBridge(
      async (fake) => {
        await callTool("select_page", { pageId: 3 });
        const snapshot = await getSessionSnapshotIfRunning();
        expect(snapshot).toBe("ok");
        expect(fake.calls).toEqual([
          { name: "select_page", args: { pageId: 3 } },
          { name: "take_snapshot", args: { pageId: 3 } },
        ]);
      },
      {
        listPages: "## Pages\n9: https://attacker.example/ [selected]",
      },
    );
  });

  it("getSessionSnapshotIfRunning degrades to null when no page is selected", async () => {
    await withFakeBridge(
      async (fake) => {
        await expect(getSessionSnapshotIfRunning()).resolves.toBeNull();
        expect(fake.calls).toEqual([]);
      },
      { listPages: "## Pages\n0: https://a.com/ [selected]" },
    );
  });

  it("surfaces a tool error result as a thrown CdpError instead of silent success (#96)", async () => {
    await withFakeBridge(
      async () => {
        await callTool("select_page", { pageId: 1 });
        await expect(
          callTool("take_screenshot", { filePath: "/tmp/x.png" }),
        ).rejects.toMatchObject({
          name: "CdpError",
          message: expect.stringContaining("Access denied"),
        });
      },
      {
        toolErrors: {
          take_screenshot:
            "Error: Access denied: path /tmp/x.png is not within any of the configured workspace roots.",
        },
      },
    );
  });

  it("negotiates the nearest existing output ancestor (#96)", async () => {
    const outputRoot = mkdtempSync(join(tmpdir(), "axi-output-root-"));
    try {
      await withFakeBridge(async (fake) => {
        await callTool("select_page", { pageId: 1 });
        await callTool("take_screenshot", {
          filePath: join(outputRoot, "new", "shots", "x.png"),
        });
        const idx = fake.calls.findIndex((c) => c.name === "take_screenshot");
        expect(idx).toBeGreaterThanOrEqual(0);
        expect(fake.roots[idx]).toEqual([process.cwd(), outputRoot]);
      });
    } finally {
      rmSync(outputRoot, { recursive: true, force: true });
    }
  });
});

describe("reconnect reporting through the deep health probe", () => {
  const RECONNECT_NOTICE =
    "Note: the browser was restarted or reconnected since the last call. Page ids have changed. Call list_pages to see open pages.";
  const RECONNECT_MESSAGE =
    "The browser reconnected and every page id changed, so no page is currently selected";

  const savedSession = process.env.CHROME_DEVTOOLS_AXI_SESSION;
  const savedHome = process.env.HOME;
  const savedPort = process.env.CHROME_DEVTOOLS_AXI_PORT;
  let tmpHome = "";

  const restore = (key: string, value: string | undefined) => {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  };

  /**
   * Drive `callTool` against the real bridge server, so the reconnect signal
   * travels the whole production path: the deep probe's `list_pages` sees
   * chrome-devtools-mcp's one-shot marker, the bridge clears the persisted
   * selection and reports it on `/health?deep=1`, and the CLI decides which
   * error to raise from that response alone.
   *
   * `reconnectOnCall` picks which MCP round-trips carry the marker (1-based,
   * counting every tool call the bridge makes, deep probes included).
   */
  async function withRealBridge(
    reconnectOnCall: (call: number) => boolean,
    run: () => Promise<void>,
  ): Promise<void> {
    tmpHome = mkdtempSync(join(tmpdir(), "axi-reconnect-cli-"));
    process.env.HOME = tmpHome;
    process.env.CHROME_DEVTOOLS_AXI_SESSION = "reconnect-cli";
    let mcpCalls = 0;
    const client: BridgeClient = {
      listTools: async () => ({ tools: [] }),
      callTool: async () => {
        mcpCalls += 1;
        const pages = "## Pages\n0: about:blank";
        return {
          content: [
            {
              type: "text",
              text: reconnectOnCall(mcpCalls)
                ? `${RECONNECT_NOTICE}\n${pages}`
                : pages,
            },
          ],
        };
      },
      close: async () => {},
    };
    const server = createBridgeServer(client, "reconnect-cli");
    try {
      await new Promise<void>((ready) => {
        server.listen(0, "127.0.0.1", ready);
      });
      const { port } = server.address() as AddressInfo;
      // The real bridge gates /health and /call on the capability token, so
      // arm it exactly as publishBridgeCapability would and write the
      // authenticated record the CLI reads to learn the token.
      const token = "reconnect-cli-test-token";
      setBridgeTokenForTest(token);
      process.env.CHROME_DEVTOOLS_AXI_PORT = String(port);
      const pidFile = resolveSessionPidFile("reconnect-cli");
      mkdirSync(dirname(pidFile), { recursive: true });
      writeFileSync(
        pidFile,
        JSON.stringify({
          pid: process.pid,
          port,
          token,
          startedAt: "fixture-start-time",
        }),
      );
      await run();
    } finally {
      setBridgeTokenForTest(null);
      await new Promise<void>((closed) => server.close(() => closed()));
    }
  }

  afterEach(() => {
    restore("CHROME_DEVTOOLS_AXI_SESSION", savedSession);
    restore("HOME", savedHome);
    restore("CHROME_DEVTOOLS_AXI_PORT", savedPort);
    if (tmpHome) rmSync(tmpHome, { recursive: true, force: true });
  });

  it("names the reconnect on the page-scoped call whose selection the deep probe just dropped", async () => {
    // Only the first MCP round-trip - this command's deep probe - reconnects.
    await withRealBridge(
      (call) => call === 1,
      async () => {
        setSelectedPageId(4);

        await expect(callTool("take_snapshot")).rejects.toMatchObject({
          name: "CdpError",
          code: "BROWSER_ERROR",
          message: RECONNECT_MESSAGE,
          suggestions: expect.arrayContaining([
            "Run `axis-browser selectpage <id>` to re-select a tab after the reconnect, then retry",
          ]),
        });

        // One-shot: the next command's deep probe sees no reconnect, so the
        // still-unselected session falls back to the plain message rather
        // than blaming a reconnect that is now history.
        await expect(callTool("take_snapshot")).rejects.toMatchObject({
          code: "BROWSER_ERROR",
          message: "No page is currently selected",
        });
      },
    );
  });

  it("does not relabel a later call when the notice's own call never resolved routing", async () => {
    // The deep probe for `pages` drops the selection and reports it, but
    // `list_pages` needs no pageId, so that command never uses the notice.
    // Ownership is per call: the *next* command's probe sees no reconnect, so
    // it must say the session has nothing selected rather than inherit an
    // attribution that was collected for a different operation.
    await withRealBridge(
      (call) => call === 1,
      async () => {
        setSelectedPageId(4);

        expect(await callTool("list_pages")).toContain("## Pages");

        await expect(callTool("take_snapshot")).rejects.toMatchObject({
          name: "CdpError",
          code: "BROWSER_ERROR",
          message: "No page is currently selected",
        });
      },
    );
  });

  it("keeps the plain no-selection message for a session that never selected a page", async () => {
    await withRealBridge(
      () => false,
      async () => {
        await expect(callTool("take_snapshot")).rejects.toMatchObject({
          name: "CdpError",
          code: "BROWSER_ERROR",
          message: "No page is currently selected",
          suggestions: expect.arrayContaining([
            "Run `axis-browser open <url>` to open a page",
          ]),
        });
      },
    );
  });

  it("keeps the plain no-selection message when a reconnect finds no routing to drop", async () => {
    // The browser really did reconnect, but this session never selected a
    // page, so there is no loss to report - only the plain message is true.
    await withRealBridge(
      (call) => call === 1,
      async () => {
        await expect(callTool("take_snapshot")).rejects.toMatchObject({
          name: "CdpError",
          code: "BROWSER_ERROR",
          message: "No page is currently selected",
        });
      },
    );
  });

  it("routes normally once a page is selected after the reconnect", async () => {
    await withRealBridge(
      (call) => call === 1,
      async () => {
        setSelectedPageId(4);
        await expect(callTool("take_snapshot")).rejects.toMatchObject({
          message: RECONNECT_MESSAGE,
        });

        await callTool("select_page", { pageId: 11 });
        expect(await callTool("take_snapshot")).toContain("## Pages");
      },
    );
  });
});

/**
 * Shared sandbox for the record-driven describes below: HOME and the session
 * env are pointed at a throwaway dir so resolveSessionPidFile and friends read
 * only records these tests write.
 */
function useSandboxedSession(name: string): { home: string; pidFile: string } {
  const home = mkdtempSync(join(tmpdir(), "axi-client-sandbox-"));
  process.env.HOME = home;
  if (name === DEFAULT_SESSION_NAME) {
    delete process.env.CHROME_DEVTOOLS_AXI_SESSION;
  } else {
    process.env.CHROME_DEVTOOLS_AXI_SESSION = name;
  }
  const pidFile = resolveSessionPidFile(name);
  mkdirSync(dirname(pidFile), { recursive: true });
  return { home, pidFile };
}

function sandboxEnvTeardown(home: string): void {
  rmSync(home, { recursive: true, force: true });
}

describe("readBridgeEndpoint", () => {
  const savedSession = process.env.CHROME_DEVTOOLS_AXI_SESSION;
  const savedHome = process.env.HOME;

  afterEach(() => {
    if (savedSession === undefined)
      delete process.env.CHROME_DEVTOOLS_AXI_SESSION;
    else process.env.CHROME_DEVTOOLS_AXI_SESSION = savedSession;
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
  });

  it("returns port and token for an authenticated record", () => {
    const { home, pidFile } = useSandboxedSession("endpoint-worker");
    try {
      writeFileSync(
        pidFile,
        JSON.stringify({
          pid: 4242,
          port: 9333,
          token: "the-capability",
          startedAt: "some start time",
        }),
      );
      expect(readBridgeEndpoint("endpoint-worker")).toEqual({
        port: 9333,
        token: "the-capability",
      });
    } finally {
      sandboxEnvTeardown(home);
    }
  });

  it("returns null for a tokenless legacy record — it is never adopted for RPC", () => {
    const { home, pidFile } = useSandboxedSession("endpoint-worker");
    try {
      writeFileSync(pidFile, JSON.stringify({ pid: 4242, port: 9333 }));
      expect(readBridgeEndpoint("endpoint-worker")).toBeNull();
    } finally {
      sandboxEnvTeardown(home);
    }
  });

  it("returns null for a record whose token or start time is blank", () => {
    const { home, pidFile } = useSandboxedSession("endpoint-worker");
    try {
      for (const record of [
        { pid: 1, port: 2, token: "", startedAt: "t" },
        { pid: 1, port: 2, token: "t", startedAt: "" },
      ]) {
        writeFileSync(pidFile, JSON.stringify(record));
        expect(readBridgeEndpoint("endpoint-worker")).toBeNull();
      }
    } finally {
      sandboxEnvTeardown(home);
    }
  });

  it("returns null when there is no record", () => {
    const { home } = useSandboxedSession("endpoint-worker");
    try {
      expect(readBridgeEndpoint("endpoint-worker")).toBeNull();
    } finally {
      sandboxEnvTeardown(home);
    }
  });
});

describe("stopBridge", () => {
  const savedSession = process.env.CHROME_DEVTOOLS_AXI_SESSION;
  const savedHome = process.env.HOME;

  afterEach(() => {
    vi.restoreAllMocks();
    if (savedSession === undefined)
      delete process.env.CHROME_DEVTOOLS_AXI_SESSION;
    else process.env.CHROME_DEVTOOLS_AXI_SESSION = savedSession;
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
  });

  it("returns false when there is no record at all", async () => {
    const { home } = useSandboxedSession("stop-worker");
    try {
      await expect(stopBridge()).resolves.toBe(false);
    } finally {
      sandboxEnvTeardown(home);
    }
  });

  it("signals nothing for a dead tokenless record and retires the record", async () => {
    const { home, pidFile } = useSandboxedSession("stop-worker");
    try {
      // Spawn-and-reap so the pid is real but dead. A tokenless record is the
      // legacy path: nothing is alive to verify or signal, but leaving the
      // file would keep refusing every `open` in this session behind a manual
      // `rm` — so `stop` clears it and reports that nothing was stopped.
      const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
      const deadPid = child.pid as number;
      await new Promise<void>((r) => child.on("exit", () => r()));
      writeFileSync(pidFile, JSON.stringify({ pid: deadPid, port: 1 }));

      const killSpy = vi.spyOn(process, "kill");
      await expect(stopBridge()).resolves.toBe(false);
      expect(killSpy.mock.calls.filter(([, s]) => s !== 0)).toEqual([]);
      // Retired, not preserved: the record named a dead pid and is gone.
      expect(existsSync(pidFile)).toBe(false);
    } finally {
      sandboxEnvTeardown(home);
    }
  });

  it("stops an authenticated bridge through the verified termination path", async () => {
    const { home, pidFile } = useSandboxedSession("stop-worker");
    const child = spawnMarkedBridge(
      "process.on('SIGTERM', () => process.exit(0)); setTimeout(() => {}, 30000);",
      true,
    );
    const pid = child.pid as number;
    try {
      writeFileSync(
        pidFile,
        JSON.stringify({
          pid,
          port: 1,
          token: "tok",
          startedAt: startedAtOf(pid),
        }),
      );

      // SIGTERM lands quickly; give the handler a tick to register first.
      await new Promise((r) => setTimeout(r, 50));
      await expect(stopBridge()).resolves.toBe(true);
      expect(await waitForProcessExit(pid, 2000)).toBe(true);
      // `stop` clears the record itself. An orderly bridge also removes it on
      // exit, but one that had to be SIGKILLed never runs that handler — and a
      // live-looking record still holding a token is exactly what a later
      // command would mistake for a running bridge. The pid+token comparison
      // means a record this session already replaced survives (covered by the
      // clearBridgeRecord ownership tests).
      expect(existsSync(pidFile)).toBe(false);
    } finally {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Already gone.
      }
      sandboxEnvTeardown(home);
    }
  });

  it("refuses to signal a pid whose live identity does not match the record", async () => {
    const { home, pidFile } = useSandboxedSession("stop-worker");
    const child = spawnMarkedBridge("setTimeout(() => {}, 30000);");
    const pid = child.pid as number;
    try {
      writeFileSync(
        pidFile,
        JSON.stringify({
          pid,
          port: 1,
          token: "tok",
          // Deliberately wrong: the pid is a bridge, but not the one this
          // record was written for — exactly the recycled-pid case.
          startedAt: "Mon Jan  1 00:00:00 1990",
        }),
      );

      await expect(stopBridge()).rejects.toMatchObject({
        code: "BRIDGE_NOT_READY",
        message: expect.stringContaining(
          "does not match the recorded identity",
        ),
      });
      expect(bridgeStillAlive(pid)).toBe(true);
    } finally {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Already gone.
      }
      sandboxEnvTeardown(home);
    }
  });

  it("retires a verified tokenless legacy bridge and removes its record", async () => {
    const { home, pidFile } = useSandboxedSession("stop-worker");
    const child = spawnMarkedBridge(
      "process.on('SIGTERM', () => process.exit(0)); setTimeout(() => {}, 30000);",
      true,
    );
    const pid = child.pid as number;
    try {
      // No token/startedAt: a pre-auth record. Port 1 answers nothing, so the
      // legacy session probe degrades to "unreachable", which is not a veto.
      writeFileSync(pidFile, JSON.stringify({ pid, port: 1 }));

      const identitySpy = vi.spyOn(processIdentity, "readProcessIdentity");
      await new Promise((r) => setTimeout(r, 50));
      await expect(stopBridge()).resolves.toBe(true);

      // The legacy path reads the identity twice before signalling, then the
      // shared terminator verifies again — the double-check is the contract.
      expect(
        identitySpy.mock.calls.filter(([p]) => p === pid).length,
      ).toBeGreaterThanOrEqual(2);
      expect(await waitForProcessExit(pid, 2000)).toBe(true);
      // A retired legacy bridge cannot clean up after itself, so stop does.
      expect(existsSync(pidFile)).toBe(false);
    } finally {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Already gone.
      }
      sandboxEnvTeardown(home);
    }
  });

  it("refuses a tokenless record when the live process is not a bridge", async () => {
    const { home, pidFile } = useSandboxedSession("stop-worker");
    const child = spawn(
      process.execPath,
      ["-e", "setTimeout(() => {}, 30000)"],
      { stdio: "ignore" },
    );
    const pid = child.pid as number;
    try {
      writeFileSync(pidFile, JSON.stringify({ pid, port: 1 }));
      const killSpy = vi.spyOn(process, "kill");

      await expect(stopBridge()).rejects.toMatchObject({
        code: "BRIDGE_NOT_READY",
        message: expect.stringContaining(
          "could not be verified as this bridge",
        ),
      });
      expect(killSpy).not.toHaveBeenCalledWith(pid, "SIGTERM");
      expect(killSpy).not.toHaveBeenCalledWith(pid, "SIGKILL");
      expect(existsSync(pidFile)).toBe(true);
    } finally {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Already gone.
      }
      sandboxEnvTeardown(home);
    }
  });

  it("refuses a tokenless bridge that answers /health as a different session", async () => {
    const { home, pidFile } = useSandboxedSession("stop-worker");
    const fake = await startFakeBridgeServer({
      shallow: "ok",
      deep: "ok",
      session: "other-session",
      auth: false, // legacy bridges predate the marker; readLegacyBridgeSession ignores it
    });
    const child = spawnMarkedBridge("setTimeout(() => {}, 30000);");
    const pid = child.pid as number;
    try {
      writeFileSync(pidFile, JSON.stringify({ pid, port: fake.port }));
      const killSpy = vi.spyOn(process, "kill");

      await expect(stopBridge()).rejects.toMatchObject({
        code: "BRIDGE_NOT_READY",
        message: expect.stringContaining('as session "other-session"'),
      });
      expect(killSpy).not.toHaveBeenCalledWith(pid, "SIGTERM");
      expect(killSpy).not.toHaveBeenCalledWith(pid, "SIGKILL");
    } finally {
      await fake.close();
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Already gone.
      }
      sandboxEnvTeardown(home);
    }
  });

  it("refuses a tokenless record behind a symlinked state directory", async () => {
    // A symlinked state dir can point the record — and the signal decision it
    // drives — at a directory the session does not own, so stop fails closed.
    const home = mkdtempSync(join(tmpdir(), "axi-stop-symlink-"));
    process.env.HOME = home;
    delete process.env.CHROME_DEVTOOLS_AXI_SESSION;
    const realDir = join(home, "real-state-dir");
    mkdirSync(realDir, { recursive: true });
    symlinkSync(realDir, join(home, ".axis-browser"));
    const child = spawnMarkedBridge("setTimeout(() => {}, 30000);");
    const pid = child.pid as number;
    try {
      writeFileSync(
        join(realDir, "bridge.pid"),
        JSON.stringify({ pid, port: 1 }),
      );
      const killSpy = vi.spyOn(process, "kill");

      await expect(stopBridge()).rejects.toMatchObject({
        code: "BRIDGE_NOT_READY",
        message: expect.stringContaining(
          "Refusing to act on the bridge record",
        ),
      });
      expect(killSpy).not.toHaveBeenCalledWith(pid, "SIGTERM");
      expect(killSpy).not.toHaveBeenCalledWith(pid, "SIGKILL");
    } finally {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Already gone.
      }
      sandboxEnvTeardown(home);
    }
  });
});

describe("getSessionSnapshotIfRunning — session record handling", () => {
  const savedSession = process.env.CHROME_DEVTOOLS_AXI_SESSION;
  const savedHome = process.env.HOME;
  const savedPort = process.env.CHROME_DEVTOOLS_AXI_PORT;

  afterEach(() => {
    if (savedSession === undefined)
      delete process.env.CHROME_DEVTOOLS_AXI_SESSION;
    else process.env.CHROME_DEVTOOLS_AXI_SESSION = savedSession;
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    if (savedPort === undefined) delete process.env.CHROME_DEVTOOLS_AXI_PORT;
    else process.env.CHROME_DEVTOOLS_AXI_PORT = savedPort;
  });

  it("degrades a malformed bridge record to null instead of throwing", async () => {
    const { home, pidFile } = useSandboxedSession("snap-worker");
    try {
      writeFileSync(pidFile, "{truncated");
      await expect(getSessionSnapshotIfRunning()).resolves.toBeNull();
    } finally {
      sandboxEnvTeardown(home);
    }
  });

  it("degrades a tokenless legacy record to null without contacting the bridge", async () => {
    const { home, pidFile } = useSandboxedSession("snap-worker");
    const fake = await startFakeCallBridge({ session: "snap-worker" });
    try {
      // Live pid, reachable port — but no token. The probe runs on every
      // prompt, so the loud "how to retire it" error belongs to `stop`, not
      // here; what matters is it never speaks to the bridge unauthenticated.
      writeFileSync(
        pidFile,
        JSON.stringify({ pid: process.pid, port: fake.port }),
      );
      await expect(getSessionSnapshotIfRunning()).resolves.toBeNull();
      expect(fake.tokens).toEqual([]);
      expect(fake.calls).toEqual([]);
    } finally {
      await fake.close();
      sandboxEnvTeardown(home);
    }
  });

  it("degrades to null when the record's pid is dead", async () => {
    const { home, pidFile } = useSandboxedSession("snap-worker");
    const fake = await startFakeCallBridge({ session: "snap-worker" });
    const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
    const deadPid = child.pid as number;
    await new Promise<void>((r) => child.on("exit", () => r()));
    try {
      writeFileSync(
        pidFile,
        JSON.stringify({
          pid: deadPid,
          port: fake.port,
          token: "tok",
          startedAt: "t",
        }),
      );
      await expect(getSessionSnapshotIfRunning()).resolves.toBeNull();
      expect(fake.tokens).toEqual([]);
    } finally {
      await fake.close();
      sandboxEnvTeardown(home);
    }
  });

  it("probes the authenticated endpoint and returns its snapshot", async () => {
    const { home, pidFile } = useSandboxedSession("snap-worker");
    const fake = await startFakeCallBridge({
      session: "snap-worker",
      result: "snap-content",
    });
    try {
      writeFileSync(
        pidFile,
        JSON.stringify({
          pid: process.pid,
          port: fake.port,
          token: "snap-token",
          startedAt: "t",
        }),
      );
      setSelectedPageId(9);
      await expect(getSessionSnapshotIfRunning()).resolves.toBe("snap-content");
      expect(fake.calls).toEqual([
        { name: "take_snapshot", args: { pageId: 9 } },
      ]);
      expect(fake.tokens.every((t) => t === "snap-token")).toBe(true);
    } finally {
      await fake.close();
      sandboxEnvTeardown(home);
    }
  });
});

describe("ensureBridge — record handling", () => {
  const savedSession = process.env.CHROME_DEVTOOLS_AXI_SESSION;
  const savedHome = process.env.HOME;
  const savedPort = process.env.CHROME_DEVTOOLS_AXI_PORT;
  const savedMode = process.env.CHROME_DEVTOOLS_AXI_MODE;

  afterEach(() => {
    for (const [key, value] of [
      ["CHROME_DEVTOOLS_AXI_SESSION", savedSession],
      ["HOME", savedHome],
      ["CHROME_DEVTOOLS_AXI_PORT", savedPort],
      ["CHROME_DEVTOOLS_AXI_MODE", savedMode],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    vi.restoreAllMocks();
  });

  it("reuses a live bridge when the record's token passes the deep probe", async () => {
    const { home, pidFile } = useSandboxedSession("ensure-worker");
    const fake = await startFakeBridgeServer({
      shallow: "ok",
      deep: "ok",
      session: "ensure-worker",
      requireToken: "reuse-token",
    });
    const child = spawnMarkedBridge("setTimeout(() => {}, 30000);");
    try {
      writeFileSync(
        pidFile,
        JSON.stringify({
          pid: child.pid as number,
          port: fake.port,
          token: "reuse-token",
          startedAt: "t",
        }),
      );
      const spawnBridge = vi.fn();

      await expect(ensureBridge(spawnBridge)).resolves.toBe(fake.port);
      // The record's token is what got presented — and no new bridge spawned.
      expect(fake.tokens.length).toBeGreaterThan(0);
      expect(fake.tokens).toEqual(
        new Array<string>(fake.tokens.length).fill("reuse-token"),
      );
      expect(spawnBridge).not.toHaveBeenCalled();
    } finally {
      await fake.close();
      try {
        process.kill(child.pid as number, "SIGKILL");
      } catch {
        // Already gone.
      }
      sandboxEnvTeardown(home);
    }
  });

  it("clears a recycled pid's stale record and spawns a replacement without signalling", async () => {
    const { home, pidFile } = useSandboxedSession("ensure-recycled");
    // The reuse probe must fail (deep: "error") so ensureBridge reaches the
    // terminate decision; the respawn poll's deep probe must then succeed, so
    // the fake's outcome is flipped inside the spawn stub — the one callback
    // that runs after the record is cleared and before the poll starts.
    const opts = {
      shallow: "ok",
      deep: "error",
      session: "ensure-recycled",
    } as { shallow: "ok"; deep: "ok" | "error"; session: string };
    const fake = await startFakeBridgeServer(opts);
    const child = spawnMarkedBridge("setTimeout(() => {}, 30000);");
    try {
      process.env.CHROME_DEVTOOLS_AXI_PORT = String(fake.port);
      // A startedAt that names no live process: the pid holds a marked bridge,
      // but not the one this record was written for.
      writeFileSync(
        pidFile,
        JSON.stringify({
          pid: child.pid as number,
          port: fake.port,
          token: "recycled-token",
          startedAt: "Mon Sep  1 00:00:00 2020",
        }),
      );
      const spawnBridge = vi.fn(() => {
        opts.deep = "ok";
        return new EventEmitter() as unknown as SpawnedBridge;
      });

      await expect(ensureBridge(spawnBridge)).resolves.toBe(fake.port);

      expect(spawnBridge).toHaveBeenCalledTimes(1);
      // The provably stale record is gone; a replacement was started; and the
      // unrelated process behind the recycled pid was never signalled.
      expect(existsSync(pidFile)).toBe(false);
      expect(() => process.kill(child.pid as number, 0)).not.toThrow();
    } finally {
      await fake.close();
      try {
        process.kill(child.pid as number, "SIGKILL");
      } catch {
        // Already gone.
      }
      sandboxEnvTeardown(home);
    }
  });

  it("still terminates a matching bridge whose deep probe failed", async () => {
    const { home, pidFile } = useSandboxedSession("ensure-unhealthy");
    const opts = {
      shallow: "ok",
      deep: "error",
      session: "ensure-unhealthy",
    } as { shallow: "ok"; deep: "ok" | "error"; session: string };
    const fake = await startFakeBridgeServer(opts);
    const child = spawnMarkedBridge("setTimeout(() => {}, 30000);");
    try {
      process.env.CHROME_DEVTOOLS_AXI_PORT = String(fake.port);
      writeFileSync(
        pidFile,
        JSON.stringify({
          pid: child.pid as number,
          port: fake.port,
          token: "unhealthy-token",
          startedAt: startedAtOf(child.pid as number),
        }),
      );
      const spawnBridge = vi.fn(() => {
        opts.deep = "ok";
        return new EventEmitter() as unknown as SpawnedBridge;
      });

      await expect(ensureBridge(spawnBridge)).resolves.toBe(fake.port);

      expect(spawnBridge).toHaveBeenCalledTimes(1);
      // The identity matched, so the unhealthy bridge was terminated rather
      // than merely recorded over: its pid no longer exists.
      expect(() => process.kill(child.pid as number, 0)).toThrow();
    } finally {
      await fake.close();
      try {
        process.kill(child.pid as number, "SIGKILL");
      } catch {
        // Already gone.
      }
      sandboxEnvTeardown(home);
    }
  });

  it("refuses to adopt a tokenless legacy record and names the stop remedy", async () => {
    const { home, pidFile } = useSandboxedSession("ensure-worker");
    try {
      writeFileSync(pidFile, JSON.stringify({ pid: process.pid, port: 1 }));
      const spawnBridge = vi.fn();

      await expect(ensureBridge(spawnBridge)).rejects.toMatchObject({
        code: "BRIDGE_NOT_READY",
        message: expect.stringContaining("carries no capability token"),
        suggestions: expect.arrayContaining([
          expect.stringContaining("axis-browser stop"),
        ]),
      });
      expect(spawnBridge).not.toHaveBeenCalled();
    } finally {
      sandboxEnvTeardown(home);
    }
  });

  it("clears a dead tokenless record and starts a fresh bridge", async () => {
    const { home, pidFile } = useSandboxedSession("ensure-dead-legacy");
    const fake = await startFakeBridgeServer({
      shallow: "ok",
      deep: "ok",
      session: "ensure-dead-legacy",
    });
    try {
      process.env.CHROME_DEVTOOLS_AXI_PORT = String(fake.port);
      // A pid that is provably gone: exit immediately, then wait for the table
      // entry to disappear so isProcessAlive cannot race the reap.
      const dead = spawnMarkedBridge("process.exit(0);");
      await new Promise<void>((resolve) => dead.on("exit", () => resolve()));
      writeFileSync(
        pidFile,
        JSON.stringify({ pid: dead.pid as number, port: fake.port }),
      );
      const spawnBridge = vi.fn(
        () => new EventEmitter() as unknown as SpawnedBridge,
      );

      await expect(ensureBridge(spawnBridge)).resolves.toBe(fake.port);

      // The inert record was retired instead of refusing forever, and the
      // replacement bridge took the session.
      expect(spawnBridge).toHaveBeenCalledTimes(1);
      expect(existsSync(pidFile)).toBe(false);
    } finally {
      await fake.close();
      sandboxEnvTeardown(home);
    }
  });

  it("propagates an invalid CHROME_DEVTOOLS_AXI_PORT instead of falling back", async () => {
    const { home } = useSandboxedSession("ensure-worker");
    try {
      process.env.CHROME_DEVTOOLS_AXI_PORT = "not-a-port";
      const spawnBridge = vi.fn();
      await expect(ensureBridge(spawnBridge)).rejects.toThrow(
        /Invalid CHROME_DEVTOOLS_AXI_PORT "not-a-port"/,
      );
      expect(spawnBridge).not.toHaveBeenCalled();
    } finally {
      sandboxEnvTeardown(home);
    }
  });

  it("spawns fresh when the record's pid is dead, and fast-fails on its early exit", async () => {
    const { home, pidFile } = useSandboxedSession("ensure-worker");
    try {
      const dead = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
      const deadPid = dead.pid as number;
      await new Promise<void>((r) => dead.on("exit", () => r()));
      writeFileSync(
        pidFile,
        JSON.stringify({
          pid: deadPid,
          port: 1,
          token: "tok",
          startedAt: "t",
        }),
      );

      let spawnCalls = 0;
      await expect(
        ensureBridge(() => {
          spawnCalls += 1;
          const fake = new EventEmitter();
          setImmediate(() => fake.emit("exit", 1, null));
          return fake as unknown as SpawnedBridge;
        }),
      ).rejects.toMatchObject({
        code: "BRIDGE_NOT_READY",
        message: expect.stringContaining("before becoming ready"),
      });
      expect(spawnCalls).toBe(1);
    } finally {
      sandboxEnvTeardown(home);
    }
  });
});

/** Liveness probe used by the stop/terminate assertions. */
function bridgeStillAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("collectRootDirs", () => {
  it("always includes the invoking cwd", () => {
    expect(collectRootDirs("click", {})).toEqual([process.cwd()]);
  });

  it("adds roots only for the named tool's output path arguments", () => {
    const outputRoot = mkdtempSync(join(tmpdir(), "axi-tool-roots-"));
    try {
      const networkRoots = collectRootDirs("get_network_request", {
        responseFilePath: join(outputRoot, "response.json"),
        requestFilePath: join(outputRoot, "request.json"),
        filePath: "/private/input.txt",
      });
      expect(networkRoots).toEqual([process.cwd(), outputRoot]);
      expect(
        collectRootDirs("upload_file", {
          filePath: "/home/user/.ssh/id_rsa",
        }),
      ).toEqual([process.cwd()]);
    } finally {
      rmSync(outputRoot, { recursive: true, force: true });
    }
  });

  it("resolves relative output paths to absolute roots", () => {
    // A relative root would cross into the detached bridge process and be
    // re-resolved against *its* cwd — wherever the session's first command
    // happened to run — naming a different directory than the CLI meant.
    const fileRoots = collectRootDirs("get_network_request", {
      responseFilePath: "out/resp.json",
    });
    const dirRoots = collectRootDirs("lighthouse_audit", {
      outputDirPath: "./reports/run-1",
    });
    for (const root of [...fileRoots, ...dirRoots]) {
      expect(isAbsolute(root), `root must be absolute: ${root}`).toBe(true);
    }
  });

  it("uses the nearest existing ancestor for a new output directory", () => {
    const outputRoot = mkdtempSync(join(tmpdir(), "axi-dir-root-"));
    try {
      const roots = collectRootDirs("lighthouse_audit", {
        outputDirPath: join(outputRoot, "reports", "run-1"),
      });
      expect(roots).toEqual([process.cwd(), outputRoot]);
    } finally {
      rmSync(outputRoot, { recursive: true, force: true });
    }
  });

  it("ignores non-string and empty path arguments", () => {
    expect(
      collectRootDirs("take_screenshot", {
        filePath: "",
        outputDirPath: 42,
      }),
    ).toEqual([process.cwd()]);
  });
});
