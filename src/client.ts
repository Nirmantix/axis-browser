/**
 * HTTP client for the Axis Browser bridge + bridge lifecycle management.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { request } from "node:http";
import { dirname, isAbsolute, resolve } from "node:path";
import { AxiError } from "axi-sdk-js";
import {
  BRIDGE_PORT_IN_USE_EXIT_CODE,
  PAGE_IDENTITY_CHANGED_ERROR,
  resolveBridgeScript,
} from "./bridge-script.js";
import { type AxiMode, resolveModeSafe } from "./mode.js";
import { needsPageId } from "./pages.js";
import { autoReapOrphans } from "./reap.js";
import {
  identityIsBridge,
  identityMatchesRecord,
  readProcessGroupId,
  readProcessIdentity,
} from "./process-identity.js";
import {
  clearSelectedPageId,
  getSelectedPageId,
  rememberToolRouting,
} from "./selected-page.js";
import { assertStateDirOwned, StateDirError } from "./state-dir.js";
import {
  BRIDGE_AUTH_SCHEME,
  BRIDGE_TOKEN_HEADER,
  clearBridgeRecord,
  clearLegacyBridgeRecord,
  DEFAULT_SESSION_NAME,
  isAuthedRecord,
  readBridgeRecord,
  resolveSessionName,
  resolveSessionPidFile,
  resolveSessionPort,
  resolveSessionStateChain,
  type BridgeRecord,
} from "./sessions.js";
import { PRIMARY_COMMAND_NAME } from "./version.js";

const DEFAULT_BRIDGE_TIMEOUT_MS = 30_000;
const MIN_BRIDGE_TIMEOUT_MS = 1_000;
const HEALTH_TIMEOUT_MS = 2_000;
const DEEP_HEALTH_TIMEOUT_MS = 5_000;

/**
 * Resolve the bridge readiness deadline in milliseconds.
 *
 * Honors `CHROME_DEVTOOLS_AXI_BRIDGE_TIMEOUT_MS` for systems where the MCP
 * bootstrap or Chrome launch is slow (>30s). Values below 1s are clamped to
 * 1s to avoid pathological retries.
 */
export function resolveBridgeTimeoutMs(): number {
  const raw = process.env.CHROME_DEVTOOLS_AXI_BRIDGE_TIMEOUT_MS;
  if (!raw) return DEFAULT_BRIDGE_TIMEOUT_MS;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed) || parsed <= 0) return DEFAULT_BRIDGE_TIMEOUT_MS;
  return Math.max(parsed, MIN_BRIDGE_TIMEOUT_MS);
}

export type ErrorCode =
  | "BRIDGE_NOT_READY"
  | "REF_NOT_FOUND"
  | "STALE_REF"
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

/**
 * An authenticated bridge endpoint: the loopback port plus the capability token
 * from the *same* session record. Both are re-read from disk at every use, so a
 * bridge that was recycled while this process was running is never addressed with
 * the previous process's token.
 */
export interface BridgeEndpoint {
  port: number;
  token: string;
}

/**
 * The active session's authenticated endpoint, or null when there is no usable
 * record. A tokenless legacy record also yields null: adopting the unauthenticated
 * bridge an older CLI may have left behind would put browser control back on a
 * predictable local port, which is exactly what the token exists to prevent.
 */
export function readBridgeEndpoint(
  sessionName: string = resolveSessionName(),
): BridgeEndpoint | null {
  const record = readBridgeRecord(resolveSessionPidFile(sessionName));
  if (!isAuthedRecord(record)) return null;
  return { port: record.port, token: record.token };
}

/** The active session's endpoint, or an actionable error naming the legacy record. */
function requireBridgeEndpoint(sessionName: string): BridgeEndpoint {
  const record = readBridgeRecord(resolveSessionPidFile(sessionName));
  if (isAuthedRecord(record)) return { port: record.port, token: record.token };
  throw legacyRecordError(sessionName, record);
}

/**
 * The error every RPC path raises for a pre-token record. It names the session,
 * tells the operator the one command that can retire the old bridge, and never
 * suggests killing a PID by hand.
 */
function legacyRecordError(
  session: string,
  record: BridgeRecord | null,
): CdpError {
  const suffix =
    session === DEFAULT_SESSION_NAME
      ? ""
      : ` (with CHROME_DEVTOOLS_AXI_SESSION=${session})`;
  return new CdpError(
    `The bridge record for session "${session}" carries no capability token, so this CLI cannot authenticate to it. It was left by an older Axis Browser; adopting it would put unauthenticated browser control back on a predictable local port.`,
    "BRIDGE_NOT_READY",
    [
      `Retire it with this upgraded CLI: axis-browser stop${suffix}`,
      "Then re-run your command; the new bridge writes an authenticated record.",
      record
        ? `If stop cannot verify pid ${record.pid}, inspect it before touching it: ps -p ${record.pid} -o command=`
        : "If stop cannot verify the process, inspect it before touching it: ps -o command= -p <pid>",
    ],
  );
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
  token?: string,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        hostname: "127.0.0.1",
        port,
        path,
        method: "GET",
        timeout: timeoutMs,
        headers: token ? { [BRIDGE_TOKEN_HEADER]: token } : undefined,
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => resolve(data));
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
  token?: string,
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
          ...(token ? { [BRIDGE_TOKEN_HEADER]: token } : {}),
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

/**
 * Probe the bridge's `/health` endpoint. With `deep: true`, asks the bridge
 * to drive one CDP-backed MCP call (`list_pages`) so callers can distinguish
 * "MCP server is up but the attached browser is gone" from genuine readiness.
 *
 * With `expectedSession`, a bridge that reports a *different* session name is
 * treated as unhealthy, so a session never silently reuses another session's
 * bridge after a port collision (two sessions pinned to one port via a global
 * `CHROME_DEVTOOLS_AXI_PORT`).
 *
 * With `notice`, a healthy *deep* probe writes the bridge's `pageIdentityChanged`
 * flag into that caller-owned holder (see {@link PageIdentityNotice}).
 *
 * A response only counts as healthy when it carries the current capability auth
 * marker. That is what stops a listener on the expected port — an older
 * unauthenticated bridge, or an unrelated local server that happens to answer
 * `/health` — from being treated as ours: the token is sent with the probe, and
 * the marker proves the answer came from a bridge that enforces it.
 *
 * Exported for tests; production code uses it via {@link ensureBridge}.
 */
