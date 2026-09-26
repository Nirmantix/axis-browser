/**
 * Making a session state directory safe to hold a bridge capability token.
 *
 * The bridge's RPC token is a bearer credential: anyone who can read
 * `~/.axis-browser/sessions/<name>/bridge.pid` can drive the victim's browser
 * through the bridge, which maps straight to CDP. Loopback binding does not help
 * — the file is the credential, not the port. So before a token is written, the
 * directory holding it is verified to be readable by nobody else, and on Windows
 * repaired if it is not.
 *
 * Two entry points, because writer and reader have different jobs:
 *
 * - {@link hardenStateDirs} — the bridge, before writing. Creates missing
 *   directories private, tightens a legacy `0755` tree to `0700`, and refuses to
 *   touch anything it does not own or that is a symlink. On Windows it repairs
 *   the ACL and then verifies the effective ACE set by SID, failing closed
 *   before any token is written.
 * - {@link assertStateDirOwned} — the CLI, before trusting a *legacy* record that
 *   carries no token. Read-only: ownership and symlink checks, no chmod, because
 *   an operator asking for `stop` must be able to retire an old bridge whose
 *   directory predates this hardening.
 *
 * `~/.axis-browser-data` (the managed Chrome profile) is never passed here and
 * must never be: it is Chrome's directory, not ours, and tightening it would
 * break the browser.
 */

import { chmodSync, lstatSync, mkdirSync } from "node:fs";
import type { Stats } from "node:fs";
import {
  defaultProbeRunner,
  guardedProbeRunner,
  type ProbeRunner,
} from "./process-identity.js";

/**
 * Directory mode a state directory must have: owner-only.
 *
 * Exported because the CLI-side writers that create a session directory before
 * any bridge exists (`selected-page.ts`, `generation.ts`) must not create it
 * world-readable either — they run too often to afford the full
 * {@link hardenStateDirs} probe, but they can at least create privately.
 */
export const PRIVATE_DIR_MODE = 0o700;
/** File mode for the record itself: owner read/write only. */
export const PRIVATE_FILE_MODE = 0o600;
/** Group/other permission bits that must not be set on a state directory. */
const GROUP_OR_OTHER_BITS = 0o077;

/** Well-known Windows SID for LocalSystem, the only other principal allowed. */
const WINDOWS_SYSTEM_SID = "S-1-5-18";
/**
 * Principals that must not hold an ACE on a directory containing a token:
 * Everyone, Authenticated Users, Users, Administrators, Anonymous Logon.
 * Numerical SIDs need the `*` prefix for icacls to read them as SIDs rather
 * than as account names, which would otherwise be locale-dependent.
 */
const WINDOWS_FORBIDDEN_SIDS = [
  "S-1-1-0",
  "S-1-5-11",
  "S-1-5-32-545",
  "S-1-5-32-544",
  "S-1-5-7",
] as const;

/**
 * A state directory that cannot be made safe. Carries the exact commands an
 * operator can run, because on Windows the automated repair is allowed to fail
 * (Constrained Language Mode, a non-admin token, an unresolvable SID) and the
 * alternative to a printed remedy is an unusable CLI with no explanation.
 */
export class StateDirError extends Error {
  constructor(
    message: string,
    public readonly repair: readonly string[] = [],
  ) {
    super(message);
    this.name = "StateDirError";
  }
}

export interface StateDirDeps {
  platform?: NodeJS.Platform;
  lstat?: (path: string) => Stats;
  mkdir?: (path: string, mode: number) => void;
  chmod?: (path: string, mode: number) => void;
  getuid?: () => number;
  /** External probes: `whoami`, `icacls`, `powershell.exe`. */
  runner?: ProbeRunner;
}

const defaultDeps = {
  lstat: (path: string) => lstatSync(path),
  mkdir: (path: string, mode: number) => mkdirSync(path, { mode }),
  chmod: (path: string, mode: number) => chmodSync(path, mode),
  getuid: () => process.getuid?.() ?? 0,
};

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === "ENOENT";
}

/** The directory appeared between the stat and the mkdir: somebody else won. */
function isAlreadyThere(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === "EEXIST";
}

/**
 * POSIX: create missing directories private, tighten anything group- or
 * world-readable, and refuse what we do not own or what is a symlink.
 *
 * A pre-existing `0755` tree is the common upgrade case — every earlier release
 * created it that way — so it is repaired rather than rejected. A directory owned
 * by somebody else is rejected without being touched: chmod on a directory we do
 * not own either fails or, worse, succeeds on a path an attacker chose.
 */
