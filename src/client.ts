/**
 * HTTP client for the Axis Browser bridge + bridge lifecycle management.
 */

import { spawn } from "node:child_process";
import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { request } from "node:http";
import { AxiError } from "axi-sdk-js";
import {
  getBridgeConfigSnapshot,
  PRIMARY_PID_FILE,
  resolveBridgeScript,
  type BridgeConfigSnapshot,
} from "./bridge.js";

const DEFAULT_PORT = 9224;
const BRIDGE_START_TIMEOUT_MS = 90_000;

export type ErrorCode =
  | "BRIDGE_NOT_READY"
  | "REF_NOT_FOUND"
  | "TIMEOUT"
  | "BROWSER_ERROR"
  | "VALIDATION_ERROR"
  | "UNKNOWN";

export class CdpError extends AxiError {
  constructor(
    message: string,
    public readonly code: ErrorCode,
    public readonly suggestions: string[] = [],
  ) {
    super(message, code, suggestions);
    this.name = "CdpError";
  }
}

interface PidInfo {
  pid: number;
  port: number;
  config?: BridgeConfigSnapshot;
}

function readPidFile(): PidInfo | null {
  try {
    if (!existsSync(PRIMARY_PID_FILE)) return null;
    const data = JSON.parse(readFileSync(PRIMARY_PID_FILE, "utf-8"));
    if (typeof data.pid === "number" && typeof data.port === "number") {
      return data as PidInfo;
    }
  } catch {
    // Ignore malformed pid files.
  }
  return null;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function httpGet(
  port: number,
  path: string,
  timeoutMs = 2000,
): Promise<{ statusCode: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request(
      { hostname: "127.0.0.1", port, path, method: "GET", timeout: timeoutMs },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () =>
          resolve({ statusCode: res.statusCode ?? 0, body: data }),
        );
      },
    );
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("timeout"));
    });
    req.end();
  });
}

function httpPost(
  port: number,
  path: string,
  body: unknown,
  timeoutMs = 120_000,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = request(
      {
        hostname: "127.0.0.1",
        port,
        path,
        method: "POST",
        timeout: timeoutMs,
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
        },
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          if (res.statusCode && res.statusCode >= 400) {
            reject(new Error(data));
          } else {
            resolve(data);
          }
        });
      },
    );
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("timeout"));
    });
    req.write(payload);
    req.end();
  });
}

async function checkBridgeHealth(port: number): Promise<boolean> {
  try {
    const resp = await httpGet(port, "/health");
    const data = JSON.parse(resp.body);
    return resp.statusCode === 200 && data.status === "ok";
  } catch {
    return false;
  }
}

type BridgePortState = "healthy" | "bridge_unhealthy" | "occupied_unknown" | "free";

async function inspectBridgePort(port: number): Promise<BridgePortState> {
  try {
    const resp = await httpGet(port, "/health");
    try {
      const data = JSON.parse(resp.body);
      if (data.status === "ok") return "healthy";
      if (typeof data.error === "string") return "bridge_unhealthy";
      return "occupied_unknown";
    } catch {
      return "occupied_unknown";
    }
  } catch {
    return "free";
  }
}

async function requestBridgeShutdown(port: number): Promise<boolean> {
  try {
    await httpPost(port, "/shutdown", {}, 2000);
    return true;
  } catch {
    return false;
  }
}

export function isLikelyAxisBridgeCommand(command: string): boolean {
  return /chrome-devtools-axi-bridge|dist\/bin\/chrome-devtools-axi\.js|bin\/chrome-devtools-axi-bridge\.ts/.test(
    command,
  );
}

