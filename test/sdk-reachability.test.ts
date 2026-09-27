import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Standing gate behind the SDK-advisory position in `docs/upstream_sync.md`
 * ("Audit position"). `pnpm audit --prod` reports advisories under
 * `@modelcontextprotocol/sdk`'s dependency graph; the fork's accepted position
 * is that this CLI's imports never load the flagged packages. That was
 * measured once by hand; this test re-measures it on every suite run, so a
 * dependency bump that makes any of them load fails CI instead of quietly
 * ageing the doc's claim into an assumption.
 *
 * `ajv` is deliberately not on the forbidden list: it does load on the client
 * path (`validation/ajv-provider.js`) and has no advisory of its own — only
 * its transitive `fast-uri` does, and ajv reaches that only through
 * `dist/runtime/uri.js`, which cross-document `$ref`/`$id` resolution would
 * trigger and MCP tool schemas do not.
 */

const ROOT = resolve(import.meta.dirname, "..");
const TRACE_REGISTER = join(
  import.meta.dirname,
  "fixtures",
  "module-trace-register.mjs",
);
const BRIDGE_SOURCE = join(ROOT, "src", "bridge.ts");

/**
 * Every `@modelcontextprotocol/sdk` specifier this fork imports, and the only
 * ones it may import. The first assertion compares this list against
 * `src/bridge.ts`, so a new import cannot slip in unnoticed: it fails the test
 * here and must be added deliberately — at which point it is traced and proven
 * not to load anything on the forbidden list below.
 */
const ALLOWED_SDK_SPECIFIERS = [
  "@modelcontextprotocol/sdk/client/index.js",
  "@modelcontextprotocol/sdk/client/stdio.js",
  "@modelcontextprotocol/sdk/client/streamableHttp.js",
  "@modelcontextprotocol/sdk/shared/transport.js",
  "@modelcontextprotocol/sdk/types.js",
] as const;

/** Packages `pnpm audit` flags under the SDK. None may load. */
const FORBIDDEN_PACKAGES = [
  "hono",
  "@hono/node-server",
  "express",
  "express-rate-limit",
  "qs",
  "fast-uri",
  "ip-address",
] as const;

/** The direct package name a module URL resolved to, or null for stdlib. */
function packageName(url: string): string | null {
  const last = url.split("/node_modules/").pop();
  if (last === undefined || last === url) return null;
  const parts = last.split("/");
  return parts[0].startsWith("@") ? `${parts[0]}/${parts[1]}` : parts[0];
}

const require = createRequire(import.meta.url);

function traceEntryGraph(): { modules: string[]; status: number | null } {
  const dir = mkdtempSync(join(tmpdir(), "cdt-axi-reach-"));
  const tracePath = join(dir, "modules.txt");
  try {
    // Resolve to file:// URLs up front: the traced script then imports exact
    // absolute targets, so nothing depends on the subprocess's cwd.
    const script = ALLOWED_SDK_SPECIFIERS.map(
      (spec) =>
        `import ${JSON.stringify(pathToFileURL(require.resolve(spec)).href)};`,
    ).join("\n");
    const result = spawnSync(
      process.execPath,
      [
        "--no-deprecation",
        "--import",
        TRACE_REGISTER,
        "--input-type=module",
        "-e",
        script,
      ],
      {
        cwd: ROOT,
        encoding: "utf8",
        env: {
          ...process.env,
          CHROME_DEVTOOLS_AXI_MODULE_TRACE: tracePath,
        },
      },
    );
    const contents = existsSync(tracePath)
      ? readFileSync(tracePath, "utf8")
      : "";
    return {
      modules: contents.split("\n").filter(Boolean),
      status: result.status,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Every way `src/bridge.ts` could start loading an SDK module, not just
 * `from "..."`: a side-effect `import "..."` and a dynamic
 * `import("...")` both add entrypoints to the traced graph, so a scan that
 * only reads `from` clauses would wave them through while the trace below
 * never exercised them.
 */
const SDK_IMPORT_PATTERNS: RegExp[] = [
  /from\s+"(@modelcontextprotocol\/sdk\/[^"]+)"/g,
  /^\s*import\s+"(@modelcontextprotocol\/sdk\/[^"]+)"/gm,
  /import\(\s*"(@modelcontextprotocol\/sdk\/[^"]+)"\s*\)/g,
];

function sdkSpecifiersIn(source: string): string[] {
  const found = new Set<string>();
  for (const pattern of SDK_IMPORT_PATTERNS) {
    for (const match of source.matchAll(pattern)) {
      if (match[1]) found.add(match[1]);
    }
  }
  return [...found];
}

describe("SDK advisory reachability", () => {
  it("imports exactly the allowed SDK entrypoints", () => {
    const source = readFileSync(BRIDGE_SOURCE, "utf8");
    expect(sdkSpecifiersIn(source).sort()).toEqual(
      [...ALLOWED_SDK_SPECIFIERS].sort(),
    );
  });

  it("detects side-effect and dynamic SDK imports, not just `from` clauses", () => {
    const synthetic = [
      'import { Client } from "@modelcontextprotocol/sdk/client/index.js";',
      'import "@modelcontextprotocol/sdk/client/stdio.js";',
      'await import("@modelcontextprotocol/sdk/client/streamableHttp.js");',
      'const url = "https://@modelcontextprotocol/sdk/mentions-only";',
    ].join("\n");
    expect(sdkSpecifiersIn(synthetic).sort()).toEqual([
      "@modelcontextprotocol/sdk/client/index.js",
      "@modelcontextprotocol/sdk/client/stdio.js",
      "@modelcontextprotocol/sdk/client/streamableHttp.js",
    ]);
  });

  it("loads none of the audited packages on the client path", () => {
    const { modules, status } = traceEntryGraph();

    // Sanity: an empty or SDK-free trace would make the forbidden check pass
    // vacuously, so prove the harness actually imported and captured the SDK.
    expect(status, "the entrypoint imports must succeed").toBe(0);
    expect(modules.length).toBeGreaterThan(0);
    expect(
      modules.some((url) => url.includes("@modelcontextprotocol/sdk/dist")),
      "trace must capture the SDK itself",
    ).toBe(true);

    const loaded = new Set(
      modules.map(packageName).filter((name): name is string => name !== null),
    );
    const offenders = FORBIDDEN_PACKAGES.filter((pkg) => loaded.has(pkg));
    expect(
      offenders,
      `advisory packages must not load: ${offenders.join(", ")}`,
    ).toEqual([]);
  });
});
