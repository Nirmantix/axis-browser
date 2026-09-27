/**
 * Persistent MCP bridge server for axis-browser.
 *
 * Selects either a local/proxy stdio session or a direct Streamable HTTP
 * session and maintains it persistently. Exposes a simple HTTP API:
 *   POST /call  { name, args }  → { result }
 *   GET  /tools                 → [{ name, description }]
 *   GET  /health                → { status: "ok", session } or 503 { status: "error", error }
 *   GET  /health?deep=1         → also verifies the attached CDP target; 503 may include reason,
 *                                 200 adds pageIdentityChanged when the probe consumed
 *                                 chrome-devtools-mcp's one-shot reconnect marker *and*
 *                                 that dropped a persisted page selection
 *
 * Writes a PID file to the active session's state dir on startup
 * (~/.axis-browser/bridge.pid for the default session; named sessions
 * nest under sessions/<name>/ - see src/sessions.ts).
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ListRootsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { execFileSync } from "node:child_process";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { existsSync } from "node:fs";
import { timingSafeEqual } from "node:crypto";
import { basename, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import {
  BRIDGE_PORT_IN_USE_EXIT_CODE,
  PAGE_IDENTITY_CHANGED_ERROR,
  resolveBridgeScript,
} from "./bridge-script.js";
import { clearSelectedPageId } from "./selected-page.js";
import { readProcessIdentity } from "./process-identity.js";
import {
  BRIDGE_AUTH_SCHEME,
  BRIDGE_TOKEN_HEADER,
  clearBridgeRecord,
  generateBridgeToken,
  resolveSessionName,
  resolveSessionPort,
  resolveSessionStateChain,
  writeBridgeRecord,
  type AuthenticatedBridgeRecord,
} from "./sessions.js";
import { hardenStateDirs, StateDirError } from "./state-dir.js";
import { resolveMode, resolveUserDataDir } from "./mode.js";

// Re-exported so existing bridge consumers keep a single import surface; the
// definitions live in the MCP-free ./bridge-script.js (see its header).
export {
  BRIDGE_PORT_IN_USE_EXIT_CODE,
  PAGE_IDENTITY_CHANGED_ERROR,
  resolveBridgeScript,
};

export interface BridgeContentBlock {
  type: string;
  text?: string;
}

export interface BridgeCallPayload {
  name: string;
  args: Record<string, unknown>;
  /**
   * Absolute directories the caller wants added to the MCP workspace roots for
   * this call, so file-writing tools may write there. See
   * {@link RootsAwareClient.applyRoots} and the roots negotiation in
   * `runBridge`.
   */
  roots?: string[];
}

interface BridgeToolDescription {
  name: string;
  description?: string;
}

export interface BridgeClient {
  listTools(): Promise<{ tools: BridgeToolDescription[] }>;
  callTool(
    request: {
      name: string;
      arguments: Record<string, unknown>;
    },
    roots?: string[],
  ): Promise<unknown>;
  close(): Promise<void>;
  /**
   * Negotiate the MCP workspace roots to the given absolute directories before
   * the next tool call, so a caller-supplied write path outside the OS temp
   * directory passes chrome-devtools-mcp's `validatePath`. Optional so test
   * fakes need not implement it; the real client always does.
   */
  applyRoots?(dirs: string[]): Promise<void>;
}

/** A {@link BridgeClient} that always negotiates MCP roots. */
export interface RootsAwareClient extends BridgeClient {
  applyRoots(dirs: string[]): Promise<void>;
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

/**
 * Probe whether the bridge's underlying CDP target is reachable. Drives one
 * round-trip MCP tool call (`list_pages`) that requires a live browser/CDP
 * connection — `listTools()` alone only confirms the local MCP server is up,
 * not that the attached browser is still alive. Used by `/health?deep=1` so
 * `ensureBridge` can detect a stale bridge after the user kills + restarts
 * the underlying Chrome/Electron target.
 *
 * It also reports chrome-devtools-mcp's one-shot reconnect marker (see
 * {@link didMcpPageIdentityChange}) rather than only its own reachability:
 * `ensureBridge` deep-probes before every command, so after an in-process
 * browser reconnect this `list_pages` is the first call to see the marker and
 * consumes it, leaving none for the `/call` that follows. `handleBridgeRequest`
 * relays that to the CLI, which otherwise has no way to tell a selection the
 * reconnect just dropped from one that was never made.
 */
export async function isBridgeTargetReachable(
  client: BridgeClient,
): Promise<
  { ok: true; pageIdentityChanged: boolean } | { ok: false; reason: string }
> {
  try {
    const result = await client.callTool({
      name: "list_pages",
      arguments: {},
    });
    if (isToolResultError(result)) {
      const reason = extractToolText(getToolContent(result));
      return { ok: false, reason: reason || 'Tool "list_pages" failed' };
    }
    return {
      ok: true,
      pageIdentityChanged: didMcpPageIdentityChange(result),
    };
  } catch (error) {
    return { ok: false, reason: getErrorMessage(error) };
  }
}

/**
 * This bridge's capability token. Set once, when the port is bound; until then
 * every request is refused, because the window between `listen` succeeding and
 * the record being written is small but real and a bearer credential has no safe
 * "open" state.
 */
let bridgeToken: string | null = null;

/** The token this bridge validates requests against; null until it is bound. */
export function currentBridgeToken(): string | null {
  return bridgeToken;
}

/**
 * Arm or disarm the capability gate directly. Exported for tests.
 *
 * Production arms the token only through {@link publishBridgeCapability}, which
 * first proves the state directory can hold a secret and that this process can be
 * identified. Unit tests that drive {@link handleBridgeRequest} without a bound
 * port need the gate itself under control; routing them through the filesystem
 * would test the record writer instead of the request handler.
 */
export function setBridgeTokenForTest(token: string | null): void {
  bridgeToken = token;
}

/**
 * Publish this bridge's capability: verify the state directory can hold a
 * secret, then write the record atomically and arm the token.
 *
 * Called from the `listen` callback, so the port is already bound and this
 * process is the winner of any same-session race — a loser exits on EADDRINUSE
 * and never gets here, which is what keeps it from publishing over the winner's
 * record. It also runs before READY is printed, so no CLI can read a record
 * whose token this bridge does not yet honour.
 *
 * Fails closed. A directory that cannot be proven private, or a process whose
 * own start time cannot be read, means the record must not be written: the first
 * would hand the token to every local user, and the second would leave a bridge
 * that `stop` can never verify and therefore never safely terminate.
 */
export function publishBridgeCapability(port: number): void {
  hardenStateDirs(resolveSessionStateChain());
  const identity = readProcessIdentity(process.pid);
  if (identity === null) {
    throw new Error(
      "Cannot establish this bridge process's own start time, so its record could never be verified before a stop. Refusing to publish a capability for a process that cannot be identified.",
    );
  }
  const token = generateBridgeToken();
  const record: AuthenticatedBridgeRecord = {
    pid: process.pid,
    port,
    token,
    startedAt: identity.startedAt,
  };
  writeBridgeRecord(record);
  bridgeToken = token;
}

/**
 * Drop our own record on the way out — and only our own. A bind-race loser never
 * armed a token, so it returns without touching the winner's record; a bridge
 * whose record was replaced by a newer one is left alone for the same reason.
 */
function unpublishBridgeCapability(): void {
  if (bridgeToken === null) return;
  clearBridgeRecord({ pid: process.pid, token: bridgeToken });
}

export function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Hostnames that identify the loopback interface. The bridge is a persistent
 * unauthenticated loopback service on a known port, so it is the target of
 * DNS-rebinding: a malicious page rebinds its own domain to 127.0.0.1 and the
 * browser then issues same-origin requests that hit the bridge. Binding to
 * 127.0.0.1 does NOT stop this - the packets still arrive on loopback. The one
 * thing a rebound request cannot hide is that it carries the attacker's own
 * domain in the `Host` (and `Origin`) header, and those are forbidden headers
 * page JavaScript cannot forge. Requiring both to name loopback is therefore
 * THE anti-rebinding control (see GHSA-x439-jhfh-v9x2).
 */
const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "localhost", "::1"]);