export async function checkBridgeHealth(
  port: number,
  opts: {
    deep?: boolean;
    expectedSession?: string;
    notice?: PageIdentityNotice;
    token?: string;
  } = {},
): Promise<boolean> {
  try {
    const path = opts.deep ? "/health?deep=1" : "/health";
    const timeoutMs = opts.deep ? DEEP_HEALTH_TIMEOUT_MS : HEALTH_TIMEOUT_MS;
    const resp = await httpGet(port, path, timeoutMs, opts.token);
    const data = JSON.parse(resp);
    if (data.status !== "ok") return false;
    if (data.auth !== BRIDGE_AUTH_SCHEME) return false;
    if (
      opts.expectedSession !== undefined &&
      typeof data.session === "string" &&
      data.session !== opts.expectedSession
    ) {
      return false;
    }
    if (opts.deep && opts.notice) {
      opts.notice.pageIdentityChanged = data.pageIdentityChanged === true;
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * One {@link callTool} invocation's reconnect notice: whether the deep probe
 * that ran for *this* call reported that chrome-devtools-mcp had reissued every
 * page id *and* that this took a selection with it. The bridge gates the flag
 * on the clear having removed an id, so a session that never selected a page is
 * never told it lost one.
 *
 * `ensureBridge` deep-probes before every command, and that probe's
 * `list_pages` is what consumes chrome-devtools-mcp's one-shot reconnect marker
 * and clears the persisted selection - so without this relay the command that
 * follows finds no selection and blames the caller for never selecting a page.
 *
 * The holder is created by the caller and threaded through, never module state:
 * a `run` script can have several `callTool`s in flight at once, and a shared
 * slot would let one call's probe overwrite - or one call's resolution consume -
 * another's attribution, so a reconnect could be reported against the wrong
 * operation or dropped entirely. Per-invocation ownership also keeps the signal
 * one-shot in the same spirit as the marker it relays: it explains only the call
 * whose own probe consumed the marker, and is discarded with that call rather
 * than relabelling later no-selection errors in the same process. A call that
 * resolves no selection simply drops it - `pages` only calls `list_pages`, and
 * the home view probe carries no holder at all, since its own health check is
 * shallow and its `take_snapshot` carries the persisted id without coming
 * through here.
 */
export interface PageIdentityNotice {
  /** Written by the last deep probe of the owning `ensureBridge` call. */
  pageIdentityChanged: boolean;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export async function waitForProcessExit(
  pid: number,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) return true;
    await sleep(50);
  }
  return !isProcessAlive(pid);
}

/**
 * Whether `pid` is still the bridge its record named, decided by re-reading the
 * live process identity and comparing it with the recorded start time. This
 * replaces the old "does the command line contain the marker" check: a marker match
 * proves the process is *a* bridge, not that it is *this* record's bridge, so a
 * recycled pid running an unrelated Axis session could be signalled on the
 * strength of a stale file.
 */
function verifiedBridgeIdentity(
  pid: number,
  expectedStartedAt: string,
): boolean {
  return identityMatchesRecord(readProcessIdentity(pid), expectedStartedAt);
}

/**
 * Raised instead of signalling anything when a recorded pid no longer names the
 * bridge we started. It tells the operator how to look for themselves and how to
 * clear the stale record, because guessing here means killing a process we do not
 * own.
 */
function staleIdentityError(pid: number): CdpError {
  return new CdpError(
    `Pid ${pid} is recorded as this session's bridge, but the live process at that pid does not match the recorded identity (command line or start time differs). Nothing was signalled: that pid may now belong to an unrelated process.`,
    "BRIDGE_NOT_READY",
    [
      `Inspect it yourself before deciding anything: ps -p ${pid} -o command=,lstart=`,
      `If it is unrelated, clear the stale record: rm -f ${resolveSessionPidFile()}`,
      "Or work in a fresh session: CHROME_DEVTOOLS_AXI_SESSION=work2 axis-browser open <url>",
    ],
  );
}

/**
 * Terminate a verified bridge process. Sends SIGTERM and waits up to ~2s; the
 * bridge's own shutdown handler removes its record and reaps its children on exit.
 * If it is still alive, identity is verified *again* before escalating, and a group
 * signal is only sent when the process still leads its own group.
 *
 * There is deliberately no post-exit group kill. Once the leader is gone the OS is
 * free to hand its pid — and that pgid — to an unrelated process, so signalling
 * `-pid` after the fact can kill a process tree we have never seen.
 */
export async function terminateBridgeProcess(
  pid: number,
  expectedStartedAt: string,
  opts: { killProcessGroup?: boolean } = {},
): Promise<void> {
  if (!isProcessAlive(pid)) return;
  if (!verifiedBridgeIdentity(pid, expectedStartedAt)) {
    throw staleIdentityError(pid);
  }

  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return; // Already gone, or not ours to signal.
  }

  if (await waitForProcessExit(pid, 2000)) return;

  // Still alive after SIGTERM. Re-verify before escalating: the pid may have
  // changed owner during the wait.
  if (!verifiedBridgeIdentity(pid, expectedStartedAt)) {
    throw staleIdentityError(pid);
  }
  if (opts.killProcessGroup === true && readProcessGroupId(pid) === pid) {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      // Group already gone; the bare kill below still applies.
    }
  }
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    return;
  }
  await waitForProcessExit(pid, 1000);
}

