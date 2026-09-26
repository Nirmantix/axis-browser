/**
 * Named sessions - per-session bridge isolation.
 *
 * Setting `CHROME_DEVTOOLS_AXI_SESSION` to a non-default name binds the
 * bridge's port and on-disk state (PID file, snapshot-generation counter,
 * selected-page-id) to that name, so multiple bridges can run concurrently -
 * one per agent session, worktree, or test worker - without sharing a single
 * bridge or stepping on each other's stale-ref tracking.
 *
 *   CHROME_DEVTOOLS_AXI_SESSION=worker-1 axis-browser open ...
 *   CHROME_DEVTOOLS_AXI_SESSION=worker-2 axis-browser open ...
 *
 * Session identity does not choose a transport or browser profile. See README
 * Configuration for local browser and shared MCP service setup.
 *
 * Precedence:
 *   port      - CHROME_DEVTOOLS_AXI_PORT > deterministic hash of the session name
 *   state dir - always derived from the session name
 *
 * The default session name is "default", which preserves prior behavior: port
 * 9224 and the Axis Browser `~/.axis-browser/` state paths.
 */

import { randomBytes } from "node:crypto";
import {
  chmodSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { PRIVATE_FILE_MODE } from "./state-dir.js";

export const DEFAULT_SESSION_NAME = "default";
export const DEFAULT_BASE_PORT = 9224;

const SESSION_PORT_RANGE = 1000; // 9225..10224 reserved for named sessions
/** Fork invariant: Axis runtime state stays under ~/.axis-browser */
const STATE_DIR_NAME = ".axis-browser";

/**
 * Resolve the active session name from `CHROME_DEVTOOLS_AXI_SESSION`. Returns
 * DEFAULT_SESSION_NAME when unset, empty, or whitespace.
 *
 * A configured-but-unsafe name throws (via `validateSessionName`). This is the
 * single chokepoint through which every command obtains the active session, so
 * validating here guarantees that no entry point - `ensureBridge`, `stopBridge`,
 * `getSessionSnapshotIfRunning`, the generation counter, the selected-page
 * id, or the bridge itself -
 * can resolve an invalid name into a filesystem path that collapses onto the
 * default session's directory.
 */
export function resolveSessionName(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const raw = env.CHROME_DEVTOOLS_AXI_SESSION?.trim();
  const name = raw && raw.length > 0 ? raw : DEFAULT_SESSION_NAME;
  validateSessionName(name);
  return name;
}

/**
 * Throw if a non-default session name is unsafe for a filesystem path. Allows
 * 1-64 chars from `[A-Za-z0-9._-]`; rejects path traversal, separators, shell
 * metacharacters, overlong names, and names made only of dots (`.` / `..` /
 * `...`), which `resolveSessionStateDir` would otherwise collapse onto the
 * default session's directory.
 */
export function validateSessionName(name: string): void {
  if (name === DEFAULT_SESSION_NAME) return;
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(name)) {
    throw new Error(
      `Invalid CHROME_DEVTOOLS_AXI_SESSION "${name}": use 1-64 chars from [A-Za-z0-9._-]`,
    );
  }
  if (/^\.+$/.test(name)) {
    throw new Error(
      `Invalid CHROME_DEVTOOLS_AXI_SESSION "${name}": a name made only of dots would collapse onto the default session's state directory`,
    );
  }
}

/**
 * Deterministic port for a session name: an FNV-1a hash mapped into
 * [DEFAULT_BASE_PORT+1, DEFAULT_BASE_PORT+SESSION_PORT_RANGE]. The default
 * session keeps DEFAULT_BASE_PORT. Two distinct names can hash to the same
 * port - a concurrency limit, not a correctness bug; set
 * CHROME_DEVTOOLS_AXI_PORT to break a collision.
 */