function isLoopbackHostname(hostname: string): boolean {
  // Node's URL parser keeps IPv6 hostnames bracketed (`[::1]`); strip the
  // brackets so the bare literal matches LOOPBACK_HOSTNAMES.
  const normalized = hostname
    .replace(/^\[/, "")
    .replace(/\]$/, "")
    .toLowerCase();
  return LOOPBACK_HOSTNAMES.has(normalized);
}

/**
 * Extract the hostname from a `Host` header value, dropping any `:port` suffix.
 * Handles bracketed IPv6 (`[::1]:9224` -> `::1`) and bare IPv6 literals
 * (`::1`). Returns null for an empty/whitespace-only value.
 */
export function extractHostHeaderHostname(hostHeader: string): string | null {
  const trimmed = hostHeader.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.startsWith("[")) {
    const end = trimmed.indexOf("]");
    if (end === -1) return null;
    // Anything after the closing bracket must be a `:port` suffix. Reject
    // trailing garbage (e.g. "[::1]evil.com") instead of treating it as the
    // loopback literal "::1" - this keeps the Host parser as strict as the
    // Origin path (new URL(...).hostname), which already rejects the analogue.
    const rest = trimmed.slice(end + 1);
    if (rest.length > 0 && !rest.startsWith(":")) return null;
    return trimmed.slice(1, end);
  }
  const firstColon = trimmed.indexOf(":");
  if (firstColon === -1) return trimmed;
  // A second colon means this is a bare (unbracketed) IPv6 literal with no
  // port, not a host:port pair - keep the whole string as the hostname.
  if (trimmed.indexOf(":", firstColon + 1) !== -1) return trimmed;
  return trimmed.slice(0, firstColon);
}

/**
 * True when the `Host` header is present and names the loopback interface.
 * A missing Host, or one naming any other host (e.g. a rebound
 * `evil.attacker.com`), is rejected.
 *
 * The parameter is `unknown` rather than `string | undefined` because this gate
 * is the last thing between a remote page and CDP: an unexpected shape — a
 * repeated header delivered as an array, which Node's parser does not produce but
 * a proxy, a future Node, or a hand-built request can — must answer "refuse".
 * Throwing instead would escape as a 500 from the request handler and tell the
 * caller nothing, while a refusal is both correct and loggable.
 */
export function isAllowedBridgeHost(host: unknown): boolean {
  if (typeof host !== "string") return false;
  const hostname = extractHostHeaderHostname(host);
  if (hostname === null) return false;
  return isLoopbackHostname(hostname);
}

/**
 * True when the request carries no `Origin` (the CLI client sends none) or an
 * `Origin` whose hostname is loopback. A present-but-non-loopback or
 * unparseable Origin is rejected.
 */
export function isRequestOriginAllowed(req: IncomingMessage): boolean {
  const rawOrigin = req.headers.origin;
  if (rawOrigin === undefined) return true;
  const origin = Array.isArray(rawOrigin) ? rawOrigin[0] : rawOrigin;
  if (origin === undefined || origin.length === 0) return true;
  let hostname: string;
  try {
    hostname = new URL(origin).hostname;
  } catch {
    return false;
  }
  return isLoopbackHostname(hostname);
}

/**
 * Anti-rebinding gate: a request is allowed only when its `Host` header names
 * loopback and any `Origin` header also names loopback. Checked FIRST on every
 * route (health included) so a rebound request is refused before any CDP tool
 * can run.
 */