/**
 * Minimal view of the spawned bridge process that {@link ensureBridge} needs:
 * an `exit` notification so a bridge that dies before reporting healthy can be
 * detected. The default {@link spawnBridgeProcess} returns a `ChildProcess`
 * (which satisfies this); tests inject a fake.
 */
export interface SpawnedBridge {
  on(
    event: "exit",
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): void;
}

/**
 * Spawn the detached bridge process. Prefers the sibling `.ts` (dev mode, run
 * via tsx) and falls back to the built `.js`, so dev and dist behave the same.
 */
function spawnBridgeProcess(port: number, sessionName: string): SpawnedBridge {
  const bridgeScript = resolveBridgeScript(import.meta.dirname);
  const script = existsSync(bridgeScript.replace(/\.js$/, ".ts"))
    ? bridgeScript.replace(/\.js$/, ".ts")
    : bridgeScript;
  const runner = script.endsWith(".ts") ? "tsx" : "node";

  const child = spawn(
    runner === "tsx" ? "npx" : "node",
    runner === "tsx" ? ["tsx", script] : [script],
    {
      stdio: "ignore",
      env: {
        ...process.env,
        CHROME_DEVTOOLS_AXI_PORT: String(port),
        CHROME_DEVTOOLS_AXI_SESSION: sessionName,
      },
      detached: true,
    },
  );
  child.unref();
  return child;
}
type SharedMcpMode = "direct" | "proxy" | null;

function resolveSharedMcpMode(): SharedMcpMode {
  const sharedServerUrl =
    process.env.CHROME_DEVTOOLS_AXI_MCP_SERVER_URL?.trim();
  if (!sharedServerUrl) return null;
  return process.env.CHROME_DEVTOOLS_AXI_MCP_PATH?.trim() ? "proxy" : "direct";
}

function sharedMcpSuggestions(mode: Exclude<SharedMcpMode, null>): string[] {
  if (mode === "direct") {
    return [
      "Shared MCP direct mode is enabled by CHROME_DEVTOOLS_AXI_MCP_SERVER_URL; AXI connects directly to that Streamable HTTP endpoint without launching a local MCP process.",
      "Verify CHROME_DEVTOOLS_AXI_MCP_SERVER_URL is an absolute http(s) MCP endpoint and that the service is running and reachable there.",
    ];
  }
  return [
    "Shared MCP proxy mode is enabled by CHROME_DEVTOOLS_AXI_MCP_SERVER_URL; this mode does not launch Chrome locally.",
    "Set CHROME_DEVTOOLS_AXI_MCP_PATH to a runnable chrome-devtools-mcp build that advertises --serverUrl in --help.",
    "Use the proxy-capable MCP build from the companion shared-server change, then restart this AXI session.",
  ];
}

/**
 * Build the error thrown when a freshly spawned bridge exits before it ever
 * reports healthy. Surfacing this the moment the child dies - rather than
 * polling the full readiness deadline - turns an early death into a fast,
 * actionable failure instead of a slow, generic "failed to start" timeout.
 *
 * The guidance is attributed by exit code. Only {@link BRIDGE_PORT_IN_USE_EXIT_CODE}
 * (the bridge's EADDRINUSE sentinel) gets the port-in-use explanation; any
 * other early death is a startup failure. Direct shared-MCP configuration gets
 * endpoint-specific guidance; proxy configuration gets `MCP_PATH`/`--serverUrl`
 * prerequisites; local mode covers MCP resolution, a broken
 * `CHROME_DEVTOOLS_AXI_MCP_PATH`, or a Chrome launch failure. In either mode, a
 * single-session user with a broken install is not misdirected to port advice.
 */
export function buildBridgeEarlyExitError(
  sessionName: string,
  port: number,
  code: number | null,
  signal: NodeJS.Signals | null,
  mode: AxiMode = resolveModeSafe(),
): CdpError {
  const how =
    signal != null
      ? `was killed by ${signal}`
      : `exited with code ${code ?? "unknown"}`;
  const message = `Bridge for session "${sessionName}" ${how} before becoming ready on port ${port} (mode: ${mode})`;

  if (code === BRIDGE_PORT_IN_USE_EXIT_CODE) {
    return new CdpError(message, "BRIDGE_NOT_READY", [
      `Port ${port} is already in use. It may be held by another axis-browser session's bridge (a hashed-port collision, or a globally-exported CHROME_DEVTOOLS_AXI_PORT forcing every session onto one port), by a stale or crashed bridge that could not be reused, or by an unrelated process.`,
      "Set a distinct CHROME_DEVTOOLS_AXI_PORT for this session, unset a global CHROME_DEVTOOLS_AXI_PORT so every session derives its own, or free whatever is holding the port.",
      `Run \`${PRIMARY_COMMAND_NAME} doctor\` to see who holds it, and \`axis-browser reap\` to clear orphaned bridges.`,
    ]);
  }

  // In attach mode axis launches no browser, so every Chrome-launch remedy below is a
  // false lead. Worse, a bare connection failure against an unauthenticated local port
  // has been observed to make an agent conclude the endpoint needs credentials and
  // escalate to a human. Both failure modes are addressed head-on here.
  if (mode === "attach") {
    const browserUrl = process.env.CHROME_DEVTOOLS_AXI_BROWSER_URL ?? "(unset)";
    return new CdpError(message, "BRIDGE_NOT_READY", [
      `Attach mode: axis did not launch a browser — it tried to connect to ${browserUrl}, which something else is expected to be serving.`,
      `Run \`${PRIMARY_COMMAND_NAME} doctor\` to probe that endpoint and name the process holding the port.`,
      "If nothing is serving DevTools there, unset CHROME_DEVTOOLS_AXI_BROWSER_URL so axis launches and owns its own browser (or set CHROME_DEVTOOLS_AXI_MODE=managed).",
      "Local CDP has no authentication. Do not request credentials, tokens, or a ws:// URL.",
    ]);
  }

  if (mode === "autoconnect") {
    return new CdpError(message, "BRIDGE_NOT_READY", [
      "Autoconnect mode: axis attaches to your already-running Chrome via chrome://inspect/#remote-debugging (Chrome 144+); it launches nothing.",
      "Confirm Chrome is running and that remote debugging is enabled on that page, or unset CHROME_DEVTOOLS_AXI_AUTO_CONNECT to let axis launch its own browser.",
      "Local CDP has no authentication. Do not request credentials, tokens, or a ws:// URL.",
    ]);
  }
  const sharedMcpMode = resolveSharedMcpMode();
  if (sharedMcpMode) {
    return new CdpError(
      message,
      "BRIDGE_NOT_READY",
      sharedMcpSuggestions(sharedMcpMode),
    );
  }

  const suggestions = [
    "Axis starts the chrome-devtools-mcp it pins as its own dependency — it does not download chrome-devtools-mcp@latest and no longer scans for a global install. Reinstall Axis Browser to restore that dependency:",
    "  npm install -g github:Nirmantix/axis-browser",
  ];
  if (mode === "managed") {
    suggestions.push(
      `Managed mode uses a persistent profile, and Chrome locks a profile to one process: if another Chrome already holds it, this launch fails. Run \`${PRIMARY_COMMAND_NAME} doctor\` to see the lock holder.`,
    );
  }
  if (process.env.CHROME_DEVTOOLS_AXI_MCP_PATH?.trim()) {
    suggestions.push(
      "CHROME_DEVTOOLS_AXI_MCP_PATH is set, so that build runs instead of the pinned one: verify it exists and starts, or unset it to use the pinned dependency.",
    );
  }
  suggestions.push(
    "Or Chrome failed to launch; confirm a usable Chrome is installed.",
  );
  return new CdpError(message, "BRIDGE_NOT_READY", suggestions);
}