export function defaultPortForSession(name: string): number {
  if (name === DEFAULT_SESSION_NAME) return DEFAULT_BASE_PORT;
  let hash = 2166136261;
  for (let i = 0; i < name.length; i++) {
    hash ^= name.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return DEFAULT_BASE_PORT + (Math.abs(hash) % SESSION_PORT_RANGE) + 1;
}

/**
 * Resolve the bridge port for a session: explicit `CHROME_DEVTOOLS_AXI_PORT`
 * wins, otherwise the session-derived default.
 *
 * A non-empty explicit value must be a plain decimal integer in 1-65535. It is
 * validated rather than parsed leniently, for two reasons. `Number.parseInt`
 * accepts `"9224abc"`, and the previous `|| default` fallback silently moved a
 * mistyped pin onto the session hash — which can land on *another* running
 * session's port and quietly make two agents share one browser. An explicit pin
 * that cannot be honoured must fail loudly, not be reinterpreted.
 */
export function resolveSessionPort(
  name: string = resolveSessionName(),
  env: NodeJS.ProcessEnv = process.env,
): number {
  const explicit = env.CHROME_DEVTOOLS_AXI_PORT?.trim();
  if (explicit) {
    const parsed = /^\d{1,5}$/.test(explicit)
      ? Number.parseInt(explicit, 10)
      : Number.NaN;
    if (Number.isNaN(parsed) || parsed < 1 || parsed > 65535) {
      throw new Error(
        `Invalid CHROME_DEVTOOLS_AXI_PORT "${explicit}": use a decimal port from 1-65535, or unset it to use this session's own port (${defaultPortForSession(name)})`,
      );
    }
    return parsed;
  }
  return defaultPortForSession(name);
}

/**
 * State directory for a session. The default session keeps the Axis Browser
 * `~/.axis-browser/` path; named sessions live under a per-name subdirectory.
 */
export function resolveSessionStateDir(
  name: string = resolveSessionName(),
  home: string = homedir(),
): string {
  const base = join(home, STATE_DIR_NAME);
  return name === DEFAULT_SESSION_NAME ? base : join(base, "sessions", name);
}

/**
 * PID file path for a session, under its state directory.
 *
 * `home` is a parameter rather than a `homedir()` call at the use site so a
 * caller diagnosing a *specific* home (`doctor --json`, tests) cannot silently
 * read the record of the home it happens to be running in.
 */
export function resolveSessionPidFile(
  name: string = resolveSessionName(),
  home: string = homedir(),
): string {
  return join(resolveSessionStateDir(name, home), "bridge.pid");
}

/**
 * Marker the bridge reports in `/health` once a request has presented a valid
 * capability token. The CLI requires this exact value — not merely HTTP 200 —
 * before it will reuse a bridge. An older bridge answers `/health` with
 * `{status:"ok"}` while ignoring the header entirely, and adopting one would
 * quietly return the session to unauthenticated RPC on a predictable port.
 */
export const BRIDGE_AUTH_SCHEME = "capability-v1";

/** Header that carries a per-session bridge capability token. */
export const BRIDGE_TOKEN_HEADER = "x-axis-bridge-token";

/**
 * The bridge record written to `<session state dir>/bridge.pid`.
 *
 * `token` and `startedAt` are optional only because a record written by an
 * earlier release has neither. Every record this release writes has both, and a
 * record without them is never adopted for RPC — it can only be retired by an
 * explicit, identity-verified `stop`.
 */
export interface BridgeRecord {
  pid: number;
  port: number;
  token?: string;
  startedAt?: string;
}

/** A record carrying the capability token and the bridge's recorded birth time. */
export interface AuthenticatedBridgeRecord extends BridgeRecord {
  token: string;
  startedAt: string;
}

/** A fresh per-session capability: 32 random bytes, hex encoded. */
export function generateBridgeToken(): string {
  return randomBytes(32).toString("hex");
}

export function isAuthedRecord(
  record: BridgeRecord | null,
): record is AuthenticatedBridgeRecord {
  return (
    record !== null &&
    typeof record.token === "string" &&
    record.token.length > 0 &&
    typeof record.startedAt === "string" &&
    record.startedAt.length > 0
  );
}

/**
 * Read and shape-check the record. Missing, unreadable, or malformed returns
 * null rather than throwing: callers distinguish "no bridge" from "a bridge we
 * cannot talk to" by what they do next, not by catching here.
 */
export function readBridgeRecord(
  pidFile: string = resolveSessionPidFile(),
): BridgeRecord | null {
  try {
    const data: unknown = JSON.parse(readFileSync(pidFile, "utf-8"));
    if (typeof data !== "object" || data === null) return null;
    const candidate = data as Record<string, unknown>;
    if (!Number.isInteger(candidate.pid) || !Number.isInteger(candidate.port)) {
      return null;
    }
    const record: BridgeRecord = {
      pid: candidate.pid as number,
      port: candidate.port as number,
    };
    if (typeof candidate.token === "string" && candidate.token.length > 0) {
      record.token = candidate.token;
    }
    if (
      typeof candidate.startedAt === "string" &&
      candidate.startedAt.length > 0
    ) {
      record.startedAt = candidate.startedAt;
    }
    return record;
  } catch {
    return null;
  }
}

/**
 * Write the record atomically: an exclusive `0600` temp file in the same
 * directory, then `rename`. A reader that races this must see either the old
 * record or the new one, never a fragment naming a port with no token. The mode
 * is applied with an explicit `chmod` as well, because `writeFileSync`'s `mode`
 * is filtered by the process umask and a loose umask would silently widen the
 * file that holds the capability.
 */
export function writeBridgeRecord(
  record: AuthenticatedBridgeRecord,
  pidFile: string = resolveSessionPidFile(),
): void {
  const dir = dirname(pidFile);
  const tempFile = join(
    dir,
    `bridge.pid.${process.pid}.${randomBytes(4).toString("hex")}.tmp`,
  );
  writeFileSync(tempFile, JSON.stringify(record), {
    mode: PRIVATE_FILE_MODE,
    flag: "wx",
  });
  try {
    chmodSync(tempFile, PRIVATE_FILE_MODE);
    renameSync(tempFile, pidFile);
  } catch (error) {
    try {
      unlinkSync(tempFile);
    } catch {
      // Leaving one temp file behind is better than masking the write failure.
    }
    throw error;
  }
}

/**
 * Delete the record only when it is still the one this bridge wrote.
 *
 * On a same-session bind race the loser exits after the winner has already
 * written the shared record; an unconditional unlink would orphan the running
 * winner, which later `stop`/reuse could then no longer find. Comparing the
 * token as well as the pid also protects against a recycled pid: a record that a
 * *newer* bridge replaced is left alone.
 */
export function clearBridgeRecord(
  expected: { pid: number; token: string },
  pidFile: string = resolveSessionPidFile(),
): void {
  const record = readBridgeRecord(pidFile);
  if (!isAuthedRecord(record)) return;
  if (record.pid !== expected.pid || record.token !== expected.token) return;
  try {
    unlinkSync(pidFile);
  } catch {
    // Already gone — fine.
  }
}

/**
 * Delete a *tokenless* legacy record that still names `expected.pid`.
 *
 * Only the explicit-stop path calls this, and only after it has verified the live
 * process twice (bridge marker plus two agreeing start-time reads). The token
 * comparison that guards {@link clearBridgeRecord} cannot apply here — the record
 * predates tokens — and an authenticated record is never touched, so a newer
 * bridge's record survives a legacy cleanup.
 */
export function clearLegacyBridgeRecord(
  expected: { pid: number },
  pidFile: string = resolveSessionPidFile(),
): void {
  const record = readBridgeRecord(pidFile);
  if (!record || isAuthedRecord(record)) return;
  if (record.pid !== expected.pid) return;
  try {
    unlinkSync(pidFile);
  } catch {
    // Already gone — fine.
  }
}

/**
 * Every directory from the state base down to this session's state directory,
 * base first. Hardening walks this order so a missing parent is created before
 * its child, and so the ancestor holding *every* session's record is checked too:
 * a world-readable `~/.axis-browser/sessions` leaks session names and lets
 * another local user plant a directory, even when each leaf is private.
 */
export function resolveSessionStateChain(
  name: string = resolveSessionName(),
): string[] {
  const base = join(homedir(), STATE_DIR_NAME);
  if (name === DEFAULT_SESSION_NAME) return [base];
  return [base, join(base, "sessions"), join(base, "sessions", name)];
}
