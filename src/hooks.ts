import {
  existsSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  installSessionStartHooks,
  shouldInstallHooksForNodeAxiExecPath,
  type HookEntry,
  type HookGroup,
  type HookSettings,
} from "axi-sdk-js";

/**
 * Identifies the hook entries this CLI owns, and names the command written into
 * the user's agent config. It is `axis-browser` because that is what a user
 * reading their own settings.json should see — the SDK matches managed hooks by
 * `command.includes(marker)`, so this doubles as the ownership tag.
 *
 * Changing it is a migration, not a rename: entries written under a previous
 * marker stop being recognized and survive as duplicates.
 */
const HOOK_MARKER = "axis-browser";

/** The packaged entrypoint. Named for the base tool; not user-facing. */
const DIST_ENTRYPOINT = "dist/bin/chrome-devtools-axi.js";

/**
 * Markers earlier versions installed hooks under. The SDK only recognizes
 * entries matching the *current* marker, so without this an upgrade leaves the
 * old entry in place and adds a second one — both firing on every session start.
 *
 * `chrome-devtools-axi` cannot match a hook this version writes (`axis-browser`
 * does not contain it), nor an unrelated `chrome-devtools-mcp` hook, so the
 * match stays narrow.
 */
const LEGACY_HOOK_MARKERS = ["chrome-devtools-axi"] as const;

function isLegacyManagedHook(hook: HookEntry): boolean {
  const command = hook?.command;
  if (typeof command !== "string") return false;
  return LEGACY_HOOK_MARKERS.some((marker) => command.includes(marker));
}

/**
 * Drop SessionStart hooks written under a previous marker. Pure; returns the
 * updated settings and whether anything changed. Groups left empty are removed
 * so an upgrade does not accumulate empty matchers.
 */
export function stripLegacyManagedHooks(
  settings: HookSettings,
): [HookSettings, boolean] {
  const groups = settings.hooks?.SessionStart;
  if (!Array.isArray(groups)) return [settings, false];

  let changed = false;
  const kept: HookGroup[] = [];
  for (const group of groups) {
    const hooks = group?.hooks;
    if (!Array.isArray(hooks)) {
      kept.push(group);
      continue;
    }
    const keptHooks = hooks.filter((hook) => !isLegacyManagedHook(hook));
    if (keptHooks.length === hooks.length) {
      kept.push(group);
      continue;
    }
    changed = true;
    // A group that only held the legacy hook disappears with it.
    if (keptHooks.length > 0) kept.push({ ...group, hooks: keptHooks });
  }
  if (!changed) return [settings, false];

  return [
    { ...settings, hooks: { ...settings.hooks, SessionStart: kept } },
    true,
  ];
}

/**
 * Replace a file's contents atomically, preserving its mode.
 *
 * These are the user's own agent configs, and they hold far more than our hook
 * — a truncated write from a crash or a full disk would take the whole file
 * with it. Writing a sibling temp file and renaming means a reader sees either
 * the old contents or the new ones, never a partial file. The temp must share
 * the directory: rename is only atomic within a filesystem.
 */
function writeFileAtomic(target: string, contents: string): void {
  const tmp = `${target}.axis-${process.pid}.tmp`;
  try {
    let mode: number | undefined;
    try {
      mode = statSync(target).mode;
    } catch {
      // No existing file — let the umask decide.
    }
    writeFileSync(
      tmp,
      contents,
      mode === undefined ? "utf-8" : { encoding: "utf-8", mode },
    );
    renameSync(tmp, target);
  } catch (error) {
    try {
      if (existsSync(tmp)) unlinkSync(tmp);
    } catch {
      // Leave no partial file behind if we can help it.
    }
    throw error;
  }
}

/**
 * Remove hooks and plugin files left behind by versions that installed under a
 * previous marker, so installing the current one cannot double up. Best-effort:
 * a config we cannot read or write is left alone rather than failing setup.
 */
function removeLegacyHookInstalls(home: string = homedir()): void {
  for (const target of [
    join(home, ".claude", "settings.json"),
    join(home, ".codex", "hooks.json"),
  ]) {
    try {
      if (!existsSync(target)) continue;
      const current = JSON.parse(readFileSync(target, "utf-8")) as HookSettings;
      const [updated, changed] = stripLegacyManagedHooks(current);
      if (changed) {
        writeFileAtomic(target, `${JSON.stringify(updated, null, 2)}\n`);
      }
    } catch {
      // Unreadable or unwritable config — never fail setup over cleanup.
    }
  }

  for (const marker of LEGACY_HOOK_MARKERS) {
    // Mirrors the SDK's naming: ~/.config/opencode/plugins/axi-<marker>.js
    const plugin = join(
      home,
      ".config",
      "opencode",
      "plugins",
      `axi-${marker.replace(/[^A-Za-z0-9._-]+/g, "_")}.js`,
    );
    try {
      if (existsSync(plugin)) unlinkSync(plugin);
    } catch {
      // Best-effort.
    }
  }
}

/**
 * Only install hooks from packaged or installed entrypoints.
 * Development TypeScript entrypoints should not self-register.
 */
export function shouldInstallHooksForExecPath(execPath: string): boolean {
  return shouldInstallHooksForNodeAxiExecPath(execPath, {
    marker: HOOK_MARKER,
    binaryNames: [HOOK_MARKER],
    distEntrypoints: [DIST_ENTRYPOINT],
  });
}

export function installHooksOrThrow(): void {
  const errors: string[] = [];
  // Must run first: the SDK only strips entries matching the current marker, so
  // a hook written under the old one would survive alongside the new install.
  removeLegacyHookInstalls();
  installSessionStartHooks({
    marker: HOOK_MARKER,
    // Must be passed explicitly. Left unset, the SDK infers binaryNames from
    // the dist filename ("chrome-devtools-axi") and then discards it, because
    // resolvePortableHookCommand only considers names containing the marker.
    // With no candidate it falls back to writing the absolute exec path.
    binaryNames: [HOOK_MARKER],
    timeoutSeconds: 10,
    shouldInstall: shouldInstallHooksForExecPath,
    onError: (message) => {
      errors.push(message);
    },
  });
  if (errors.length > 0) {
    throw new Error(errors.join("\n"));
  }
}