export function isRequestAllowed(req: IncomingMessage): boolean {
  return isAllowedBridgeHost(req.headers.host) && isRequestOriginAllowed(req);
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

/**
 * Whether an MCP tool result signals failure (`isError: true`). chrome-devtools-mcp
 * reports recoverable tool failures - a denied file write, a bad selector, a
 * navigation error - as a *successful* JSON-RPC response carrying `isError`, not
 * as a protocol error. Treating that as success is how a rejected screenshot got
 * reported as written (issue #96); the bridge must surface it as a failure so the
 * CLI exits non-zero with the tool's own message.
 */
export function isToolResultError(result: unknown): boolean {
  return (
    !!result &&
    typeof result === "object" &&
    "isError" in result &&
    (result as { isError?: unknown }).isError === true
  );
}

const MCP_RECONNECT_NOTICE_PREFIX =
  "Note: the browser was restarted or reconnected since the last call.";

/**
 * chrome-devtools-mcp keeps its stdio process alive when Chrome reconnects,
 * but deliberately reissues every page id. Its one-shot reconnect marker is
 * the authoritative identity boundary; the bridge must observe it before the
 * response is flattened or a persisted AXI selection can outlive the ids it
 * belongs to.
 */
export function didMcpPageIdentityChange(
  result: unknown,
  flattenedText?: string,
): boolean {
  if (hasStructuredReconnectMarker(result)) return true;

  // Upstream only includes structuredContent behind its experimental flag; its
  // default protocol response carries the same one-shot marker as text. Only
  // the first line is consulted: page-owned strings that upstream interpolates
  // verbatim (a dialog message, a title) may contain raw newlines and would
  // otherwise open a line of their own that starts with this clause. Within
  // that first line the match stays a prefix, so a reworded tail or a renamed
  // `list_pages` still registers.
  //
  // UNVERIFIED DEPENDENCY CONTRACT: this assumes chrome-devtools-mcp emits the
  // reconnect notice as the FIRST line of the flattened body (and, for the
  // sibling matcher in `src/client.ts`, appends `Error: <message>` LAST).
  // Nothing in the test suite pins that order - chrome-devtools-mcp is spawned
  // via npx, not installed as a devDependency, so there is no build to assert
  // against. If upstream reorders, the consequence is a less accurate message,
  // not a silent retarget: `isMissingPageError` is an independent net on the
  // last non-empty line, and upstream hands out page ids from a process-wide
  // monotonic counter, so a stale id fails to resolve rather than landing on
  // an unrelated page.
  const text = flattenedText ?? extractToolText(getToolContent(result));
  const [firstLine = ""] = text.split(/\r?\n/, 1);
  return firstLine.trim().startsWith(MCP_RECONNECT_NOTICE_PREFIX);
}

function hasStructuredReconnectMarker(result: unknown): boolean {
  if (!result || typeof result !== "object") return false;
  if (!("structuredContent" in result)) return false;
  const structured = (result as { structuredContent?: unknown })
    .structuredContent;
  return (
    !!structured &&
    typeof structured === "object" &&
    "reconnected" in structured &&
    (structured as { reconnected?: unknown }).reconnected === true
  );
}

export function parseBridgeCallPayload(body: string): BridgeCallPayload {
  let payload: { name?: unknown; args?: unknown; roots?: unknown };
  try {
    payload = JSON.parse(body) as {
      name?: unknown;
      args?: unknown;
      roots?: unknown;
    };
  } catch {
    throw new Error("Invalid bridge request payload");
  }
  if (typeof payload.name !== "string" || payload.name.length === 0) {
    throw new Error("Invalid bridge request payload");
  }
  const roots = parseRootsField(payload.roots);
  if (payload.args === undefined) {
    return { name: payload.name, args: {}, ...(roots ? { roots } : {}) };
  }
  if (
    payload.args === null ||
    typeof payload.args !== "object" ||
    Array.isArray(payload.args)
  ) {
    throw new Error("Invalid bridge request payload");
  }
  return {
    name: payload.name,
    args: payload.args as Record<string, unknown>,
    ...(roots ? { roots } : {}),
  };
}

/**
 * Validate the optional `roots` field: absent, or an array of absolute
 * directory paths. Any other shape is a malformed payload and is rejected
 * loudly rather than silently dropped, so a client bug can't quietly disable
 * roots negotiation or make roots depend on the bridge process's cwd.
 */
function parseRootsField(roots: unknown): string[] | undefined {
  if (roots === undefined) return undefined;
  if (
    !Array.isArray(roots) ||
    !roots.every((r) => typeof r === "string" && isAbsolute(r))
  ) {
    throw new Error("Invalid bridge request payload");
  }
  return roots as string[];
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
  onPageIdentityChanged?: () => boolean | void,
): Promise<void> {
  const body = await readRequestBody(req);
  const payload = parseBridgeCallPayload(body);
  const result = await client.callTool(
    {
      name: payload.name,
      arguments: payload.args,
    },
    payload.roots,
  );
  const text = extractToolText(getToolContent(result));
  const pageIdentityChanged = didMcpPageIdentityChange(result, text);
  if (pageIdentityChanged) onPageIdentityChanged?.();
  // The reconnect that reissued every page id happened *during* this call, so
  // an explicit `pageId` in the request was resolved against the new id space:
  // the content may belong to another tab, and upstream's own failure text
  // ("No page found", because page ids come from a monotonic counter) names a
  // missing page instead of the reconnect that caused it. Report the identity
  // boundary either way, ahead of the tool-error branch, so the caller
  // re-selects rather than hunting for a closed tab. Only a call that named no
  // page - `list_pages`, `new_page` - targeted no particular tab and is left
  // alone. The home view probe is NOT one of those: it always sends the
  // persisted `pageId`, so after a reconnect it takes this branch, `postTool`
  // throws, and `getSessionSnapshotIfRunning` degrades to no page. That
  // degradation is intentional - rendering a snapshot resolved in a reissued
  // id space is exactly the silent retarget this branch exists to prevent.
  if (pageIdentityChanged && typeof payload.args.pageId === "number") {
    writeJson(res, 200, { error: PAGE_IDENTITY_CHANGED_ERROR });
    return;
  }
  if (isToolResultError(result)) {
    // Surface the tool's own failure text as an error so the CLI throws and
    // exits non-zero instead of printing success (issue #96).
    writeJson(res, 200, { error: text || `Tool "${payload.name}" failed` });
    return;
  }
  writeJson(res, 200, { result: text });
}

/** Longest hostname DNS permits; anything longer is not a hostname. */
const MAX_LOGGED_HOSTNAME = 253;

/**
 * Strip what would let a caller forge diagnostics: C0/C1 controls (including
 * CR/LF, which would inject fake log lines) and anything past a legal hostname
 * length. Applied to every derived value before it reaches the log.
 */
function sanitizeLoggedHostname(hostname: string | null): string {
  if (hostname === null || hostname.length === 0) return "(unparseable)";
  const stripped = hostname.replace(/[\u0000-\u001f\u007f-\u009f]/g, "");
  const capped = stripped.slice(0, MAX_LOGGED_HOSTNAME);
  return capped.length > 0 ? capped : "(unparseable)";
}

function originHostname(origin: string | undefined): string | null {
  if (origin === undefined || origin.length === 0) return null;
  try {
    // The same parse isRequestOriginAllowed used to decide the refusal, so the
    // log names exactly the host that was judged.
    return new URL(origin).hostname;
  } catch {
    return null;
  }
}

/**
 * A diagnosable description of a request the anti-rebinding gate refused.
 *
 * The previous log line interpolated the raw `Host` header, the raw `Origin`
 * header, and `req.url`. All three are caller-controlled, so anything that could
 * reach the port could write arbitrary text into the bridge's diagnostics:
 * credentials smuggled into a query string, a forged `Origin`, or a newline that
 * fakes subsequent log entries. Only derived values are logged now — the hostname
 * the gate itself parsed, a fixed refusal category, and the method. Never the raw
 * headers, the URL, the path, the query, the port, or the token.
 */
export function describeRejectedRequest(req: IncomingMessage): string {
  const hostHeader = req.headers.host;
  const hostAllowed = isAllowedBridgeHost(hostHeader);
  const hostHostname =
    typeof hostHeader === "string"
      ? extractHostHeaderHostname(hostHeader)
      : null;

  // Host first: when it fails, the origin was never the reason, and logging an
  // attacker-supplied origin as the cause would misdirect the operator.
  if (!hostAllowed) {
    return `Rejected ${req.method ?? "REQUEST"}: host hostname=${sanitizeLoggedHostname(hostHostname)}`;
  }
  const rawOrigin = req.headers.origin;
  const origin = Array.isArray(rawOrigin) ? rawOrigin[0] : rawOrigin;
  return `Rejected ${req.method ?? "REQUEST"}: origin hostname=${sanitizeLoggedHostname(originHostname(origin))}`;
}

/**
 * Whether the request presents this bridge's capability token.
 *
 * Fails closed when the token is not armed yet (the port is bound but the record
 * is not published) and compares in constant time when it is. The length check
 * comes first because `timingSafeEqual` throws on a length mismatch, and a
 * malformed header must produce a 401 rather than a 500 that also tells the
 * caller its guess had the right length.
 */
export function hasValidBridgeToken(req: IncomingMessage): boolean {
  const expected = bridgeToken;
  if (expected === null) return false;
  const raw = req.headers[BRIDGE_TOKEN_HEADER];
  const presented = Array.isArray(raw) ? raw[0] : raw;
  if (typeof presented !== "string") return false;
  const presentedBytes = Buffer.from(presented, "utf8");
  const expectedBytes = Buffer.from(expected, "utf8");
  if (presentedBytes.length !== expectedBytes.length) return false;
  return timingSafeEqual(presentedBytes, expectedBytes);
}

export async function handleBridgeRequest(
  client: BridgeClient,
  req: IncomingMessage,
  res: ServerResponse,
  sessionName?: string,
  logForbidden?: (message: string) => void,
  onPageIdentityChanged?: () => boolean | void,
): Promise<void> {
  res.setHeader("Content-Type", "application/json");

  // Reject rebound requests before any routing — see isRequestAllowed and
  // GHSA-x439-jhfh-v9x2. This gate covers /health, /tools, and /call alike. It
  // sits ahead of the try below deliberately: a disallowed host must never reach
  // routing, and a header check has nothing to throw.
  if (!isRequestAllowed(req)) {
    // Log the refusal so an operator can tell a mis-configured client apart
    // from an actual rebinding attempt. Injected (not a direct
    // logBridgeMessage call) so unit tests stay quiet unless they opt in.
    logForbidden?.(describeRejectedRequest(req));
    writeJson(res, 403, { error: "Forbidden host" });
    return;
  }

  // Capability gate: after the anti-rebinding gate (which costs nothing and
  // stops the remote attacker) and before every route, /health included. The
  // Host/Origin check proves a request did not come from a web page; it says
  // nothing about the *other* processes on this machine, and `/call` maps
  // straight to CDP. For another local user, loopback binding was never an
  // authentication boundary — the token is.
  if (!hasValidBridgeToken(req)) {
    writeJson(res, 401, {
      error: "Missing or invalid bridge capability token",
    });
    return;
  }

  // Every branch stays inside the try. The health probes catch internally
  // today, so a throw here is not reachable — but this handler is dispatched
  // without an awaiting caller, so anything that escaped would surface as an
  // unhandled rejection and take the bridge down rather than fail one request.
  try {
    if (
      req.method === "GET" &&
      (req.url === "/health" || req.url?.startsWith("/health?"))
    ) {
      if (!(await isBridgeClientConnected(client))) {
        writeJson(res, 503, { status: "error", error: "Not connected" });
        return;
      }
      const deep = req.url.includes("deep=1");
      let droppedSelection = false;
      if (deep) {
        const probe = await isBridgeTargetReachable(client);
        if (!probe.ok) {
          writeJson(res, 503, {
            status: "error",
            error: "CDP target unreachable",
            reason: probe.reason,
          });
          return;
        }
        // The marker alone only says the browser reconnected. Reporting that
        // to a session with no routing would invent a loss, so the flag rides
        // on the clear having actually removed an id.
        if (probe.pageIdentityChanged) {
          droppedSelection = onPageIdentityChanged?.() === true;
        }
      }
      // Absent on a shallow probe and on a reconnect that dropped nothing, so
      // the CLI reads its absence as "no routing was lost" rather than "old
      // bridge".
      writeJson(res, 200, {
        status: "ok",
        session: sessionName,
        // `auth` is what a CLI keys on to prove this bridge validated its token.
        // An older bridge answers 200 {status:"ok"} while ignoring the header
        // entirely, so without the marker a CLI cannot tell the two apart and
        // would silently reuse an unauthenticated bridge. It is emitted only
        // here, after the capability gate above has passed.
        auth: BRIDGE_AUTH_SCHEME,
        ...(droppedSelection ? { pageIdentityChanged: true } : {}),
      });
      return;
    }

    if (req.method === "GET" && req.url === "/tools") {
      await handleToolsRequest(client, res);
      return;
    }

    if (req.method === "POST" && req.url === "/call") {
      await handleCallRequest(client, req, res, onPageIdentityChanged);
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
  sessionName?: string,
): Server {
  return createServer((req, res) => {
    // Backstop: one failed request must never kill the bridge. handleBridgeRequest
    // already reports its own errors, so reaching here means the failure escaped
    // even that — respond if we still can, and always close the socket.
    // `logBridgeMessage` is passed as logForbidden so the anti-rebinding gate can
    // report refusals; tests omit it to stay quiet.
    handleBridgeRequest(
      client,
      req,
      res,
      sessionName,
      logBridgeMessage,
      clearSelectedPageId,
    ).catch((error) => {
      logBridgeMessage(`Request handler error: ${getErrorMessage(error)}`);
      if (!res.headersSent) {
        writeJson(res, 500, { error: getErrorMessage(error) });
      } else {
        res.end();
      }
    });
  });
}

function logBridgeMessage(message: string): void {
  process.stderr.write(`[axis-browser] ${message}\n`);
}

/**
 * Handle a fatal HTTP server error by logging it and exiting non-zero. An
 * EADDRINUSE means another bridge already owns this port (typically because
 * `CHROME_DEVTOOLS_AXI_PORT` was exported globally, forcing every session onto
 * one port); it exits with {@link BRIDGE_PORT_IN_USE_EXIT_CODE} so `ensureBridge`
 * can distinguish it from any other early death. Failing loudly prevents
 * `ensureBridge` from silently attaching to the other session's bridge. `exit`
 * is injectable for tests.
 */
export function handleBridgeServerError(
  error: NodeJS.ErrnoException,
  port: number,
  exit: (code: number) => void = process.exit,
): void {
  if (error.code === "EADDRINUSE") {
    logBridgeMessage(
      `Port ${port} is already in use (EADDRINUSE) - another bridge is listening there. ` +
        `Exporting CHROME_DEVTOOLS_AXI_PORT globally forces every session onto one port; ` +
        `unset it so each session gets its own, or set it only per-session.`,
    );
    exit(BRIDGE_PORT_IN_USE_EXIT_CODE);
    return;
  }
  logBridgeMessage(`Bridge server error: ${getErrorMessage(error)}`);
  exit(1);
}

function writeReadySignal(): void {
  process.stdout.write("READY\n");
}

/**
 * Chrome flags that keep a browser *we* launch away from the machine owner's
 * login keychain.
 *
 * `--use-mock-keychain` makes Chromium's OSCrypt use an in-memory mock instead
 * of the real `Chrome Safe Storage` keychain item; `--password-store=basic`
 * keeps the password store off the platform secret service. Without them a
 * launched Chrome calls `SecItemAdd` against the login keychain, and if that
 * keychain is not resolvable for the browser process (for example because it
 * was spawned with a redirected `HOME`) macOS answers `errSecNoDefaultKeychain`
 * and raises the `system.keychain.create.loginkc` authorization panel -
 * "Keychain Not Found ... Reset To Defaults" - on the machine owner's screen.
 *
 * Puppeteer happens to pass both flags in its own default set today, so this is
 * currently belt-and-braces. It is stated explicitly because the isolation is a
 * property we owe our users, not one we want to silently inherit from an
 * upstream default that could change: an automation browser must never be able
 * to reach - or offer to reset - the owner's password store.
 */
export const KEYCHAIN_ISOLATION_CHROME_ARGS = [
  "--use-mock-keychain",
  "--password-store=basic",
] as const;

export function buildTransportArgs(): string[] {
  // Only chrome-devtools-mcp flags. Which binary runs, and how, is decided by
  // resolveTransportSpec — this package's pinned dependency spawned with node.
  // The old `["-y", "chrome-devtools-mcp@latest"]` prefix existed purely for the
  // npx fallback and is gone with it: nothing on this path may download and
  // execute an unreviewed version at bridge startup.
  const args: string[] = [
    // `network` prints request and response headers back to the caller, so the
    // sensitive ones are redacted at the source instead of filtered downstream.
    // Verified present in the pinned chrome-devtools-mcp 1.9.0, where it
    // defaults to false.
    "--redactNetworkHeaders",
  ];

  // The mode is now resolved explicitly rather than inferred from whichever variable
  // happened to be set first. resolveMode() falls back to the historical inference when
  // CHROME_DEVTOOLS_AXI_MODE is unset, so this is behaviour-preserving by default.
  const mode = resolveMode();
  const browserUrl = process.env.CHROME_DEVTOOLS_AXI_BROWSER_URL;
  const channel = process.env.CHROME_DEVTOOLS_AXI_CHANNEL?.trim();

  if (mode === "autoconnect") {
    // Chrome 144+ built-in remote debugging via chrome://inspect/#remote-debugging.
    // Connects to the user's running Chrome - no separate browser launched.
    args.push("--autoConnect");
  } else if (mode === "attach" && browserUrl) {
    // Connect to an existing Chrome instance - skip --isolated and --headless
    // since the user manages the browser lifecycle externally.
    // ws://|wss:// route to --wsEndpoint (direct WebSocket), http(s):// to --browserUrl
    // (which fetches /json/version to discover the WebSocket URL).
    const isWs = /^wss?:\/\//i.test(browserUrl);
    if (isWs) {
      args.push(`--wsEndpoint=${browserUrl}`);
      const wsHeaders = process.env.CHROME_DEVTOOLS_AXI_WS_HEADERS;
      if (wsHeaders?.trim()) {
        // chrome-devtools-mcp 1.9.0 accepts WebSocket headers only as a
        // command-line value (verified: `--wsHeaders` is its sole interface, and
        // it works only with `--wsEndpoint`). An argv secret is readable by every
        // other process owned by any user on this machine through the process
        // table, so it is refused unless the operator explicitly accepts that
        // exposure. The value itself is never echoed — not here, not in the
        // validation errors below.
        if (process.env.CHROME_DEVTOOLS_AXI_ALLOW_WS_HEADERS_ARGV !== "1") {
          throw new Error(
            "CHROME_DEVTOOLS_AXI_WS_HEADERS is set but was not forwarded: chrome-devtools-mcp only accepts WebSocket headers as a command-line argument, which other local processes can read from the process table. Unset it, or re-run with CHROME_DEVTOOLS_AXI_ALLOW_WS_HEADERS_ARGV=1 if you accept that exposure on this machine. The value is not printed here.",
          );
        }
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
    const userDataDir = resolveUserDataDir(
      mode,
      process.env,
      resolveSessionName(),
    );
    if (userDataDir) {
      // Persistent profile — skip --isolated so the profile is preserved.
      args.push(`--userDataDir=${userDataDir}`);
    } else {
      args.push("--isolated");
    }
    if (process.env.CHROME_DEVTOOLS_AXI_HEADED !== "1") {
      args.push("--headless");
    }
    // Launch modes only: pinning an executable is meaningless when attaching to a
    // browser somebody else started — that browser already exists.
    const executablePath =
      process.env.CHROME_DEVTOOLS_AXI_EXECUTABLE_PATH?.trim();
    if (executablePath) {
      args.push(`--executablePath=${executablePath}`);
    }
    // Launch modes only: `--chrome-arg` is ignored when chrome-devtools-mcp
    // attaches to a browser somebody else started, and that browser's keychain
    // policy is its owner's to decide, not ours.
    for (const arg of KEYCHAIN_ISOLATION_CHROME_ARGS) {
      args.push(`--chrome-arg=${arg}`);
    }
  }

  // --channel selects which installed Chrome distribution chrome-devtools-mcp
  // targets: the running instance --autoConnect attaches to, or the one launched
  // by default. It is irrelevant when attaching to an explicit endpoint, so it is
  // omitted in attach mode. Validation is left to chrome-devtools-mcp.
  if (channel && mode !== "attach") {
    args.push(`--channel=${channel}`);
  }

  const extraChromeArgs = process.env.CHROME_DEVTOOLS_AXI_CHROME_ARGS;
  if (extraChromeArgs) {
    for (const arg of extraChromeArgs.trim().split(/\s+/)) {
      args.push(`--chrome-arg=${arg}`);
    }
  }

  return args;
}

/**
 * Probe interface for {@link resolveBundledMcpPath}. Defaults to real `node:fs`
 * plus this module's own resolver; injectable for tests.
 */
export interface McpPathProbe {
  existsSync: (path: string) => boolean;
  /** Resolve one of this package's own dependencies to an absolute path. */
  resolveDependency: (specifier: string) => string | null;
}
/**
 * The command and arguments for a stdio-launched chrome-devtools-mcp process.
 * This stays separate from direct Streamable HTTP selection so callers cannot
 * accidentally spawn a local MCP process when only a shared URL is configured.
 */
export interface TransportSpec {
  command: string;
  args: string[];
}

export interface SessionTerminatingTransport extends Transport {
  terminateSession(): Promise<void>;
}

export type ResolvedTransport =
  { kind: "http"; url: URL } | { kind: "stdio"; spec: TransportSpec };

/**
 * A selected MCP transport plus the lifecycle operation that is unique to a
 * Streamable HTTP session. Stdio transports intentionally omit
 * `terminateSession`; closing them only tears down their local child process.
 */
export interface BridgeTransport {
  transport: Transport;
  terminateSession?: () => Promise<void>;
}

export interface BridgeTransportFactories {
  createStdio: (spec: TransportSpec) => Transport;
  createHttp: (url: URL) => SessionTerminatingTransport;
}

const DEFAULT_MCP_PATH_PROBE: McpPathProbe = {
  existsSync: (path) => existsSync(path),
  resolveDependency: (specifier) => {
    try {
      return createRequire(import.meta.url).resolve(specifier);
    } catch {
      return null;
    }
  },
};

/**
 * Entry point of the chrome-devtools-mcp version this package pins, resolved
 * through Node's own module resolver from *this* module — so it is the dependency
 * installed and reviewed with this release, on POSIX and Windows alike.
 *
 * It replaces two older behaviors, either of which could run code nobody
 * reviewed:
 *
 * - an `npm prefix -g` scan that used whatever chrome-devtools-mcp happened to be
 *   installed globally, at any version. Being built on the POSIX npm prefix, it
 *   also silently missed Windows global installs and fell through to npx there.
 * - an `npx -y chrome-devtools-mcp@latest` fallback that downloaded the newest
 *   release at bridge startup: floating code, fetched over the network and
 *   executed with the operator's privileges, on a path with no version pin and no
 *   offline guarantee. A slow cold fetch could also exceed the readiness deadline
 *   and surface as a bogus "Chrome failed to start".
 *
 * `chrome-devtools-mcp` publishes no `exports` map, so this subpath resolves
 * directly; it is the same file the package's own `bin` entry points at.
 */
export const PINNED_MCP_ENTRY =
  "chrome-devtools-mcp/build/src/bin/chrome-devtools-mcp.js";

/** Absolute path of the pinned MCP entry, or null when it is not installed. */
export function resolveBundledMcpPath(
  probe: McpPathProbe = DEFAULT_MCP_PATH_PROBE,
): string | null {
  const resolved = probe.resolveDependency(PINNED_MCP_ENTRY);
  if (!resolved || !probe.existsSync(resolved)) return null;
  return resolved;
}

/**
 * Resolve the command + args used to spawn the chrome-devtools-mcp transport.
 *
 * This resolver intentionally handles only stdio paths. Shared URL + executable
 * mode is the stdio proxy path and must verify proxy support before spawning:
 * an incompatible MCP executable could otherwise start a separate local
 * browser. Local browser arguments are deliberately excluded because the
 * service owns Chrome's policy. See README Configuration for the supported
 * dependency and setup.
 *
 * Ordinary local mode runs exactly one of two binaries: an explicit
 * `CHROME_DEVTOOLS_AXI_MCP_PATH` the operator chose, or this package's pinned
 * dependency. There is no global-install scan and no network fetch — a missing
 * pinned dependency is a reinstall error, not a reason to improvise.
 */
export function resolveTransportSpec(
  probe: McpPathProbe = DEFAULT_MCP_PATH_PROBE,
): TransportSpec {
  const explicitPath = process.env.CHROME_DEVTOOLS_AXI_MCP_PATH?.trim();
  const sharedServerUrl =
    process.env.CHROME_DEVTOOLS_AXI_MCP_SERVER_URL?.trim();
  if (sharedServerUrl) {
    if (!explicitPath) {
      throw new Error(
        "CHROME_DEVTOOLS_AXI_MCP_SERVER_URL requires CHROME_DEVTOOLS_AXI_MCP_PATH pointing to a chrome-devtools-mcp build with --server-url proxy support",
      );
    }
    let help: string;
    try {
      help = execFileSync(process.execPath, [explicitPath, "--help"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 5_000,
        killSignal: "SIGKILL",
      });
    } catch (error) {
      throw new Error(
        "Cannot verify --server-url proxy support: CHROME_DEVTOOLS_AXI_MCP_PATH must point to a runnable chrome-devtools-mcp build whose --help succeeds",
        { cause: error },
      );
    }
    if (!/^\s+--serverUrl\s/m.test(help)) {
      throw new Error(
        "CHROME_DEVTOOLS_AXI_MCP_PATH does not advertise --serverUrl in --help; select a chrome-devtools-mcp build with --server-url proxy support",
      );
    }
    return {
      command: process.execPath,
      args: [explicitPath, `--server-url=${sharedServerUrl}`],
    };
  }

  const mcpArgs = buildTransportArgs();
  const mcpPath = explicitPath || resolveBundledMcpPath(probe);
  if (!mcpPath) {
    throw new Error(
      "Cannot start a bridge: the chrome-devtools-mcp version this package pins is not installed. Reinstall Axis Browser (npm install -g github:Nirmantix/axis-browser, or pnpm install in a checkout) so its pinned chrome-devtools-mcp dependency is present. Axis does not download an unpinned chrome-devtools-mcp at startup and no longer scans for a global install; to run a build you reviewed yourself, set CHROME_DEVTOOLS_AXI_MCP_PATH to its absolute path.",
    );
  }
  return { command: process.execPath, args: [mcpPath, ...mcpArgs] };
}

function parseSharedServerUrl(value: string): URL {
  if (!/^https?:\/\//i.test(value)) {
    throw new Error(
      "CHROME_DEVTOOLS_AXI_MCP_SERVER_URL must be an absolute http(s) URL",
    );
  }
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error("unsupported protocol");
    }
    return url;
  } catch (error) {
    throw new Error(
      "CHROME_DEVTOOLS_AXI_MCP_SERVER_URL must be an absolute http(s) URL",
      { cause: error },
    );
  }
}

/**
 * Select direct Streamable HTTP when only a shared URL is configured.
 * Supplying MCP_PATH opts into the verified stdio proxy path instead.
 */
export function resolveTransport(
  probe: McpPathProbe = DEFAULT_MCP_PATH_PROBE,
): ResolvedTransport {
  const sharedServerUrl =
    process.env.CHROME_DEVTOOLS_AXI_MCP_SERVER_URL?.trim();
  if (sharedServerUrl && !process.env.CHROME_DEVTOOLS_AXI_MCP_PATH?.trim()) {
    return { kind: "http", url: parseSharedServerUrl(sharedServerUrl) };
  }
  return { kind: "stdio", spec: resolveTransportSpec(probe) };
}

const DEFAULT_BRIDGE_TRANSPORT_FACTORIES: BridgeTransportFactories = {
  createStdio: (spec) => new StdioClientTransport(spec),
  createHttp: (url) => new StreamableHTTPClientTransport(url),
};

/**
 * Construct the selected transport. Direct HTTP gets a session terminator;
 * stdio deliberately does not, so shutdown cannot issue a second termination.
 */
export function createTransport(
  selection: ResolvedTransport = resolveTransport(),
  factories: BridgeTransportFactories = DEFAULT_BRIDGE_TRANSPORT_FACTORIES,
): BridgeTransport {
  if (selection.kind === "http") {
    const transport = factories.createHttp(selection.url);
    return {
      transport,
      terminateSession: () => transport.terminateSession(),
    };
  }
  return { transport: factories.createStdio(selection.spec) };
}

/**
 * Close a bridge transport, terminating a direct remote MCP session first.
 * `Client.close()` delegates to its transport, so this helper closes the
 * transport exactly once without separately closing the Client.
 */
export async function closeBridgeTransport(
  bridgeTransport: BridgeTransport,
): Promise<void> {
  try {
    await bridgeTransport.terminateSession?.();
  } finally {
    await bridgeTransport.transport.close();
  }
}

function createBridgeClient(): Client {
  // Declare the `roots` capability so chrome-devtools-mcp asks us for workspace
  // roots (via `roots/list`) instead of restricting every file write to the OS
  // temp directory. `listChanged` lets us update the roots per call.
  return new Client(
    { name: "chrome-devtools-axi-bridge", version: "1.0.0" },
    { capabilities: { roots: { listChanged: true } } },
  );
}

/** How long {@link RootsAwareClient.applyRoots} waits for chrome-devtools-mcp to
 * re-read our roots after a `list_changed` notification before proceeding. The
 * cap stops a server that never re-reads from wedging the call. */
const ROOTS_FETCH_WAIT_MS = 2_000;

/**
 * The bounded wait expired without the server re-reading our roots. Kept as a
 * distinct type so `callTool` can degrade on exactly this failure — a server
 * that did not re-fetch in time — without swallowing real transport errors,
 * while the explicit `applyRoots` API still surfaces it to its caller.
 */
class RootsNegotiationTimeout extends Error {
  constructor() {
    super("Timed out waiting for roots negotiation");
    this.name = "RootsNegotiationTimeout";
  }
}

function toRoots(dirs: string[]): Array<{ uri: string; name: string }> {
  const seen = new Set<string>();
  const roots: Array<{ uri: string; name: string }> = [];
  for (const dir of dirs) {
    const uri = pathToFileURL(dir).href;
    if (seen.has(uri)) continue;
    seen.add(uri);
    roots.push({ uri, name: basename(dir) || dir });
  }
  return roots;
}

function rootUrisEqual(
  a: Array<{ uri: string }>,
  b: Array<{ uri: string }>,
): boolean {
  if (a.length !== b.length) return false;
  return a.every((root, i) => root.uri === b[i]?.uri);
}

/**
 * Wrap an MCP {@link Client} so it answers `roots/list` and can renegotiate the
 * workspace roots on demand. Registers the `roots/list` handler that returns the
 * current roots, and exposes {@link RootsAwareClient.applyRoots}: it swaps in the
 * requested directories, fires `roots/list_changed`, and waits for the server to
 * re-read them (bounded) before returning, so the *next* tool call validates
 * against the new roots rather than the previous set. A no-op when the roots are
 * unchanged, so repeated calls in the same directory add no round-trips.
 */
export function createRootsAwareBridgeClient(client: Client): RootsAwareClient {
  let currentRoots: Array<{ uri: string; name: string }> = [];
  let confirmedRoots: Array<{ uri: string; name: string }> | null = [];
  let onRootsFetched: {
    resolve: () => void;
    reject: (error: unknown) => void;
  } | null = null;
  let callQueue = Promise.resolve();

  client.setRequestHandler(ListRootsRequestSchema, () => {
    const notify = onRootsFetched;
    onRootsFetched = null;
    if (notify) {
      setImmediate(() => {
        void client.ping().then(notify.resolve, notify.reject);
      });
    }
    return { roots: currentRoots };
  });

  async function applyRootsNow(dirs: string[]): Promise<void> {
    const next = toRoots(dirs);
    if (confirmedRoots && rootUrisEqual(next, confirmedRoots)) return;
    confirmedRoots = null;
    currentRoots = next;
    let waiter:
      { resolve: () => void; reject: (error: unknown) => void } | undefined;
    const fetched = new Promise<void>((resolve, reject) => {
      waiter = { resolve, reject };
      onRootsFetched = waiter;
    });
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        (async () => {
          await client.notification({
            method: "notifications/roots/list_changed",
          });
          await fetched;
        })(),
        new Promise<void>((_resolve, reject) => {
          timeout = setTimeout(
            () => reject(new RootsNegotiationTimeout()),
            ROOTS_FETCH_WAIT_MS,
          );
        }),
      ]);
      confirmedRoots = next;
    } finally {
      if (timeout) clearTimeout(timeout);
      if (onRootsFetched === waiter) onRootsFetched = null;
    }
  }

  function enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = callQueue.then(operation);
    callQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  return {
    listTools: () => client.listTools(),
    callTool: (request, roots) =>
      enqueue(async () => {
        if (roots) {
          try {
            await applyRootsNow(roots);
          } catch (error) {
            if (!(error instanceof RootsNegotiationTimeout)) throw error;
            // Roots are an optional precursor, not a precondition: a server
            // that did not re-read them within the bounded wait still holds
            // the roots it had. Failing the tool call here would convert a
            // degraded negotiation into a hard browser-command failure, so
            // proceed and leave the timeout visible in the bridge log.
            logBridgeMessage(
              `Roots negotiation timed out after ${ROOTS_FETCH_WAIT_MS}ms; proceeding with the server's existing roots`,
            );
          }
        }
        return client.callTool(request);
      }),
    close: () => client.close(),
    applyRoots: (dirs) => enqueue(() => applyRootsNow(dirs)),
  };
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      // A stop signal can land before listen() completes — runBridge boots
      // Chrome before binding, so that window is seconds wide. An unbound
      // server is already closed for our purposes, not a failure.
      if (
        error &&
        (error as NodeJS.ErrnoException).code !== "ERR_SERVER_NOT_RUNNING"
      ) {
        reject(error);
      } else {
        resolve();
      }
    });
  });
}

