/**
 * Orphaned-bridge detection and cleanup.
 *
 * `runBridge` kills its own process group on exit, so an orderly shutdown leaves nothing
 * behind. The leak comes from the disorderly ones: a bridge killed with SIGKILL, or lost
 * to a crash or a reboot-less logout, never runs that handler — and it takes its
 * chrome-devtools-mcp child and that child's Chrome with it. Six such trees accumulated
 * in about five days on one machine, each holding a port and a browser nobody could see.
 *
 * An orphan is defined narrowly and structurally: a live process whose command line
 * identifies it as one of *our* bridges, which no session's PID file claims. That
 * definition cannot match another tool's process, and it cannot match a bridge that is
 * currently in use — a running session always owns a PID file naming its pid.
 *
 * This module never touches browsers. A leaked browser is the watchdog's problem; a
 * leaked bridge is ours, and a bridge we own is one we may reap.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import {
  type ProcessIdentity,
  identityMatchesRecord,
  readProcessIdentity,
} from "./process-identity.js";

/** Command-line marker identifying a process as one of our bridges. */
const BRIDGE_MARKER = "chrome-devtools-axi-bridge";

export interface BridgeProcess {
  pid: number;
  ppid: number;
  pgid: number;
  ageMs: number;
  command: string;
  /**
   * Process start time observed when the listing was built — the baseline every
   * later identity re-read is compared against before a signal is sent. Null
   * when the identity probe failed at listing time; null means never signal.
   */
  startedAt: string | null;
}

export interface ReapOutcome {
  reaped: number[];
  failed: number[];
  skipped: number[];
}

function stateRoot(home: string = homedir()): string {
  return join(home, ".axis-browser");
}

/** `[[DD-]HH:]MM:SS` elapsed time from ps, in ms. */
export function parseElapsed(value: string): number {
  let days = 0;
  let rest = value;
  const dash = value.indexOf("-");
  if (dash !== -1) {
    days = Number(value.slice(0, dash)) || 0;
    rest = value.slice(dash + 1);
  }
  let seconds = 0;
  for (const part of rest.split(":")) {
    const n = Number(part);
    seconds = seconds * 60 + (Number.isFinite(n) ? n : 0);
  }
  return (seconds + days * 86400) * 1000;
}

/** Every live process whose command line marks it as one of our bridges. */
export function listBridgeProcesses(
  runPs: () => string = () =>
    execFileSync("ps", ["-axo", "pid=,ppid=,pgid=,etime=,command="], {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      timeout: 10_000,
    }),
  readIdentity: (pid: number) => ProcessIdentity | null = readProcessIdentity,
): BridgeProcess[] {
  let out: string;
  try {
    out = runPs();
  } catch {
    // No ps (Windows) or it failed: report nothing rather than guessing.
    return [];
  }
  const rows: BridgeProcess[] = [];
  for (const line of out.split("\n")) {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/);
    if (!match) continue;
    const command = match[5];
    if (!command.includes(BRIDGE_MARKER)) continue;
    // `ps` also lists the grep/ps invocation itself in some shells; a bridge is
    // always run by a JS runtime, never by a shell pipeline.
    if (/\bgrep\b/.test(command)) continue;
    rows.push({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      pgid: Number(match[3]),
      ageMs: parseElapsed(match[4]),
      command,
      startedAt: readIdentity(Number(match[1]))?.startedAt ?? null,
    });
  }
  return rows;
}

export interface PidFileScan {
  /** Pids explicitly claimed by a readable session PID file. */
  claimed: Set<number>;
  /** Paths of PID files that exist but could not be parsed. */
  malformed: string[];
}

/**
 * Read every session PID file: the default session's plus each
 * `sessions/<name>/bridge.pid`.
 *
 * A file that exists but cannot be parsed is reported separately rather than simply
 * claiming nothing. The distinction matters because the two consumers want opposite
 * defaults: a *manual* `reap` carries human intent and should still clean up, but
 * *automatic* reaping must not destroy a process on the strength of a file it failed to
 * read. A live bridge whose PID file was truncated by a crash or a full disk is exactly
 * the case where "claims nothing" and "is an orphan" are not the same statement.
 */