/**
 * Ensure the bridge is running, starting it if needed. Returns the port.
 *
 * Verifies a *deep* health check (one round-trip CDP-backed MCP call) before
 * declaring the bridge ready, so a bridge whose attached browser/Electron
 * target was killed while still answering local /health requests gets torn
 * down + restarted instead of being reused as a stale endpoint.
 *
 * `spawnBridge` is injectable for tests; production uses {@link spawnBridgeProcess}.
 *
 * `notice` is the caller's own {@link PageIdentityNotice} holder; every deep
 * probe this call makes writes its `pageIdentityChanged` flag there, so the
 * reconnect attribution belongs to this invocation and cannot cross a
 * concurrent one.
 */
export async function ensureBridge(
  spawnBridge: (
    port: number,
    sessionName: string,
  ) => SpawnedBridge = spawnBridgeProcess,
  notice?: PageIdentityNotice,
): Promise<number> {
  const sessionName = resolveSessionName();
  const port = resolveSessionPort(sessionName);
  const pidFile = resolveSessionPidFile(sessionName);

  // Check the existing bridge through its session record rather than a bare pid
  // file: the record carries the capability token this CLI must present, and the
  // start time it must match before anything is signalled.
  const record = readBridgeRecord(pidFile);
  if (record) {
    // A tokenless record was left by an older CLI. Adopting it would put
    // unauthenticated browser control back on a predictable local port, so every
    // RPC path refuses and points at the one command that can retire it.
    if (!isAuthedRecord(record)) {
      // A live tokenless bridge stays non-adoptable: this CLI will not put
      // unauthenticated browser control back into use, and `stop` is the one
      // verified way to retire it. But a record whose pid is confirmed dead
      // names nothing at all — refusing forever would leave the session
      // bricked behind a file only a manual `rm` clears, and every `open` an
      // attacker could achieve by planting one. The pid is dead, nothing is
      // signalled, and `clearLegacyBridgeRecord` still requires the on-disk
      // record to be tokenless with this pid, so a bridge that restarted in
      // the meantime keeps its own record.
      if (isProcessAlive(record.pid))
        throw legacyRecordError(sessionName, record);
      clearLegacyBridgeRecord({ pid: record.pid }, pidFile);
    } else if (isProcessAlive(record.pid)) {
      // Deep probe, so a bridge whose attached CDP target has gone away gets
      // recycled instead of returned.
      if (
        await checkBridgeHealth(record.port, {
          deep: true,
          expectedSession: sessionName,
          notice,
          token: record.token,
        })
      ) {
        return record.port;
      }
      // The deep probe failed on a pid that is still alive. If that pid no
      // longer names our bridge — it was recycled onto an unrelated process —
      // `terminateBridgeProcess` would rightly refuse to signal it, but letting
      // that refusal propagate would strand every later command on a record
      // nothing will clear: `stop` refuses the same mismatch, so the recorded
      // remediation is a manual `rm` of the pid file. The record is provably
      // stale, so clear exactly it — `clearBridgeRecord` re-reads and requires
      // pid and token to still match, so a bridge that restarted in the
      // meantime keeps its own record — and let a fresh bridge take the
      // session. If something else now holds the deterministic port, the spawn
      // below fails fast with the collision attributed. A pid whose identity
      // cannot be read at all still goes to `terminateBridgeProcess`, whose
      // fail-closed refusal stands: unverifiable is not the same as stale.
      const liveIdentity = readProcessIdentity(record.pid);
      if (
        liveIdentity !== null &&
        !identityMatchesRecord(liveIdentity, record.startedAt)
      ) {
        clearBridgeRecord({ pid: record.pid, token: record.token }, pidFile);
      } else {
        await terminateBridgeProcess(record.pid, record.startedAt, {
          killProcessGroup: true,
        });
      }
    }
  }

  // MCP page ids reset with a new process; a leftover session id would
  // target the wrong tab (or none). Keep the file when reusing a live bridge.
  // Clearing here is also why a respawn never reports a reconnect: the new
  // bridge's first deep probe finds no selection left to drop, so its 200
  // omits `pageIdentityChanged` and the poll loop below records no notice.
  clearSelectedPageId();

  // We are about to start a bridge, which is the one moment it is both safe and
  // useful to clear abandoned ones: the reuse fast path above has already been
  // ruled out, so nothing here can be reaping a bridge this command wants. Only
  // our own bridges, claimed by no session, older than four hours — see reap.ts.
  autoReapOrphans();

  // Start a new bridge
  const child = spawnBridge(port, sessionName);

  // If the freshly spawned bridge dies before it reports healthy - an EADDRINUSE
  // port collision with another session, or a startup failure (MCP launch,
  // Chrome), whose stderr is lost to `stdio: "ignore"` - fail fast
  // instead of polling the full readiness deadline and reporting a generic
  // timeout. The exit code attributes the cause (see buildBridgeEarlyExitError).
  let childExited = false;
  let exitCode: number | null = null;
  let exitSignal: NodeJS.Signals | null = null;
  child.on("exit", (code, signal) => {
    childExited = true;
    exitCode = code;
    exitSignal = signal;
  });

  // Poll for health — Chrome launch can be slow on a cold profile.
  // Track whether the *shallow* health check ever passed so we can attribute
  // the failure correctly: shallow-but-no-deep means the MCP server came up
  // but the attached CDP target is dead, vs. nothing-came-up which is the
  // generic startup-timeout case.
  const timeoutMs = resolveBridgeTimeoutMs();
  const deadline = Date.now() + timeoutMs;
  let sawShallowReady = false;
  while (Date.now() < deadline) {
    // The bridge publishes its capability record only once it is listening, so
    // the token is re-read on every pass. Until it appears the bridge answers
    // 401 and the probe correctly reports "not ready yet" — a bind-race loser
    // that never published is therefore indistinguishable from one still
    // starting, and never gets adopted.
    const token = readBridgeRecord(pidFile)?.token;
    if (
      await checkBridgeHealth(port, {
        deep: true,
        expectedSession: sessionName,
        notice,
        token,
      })
    ) {
      return port;
    }
    if (childExited) {
      if (
        await checkBridgeHealth(port, {
          deep: true,
          expectedSession: sessionName,
          notice,
          token: readBridgeRecord(pidFile)?.token,
        })
      ) {
        return port;
      }
      throw buildBridgeEarlyExitError(sessionName, port, exitCode, exitSignal);
    }
    if (
      !sawShallowReady &&
      (await checkBridgeHealth(port, { expectedSession: sessionName, token }))
    ) {
      sawShallowReady = true;
    }
    await sleep(500);
  }

  const seconds = Math.round(timeoutMs / 1000);

  const sharedMcpMode = resolveSharedMcpMode();
  if (sawShallowReady) {
    const suggestions = sharedMcpMode
      ? [
          ...sharedMcpSuggestions(sharedMcpMode),
          "The shared MCP service may be reachable while its attached Chrome target is unavailable.",
        ]
      : [
          "The Chrome/Electron instance the bridge was attached to may have exited.",
          "Verify the target is still listening on its remote-debugging port, then re-run the command.",
          "If the target was restarted, the bridge has already been recycled — this run will succeed once the target is reachable.",
        ];
    throw new CdpError(
      "Bridge is running but the attached CDP target appears to have gone away",
      "BRIDGE_NOT_READY",
      suggestions,
    );
  }

  const suggestions =
    sharedMcpMode === "direct"
      ? sharedMcpSuggestions("direct")
      : sharedMcpMode === "proxy"
        ? sharedMcpSuggestions("proxy")
        : [
            "Axis starts its own pinned chrome-devtools-mcp dependency; reinstall Axis Browser if it is missing (npm install -g github:Nirmantix/axis-browser)",
          ];
  if (!sharedMcpMode && process.env.CHROME_DEVTOOLS_AXI_MCP_PATH?.trim()) {
    suggestions.push(
      "CHROME_DEVTOOLS_AXI_MCP_PATH overrides the pinned build: verify that path starts, or unset it.",
    );
  }
  suggestions.push(
    "Or extend the deadline: export CHROME_DEVTOOLS_AXI_BRIDGE_TIMEOUT_MS=60000",
  );
  throw new CdpError(
    `Bridge failed to start within ${seconds}s`,
    "BRIDGE_NOT_READY",
    suggestions,
  );
}