export async function runBridge(port = resolveSessionPort()): Promise<void> {
  // Connect the selected MCP transport before binding the port. In local and
  // proxy modes this may spawn chrome-devtools-mcp; URL-only shared mode
  // connects directly to the existing Streamable HTTP endpoint. A same-session
  // bind race then self-heals: both racers finish booting before listen(), so
  // the loser's EADDRINUSE exit finds the winner already deep-healthy and
  // reuses it instead of failing. The trade-off is one wasted startup on a
  // genuine cross-session collision, a rare and self-correcting path.
  const bridgeTransport = createTransport();
  const client = createBridgeClient();
  const bridgeClient = createRootsAwareBridgeClient(client);
  await client.connect(bridgeTransport.transport);
  logBridgeMessage("Connected to chrome-devtools-mcp");

  const sessionName = resolveSessionName();
  const server = createBridgeServer(bridgeClient, sessionName);
  server.on("error", (error: NodeJS.ErrnoException) => {
    handleBridgeServerError(error, port);
  });
  server.listen(port, "127.0.0.1", () => {
    try {
      publishBridgeCapability(port);
    } catch (error) {
      // Fail closed: a bridge that cannot prove its record is private, or cannot
      // identify its own process, must not serve. Exiting non-zero here is what
      // lets ensureBridge attribute the failure and print the repair steps.
      logBridgeMessage(
        `Refusing to serve without a verified capability record: ${getErrorMessage(error)}`,
      );
      if (error instanceof StateDirError) {
        for (const step of error.repair) {
          logBridgeMessage(`  repair: ${step}`);
        }
      }
      process.exit(1);
      return;
    }
    logBridgeMessage(`Listening on http://127.0.0.1:${port}`);
    writeReadySignal();
  });

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    unpublishBridgeCapability();
    // Each resource is torn down independently: one failure must not skip the
    // rest, or a server close error would leave the MCP transport open.
    // Failures are logged, never rethrown — an escaping rejection exits
    // 1, which ensureBridge reports as a *startup* failure with misleading
    // Chrome guidance. The exit handler below still reaps the process group,
    // so a stop that got this far is a clean stop.
    const close = async (name: string, fn: () => Promise<void>) => {
      try {
        await fn();
      } catch (error) {
        logBridgeMessage(
          `Shutdown warning (${name}): ${getErrorMessage(error)}`,
        );
      }
    };
    await close("server", () => closeServer(server));
    // closeBridgeTransport terminates a direct remote MCP session first, then
    // closes the transport exactly once. Client.close() delegates to that same
    // transport, so the client is deliberately not closed separately.
    await close("transport", () => closeBridgeTransport(bridgeTransport));
    process.exit(0);
  };

  // Kill our entire process group on exit so chrome-devtools-mcp children
  // don't survive as orphans. The bridge is spawned with detached:true,
  // making it a process group leader — all children share our PGID.
  process.on("exit", () => {
    unpublishBridgeCapability();
    try {
      process.kill(-process.pid, "SIGTERM");
    } catch {
      // Already dead or not a group leader
    }
  });

  const onStopSignal = () => {
    shutdown().catch(() => process.exit(0));
  };
  process.on("SIGTERM", onStopSignal);
  process.on("SIGINT", onStopSignal);
}