function hardenPosixDirs(
  chain: readonly string[],
  deps: Required<Pick<StateDirDeps, "lstat" | "mkdir" | "chmod" | "getuid">>,
): void {
  const uid = deps.getuid();
  for (const dir of chain) {
    let stats: Stats;
    try {
      stats = deps.lstat(dir);
    } catch (error) {
      if (!isMissing(error)) {
        throw new StateDirError(
          `Cannot inspect the session state directory ${dir}: ${(error as Error).message}`,
          [`Inspect it manually: ls -ld ${dir}`],
        );
      }
      try {
        deps.mkdir(dir, PRIVATE_DIR_MODE);
      } catch (error) {
        // Neither of these is fatal, and both are what the re-read below is for:
        // EEXIST means a concurrent creator won the race (two bridges for
        // different sessions sharing a missing `sessions/` parent), and ENOENT
        // means a parent disappeared under us. A real failure — EACCES, ENOSPC,
        // ELOOP — still has to stop here rather than be reinterpreted.
        if (!isMissing(error) && !isAlreadyThere(error)) {
          throw new StateDirError(
            `Cannot create the session state directory ${dir}: ${(error as Error).message}`,
            [`Create it private yourself: mkdir -m 700 -p ${dir}`],
          );
        }
      }
      // Re-read: a concurrent creator may have won, and mkdir's mode is also
      // filtered by the process umask, so the result must be checked, not assumed.
      try {
        stats = deps.lstat(dir);
      } catch {
        throw new StateDirError(
          `Cannot create the session state directory ${dir}`,
          [`Create it private yourself: mkdir -m 700 -p ${dir}`],
        );
      }
    }

    if (stats.isSymbolicLink()) {
      throw new StateDirError(
        `Refusing to use ${dir}: it is a symlink, so its permissions describe the link and not the directory a token would be written into.`,
        [
          `Remove the symlink and recreate the directory: rm ${dir} && mkdir -m 700 ${dir}`,
        ],
      );
    }
    if (!stats.isDirectory()) {
      throw new StateDirError(
        `Refusing to use ${dir}: it is not a directory.`,
        [`Inspect it manually: ls -ld ${dir}`],
      );
    }
    if (stats.uid !== uid) {
      throw new StateDirError(
        `Refusing to use ${dir}: it is owned by uid ${stats.uid}, not this user (uid ${uid}). It was not modified.`,
        [`Have its owner repair it, or choose another HOME for this session`],
      );
    }

    const mode = stats.mode & 0o777;
    if (mode & GROUP_OR_OTHER_BITS) {
      try {
        deps.chmod(dir, PRIVATE_DIR_MODE);
      } catch (error) {
        throw new StateDirError(
          `Cannot tighten ${dir} from ${mode.toString(8)} to 700: ${(error as Error).message}`,
          [`chmod 700 ${dir}`],
        );
      }
      const after = deps.lstat(dir).mode & 0o777;
      if (after !== PRIVATE_DIR_MODE) {
        throw new StateDirError(
          `${dir} is still mode ${after.toString(8)} after an attempt to set 700.`,
          [`chmod 700 ${dir}`],
        );
      }
    }
  }
}

/** POSIX read-only check used before trusting a token-less legacy record. */
function assertPosixDirsOwned(
  chain: readonly string[],
  deps: Required<Pick<StateDirDeps, "lstat" | "getuid">>,
): void {
  const uid = deps.getuid();
  for (const dir of chain) {
    let stats: Stats;
    try {
      stats = deps.lstat(dir);
    } catch (error) {
      if (isMissing(error)) continue; // nothing recorded could live there
      throw new StateDirError(
        `Cannot inspect the session state directory ${dir}: ${(error as Error).message}`,
        [`Inspect it manually: ls -ld ${dir}`],
      );
    }
    if (stats.isSymbolicLink()) {
      throw new StateDirError(
        `Refusing to read a bridge record through ${dir}: it is a symlink.`,
        [
          `Remove the symlink and recreate the directory: rm ${dir} && mkdir -m 700 ${dir}`,
        ],
      );
    }
    if (stats.isDirectory() && stats.uid !== uid) {
      throw new StateDirError(
        `Refusing to read a bridge record from ${dir}: it is owned by uid ${stats.uid}, not this user (uid ${uid}).`,
        [`Have its owner remove it, or choose another HOME for this session`],
      );
    }
  }
}

