/**
 * `axis-browser doctor` — machine-readable preflight.
 *
 * This is the anti-escalation lever. The incident that produced it went: a command failed
 * with a diagnostic that named neither the mode nor the process holding the port; the
 * agent could not tell "misconfigured" from "needs a human"; it invented an
 * authentication requirement for an unauthenticated local port and stopped work to ask
 * the operator. Nothing in the toolchain could have told it otherwise, because nothing
 * reported the state it needed.
 *
 * So `doctor` reports that state, and every remedy it emits is a **runnable command, not
 * prose**. An agent should receive a fix, not a diagnosis. The only two conditions that
 * legitimately need a human are marked as such:
 *
 *   NEEDS_INTERACTIVE_LOGIN        the managed profile has never logged into the site
 *   PORT_HELD_BY_FOREIGN_PROCESS   killing the operator's own browser is their call
 */

import { existsSync, readlinkSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { checkBridgeHealth } from "./client.js";
import { type AxiMode, resolveModeSafe, resolveUserDataDir } from "./mode.js";
import {
  DEFAULT_REAP_MIN_AGE_MS,
  expandClaimedToTrees,
  findOrphanBridges,
  listBridgeProcesses,
  scanSessionPidFiles,
} from "./reap.js";
import {
  DEFAULT_SESSION_NAME,
  defaultPortForSession,
  isAuthedRecord,
  readBridgeRecord,
  resolveSessionName,
  resolveSessionPidFile,
  resolveSessionPort,
} from "./sessions.js";
import { chromeCheck } from "./setup.js";
import {
  type ProbeResult,
  describePortHolder,
  describeProbeFailure,
  probeCdpEndpoint,
} from "./target.js";

export type DoctorStatus = "ok" | "warn" | "error";

export interface DoctorReport {
  status: DoctorStatus;
  mode: AxiMode;
  session: { name: string; port: number };
  endpoint?: {
    url: string;
    ok: boolean;
    browser?: string;
    reason?: string;
    detail?: string;
    holder?: { pid: number; command: string };
  };
  binary: { status: string; path?: string; executablePath?: string };
  profile?: {
    dir: string;
    exists: boolean;
    locked: boolean;
    lockHolder?: string;
  };
  bridges: Array<{ pid: number; claimed: boolean; ageMs: number }>;
  orphans: Array<{ pid: number; ageMs: number }>;
  /** PID files that exist but could not be parsed; these suppress automatic reaping. */
  malformedPidFiles: string[];
  blockers: string[];
  remedies: string[];
}

/**
 * Read Chrome's `SingletonLock`. On POSIX it is a symlink whose target is
 * `<hostname>-<pid>`; its presence is how Chrome enforces one process per profile. A
 * stale lock (the naming process is gone) is reported as unlocked, because that is the
 * case where a relaunch simply works.
 */
export function readProfileLock(
  profileDir: string,
  alive: (pid: number) => boolean = isAlive,
): { locked: boolean; holder?: string } {
  const lockPath = join(profileDir, "SingletonLock");
  let target: string;
  try {
    target = readlinkSync(lockPath);
  } catch {
    return { locked: false };
  }
  const pid = Number(target.slice(target.lastIndexOf("-") + 1));
  if (!Number.isFinite(pid) || pid <= 0)
    return { locked: true, holder: target };
  return alive(pid) ? { locked: true, holder: target } : { locked: false };
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export interface DoctorDeps {
  probe?: typeof probeCdpEndpoint;
  health?: typeof checkBridgeHealth;
  home?: string;
  platform?: NodeJS.Platform;
}

export async function buildDoctorReport(
  env: NodeJS.ProcessEnv = process.env,
  deps: DoctorDeps = {},
): Promise<DoctorReport> {
  const probe = deps.probe ?? probeCdpEndpoint;
  const health = deps.health ?? checkBridgeHealth;
  const home = deps.home ?? homedir();
  const platform = deps.platform ?? process.platform;

  const mode = resolveModeSafe(env);
  const blockers: string[] = [];
  const remedies: string[] = [];
  let status: DoctorStatus = "ok";

  // `resolveModeSafe` exists so an invalid mode cannot replace the diagnosis with an
  // unrelated exception — but `resolveSessionName` throws on an invalid
  // CHROME_DEVTOOLS_AXI_SESSION for the same reason, and that killed `doctor` with a raw
  // stack trace instead of reporting the very misconfiguration it exists to report.
  let sessionName: string;
  try {
    // Pass the report's own env: buildDoctorReport is parameterised on env, so
    // reading process.env here would make it diagnose a different environment
    // than the one it was handed.
    sessionName = resolveSessionName(env);
  } catch (error) {
    sessionName = DEFAULT_SESSION_NAME;
    status = "error";
    blockers.push(error instanceof Error ? error.message : String(error));
    remedies.push("unset CHROME_DEVTOOLS_AXI_SESSION");
  }
  // Same reasoning as the session name above: doctor exists to *report* a
  // misconfiguration, so an unusable CHROME_DEVTOOLS_AXI_PORT has to become a
  // blocker rather than an exception that replaces the whole diagnosis.
  let port: number;
  try {
    port = resolveSessionPort(sessionName, env);
  } catch (error) {
    port = defaultPortForSession(sessionName);
    status = "error";
    blockers.push(error instanceof Error ? error.message : String(error));
    remedies.push("unset CHROME_DEVTOOLS_AXI_PORT");
  }

  const report: DoctorReport = {
    status,
    mode,
    session: { name: sessionName, port },
    binary: { status: "unknown" },
    bridges: [],
    orphans: [],
    malformedPidFiles: [],
    blockers,
    remedies,
  };

  // Established up front because the profile check below depends on it: a locked
  // profile is only a problem when it is NOT our own healthy bridge holding it.
  // The bridge now requires a capability token, so doctor presents the same secret
  // every other RPC path does: without it a perfectly healthy bridge answers 401
  // and doctor would report the session as broken.
  const record = readBridgeRecord(resolveSessionPidFile(sessionName, home));
  const bridgeHealthy = await health(port, {
    expectedSession: sessionName,
    token: isAuthedRecord(record) ? record.token : undefined,
  });
  if (record && !isAuthedRecord(record)) {
    if (status === "ok") status = "warn";
    blockers.push(
      `The bridge record for session "${sessionName}" predates capability tokens, so this CLI cannot authenticate to the bridge it names (pid ${record.pid}).`,
    );
    remedies.push(
      "axis-browser stop   (verifies then retires the unauthenticated bridge)",
    );
  }

  // ── the target ────────────────────────────────────────────────────────────────
  if (mode === "attach") {
    const url = env.CHROME_DEVTOOLS_AXI_BROWSER_URL ?? "";
    if (/^wss?:\/\//i.test(url)) {
      // A ws(s) endpoint exposes no /json/version to probe; report it plainly rather
      // than pretending to have verified it.
      report.endpoint = { url, ok: true, browser: "(ws endpoint, not probed)" };
    } else {
      const result: ProbeResult = await probe(url, 2000);
      if (result.ok) {
        report.endpoint = { url, ok: true, browser: result.browser };
      } else {
        status = "error";
        report.endpoint = {
          url,
          ok: false,
          reason: result.reason,
          ...(result.detail ? { detail: result.detail } : {}),
          ...(result.holder ? { holder: result.holder } : {}),
        };
        blockers.push(...describeProbeFailure(url, result));
        // The holder being someone else's browser is the one case a human must rule
        // on: axis will not kill a process it does not own.
        if (result.holder) {
          blockers.push("PORT_HELD_BY_FOREIGN_PROCESS");
        }
        remedies.push(
          "unset CHROME_DEVTOOLS_AXI_BROWSER_URL",
          "export CHROME_DEVTOOLS_AXI_MODE=managed",
          "axis-browser start",
        );
      }
    }
  }

  // ── the browser binary ────────────────────────────────────────────────────────
  const chrome = chromeCheck(platform);
  const executablePath = env.CHROME_DEVTOOLS_AXI_EXECUTABLE_PATH?.trim();
  report.binary = {
    status: chrome.status,
    ...(chrome.path ? { path: chrome.path } : {}),
    ...(executablePath ? { executablePath } : {}),
  };
  if (executablePath && !existsSync(executablePath)) {
    status = "error";
    blockers.push(
      `CHROME_DEVTOOLS_AXI_EXECUTABLE_PATH points at "${executablePath}", which does not exist.`,
    );
    remedies.push("unset CHROME_DEVTOOLS_AXI_EXECUTABLE_PATH");
  }
  if (chrome.status === "missing" && mode !== "attach") {
    status = "error";
    blockers.push(
      "No Chrome/Chromium was found, and this mode launches a browser.",
    );
  }

  // ── the profile ───────────────────────────────────────────────────────────────
  if (mode === "managed") {
    let dir: string | null = null;
    try {
      dir = resolveUserDataDir(mode, env, sessionName, home, platform);
    } catch (error) {
      status = "error";
      blockers.push(error instanceof Error ? error.message : String(error));
      remedies.push(
        `export CHROME_DEVTOOLS_AXI_USER_DATA_DIR="${join(home, ".axis-browser-data")}"`,
      );
    }
    if (dir) {
      const exists = existsSync(dir);
      const lock = readProfileLock(dir);
      report.profile = {
        dir,
        exists,
        locked: lock.locked,
        ...(lock.holder ? { lockHolder: lock.holder } : {}),
      };
      // A lock held while our own bridge is healthy is just our browser running —
      // reporting that as a problem would train readers to ignore the field.
      if (lock.locked && !bridgeHealthy) {
        if (status === "ok") status = "warn";
        blockers.push(
          `The profile at ${dir} is locked by another Chrome (${lock.holder}), and this session's bridge is not answering; a launch on it will fail.`,
        );
        remedies.push(
          `CHROME_DEVTOOLS_AXI_SESSION=${sessionName}-2 axis-browser start`,
        );
      }
      if (!exists) {
        // Not an error: the first managed run creates it. But a site that needs a
        // login has nowhere to have stored one yet, and that IS a human's call.
        // status follows blockers: a condition mandating escalation is not "ok".
        if (status === "ok") status = "warn";
        blockers.push("NEEDS_INTERACTIVE_LOGIN (profile has no state yet)");
        remedies.push("axis-browser login <url>");
      }
    }
  }

  // ── bridges and orphans ───────────────────────────────────────────────────────
  // One `ps` for both the listing and the orphan scan.
  const processes = listBridgeProcesses();
  const scan = scanSessionPidFiles(home);
  const claimedTrees = expandClaimedToTrees(scan.claimed, processes);
  for (const bridge of processes) {
    report.bridges.push({
      pid: bridge.pid,
      claimed: claimedTrees.has(bridge.pid),
      ageMs: bridge.ageMs,
    });
  }
  const orphans = findOrphanBridges(DEFAULT_REAP_MIN_AGE_MS, home, processes);
  for (const orphan of orphans) {
    report.orphans.push({ pid: orphan.pid, ageMs: orphan.ageMs });
  }
  if (orphans.length > 0) {
    if (status === "ok") status = "warn";
    remedies.push("axis-browser reap");
  }

  // An unreadable PID file disables automatic reaping (see reap.ts). Silent
  // disablement is how a safety mechanism rots, so it is reported, not just obeyed.
  report.malformedPidFiles = scan.malformed;
  if (scan.malformed.length > 0) {
    if (status === "ok") status = "warn";
    blockers.push(
      `Unreadable session PID file(s): ${scan.malformed.join(", ")}. ` +
        "Automatic reaping is suppressed while one exists, because an unparseable file is an " +
        "unverifiable claim rather than an absent one.",
    );
    for (const file of scan.malformed) remedies.push(`rm ${file}`);
  }

  // ── the bridge for THIS session ───────────────────────────────────────────────
  if (!bridgeHealthy) {
    const holder = describePortHolder(port, platform);
    if (holder) {
      if (status === "ok") status = "warn";
      blockers.push(
        `Port ${port} is held by ${holder.command} (pid ${holder.pid}) but it is not answering as this session's bridge.`,
      );
      remedies.push(
        `CHROME_DEVTOOLS_AXI_PORT=${port + 1} axis-browser start`,
        "axis-browser stop",
      );
    }
  }

  report.status = status;
  return report;
}

/** Human-readable rendering. The JSON form is the contract; this is for eyes. */
export function renderDoctorReport(report: DoctorReport): string {
  const lines: string[] = [];
  lines.push(`status: ${report.status}`);
  lines.push(`mode: ${report.mode}`);
  lines.push(`session: ${report.session.name} (port ${report.session.port})`);

  if (report.endpoint) {
    const e = report.endpoint;
    lines.push(
      `endpoint: ${e.url} — ${e.ok ? `ok (${e.browser})` : `${e.reason}${e.detail ? ` (${e.detail})` : ""}`}`,
    );
    if (e.holder) {
      lines.push(`  held by: ${e.holder.command} (pid ${e.holder.pid})`);
    }
  }

  lines.push(
    `browser: ${report.binary.status}${report.binary.path ? ` at ${report.binary.path}` : ""}`,
  );
  if (report.binary.executablePath) {
    lines.push(`  pinned: ${report.binary.executablePath}`);
  }
  if (report.profile) {
    lines.push(
      `profile: ${report.profile.dir} (${report.profile.exists ? "exists" : "not created yet"}${report.profile.locked ? ", LOCKED" : ""})`,
    );
  }
  lines.push(
    `bridges: ${report.bridges.length} (${report.orphans.length} orphaned)`,
  );
  if (report.malformedPidFiles.length > 0) {
    lines.push(
      `unreadable PID files: ${report.malformedPidFiles.length} (auto-reap suppressed)`,
    );
  }

  if (report.blockers.length > 0) {
    lines.push("", "blockers:");
    for (const blocker of report.blockers) lines.push(`  - ${blocker}`);
  }
  if (report.remedies.length > 0) {
    lines.push("", "remedies (runnable):");
    for (const remedy of report.remedies) lines.push(`  $ ${remedy}`);
  }
  return lines.join("\n");
}
