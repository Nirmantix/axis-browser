/**
 * Endpoint identity — answering "what is actually listening there?" before we hand a
 * URL to chrome-devtools-mcp.
 *
 * This module exists because of a real, day-long work stoppage. A globally-exported
 * `CHROME_DEVTOOLS_AXI_BROWSER_URL=http://127.0.0.1:9222` pinned every shell into attach
 * mode, but 9222 was held by an unrelated Chromium-based browser that served no DevTools
 * endpoint. chrome-devtools-mcp failed opaquely, ~30s later, with no mention of who held
 * the port — and the agent reading that failure concluded the endpoint must need
 * authentication and escalated to the operator. Local CDP has no authentication; the
 * conclusion was invented to explain a diagnostic that never named the real cause.
 *
 * So validity here is deliberately strict. A 200 is NOT proof: the squatter answered 404
 * on every path, but a squatter answering 200 with unrelated JSON would have been worse.
 * An endpoint is only usable when it is HTTP 200 **and** parseable JSON **and** carries a
 * `webSocketDebuggerUrl` **and** its `Browser` string looks like Chrome. Anything else
 * gets a named reason and, where the platform allows, the identity of the port holder.
 */

import { execFileSync } from "node:child_process";

export type ProbeFailureReason =
  "NO_LISTENER" | "NOT_CDP" | "WRONG_BROWSER" | "TIMEOUT";

export interface PortHolder {
  pid: number;
  command: string;
}

export type ProbeResult =
  | { ok: true; browser: string; wsUrl: string }
  | {
      ok: false;
      reason: ProbeFailureReason;
      detail?: string;
      holder?: PortHolder;
    };

/** A CDP `Browser` string we are willing to drive, e.g. "Chrome/141.0.0.0". */
const CHROME_BROWSER_RE = /^(Headless)?Chrome\//;

export interface ProbeDeps {
  fetchFn?: typeof fetch;
  describeHolder?: (port: number) => PortHolder | null;
}

/** Extract the port from an http(s) URL, or null when it carries none we can read. */
export function portOf(baseUrl: string): number | null {
  try {
    const url = new URL(baseUrl);
    if (url.port) return Number(url.port);
    if (url.protocol === "http:") return 80;
    if (url.protocol === "https:") return 443;
    return null;
  } catch {
    return null;
  }
}

/**
 * Probe an http(s) CDP endpoint's `/json/version`.
 *
 * Failure results carry `holder` whenever a port holder can be identified, because
 * "nothing is listening on 9222" and "Ulaa is listening on 9222" call for opposite
 * remedies, and only the second one is a decision the operator has to make.
 */
export async function probeCdpEndpoint(
  baseUrl: string,
  timeoutMs = 2000,
  deps: ProbeDeps = {},
): Promise<ProbeResult> {
  const doFetch = deps.fetchFn ?? fetch;
  const describe = deps.describeHolder ?? describePortHolder;
  const port = portOf(baseUrl);
  const holderOf = (): PortHolder | undefined => {
    if (port === null) return undefined;
    return describe(port) ?? undefined;
  };
  const withHolder = (
    reason: ProbeFailureReason,
    detail?: string,
  ): ProbeResult => {
    const holder = holderOf();
    return {
      ok: false,
      reason,
      ...(detail ? { detail } : {}),
      ...(holder ? { holder } : {}),
    };
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response: Response;
  try {
    response = await doFetch(`${baseUrl.replace(/\/+$/, "")}/json/version`, {
      signal: controller.signal,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // An aborted request is a timeout; anything else at this stage means we never got
    // a response at all (connection refused, DNS, TLS).
    const aborted =
      controller.signal.aborted ||
      (error instanceof Error && error.name === "AbortError");
    return withHolder(aborted ? "TIMEOUT" : "NO_LISTENER", message);
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    return withHolder("NOT_CDP", `HTTP ${response.status}`);
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return withHolder("NOT_CDP", "response body was not JSON");
  }

  if (payload === null || typeof payload !== "object") {
    return withHolder("NOT_CDP", "response JSON was not an object");
  }
  const record = payload as Record<string, unknown>;
  const wsUrl = record.webSocketDebuggerUrl;
  const browser = record.Browser;
  if (typeof wsUrl !== "string" || wsUrl.length === 0) {
    return withHolder("NOT_CDP", "no webSocketDebuggerUrl in /json/version");
  }
  if (typeof browser !== "string" || !CHROME_BROWSER_RE.test(browser)) {
    return withHolder(
      "WRONG_BROWSER",
      `Browser=${typeof browser === "string" ? browser : "(absent)"}`,
    );
  }

  return { ok: true, browser, wsUrl };
}

/**
 * Identify the process listening on a TCP port. Best-effort and non-fatal: it shells out
 * to `lsof`, which is absent on Windows and can be missing or restricted elsewhere, so
 * every failure path returns null rather than throwing. Naming the holder is a diagnostic
 * nicety; failing to name it must never break a command.
 */
export function describePortHolder(
  port: number,
  platform: NodeJS.Platform = process.platform,
): PortHolder | null {
  if (platform === "win32") return null;
  try {
    const out = execFileSync(
      "lsof",
      ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-F", "pc"],
      { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] },
    );
    // -F pc emits records as `p<pid>` / `c<command>` on separate lines.
    let pid: number | null = null;
    let command: string | null = null;
    for (const line of out.split("\n")) {
      if (line.startsWith("p")) pid = Number(line.slice(1));
      else if (line.startsWith("c") && pid !== null) {
        command = line.slice(1);
        break;
      }
    }
    if (pid === null || !Number.isFinite(pid) || command === null) return null;
    return { pid, command };
  } catch {
    return null;
  }
}

/**
 * Render a probe failure as operator/agent-facing lines.
 *
 * The final line is load-bearing and must not be softened: an agent that reads a bare
 * connection failure against a local CDP port has been observed to invent an
 * authentication requirement and escalate. Saying plainly that there is no auth removes
 * the gap the hallucination fills.
 */
export function describeProbeFailure(
  baseUrl: string,
  result: Extract<ProbeResult, { ok: false }>,
): string[] {
  const lines: string[] = [];
  const holder = result.holder
    ? `${result.holder.command} (pid ${result.holder.pid})`
    : null;

  switch (result.reason) {
    case "NO_LISTENER":
      lines.push(
        `Nothing is listening on ${baseUrl} — no browser is exposing a DevTools endpoint there.`,
        "Either start one, or unset CHROME_DEVTOOLS_AXI_BROWSER_URL to let axis launch and own its own browser.",
      );
      break;
    case "TIMEOUT":
      lines.push(
        `${baseUrl} accepted a connection but did not answer /json/version in time.`,
      );
      if (holder) lines.push(`The port is held by ${holder}.`);
      break;
    case "NOT_CDP":
      lines.push(
        `${baseUrl} is listening but is not a DevTools endpoint${result.detail ? ` (${result.detail})` : ""}.`,
      );
      if (holder) {
        lines.push(
          `The port is held by ${holder} — that is not a CDP server, so attaching to it cannot work.`,
        );
      }
      lines.push(
        "Point CHROME_DEVTOOLS_AXI_BROWSER_URL at a real DevTools endpoint, or unset it to let axis launch its own browser.",
      );
      break;
    case "WRONG_BROWSER":
      lines.push(
        `${baseUrl} answered, but the browser there is not one axis can drive${result.detail ? ` (${result.detail})` : ""}.`,
      );
      break;
  }

  lines.push(
    "Local CDP has no authentication. Do not request credentials, tokens, or a ws:// URL.",
  );
  return lines;
}