/**
 * The current user's SID from `whoami /user /fo csv /nh`. CSV output is used
 * because the tabular form localizes its headers and pads columns; the SID field
 * is selected by shape rather than by position, since the CSV carries the
 * account name first and that name is locale- and domain-dependent.
 */
export function currentUserSid(runner: ProbeRunner): string | null {
  const output = runner("whoami.exe", ["/user", "/fo", "csv", "/nh"]);
  if (output === null) return null;
  for (const field of output.split(/[,\r\n]/)) {
    const candidate = field.replace(/^"|"$/g, "").trim();
    if (/^S-\d(?:-\d+)+$/.test(candidate)) return candidate;
  }
  return null;
}

/**
 * Remove inherited and explicit ACEs for the well-known groups, then grant only
 * the current user and LocalSystem. Mirrors the POSIX `0755 -> 0700` tightening:
 * repair first, verify after, and never write a token into a directory whose
 * effective ACL was not proven.
 */
export function repairWindowsAcl(
  dir: string,
  sid: string,
  runner: ProbeRunner,
): void {
  runner("icacls.exe", [dir, "/inheritancelevel:r"]);
  for (const forbidden of WINDOWS_FORBIDDEN_SIDS) {
    runner("icacls.exe", [dir, "/remove:g", `*${forbidden}`]);
  }
  runner("icacls.exe", [dir, "/grant:r", `*${sid}:(OI)(CI)F`]);
  runner("icacls.exe", [dir, "/grant:r", `*${WINDOWS_SYSTEM_SID}:(OI)(CI)F`]);
}

/** Same two grants on the record file itself, without inheritance. */
export function repairWindowsFileAcl(
  file: string,
  sid: string,
  runner: ProbeRunner,
): void {
  runner("icacls.exe", [file, "/inheritancelevel:r"]);
  for (const forbidden of WINDOWS_FORBIDDEN_SIDS) {
    runner("icacls.exe", [file, "/remove:g", `*${forbidden}`]);
  }
  runner("icacls.exe", [file, "/grant:r", `*${sid}:F`]);
  runner("icacls.exe", [file, "/grant:r", `*${WINDOWS_SYSTEM_SID}:F`]);
}

/**
 * The SIDs that effectively hold an ACE on `dir`, read through .NET's SID
 * translation so the answer does not depend on localized account names.
 *
 * Returns null when the answer cannot be trusted: no PowerShell, or Constrained
 * Language Mode blocking `.Translate`. Null means fail closed — an unverifiable
 * ACL is treated exactly like a permissive one.
 */
export function readWindowsAceSids(
  dir: string,
  runner: ProbeRunner,
): string[] | null {
  const script =
    `(Get-Acl -LiteralPath '${dir.replace(/'/g, "''")}').Access | ` +
    `ForEach-Object { $_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value }`;
  const output = runner("powershell.exe", [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    script,
  ]);
  if (output === null) return null;
  const sids = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^S-\d(?:-\d+)+$/.test(line));
  // An empty answer is not "no ACEs" — Get-Acl always reports at least the
  // owner's, so nothing parseable means the probe did not really run.
  return sids.length > 0 ? [...new Set(sids)] : null;
}

/**
 * Cross-check `readWindowsAceSids` with icacls' own SID search, so a single
 * lying probe cannot make an unsafe directory look safe. `/findsid` exits
 * non-zero (and so returns null through the runner) when the SID is absent.
 */
function icaclsHasSid(dir: string, sid: string, runner: ProbeRunner): boolean {
  return runner("icacls.exe", [dir, "/findsid", `*${sid}`]) !== null;
}

/**
 * Verify that the effective ACE set of `dir` is exactly {user SID, LocalSystem}
 * and that none of the well-known groups remain. Throws with the exact manual
 * commands when verification fails or cannot be performed.
 */
