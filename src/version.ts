// Leaf module: node builtins only. The version fast path in
// bin/chrome-devtools-axi.ts imports this instead of the heavy cli.js graph.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

function readPackageVersion(): string {
  const here = dirname(fileURLToPath(import.meta.url));

  for (const candidate of [
    join(here, "..", "package.json"),
    join(here, "..", "..", "package.json"),
  ]) {
    if (!existsSync(candidate)) {
      continue;
    }

    const parsed = JSON.parse(readFileSync(candidate, "utf-8")) as {
      version?: unknown;
    };
    if (typeof parsed.version === "string" && parsed.version.length > 0) {
      return parsed.version;
    }
  }

  throw new Error("Could not determine chrome-devtools-axi package version");
}

export const VERSION = readPackageVersion();

/**
 * The command name this fork documents and suggests: the `axis-browser` bin,
 * not the upstream-inherited `chrome-devtools-axi` alias. Every string that
 * tells the operator what to type next builds from this constant, and
 * `test/command-name.test.ts` holds the whole repo to it — the alias may be
 * *shown* in a list of all three bins, but never presented as the command to
 * run.
 */
export const PRIMARY_COMMAND_NAME = "axis-browser";
