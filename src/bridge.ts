/**
 * Persistent MCP bridge server for chrome-devtools-axi.
 *
 * Spawns chrome-devtools-mcp as a child process and maintains a single
 * persistent MCP session. Exposes a simple HTTP API:
 *   POST /call  { name, args }  → { result }
 *   GET  /tools                 → [{ name, description }]
 *   GET  /health                → { status: "ok" }
 *
 * Writes a PID file to ~/.axis-browser/bridge.pid on startup.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";

const DEFAULT_PORT = Number.parseInt(
  process.env.CHROME_DEVTOOLS_AXI_PORT ?? "9224",
  10,
);
export const PRIMARY_STATE_DIR = join(homedir(), ".axis-browser");
export const PRIMARY_PID_FILE = join(PRIMARY_STATE_DIR, "bridge.pid");
export const MCP_CACHE_DIR = join(PRIMARY_STATE_DIR, "npm-cache");

export interface BridgeConfigSnapshot {
  autoConnect: boolean;
  browserUrl: string | null;
  userDataDir: string | null;
  headed: boolean;
  chromeArgs: string[];
  wsHeaders: string | null;
}

export interface BridgeContentBlock {
  type: string;
  text?: string;
}

export interface BridgeCallPayload {
  name: string;
  args: Record<string, unknown>;
}

interface BridgeToolDescription {
  name: string;
  description?: string;
}

export interface BridgeClient {
  listTools(): Promise<{ tools: BridgeToolDescription[] }>;
  callTool(request: {
    name: string;
    arguments: Record<string, unknown>;
  }): Promise<unknown>;
  close(): Promise<void>;
}

export async function isBridgeClientConnected(
  client: BridgeClient,
): Promise<boolean> {
  try {
    await client.listTools();
    return true;
  } catch {
    return false;
  }
}

export function getBridgeConfigSnapshot(
  env: NodeJS.ProcessEnv = process.env,
): BridgeConfigSnapshot {
  const rawChromeArgs = env.CHROME_DEVTOOLS_AXI_CHROME_ARGS?.trim() ?? "";
  const autoConnect = env.CHROME_DEVTOOLS_AXI_AUTO_CONNECT === "1";
  const browserUrl = autoConnect
    ? null
    : env.CHROME_DEVTOOLS_AXI_BROWSER_URL ?? null;
  const usingBrowserUrl = browserUrl !== null;
  const isWsBrowserUrl = browserUrl !== null && /^wss?:\/\//i.test(browserUrl);

  return {
    autoConnect,
    browserUrl,
    userDataDir:
      autoConnect || usingBrowserUrl
        ? null
        : env.CHROME_DEVTOOLS_AXI_USER_DATA_DIR ?? null,
    headed:
      autoConnect || usingBrowserUrl
        ? false
        : env.CHROME_DEVTOOLS_AXI_HEADED === "1",
    chromeArgs: rawChromeArgs ? rawChromeArgs.split(/\s+/) : [],
    wsHeaders: isWsBrowserUrl ? env.CHROME_DEVTOOLS_AXI_WS_HEADERS ?? null : null,
  };
}

function writePidFile(port: number): void {
  mkdirSync(PRIMARY_STATE_DIR, { recursive: true });
  writeFileSync(
    PRIMARY_PID_FILE,
    JSON.stringify({ pid: process.pid, port, config: getBridgeConfigSnapshot() }),
  );
}

function removePidFile(): void {
  try {
    unlinkSync(PRIMARY_PID_FILE);
  } catch {
    // Already gone — fine
  }
}

export function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function extractToolText(content: BridgeContentBlock[]): string {
  return content
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n");
}

function getToolContent(result: unknown): BridgeContentBlock[] {
  if (
    !result ||
    typeof result !== "object" ||
    !("content" in result) ||
    !Array.isArray(result.content)
  ) {
    return [];
  }
  return result.content as BridgeContentBlock[];
}

export function parseBridgeCallPayload(body: string): BridgeCallPayload {
  let payload: { name?: unknown; args?: unknown };
  try {
    payload = JSON.parse(body) as { name?: unknown; args?: unknown };
  } catch {
    throw new Error("Invalid bridge request payload");
  }
  if (typeof payload.name !== "string" || payload.name.length === 0) {
    throw new Error("Invalid bridge request payload");
  }
  if (payload.args === undefined) {
    return { name: payload.name, args: {} };
  }
  if (
    payload.args === null ||
    typeof payload.args !== "object" ||
    Array.isArray(payload.args)
  ) {
    throw new Error("Invalid bridge request payload");
  }
  return { name: payload.name, args: payload.args as Record<string, unknown> };
}

export function resolveBridgeScript(importMetaDir: string): string {
  const builtScript = resolve(
    importMetaDir,
    "../bin/chrome-devtools-axi-bridge.js",
  );
  if (builtScript.includes(`${resolve(importMetaDir, "..")}/bin/`)) {
    // When the installed CLI is executing from dist/, prefer the built bridge so
    // startup does not depend on `tsx` resolution from the caller's cwd.
    const distDir = `${resolve(importMetaDir, "..")}`;
    if (distDir.endsWith("/dist")) {
      return builtScript;
    }
  }
  const sourceScript = builtScript.replace(/\.js$/, ".ts");
  return existsSync(sourceScript) ? sourceScript : builtScript;
}

export function getTransportEnv(
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const mergedEnv = {
    ...env,
    npm_config_cache: MCP_CACHE_DIR,
  };
  return Object.fromEntries(
    Object.entries(mergedEnv).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
}

async function readRequestBody(req: IncomingMessage): Promise<string> {
  let body = "";
  for await (const chunk of req) {
    body += typeof chunk === "string" ? chunk : chunk.toString("utf-8");
  }
  return body;
}

function writeJson(
  res: ServerResponse,
  statusCode: number,
  payload: unknown,
): void {
  res.statusCode = statusCode;
  res.end(JSON.stringify(payload));
}

async function handleToolsRequest(
  client: BridgeClient,
  res: ServerResponse,
): Promise<void> {
  const result = await client.listTools();
  writeJson(
    res,
    200,
    result.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
    })),
  );
}

async function handleCallRequest(
  client: BridgeClient,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const body = await readRequestBody(req);
  const payload = parseBridgeCallPayload(body);
  const result = await client.callTool({
    name: payload.name,
    arguments: payload.args,
  });
  writeJson(res, 200, { result: extractToolText(getToolContent(result)) });
}

export type ShutdownHandler = () => Promise<void>;

export async function handleBridgeRequest(
  client: BridgeClient,
  req: IncomingMessage,
  res: ServerResponse,
  shutdown?: ShutdownHandler,
): Promise<void> {
  res.setHeader("Content-Type", "application/json");

  if (req.method === "GET" && req.url === "/health") {
    if (await isBridgeClientConnected(client)) {
      writeJson(res, 200, { status: "ok" });
    } else {
      writeJson(res, 503, { error: "Not connected" });
    }
    return;
  }

  try {
    if (req.method === "GET" && req.url === "/tools") {
      await handleToolsRequest(client, res);
      return;
    }

    if (req.method === "POST" && req.url === "/call") {
      await handleCallRequest(client, req, res);
      return;
    }

    if (req.method === "POST" && req.url === "/shutdown" && shutdown) {
      writeJson(res, 200, { status: "shutting_down" });
      setImmediate(() => {
        void shutdown();
      });
      return;
    }
  } catch (error) {
    writeJson(res, 500, { error: getErrorMessage(error) });
    return;
  }

  writeJson(res, 404, { error: "not found" });
}

export function createBridgeServer(
  client: BridgeClient,
  shutdown?: ShutdownHandler,
): Server {
  return createServer((req, res) => {
    void handleBridgeRequest(client, req, res, shutdown);
  });
}

function logBridgeMessage(message: string): void {
  process.stderr.write(`[chrome-devtools-axi] ${message}\n`);
}

function writeReadySignal(): void {
  process.stdout.write("READY\n");
}

export function buildTransportArgs(): string[] {
  const args = ["-y", "chrome-devtools-mcp@latest"];

  const autoConnect = process.env.CHROME_DEVTOOLS_AXI_AUTO_CONNECT === "1";
  const browserUrl = process.env.CHROME_DEVTOOLS_AXI_BROWSER_URL;
  const userDataDir = process.env.CHROME_DEVTOOLS_AXI_USER_DATA_DIR;

  if (autoConnect) {
    // Chrome 144+ built-in remote debugging via chrome://inspect/#remote-debugging.
    // Connects to the user's running Chrome - no separate browser launched.
    args.push("--autoConnect");
  } else if (browserUrl) {
    // Connect to an existing Chrome instance - skip --isolated and --headless
    // since the user manages the browser lifecycle externally.
    // ws://|wss:// route to --wsEndpoint (direct WebSocket), http(s):// to --browserUrl
    // (which fetches /json/version to discover the WebSocket URL).
    const isWs = /^wss?:\/\//i.test(browserUrl);
    if (isWs) {
      args.push(`--wsEndpoint=${browserUrl}`);
      const wsHeaders = process.env.CHROME_DEVTOOLS_AXI_WS_HEADERS;
      if (wsHeaders) {
        let parsedHeaders: unknown;
        try {
          parsedHeaders = JSON.parse(wsHeaders);
        } catch {
          throw new Error("CHROME_DEVTOOLS_AXI_WS_HEADERS must be valid JSON");
        }
        if (
          parsedHeaders === null ||
          typeof parsedHeaders !== "object" ||
          Array.isArray(parsedHeaders)
        ) {
          throw new Error(
            "CHROME_DEVTOOLS_AXI_WS_HEADERS must be a JSON object",
          );
        }
        args.push(`--wsHeaders=${wsHeaders}`);
      }
    } else {
      args.push(`--browserUrl=${browserUrl}`);
    }
  } else {
    if (userDataDir) {
      // Persistent profile — skip --isolated so the profile is preserved.
      args.push(`--userDataDir=${userDataDir}`);
    } else {
      args.push("--isolated");
    }
    if (process.env.CHROME_DEVTOOLS_AXI_HEADED !== "1") {
      args.push("--headless");
    }
  }

  const extraChromeArgs = process.env.CHROME_DEVTOOLS_AXI_CHROME_ARGS;
  if (extraChromeArgs) {
    for (const arg of extraChromeArgs.trim().split(/\s+/)) {
      args.push(`--chrome-arg=${arg}`);
    }
  }

  return args;
}

function createTransport(): StdioClientTransport {
  mkdirSync(MCP_CACHE_DIR, { recursive: true });
  return new StdioClientTransport({
    command: "npx",
    args: buildTransportArgs(),
    env: getTransportEnv(),
  });
}

function createBridgeClient(): Client {
  return new Client({ name: "chrome-devtools-axi-bridge", version: "1.0.0" });
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
  });
}

export async function runBridge(port = DEFAULT_PORT): Promise<void> {
  const transport = createTransport();
  const client = createBridgeClient();
  await client.connect(transport);
  logBridgeMessage("Connected to chrome-devtools-mcp");

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    removePidFile();
    await closeServer(server);
    await client.close();
    await transport.close();
    process.exit(0);
  };

  const server = createBridgeServer(client, shutdown);
  server.listen(port, "127.0.0.1", () => {
    writePidFile(port);
    logBridgeMessage(`Listening on http://127.0.0.1:${port}`);
    writeReadySignal();
  });

  // Kill our entire process group on exit so chrome-devtools-mcp children
  // don't survive as orphans. The bridge is spawned with detached:true,
  // making it a process group leader — all children share our PGID.
  process.on("exit", () => {
    removePidFile();
    if (process.platform === "win32") {
      return;
    }
    try {
      process.kill(-process.pid, "SIGTERM");
    } catch {
      // Already dead or not a group leader
    }
  });

  process.on("SIGTERM", () => {
    void shutdown();
  });
  process.on("SIGINT", () => {
    void shutdown();
  });
}