export function assertWindowsAclPrivate(
  dir: string,
  sid: string,
  runner: ProbeRunner,
): void {
  const manual = [
    `icacls "${dir}" /inheritancelevel:r`,
    ...WINDOWS_FORBIDDEN_SIDS.map((s) => `icacls "${dir}" /remove:g *${s}`),
    `icacls "${dir}" /grant:r *${sid}:(OI)(CI)F`,
    `icacls "${dir}" /grant:r *${WINDOWS_SYSTEM_SID}:(OI)(CI)F`,
    `icacls "${dir}"`,
  ];

  const observed = readWindowsAceSids(dir, runner);
  if (observed === null) {
    throw new StateDirError(
      `Cannot verify the ACL on ${dir}: PowerShell did not return a readable SID list (it may be missing, or Constrained Language Mode may block the SID translation). Refusing to write a bridge capability token into a directory whose permissions cannot be proven.`,
      manual,
    );
  }

  const allowed = [sid, WINDOWS_SYSTEM_SID];
  const unexpected = observed.filter((found) => !allowed.includes(found));
  const missing = allowed.filter((want) => !observed.includes(want));
  if (unexpected.length > 0 || missing.length > 0) {
    throw new StateDirError(
      `${dir} is not private: effective ACE SIDs are ${observed.join(", ")} but must be exactly ${allowed.join(", ")}${
        unexpected.length > 0 ? ` (unexpected: ${unexpected.join(", ")})` : ""
      }${missing.length > 0 ? ` (missing: ${missing.join(", ")})` : ""}. No bridge token was written.`,
      manual,
    );
  }

  for (const forbidden of WINDOWS_FORBIDDEN_SIDS) {
    if (icaclsHasSid(dir, forbidden, runner)) {
      throw new StateDirError(
        `${dir} still grants access to ${forbidden} according to icacls, which disagrees with the ACL read above. No bridge token was written.`,
        manual,
      );
    }
  }
  for (const required of allowed) {
    if (!icaclsHasSid(dir, required, runner)) {
      throw new StateDirError(
        `icacls cannot find the required ACE for ${required} on ${dir}, which disagrees with the ACL read above. No bridge token was written.`,
        manual,
      );
    }
  }
}

function hardenWindowsDirs(
  chain: readonly string[],
  runner: ProbeRunner,
): void {
  const sid = currentUserSid(runner);
  if (sid === null) {
    throw new StateDirError(
      "Cannot determine the current user's SID (`whoami /user /fo csv /nh` gave no S-… field), so the ACL on the session state directory cannot be verified. No bridge token was written.",
      ["whoami /user /fo csv /nh"],
    );
  }
  for (const dir of chain) {
    // Repair before verify: a directory created by an older release inherits
    // Users/Authenticated Users, and failing on that without trying would make
    // the upgrade path a dead end.
    repairWindowsAcl(dir, sid, runner);
    assertWindowsAclPrivate(dir, sid, runner);
  }
}

/**
 * Ensure every directory from the state base down to the session directory may
 * hold a capability token. `chain` is ordered base-first (see
 * `resolveSessionStateChain`), so a missing parent is created before its child.
 */
export function hardenStateDirs(
  chain: readonly string[],
  deps: StateDirDeps = {},
): void {
  const platform = deps.platform ?? process.platform;
  if (platform === "win32") {
    // A default runner, not a refusal: `publishBridgeCapability` calls this with
    // no deps, so throwing here would make every Windows bridge fail to start.
    // The runner is guarded so a non-string probe result degrades to "could not
    // verify" — which the ACL checks below already treat as fail-closed.
    hardenWindowsDirs(
      chain,
      guardedProbeRunner(deps.runner ?? defaultProbeRunner),
    );
    return;
  }
  hardenPosixDirs(chain, {
    lstat: deps.lstat ?? defaultDeps.lstat,
    mkdir: deps.mkdir ?? defaultDeps.mkdir,
    chmod: deps.chmod ?? defaultDeps.chmod,
    getuid: deps.getuid ?? defaultDeps.getuid,
  });
}

/**
 * Read-only ownership check for a directory chain that may predate hardening.
 * Used before acting on a legacy record, where tightening somebody's directory
 * as a side effect of `stop` would be the wrong trade.
 */
export function assertStateDirOwned(
  chain: readonly string[],
  deps: StateDirDeps = {},
): void {
  if ((deps.platform ?? process.platform) === "win32") {
    // No POSIX ownership bit to check; the ACL is the equivalent, and a legacy
    // stop does not repair ACLs. Presence of the record is what the caller
    // verifies, so there is nothing to assert here.
    return;
  }
  assertPosixDirsOwned(chain, {
    lstat: deps.lstat ?? defaultDeps.lstat,
    getuid: deps.getuid ?? defaultDeps.getuid,
  });
}