function killPidListeningOnPort(port: number): boolean {
  if (process.platform === "win32") return false;
  try {
    const output = execFileSync(
      "lsof",
      ["-ti", `tcp:${port}`, "-sTCP:LISTEN"],
      { encoding: "utf-8" },
    ).trim();
    if (!output) return false;
    const pid = Number.parseInt(output.split("\n")[0] ?? "", 10);
    if (!Number.isFinite(pid)) return false;
    const command = execFileSync("ps", ["-p", String(pid), "-o", "command="], {
      encoding: "utf-8",
    }).trim();
    if (!isLikelyAxisBridgeCommand(command)) {
      return false;
    }
    process.kill(pid, "SIGTERM");
    return true;
  } catch {
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export function bridgeConfigsMatch(
  existing: BridgeConfigSnapshot | undefined,
  current: BridgeConfigSnapshot,
): boolean {
  if (!existing) return false;

  return (
    existing.autoConnect === current.autoConnect &&
    existing.browserUrl === current.browserUrl &&
    existing.userDataDir === current.userDataDir &&
    existing.headed === current.headed &&
    existing.wsHeaders === current.wsHeaders &&
    existing.chromeArgs.length === current.chromeArgs.length &&
    existing.chromeArgs.every((value, index) => value === current.chromeArgs[index])
  );
}

/**
 * Ensure the bridge is running, starting it if needed. Returns the port.
 */
export async function ensureBridge(): Promise<number> {
  const port = parseInt(
    process.env.CHROME_DEVTOOLS_AXI_PORT ?? String(DEFAULT_PORT),
    10,
  );
  const currentConfig = getBridgeConfigSnapshot();

  // Check existing bridge via PID file
  const pidInfo = readPidFile();
  if (pidInfo && isProcessAlive(pidInfo.pid)) {
    if (
      bridgeConfigsMatch(pidInfo.config, currentConfig) &&
      (await checkBridgeHealth(pidInfo.port))
    ) {
      return pidInfo.port;
    }
    try {
      process.kill(pidInfo.pid, "SIGTERM");
    } catch {
      // Best effort — if shutdown fails, the startup poll below will time out.
    }
  }

  const existingPortState = await inspectBridgePort(port);
  if (existingPortState === "healthy") {
    return port;
  }
  if (existingPortState === "bridge_unhealthy") {
    const shutdownRequested = await requestBridgeShutdown(port);
    if (!shutdownRequested) {
      killPidListeningOnPort(port);
    }
    const shutdownDeadline = Date.now() + 5_000;
    while (Date.now() < shutdownDeadline) {
      if ((await inspectBridgePort(port)) === "free") break;
      await sleep(200);
    }
  }
  const finalPortState = await inspectBridgePort(port);
  if (finalPortState === "bridge_unhealthy") {
    const killed = killPidListeningOnPort(port);
    if (killed) {
      const shutdownDeadline = Date.now() + 2_000;
      while (Date.now() < shutdownDeadline) {
        if ((await inspectBridgePort(port)) === "free") break;
        await sleep(200);
      }
    }
  }
  const postRecoveryPortState = await inspectBridgePort(port);
  if (postRecoveryPortState === "bridge_unhealthy") {
    throw new CdpError(
      `Bridge port ${port} is still held by an unhealthy local bridge`,
      "BRIDGE_NOT_READY",
      [
        `Run \`axis-browser stop\` and retry, or free port ${port} manually`,
        `Set CHROME_DEVTOOLS_AXI_PORT to another port if ${port} must stay occupied`,
      ],
    );
  }
  if (postRecoveryPortState === "occupied_unknown") {
    throw new CdpError(
      `Bridge port ${port} is already in use by another process`,
      "BRIDGE_NOT_READY",
      [
        `Free port ${port} or set CHROME_DEVTOOLS_AXI_PORT to another port`,
        "If this is an orphaned local bridge, stop it and retry",
      ],
    );
  }

  // Start a new bridge

  const bridgeScript = resolveBridgeScript(import.meta.dirname);
  // Try .ts first (dev mode), fall back to .js (built)
  const script = existsSync(bridgeScript.replace(/\.js$/, ".ts"))
    ? bridgeScript.replace(/\.js$/, ".ts")
    : bridgeScript;
  const runner = script.endsWith(".ts") ? "tsx" : "node";

  const child = spawn(
    runner === "tsx" ? "npx" : "node",
    runner === "tsx" ? ["tsx", script] : [script],
    {
      stdio: "ignore",
      env: { ...process.env, CHROME_DEVTOOLS_AXI_PORT: String(port) },
      detached: true,
    },
  );
  child.unref();

  // Poll for health. A fresh npx install of chrome-devtools-mcp can be slow.
  const deadline = Date.now() + BRIDGE_START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await checkBridgeHealth(port)) {
      return port;
    }
    await sleep(500);
  }

  throw new CdpError(`Bridge failed to start within ${BRIDGE_START_TIMEOUT_MS / 1000}s`, "BRIDGE_NOT_READY", [
    "Check that chrome-devtools-mcp is installed: npx chrome-devtools-mcp@latest --help",
  ]);
}