function parseCallResponse(resp: string): string {
  // Remote input: the bridge always sends a string `result` (extractToolText),
  // but parsing to `any` let a non-string escape through a Promise<string>
  // signature untouched. Validate rather than trust the wire.
  const data = JSON.parse(resp) as { error?: unknown; result?: unknown };
  // Presence, not truthiness: the bridge sets `error` only on failure, so a
  // falsy-but-present value ("" from a truncated message, 0, false) is still
  // an error response and must not fall through as a successful result.
  if (data.error != null) {
    const detail =
      typeof data.error === "string" ? data.error : JSON.stringify(data.error);
    throw new Error(detail || "Bridge reported an error with no detail");
  }
  if (data.result == null) return "";
  return typeof data.result === "string" ? data.result : String(data.result);
}

async function postTool(
  port: number,
  name: string,
  args: Record<string, unknown>,
  opts: { roots?: string[]; timeoutMs?: number; token?: string } = {},
): Promise<string> {
  const body: Record<string, unknown> = { name, args };
  if (opts.roots && opts.roots.length > 0) body.roots = opts.roots;
  const resp = await httpPost(port, "/call", body, opts.timeoutMs, opts.token);
  return parseCallResponse(resp);
}

/**
 * Tool argument keys whose value is a caller-supplied output path, resolved to
 * an absolute path by `resolveOutputPath` before it reaches here. The nearest
 * existing ancestor of their parent directory (or of a directory argument
 * itself) is negotiated as an MCP workspace root, so the write is not restricted
 * to the OS temp directory and missing directories can be created beneath an
 * allowed root (issue #96). Add a key here when a new file-writing tool argument
 * is introduced.
 */