export function scanSessionPidFiles(home: string = homedir()): PidFileScan {
  const claimed = new Set<number>();
  const malformed: string[] = [];
  const root = stateRoot(home);
  const files = [join(root, "bridge.pid")];

  const sessionsDir = join(root, "sessions");
  try {
    for (const entry of readdirSync(sessionsDir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        files.push(join(sessionsDir, entry.name, "bridge.pid"));
      }
    }
  } catch {
    // No named sessions on this machine.
  }

  for (const file of files) {
    if (!existsSync(file)) continue;
    try {
      const data = JSON.parse(readFileSync(file, "utf8")) as { pid?: unknown };
      if (typeof data.pid === "number") claimed.add(data.pid);
      else malformed.push(file);
    } catch {
      malformed.push(file);
    }
  }
  return { claimed, malformed };
}

/** Pids claimed by a readable session PID file. */
export function claimedBridgePids(home: string = homedir()): Set<number> {
  return scanSessionPidFiles(home).claimed;
}

/**
 * Expand a set of claimed pids to every bridge process in the same process tree.
 *
 * A running bridge is not one process but a chain — `npm exec tsx …` spawns the tsx CLI,
 * which spawns the actual bridge — and every link carries the bridge marker in its
 * command line. Only the innermost one writes the PID file, so a naive pid-equality check
 * calls the two ancestors of a perfectly healthy bridge "unclaimed". Reaping those would
 * take the live bridge down with them, since the kill targets the process group.
 *
 * Found by running `reap --min-age-hours 0 --dry-run` against a live session and seeing
 * it name that session's own npx and tsx processes.
 */
export function expandClaimedToTrees(
  claimed: Set<number>,
  processes: BridgeProcess[],
): Set<number> {
  const byPid = new Map(processes.map((p) => [p.pid, p]));
  const childrenOf = new Map<number, number[]>();
  for (const p of processes) {
    const siblings = childrenOf.get(p.ppid) ?? [];
    siblings.push(p.pid);
    childrenOf.set(p.ppid, siblings);
  }

  const result = new Set(claimed);
  // Walk both directions from every claimed pid: ancestors (the npx/tsx launchers)
  // and descendants (anything the bridge spawned that still carries the marker).
  const queue = [...claimed];
  while (queue.length > 0) {
    const pid = queue.pop() as number;
    const node = byPid.get(pid);
    if (node && !result.has(node.ppid) && byPid.has(node.ppid)) {
      result.add(node.ppid);
      queue.push(node.ppid);
    }
    for (const child of childrenOf.get(pid) ?? []) {
      if (!result.has(child)) {
        result.add(child);
        queue.push(child);
      }
    }
  }
  return result;
}

/**
 * Bridges that no session claims and that are older than `minAgeMs`.
 *
 * The age floor is what makes this safe to run on a hot path: a bridge that is starting
 * up right now has not yet written its PID file, and would otherwise look exactly like an
 * orphan to a concurrent command. Four hours is far beyond any startup race.
 */