/**
 * Call an MCP tool via the bridge. Returns the text result.
 */
export async function callTool(
  name: string,
  args: Record<string, unknown> = {},
): Promise<string> {
  const port = await ensureBridge();

  try {
    const resp = await httpPost(port, "/call", { name, args });
    const data = JSON.parse(resp);
    if (data.error) {
      throw new Error(data.error);
    }
    return data.result ?? "";
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw mapErrorMessage(message);
  }
}

export function mapErrorMessage(message: string): CdpError {
  if (message.includes("ECONNREFUSED") || message.includes("ECONNRESET")) {
    return new CdpError("Bridge is not running", "BRIDGE_NOT_READY", [
      "Run `axis-browser open <url>` — the bridge starts automatically",
    ]);
  }
  if (
    (message.includes("uid") || message.includes("element")) &&
    (message.includes("not found") || message.includes("invalid"))
  ) {
    return new CdpError(message, "REF_NOT_FOUND", [
      "Run `axis-browser snapshot` to see available elements and their @uid refs",
    ]);
  }
  if (message.includes("timeout") || message.includes("timed out")) {
    return new CdpError(message, "TIMEOUT", [
      "Run `axis-browser snapshot` to see current page state",
    ]);
  }
  // Try to parse JSON error
  try {
    const parsed = JSON.parse(message);
    if (parsed.error) {
      return new CdpError(parsed.error, "BROWSER_ERROR", [
        "Run `axis-browser snapshot` to see current page state",
      ]);
    }
  } catch {
    // Not JSON
  }
  return new CdpError(message, "UNKNOWN");
}

/**
 * Get the current page snapshot without starting the bridge.
 * Returns null if the bridge is not running or healthy.
 */
export async function getSessionSnapshotIfRunning(): Promise<string | null> {
  const pidInfo = readPidFile();
  if (!pidInfo || !isProcessAlive(pidInfo.pid)) {
    return null;
  }
  if (!(await checkBridgeHealth(pidInfo.port))) {
    return null;
  }
  try {
    const resp = await httpPost(
      pidInfo.port,
      "/call",
      { name: "take_snapshot", args: {} },
      5000,
    );
    const data = JSON.parse(resp);
    if (data.error) return null;
    return data.result ?? null;
  } catch {
    return null;
  }
}

/**
 * Stop the bridge process.
 */
export async function stopBridge(): Promise<boolean> {
  const pidInfo = readPidFile();
  if (pidInfo && isProcessAlive(pidInfo.pid)) {
    process.kill(pidInfo.pid, "SIGTERM");
    return true;
  }
  const port = parseInt(
    process.env.CHROME_DEVTOOLS_AXI_PORT ?? String(DEFAULT_PORT),
    10,
  );
  const portState = await inspectBridgePort(port);
  if (portState === "healthy" || portState === "bridge_unhealthy") {
    const shutdownRequested = await requestBridgeShutdown(port);
    return shutdownRequested || killPidListeningOnPort(port);
  }
  return false;
}