const FILE_OUTPUT_ARGS_BY_TOOL = new Map<string, readonly string[]>([
  ["take_screenshot", ["filePath"]],
  ["get_network_request", ["responseFilePath", "requestFilePath"]],
  ["performance_start_trace", ["filePath"]],
  ["performance_stop_trace", ["filePath"]],
  ["take_memory_snapshot", ["filePath"]],
]);
const DIR_OUTPUT_ARGS_BY_TOOL = new Map<string, readonly string[]>([
  ["lighthouse_audit", ["outputDirPath"]],
]);

function nearestExistingAncestor(path: string): string {
  let candidate = path;
  while (!existsSync(candidate)) {
    const parent = dirname(candidate);
    if (parent === candidate) return candidate;
    candidate = parent;
  }
  return candidate;
}

/**
 * The workspace roots a call needs: always the invoking cwd (so writes under it
 * pass), plus the nearest existing ancestor of any output path argument (so a
 * write outside cwd, e.g. `$HOME/a.png`, passes too).
 */
export function collectRootDirs(
  name: string,
  args: Record<string, unknown>,
): string[] {
  const dirs = new Set<string>([process.cwd()]);
  for (const key of FILE_OUTPUT_ARGS_BY_TOOL.get(name) ?? []) {
    const value = args[key];
    if (typeof value === "string" && value.length > 0) {
      dirs.add(nearestExistingAncestor(dirname(resolve(value))));
    }
  }
  for (const key of DIR_OUTPUT_ARGS_BY_TOOL.get(name) ?? []) {
    const value = args[key];
    if (typeof value === "string" && value.length > 0) {
      dirs.add(nearestExistingAncestor(resolve(value)));
    }
  }
  return [...dirs];
}

/**
 * Resolve the page AXI last selected in this session. Fails loudly when
 * nothing has been selected — AXI will not guess a pageId from
 * `list_pages` `[selected]` (titles/dialogs can forge that marker), and
 * chrome-devtools-mcp 1.8+ will not either (`Required at pageId`).
 *
 * When this invocation's own deep probe reported a browser reconnect
 * (`reconnected`), the missing selection is that reconnect's doing rather than
 * the caller's, so the error names it. The two cases stay distinct: a session
 * that never selected a page, or whose bridge was just respawned, still gets
 * the plain message.
 */
function resolveSelectedPageId(reconnected: boolean): number {
  const pageId = getSelectedPageId();
  if (pageId === null) {
    if (reconnected) throw pageIdentityClearedError();
    throw new CdpError("No page is currently selected", "BROWSER_ERROR", [
      `Run \`${PRIMARY_COMMAND_NAME} open <url>\` to open a page`,
      `Run \`${PRIMARY_COMMAND_NAME} pages\` to list tabs`,
      `Run \`${PRIMARY_COMMAND_NAME} selectpage <id>\` to select a tab`,
    ]);
  }
  return pageId;
}

function resolveToolArgs(
  name: string,
  args: Record<string, unknown>,
  reconnected: boolean,
): Record<string, unknown> {
  if (!needsPageId(name, args)) return args;
  return { ...args, pageId: resolveSelectedPageId(reconnected) };
}

/**
 * Call an MCP tool via the bridge. Returns the text result.
 *
 * Page-scoped tools (eval/snapshot/click/fill and the rest of
 * `PAGE_SCOPED_TOOLS` in `src/pages.ts`) get the session's last
 * `select_page` / url-matched `new_page` `pageId` injected so they satisfy
 * chrome-devtools-mcp 1.8+ defaults. `list_pages` is never consulted.
 */
export async function callTool(
  name: string,
  args: Record<string, unknown> = {},
): Promise<string> {
  // Owned by this call alone, so a concurrent `run`-script call cannot
  // overwrite or consume this one's reconnect attribution.
  const notice: PageIdentityNotice = { pageIdentityChanged: false };
  const port = await ensureBridge(undefined, notice);
  // Re-read for every tool call: the bridge may have been recycled between
  // ensureBridge's probe and this request, and a stale token is a hard 401
  // rather than a silent fall-through to an unauthenticated call.
  const { token } = requireBridgeEndpoint(resolveSessionName());
  let resolved = args;

  try {
    resolved = resolveToolArgs(name, args, notice.pageIdentityChanged);
    const result = await postTool(port, name, resolved, {
      roots: collectRootDirs(name, resolved),
      token,
    });
    rememberToolRouting(name, resolved, result);
    return result;
  } catch (err) {
    if (err instanceof CdpError) throw err;
    const message = err instanceof Error ? err.message : String(err);
    if (isMissingPageError(message)) {
      const pageId =
        typeof resolved.pageId === "number" ? resolved.pageId : null;
      if (pageId !== null && getSelectedPageId() === pageId) {
        clearSelectedPageId();
      }
      throw missingPageError(pageId);
    }
    throw mapErrorMessage(message);
  }
}

/**
 * chrome-devtools-mcp text the bridge flattens into a `/call` error body: a
 * bare line when the tool handler rethrows, or an `Error: `-prefixed line when
 * the response builder appends it. `The selected page has been closed.` leads a
 * sentence that interpolates the `list_pages` tool name, so only its stable
 * clause is anchored.
 */
const MCP_MISSING_PAGE_LINE = "No page found";
const MCP_CLOSED_PAGE_LINE_PREFIX = "The selected page has been closed.";