export function findOrphanBridges(
  minAgeMs: number,
  home: string = homedir(),
  processes: BridgeProcess[] = listBridgeProcesses(),
): BridgeProcess[] {
  const claimed = expandClaimedToTrees(claimedBridgePids(home), processes);
  return processes.filter(
    (p) => !claimed.has(p.pid) && p.ageMs >= minAgeMs && p.pid !== process.pid,
  );
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Kill orphaned bridges, process group first so the chrome-devtools-mcp child and its
 * Chrome die with the bridge rather than surviving as a second-generation orphan.
 *
 * The group is only signalled when the bridge leads it — bridges are spawned detached
 * (`detached: true`), so in production it always does. When it does not, we signal the
 * bare pid: killing a group we do not lead could reach an unrelated shell.
 *
 * A pid is only ever signalled after its identity is re-verified: the process
 * listing that produced `targets` may be seconds old by the time a signal goes
 * out, and a pid recycled in that window would put the signal — possibly a
 * whole process group's worth — on an unrelated process. Immediately before
 * each batch the live identity is compared against the start time the listing
 * recorded; a target that cannot be re-verified (gone, recycled, no recorded
 * start time, or no longer a bridge command) is skipped, never signalled.
 */
export function reapBridges(
  targets: BridgeProcess[],
  opts: {
    dryRun?: boolean;
    readIdentity?: (pid: number) => ProcessIdentity | null;
  } = {},
): ReapOutcome {
  const readIdentity = opts.readIdentity ?? readProcessIdentity;
  if (opts.dryRun) {
    return { reaped: [], failed: [], skipped: targets.map((t) => t.pid) };
  }
  if (targets.length === 0) {
    return { reaped: [], failed: [], skipped: [] };
  }

  /** Brief settle before deciding whether to escalate. Synchronous on purpose:
   *  callers are CLI commands, not the event loop. */
  const settle = () => {
    try {
      execFileSync("sleep", ["1"], { timeout: 5000 });
    } catch {
      /* best effort */
    }
  };

  /** Pids whose identity could not be re-verified just before a signal. */
  const unverified = new Set<number>();

  const signal = (batch: BridgeProcess[], sig: "SIGTERM" | "SIGKILL") => {
    for (const target of batch) {
      if (!isAlive(target.pid)) continue;
      // Re-read the identity *now*: the listing's picture may be seconds old and
      // this pid could have been recycled onto an unrelated process. It is also
      // what makes the recorded pgid safe to act on — a group signal is only
      // sent when `pgid === pid`, and only after this check proves the pid still
      // names the same bridge that recorded that pgid.
      if (
        target.startedAt === null ||
        !identityMatchesRecord(readIdentity(target.pid), target.startedAt)
      ) {
        unverified.add(target.pid);
        continue;
      }
      try {
        if (target.pgid === target.pid) process.kill(-target.pgid, sig);
        else process.kill(target.pid, sig);
      } catch {
        // Already gone, or not ours to signal.
      }
    }
  };

  // Signalled as a batch, not one at a time. Per-target settling cost 2s each, and
  // this runs on the bridge-*spawn* path — six orphans (the number observed
  // accumulating in five days on one machine) would have added ~12s to a cold
  // `axis-browser open`. Batched, the wait is 2s no matter how many are reaped.
  signal(targets, "SIGTERM");
  settle();
  const survivors = targets.filter((t) => isAlive(t.pid));
  if (survivors.length > 0) {
    signal(survivors, "SIGKILL");
    settle();
  }

  const outcome: ReapOutcome = { reaped: [], failed: [], skipped: [] };
  for (const target of targets) {
    // A pid we refused to signal is skipped, never failed — it was not ours to
    // kill, so its survival is not a reap failure.
    if (unverified.has(target.pid)) outcome.skipped.push(target.pid);
    else if (isAlive(target.pid)) outcome.failed.push(target.pid);
    else outcome.reaped.push(target.pid);
  }
  return outcome;
}

/** Default age floor for automatic reaping: well past any plausible startup race. */
export const DEFAULT_REAP_MIN_AGE_MS = 4 * 60 * 60 * 1000;

/**
 * Best-effort automatic cleanup, called from the bridge-startup path.
 *
 * Deliberately conservative, and deliberately not silent about why: killing a process the
 * user did not ask to kill is the same class of surprise that caused the incident this
 * work came out of. It only ever touches processes matching our own bridge marker, that
 * no session claims, and that are at least four hours old. `CHROME_DEVTOOLS_AXI_AUTO_REAP=0`
 * turns it off entirely. Any failure is swallowed — cleanup must never break a command.
 */
export function autoReapOrphans(env: NodeJS.ProcessEnv = process.env): number {
  if (env.CHROME_DEVTOOLS_AXI_AUTO_REAP === "0") return 0;
  try {
    // A PID file we could not read is a claim we could not verify, not an absent
    // claim. Killing on that basis would mean a live bridge whose PID file was
    // truncated gets group-killed at the age floor. Manual `axis-browser reap` still
    // handles these, and `doctor` reports the unreadable file — automatic
    // destruction is the one path that must fail safe.
    if (scanSessionPidFiles().malformed.length > 0) return 0;
    const orphans = findOrphanBridges(DEFAULT_REAP_MIN_AGE_MS);
    if (orphans.length === 0) return 0;
    return reapBridges(orphans).reaped.length;
  } catch {
    return 0;
  }
}
