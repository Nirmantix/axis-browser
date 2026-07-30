/**
 * Connection mode — made explicit.
 *
 * Axis has always had four ways to reach a browser, but until now they were only ever
 * *inferred* from which environment variable happened to be set, in a silent `else if`
 * chain. That inference is what turned one stray global export into a day-long outage: a
 * `CHROME_DEVTOOLS_AXI_BROWSER_URL` exported from a shell profile put every shell —
 * including every agent's non-interactive shell — into attach mode, and nothing in any
 * command's output ever said the words "attach mode". The mode was invisible precisely
 * where it mattered.
 *
 * `CHROME_DEVTOOLS_AXI_MODE` makes it sayable and assertable. Inference is retained as
 * the default so existing setups keep working unchanged, but an explicit mode always
 * wins, and a mode that cannot be satisfied fails loudly at the front door instead of
 * 30 seconds later inside chrome-devtools-mcp.
 *
 *   ephemeral   launch a throwaway browser (--isolated), discard the profile
 *   managed     launch a browser on a persistent profile we own
 *   attach      connect to a browser somebody else started and owns
 *   autoconnect attach to the user's running Chrome via chrome://inspect (Chrome 144+)
 */

import { homedir } from "node:os";
import { realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { DEFAULT_SESSION_NAME } from "./sessions.js";

export const AXI_MODES = [
  "ephemeral",
  "managed",
  "attach",
  "autoconnect",
] as const;
export type AxiMode = (typeof AXI_MODES)[number];

/** Default profile for managed mode when the operator names no directory. */
export const DEFAULT_MANAGED_PROFILE_DIR_NAME = ".axis-browser-data";

type Env = Record<string, string | undefined>;

export function defaultManagedProfileDir(home: string = homedir()): string {
  return join(home, DEFAULT_MANAGED_PROFILE_DIR_NAME);
}

/**
 * The mode implied by the environment, using the historical precedence. Kept as the
 * default so nothing that works today stops working.
 */
export function inferMode(env: Env = process.env): AxiMode {
  if (env.CHROME_DEVTOOLS_AXI_AUTO_CONNECT === "1") return "autoconnect";
  if (env.CHROME_DEVTOOLS_AXI_BROWSER_URL) return "attach";
  if (env.CHROME_DEVTOOLS_AXI_USER_DATA_DIR) return "managed";
  return "ephemeral";
}

/**
 * Resolve the active mode. An explicit `CHROME_DEVTOOLS_AXI_MODE` wins over inference;
 * an unsatisfiable one throws with the specific fix rather than being quietly downgraded.
 */
export function resolveMode(env: Env = process.env): AxiMode {
  const raw = env.CHROME_DEVTOOLS_AXI_MODE?.trim().toLowerCase();
  if (!raw) return inferMode(env);

  if (!(AXI_MODES as readonly string[]).includes(raw)) {
    throw new Error(
      `Invalid CHROME_DEVTOOLS_AXI_MODE "${env.CHROME_DEVTOOLS_AXI_MODE}": expected one of ${AXI_MODES.join(", ")}`,
    );
  }
  const mode = raw as AxiMode;

  // attach is the only mode that cannot invent its own target: it needs an endpoint
  // somebody else is already serving.
  if (mode === "attach" && !env.CHROME_DEVTOOLS_AXI_BROWSER_URL) {
    throw new Error(
      "CHROME_DEVTOOLS_AXI_MODE=attach requires CHROME_DEVTOOLS_AXI_BROWSER_URL " +
        "(http(s):// or ws(s)://) naming the browser to attach to. " +
        "To let axis launch and own a browser instead, use CHROME_DEVTOOLS_AXI_MODE=managed or ephemeral.",
    );
  }
  return mode;
}

/**
 * Resolve the mode without ever throwing. For use on paths that are already reporting a
 * failure — an invalid mode string must not replace the error the caller is trying to
 * describe with a second, unrelated one.
 */
export function resolveModeSafe(env: Env = process.env): AxiMode {
  try {
    return resolveMode(env);
  } catch {
    return inferMode(env);
  }
}

/**
 * Browser profile roots that belong to a human. Launching an automation browser against
 * one of these is never what the caller wants, and against the *default Chrome profile*
 * it silently half-works: Chrome accepts `--remote-debugging-port` on the default
 * user-data-dir and then refuses to bind the socket, so the flag appears to be honoured
 * while nothing ever listens. That trap cost a full day of diagnosis; it is refused here
 * rather than explained later.
 */
function realProfileRoots(home: string, platform: NodeJS.Platform): string[] {
  if (platform === "darwin") {
    const support = join(home, "Library", "Application Support");
    return [
      join(support, "Google", "Chrome"),
      join(support, "Chromium"),
      join(support, "Microsoft Edge"),
      join(support, "BraveSoftware"),
      join(support, "Ulaa"),
    ];
  }
  if (platform === "win32") {
    const localAppData =
      process.env.LOCALAPPDATA ?? join(home, "AppData", "Local");
    return [
      join(localAppData, "Google", "Chrome", "User Data"),
      join(localAppData, "Microsoft", "Edge", "User Data"),
      join(localAppData, "Chromium", "User Data"),
    ];
  }
  return [
    join(home, ".config", "google-chrome"),
    join(home, ".config", "chromium"),
    join(home, ".config", "microsoft-edge"),
  ];
}

function isWithin(child: string, parent: string): boolean {
  const a = resolve(child);
  const b = resolve(parent);
  return a === b || a.startsWith(b.endsWith(sep) ? b : b + sep);
}

/**
 * Dereference symlinks on the longest existing ancestor of `dir`, then re-append any
 * not-yet-existing trailing components. `path.resolve` is purely lexical, so without
 * this a symlink can route a profile directory inside a real browser profile while
 * slipping past `isWithin`.
 */
function resolveReal(dir: string): string {
  const abs = resolve(dir);
  const suffix: string[] = [];
  let cur = abs;
  for (;;) {
    try {
      const real = realpathSync(cur);
      return suffix.length ? join(real, ...suffix) : real;
    } catch {
      if (cur === sep || dirname(cur) === cur) return abs; // reached root; nothing left to dereference
      suffix.unshift(basename(cur));
      cur = dirname(cur);
    }
  }
}

/**
 * Refuse a user-data-dir that resolves inside a human's browser profile. Throws with
 * the reason; returns the resolved path otherwise. Symlinks are dereferenced first
 * (`resolveReal`) so a link cannot smuggle a real profile past the containment check.
 */
export function assertSafeUserDataDir(
  dir: string,
  home: string = homedir(),
  platform: NodeJS.Platform = process.platform,
): string {
  const realDir = resolveReal(dir);
  for (const root of realProfileRoots(home, platform)) {
    if (isWithin(realDir, resolveReal(root))) {
      throw new Error(
        `Refusing to use "${dir}" (resolves to "${realDir}") as an automation profile: it is inside the browser profile at "${root}". ` +
          "Chrome refuses to bind a debugging socket on a default profile (the flag is accepted, nothing listens), " +
          "and an automation run would contend for that profile's lock against the browser you use yourself. " +
          `Use a dedicated directory instead, e.g. CHROME_DEVTOOLS_AXI_USER_DATA_DIR="${defaultManagedProfileDir(home)}".`,
      );
    }
  }
  return resolve(dir);
}

/**
 * The profile directory for this mode and session, or null when the mode owns no profile.
 *
 * Named sessions get their own subdirectory. Chrome locks a user-data-dir to a single
 * process, so two concurrent sessions sharing one profile do not merely interfere — the
 * second fails to launch. Ports are already derived per session; profiles have to be, or
 * the isolation is only half real.
 */
export function resolveUserDataDir(
  mode: AxiMode,
  env: Env = process.env,
  sessionName: string = DEFAULT_SESSION_NAME,
  home: string = homedir(),
  platform: NodeJS.Platform = process.platform,
): string | null {
  if (mode !== "managed") return null;

  const configured = env.CHROME_DEVTOOLS_AXI_USER_DATA_DIR?.trim();
  const base =
    configured && configured.length > 0
      ? isAbsolute(configured)
        ? configured
        : resolve(configured)
      : defaultManagedProfileDir(home);

  const perSession =
    sessionName === DEFAULT_SESSION_NAME
      ? base
      : join(base, "sessions", sessionName);

  return assertSafeUserDataDir(perSession, home, platform);
}