/**
 * Whether the bridge error body names a page chrome-devtools-mcp itself could
 * not resolve. The body is the *whole* flattened MCP response, and page-owned
 * strings upstream interpolates verbatim (a dialog message, a title) may carry
 * raw newlines, so any line in the middle of the body can be page-controlled.
 * Only the final non-empty line is consulted, which rules those out.
 *
 * It does NOT make the marker unforgeable. Upstream's last element is
 * `Error: <errorMessage>` with the raw exception message interpolated, and
 * that message can itself contain a raw newline, so a page that throws
 * "\nNo page found" ends the body with a line that is exactly the sentence.
 * No purely text-based matcher can separate page bytes inside `errorMessage`
 * from upstream's own sentence. The consequence is fail-closed - a spurious
 * loud error plus dropped routing, never a silent retarget - and the sibling
 * reconnect matcher in `src/bridge.ts` is unaffected, because a forged first
 * line still carries upstream's literal `Error: ` prefix.
 *
 * PARTIALLY VERIFIED DEPENDENCY CONTRACT: the two literals this matcher keys on
 * are pinned against the installed build by `test/mcp-pin.test.ts`, so a
 * chrome-devtools-mcp bump that rewords them fails the suite instead of silently
 * degrading every missing-page error. What is still assumed is the *order*: that
 * chrome-devtools-mcp appends `Error: <message>` LAST, after every page-derived
 * block (and, for the sibling reconnect matcher in `src/bridge.ts`, emits its
 * notice FIRST). If upstream reorders, a genuine missing page falls through to
 * `mapErrorMessage` and surfaces as a less specific error rather than
 * retargeting anything; upstream hands out page ids from a process-wide
 * monotonic counter, so a stale id fails to resolve instead of landing on an
 * unrelated page.
 */
function isMissingPageError(message: string): boolean {
  const line = lastNonEmptyLine(message).replace(/^Error:\s*/, "");
  return (
    line === MCP_MISSING_PAGE_LINE ||
    line.startsWith(MCP_CLOSED_PAGE_LINE_PREFIX)
  );
}

function lastNonEmptyLine(message: string): string {
  const lines = message.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i].trim();
    if (line) return line;
  }
  return "";
}

function missingPageError(pageId: number | null): CdpError {
  return new CdpError(
    pageId === null
      ? "The selected page is no longer available"
      : `Page ${pageId} is no longer available`,
    "BROWSER_ERROR",
    [
      `Run \`${PRIMARY_COMMAND_NAME} pages\` to list the remaining tabs`,
      `Run \`${PRIMARY_COMMAND_NAME} selectpage <id>\` to select a tab, or \`${PRIMARY_COMMAND_NAME} open <url>\` to open one`,
    ],
  );
}

const PAGE_IDENTITY_SUGGESTIONS = [
  `Run \`${PRIMARY_COMMAND_NAME} pages\` to list the current tabs and their new ids`,
  `Run \`${PRIMARY_COMMAND_NAME} selectpage <id>\` to re-select a tab after the reconnect, then retry`,
];

function pageIdentityChangedError(): CdpError {
  return new CdpError(
    PAGE_IDENTITY_CHANGED_ERROR,
    "BROWSER_ERROR",
    PAGE_IDENTITY_SUGGESTIONS,
  );
}

/**
 * The reconnect already happened before this command ran: the deep probe
 * consumed the marker and dropped the routing it invalidated, so nothing was
 * sent to a wrong tab and there is nothing to retarget — the caller just has
 * to re-select. Keeps the `BROWSER_ERROR` code and the "no page" clause of the
 * plain no-selection message so `open`'s existing recovery still applies (it
 * creates a new tab; see AGENTS.md).
 *
 * Exported so the `open` / `page.open` recovery tests build their rejection
 * from the message this ships rather than a copy of it, which is what makes
 * them fail if a reword breaks that match.
 */
export function pageIdentityClearedError(): CdpError {
  return new CdpError(
    "The browser reconnected and every page id changed, so no page is currently selected",
    "BROWSER_ERROR",
    PAGE_IDENTITY_SUGGESTIONS,
  );
}

export function mapErrorMessage(message: string): CdpError {
  if (message === PAGE_IDENTITY_CHANGED_ERROR) {
    return pageIdentityChangedError();
  }
  if (isMissingPageError(message)) return missingPageError(null);
  if (message.includes("ECONNREFUSED") || message.includes("ECONNRESET")) {
    return new CdpError("Bridge is not running", "BRIDGE_NOT_READY", [
      `Run \`${PRIMARY_COMMAND_NAME} open <url>\` — the bridge starts automatically`,
    ]);
  }
  if (
    (message.includes("uid") || message.includes("element")) &&
    (message.includes("not found") || message.includes("invalid"))
  ) {
    return new CdpError(message, "REF_NOT_FOUND", [
      `Run \`${PRIMARY_COMMAND_NAME} snapshot\` to see available elements and their @uid refs`,
    ]);
  }
  if (message.includes("timeout") || message.includes("timed out")) {
    return new CdpError(message, "TIMEOUT", [
      `Run \`${PRIMARY_COMMAND_NAME} snapshot\` to see current page state`,
    ]);
  }
  // Try to parse JSON error
  try {
    const parsed = JSON.parse(message);
    if (parsed.error) {
      return new CdpError(parsed.error, "BROWSER_ERROR", [
        `Run \`${PRIMARY_COMMAND_NAME} snapshot\` to see current page state`,
      ]);
    }
  } catch {
    // Not JSON
  }
  return new CdpError(message, "UNKNOWN");
}

/**
 * Get the current page snapshot without starting the bridge.
 *
 * Returns null if the bridge is not running or healthy. This is the ambient
 * home view / SessionStart probe, so it must stay cheap and never throw: an
 * invalid `CHROME_DEVTOOLS_AXI_SESSION` degrades to "no active session" (null)
 * here, while action commands (`ensureBridge` / `stopBridge`) still fail loudly.
 */
