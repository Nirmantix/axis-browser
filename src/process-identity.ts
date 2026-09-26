/**
 * Cross-platform process identity probes.
 *
 * Why this exists: a PID file records a number, and numbers get reused. Before
 * this module the CLI sent SIGTERM to whatever PID the record named, after a
 * `ps`-based check that ran once, at an arbitrary distance from the signal — so a
 * stale record whose PID had been recycled could terminate an unrelated process
 * owned by the same user. Every signal path now asks for the process's command
 * line *and* its start time, and compares the start time against the one recorded
 * when the bridge bound its port. A reused PID has a different start time, so it
 * is left alone and reported as stale state instead.
 *
 * `ps` does not exist on Windows and PowerShell does not exist everywhere else,
 * so both are implemented and selected by platform. Every probe is injectable and
 * fails closed: an unreadable, unparseable, or absent identity returns `null`,
 * and callers must treat `null` as "do not signal".
 *
 * This is best-effort verification against PID reuse, not an OS-level
 * process-handle guarantee — POSIX has no "signal this exact process instance"
 * primitive available to us, and the two probes (identity read, then signal) are
 * not atomic. Callers re-read immediately before each signal to keep the window
 * as small as possible.
 */

import { execFileSync } from "node:child_process";

/** Substring that identifies one of our bridge processes by its command line. */
export const BRIDGE_COMMAND_MARKER = "chrome-devtools-axi-bridge";

export interface ProcessIdentity {
  /** Command line as the OS reports it. */
  command: string;
  /**
   * Start time, normalized to a string that is stable for comparison across
   * reads of the same process: `ps` `lstart` on POSIX, ISO-8601 on Windows.
   */
  startedAt: string;
}

/** Runs an external probe and returns its trimmed stdout, or null on failure. */
export type ProbeRunner = (
  command: string,
  args: readonly string[],
) => string | null;

export interface IdentityDeps {
  runner?: ProbeRunner;
  platform?: NodeJS.Platform;
}

/**
 * `ps -o lstart=` prints a fixed 24-character timestamp
 * (`Sun Sep 27 00:24:35 2026`, day space-padded). Reading it in the same
 * invocation as the command line is what makes the pair one observation rather
 * than two: the command line is last because it can contain anything, including
 * newlines.
 */
const LSTART_WIDTH = 24;
const LSTART_SHAPE =
  /^[A-Z][a-z]{2} [A-Z][a-z]{2} [ \d]\d \d{2}:\d{2}:\d{2} \d{4}$/;
const ISO_8601_SHAPE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;

/**
 * The production probe runner, exported so other fail-closed modules
 * (`state-dir.ts`) share one implementation instead of inventing a second
 * `execFileSync` wrapper with different timeout or locale behaviour.
 */
export const defaultProbeRunner: ProbeRunner = (command, args) => {
  try {
    const output = execFileSync(command, [...args], {
      encoding: "utf8",
      timeout: 2_000,
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
      // `lstart` renders month and weekday names; pin the locale so the
      // fixed-width parse and the shape check do not depend on the caller's.
      env: { ...process.env, LC_ALL: "C" },
    });
    return output.replace(/\n$/, "");
  } catch {
    // Non-zero exit (no such pid), timeout, or a missing binary: all mean the
    // identity could not be established, which callers treat as "do not signal".
    return null;
  }
};

/**
 * Adapt a runner so that neither a non-string result nor a thrown error can
 * reach a parser.
 *
 * Every probe here promises "null means we could not establish this, so do not
 * act". A `TypeError` from `.slice` on a Buffer, or an escaping throw from an
 * injected stub, would replace that refusal with a crash on the termination path
 * — the one place a crash is worse than saying "I could not verify this". The
 * default runner already catches internally and always returns a string; this
 * guard is what makes the contract true for *every* runner rather than for the
 * happy path, and it is why callers can treat null as the only failure mode.
 */
export function guardedProbeRunner(runner: ProbeRunner): ProbeRunner {
  return (command, args) => {
    try {
      const output = runner(command, args);
      return typeof output === "string" ? output : null;
    } catch {
      return null;
    }
  };
}

function readPosixIdentity(
  pid: number,
  runner: ProbeRunner,
): ProcessIdentity | null {
  const raw = runner("ps", ["-p", String(pid), "-o", "lstart=,command="]);
  if (raw === null || raw.length <= LSTART_WIDTH) return null;
  const startedAt = raw.slice(0, LSTART_WIDTH).trim();
  const command = raw.slice(LSTART_WIDTH).trim();
  if (!LSTART_SHAPE.test(startedAt) || command.length === 0) return null;
  return { command, startedAt };
}

/**
 * One PowerShell invocation returns both fields, separated by the first `|`.
 * A null `CommandLine` (access denied) is treated as unverifiable rather than as
 * an empty command: we would otherwise accept "no command line" as a match for
 * nothing and signal a process we cannot identify.
 */
function readWindowsIdentity(
  pid: number,
  runner: ProbeRunner,
): ProcessIdentity | null {
  const script =
    `$p = Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}'; ` +
    `if ($p -and $p.CreationDate -and $p.CommandLine) { ` +
    `Write-Output ($p.CreationDate.ToString('o') + '|' + $p.CommandLine) }`;
  const raw = runner("powershell.exe", [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    script,
  ]);
  if (raw === null) return null;
  const separator = raw.indexOf("|");
  if (separator < 0) return null;
  const startedAt = raw.slice(0, separator).trim();
  const command = raw.slice(separator + 1).trim();
  if (!ISO_8601_SHAPE.test(startedAt) || command.length === 0) return null;
  return { command, startedAt };
}

/**
 * The command line and start time of `pid`, or null when either cannot be
 * established. Callers must not signal a process whose identity is null.
 */
export function readProcessIdentity(
  pid: number,
  deps: IdentityDeps = {},
): ProcessIdentity | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  const runner = guardedProbeRunner(deps.runner ?? defaultProbeRunner);
  const platform = deps.platform ?? process.platform;
  return platform === "win32"
    ? readWindowsIdentity(pid, runner)
    : readPosixIdentity(pid, runner);
}

/**
 * The process group ID of `pid`, or null when it cannot be determined.
 *
 * Used before any group signal: killing `-pid` is only safe when `pid` is its own
 * group leader, which is exactly what `pgid === pid` states. A caller-supplied
 * arbitrary PGID is never signaled — the group is always read back from the
 * process being terminated, so a recycled PID cannot redirect a group kill onto
 * an unrelated session's process tree. Always null on Windows, which has no
 * POSIX process groups; callers there must not escalate to a group signal.
 */
export function readProcessGroupId(
  pid: number,
  deps: IdentityDeps = {},
): number | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  if ((deps.platform ?? process.platform) === "win32") return null;
  const runner = guardedProbeRunner(deps.runner ?? defaultProbeRunner);
  const raw = runner("ps", ["-p", String(pid), "-o", "pgid="]);
  if (raw === null) return null;
  const parsed = Number.parseInt(raw.trim(), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

/** True when the identity names one of our bridge processes. */
export function identityIsBridge(identity: ProcessIdentity | null): boolean {
  return identity !== null && identity.command.includes(BRIDGE_COMMAND_MARKER);
}

/**
 * True when `observed` still describes the process `expected` was recorded from:
 * a bridge command line and the same start time. A recycled PID fails the start
 * time comparison even if the new process happens to be another bridge.
 */
export function identityMatchesRecord(
  observed: ProcessIdentity | null,
  expectedStartedAt: string,
): boolean {
  return (
    identityIsBridge(observed) && observed?.startedAt === expectedStartedAt
  );
}