export async function getSessionSnapshotIfRunning(): Promise<string | null> {
  let sessionName: string;
  let endpoint: BridgeEndpoint | null;
  let pid: number | null;
  try {
    sessionName = resolveSessionName();
    const record = readBridgeRecord(resolveSessionPidFile(sessionName));
    endpoint = isAuthedRecord(record)
      ? { port: record.port, token: record.token }
      : null;
    pid = record?.pid ?? null;
  } catch {
    return null;
  }
  // A tokenless legacy record degrades to "no active session" here instead of
  // raising: this probe runs on every prompt, and `axis-browser stop` is the loud
  // path that explains how to retire the old bridge.
  if (!endpoint || pid === null || !isProcessAlive(pid)) return null;
  if (
    !(await checkBridgeHealth(endpoint.port, {
      expectedSession: sessionName,
      token: endpoint.token,
    }))
  ) {
    return null;
  }
  try {
    const pageId = getSelectedPageId();
    if (pageId === null) return null;
    return await postTool(
      endpoint.port,
      "take_snapshot",
      { pageId },
      { timeoutMs: 5000, token: endpoint.token },
    );
  } catch {
    return null;
  }
}

/**
 * Stop the bridge process for the selected session. Waits for the pid to actually
 * exit before escalating, and only ever signals a process whose live identity
 * matches the record — see {@link terminateBridgeProcess}.
 *
 * A tokenless record predates the capability token, so it cannot be authenticated.
 * Because `stop` is an explicit operator command rather than a probe that races
 * bridge startup, it still retires that bridge, but only through the verified path
 * in {@link stopLegacyBridge}.
 */
export async function stopBridge(): Promise<boolean> {
  const sessionName = resolveSessionName();
  const pidFile = resolveSessionPidFile(sessionName);
  const record = readBridgeRecord(pidFile);
  if (!record) return false;
  if (!isProcessAlive(record.pid)) {
    // Nothing to signal, but a tokenless record left in place keeps refusing
    // every later `open` — retire it here so `stop` actually clears the
    // session instead of reporting a no-op forever. Authenticated records
    // keep their lifecycle: a dead one is simply overwritten by the next
    // bridge this session starts, and its token is useless without a process.
    // No ownership proof is needed for a deletion the directory's writer could
    // already perform; the verified path above is what guards *signalling*.
    if (!isAuthedRecord(record)) {
      clearLegacyBridgeRecord({ pid: record.pid }, pidFile);
    }
    return false;
  }

  if (isAuthedRecord(record)) {
    await terminateBridgeProcess(record.pid, record.startedAt, {
      killProcessGroup: true,
    });
    // An orderly bridge removes its own record on exit; one that had to be
    // SIGKILLed never ran that handler. Clear it here so a dead session does not
    // leave a live-looking record — holding a token — on disk. The pid and token
    // comparison means a bridge that restarted in the meantime is left alone.
    clearBridgeRecord({ pid: record.pid, token: record.token }, pidFile);
  } else {
    await stopLegacyBridge(sessionName, record);
  }
  clearSelectedPageId();
  return true;
}

/**
 * Retire a pre-token bridge on explicit operator request — or explain why it will
 * not be touched.
 *
 * Nothing here is authenticated by a secret, so the authority to signal comes from
 * evidence instead: the state directory must be a real owner-controlled directory
 * (never a symlink), the live process must carry the bridge marker, and two
 * independent identity reads must agree on the same start time. That last check is
 * what separates "this pid has been the same bridge all along" from "this pid was
 * recycled between our two looks". Anything unverifiable raises instead of
 * signalling.
 */
async function stopLegacyBridge(
  sessionName: string,
  record: BridgeRecord,
): Promise<void> {
  const pidFile = resolveSessionPidFile(sessionName);
  try {
    assertStateDirOwned(resolveSessionStateChain(sessionName));
  } catch (error) {
    throw new CdpError(
      `Refusing to act on the bridge record for session "${sessionName}": ${error instanceof Error ? error.message : String(error)}`,
      "BRIDGE_NOT_READY",
      error instanceof StateDirError ? [...error.repair] : [],
    );
  }

  const first = readProcessIdentity(record.pid);
  const second =
    first && identityIsBridge(first) ? readProcessIdentity(record.pid) : null;
  if (
    !first ||
    !identityIsBridge(first) ||
    !second ||
    !identityMatchesRecord(second, first.startedAt)
  ) {
    throw new CdpError(
      `The record for session "${sessionName}" names pid ${record.pid}, but that pid could not be verified as this bridge (no bridge marker in its command line, or its start time changed between two reads). Nothing was signalled.`,
      "BRIDGE_NOT_READY",
      [
        `Inspect it yourself before deciding anything: ps -p ${record.pid} -o command=,lstart=`,
        `If it is unrelated, clear the stale record: rm -f ${pidFile}`,
        "Or work in a fresh session: CHROME_DEVTOOLS_AXI_SESSION=work2 axis-browser open <url>",
      ],
    );
  }

  // If the old bridge answers /health at all, insist that it is *this* session's.
  // No answer is not a failure: a tokenless bridge may already be wedged, and the
  // identity checks above are what authorise the signal.
  const reported = await readLegacyBridgeSession(record.port);
  if (reported !== null && reported !== sessionName) {
    throw new CdpError(
      `Pid ${record.pid} answers on port ${record.port} as session "${reported}", not "${sessionName}". Nothing was signalled: the record and the live bridge disagree about which session they belong to.`,
      "BRIDGE_NOT_READY",
      [
        `Stop the session that actually owns it: CHROME_DEVTOOLS_AXI_SESSION=${reported} axis-browser stop`,
        `Then clear this stale record: rm -f ${pidFile}`,
      ],
    );
  }

  await terminateBridgeProcess(record.pid, second.startedAt, {
    killProcessGroup: true,
  });
  // A SIGKILLed legacy bridge never runs its own cleanup, so its record would
  // outlive it and be mistaken for a live bridge by the next command.
  clearLegacyBridgeRecord({ pid: record.pid });
}

/** The session name a pre-token bridge reports on /health, or null if it does not answer. */
async function readLegacyBridgeSession(port: number): Promise<string | null> {
  try {
    const data = JSON.parse(
      await httpGet(port, "/health", HEALTH_TIMEOUT_MS),
    ) as {
      session?: unknown;
    };
    return typeof data.session === "string" ? data.session : null;
  } catch {
    return null;
  }
}
