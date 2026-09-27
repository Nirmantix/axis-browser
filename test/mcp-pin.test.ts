import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  buildTransportArgs,
  PINNED_MCP_ENTRY,
  resolveBundledMcpPath,
} from "../src/bridge.js";

/**
 * The pinned chrome-devtools-mcp is now part of this package's contract, so the
 * assumptions the CLI makes about it are testable instead of folklore.
 *
 * Everything here reads the dependency that is actually installed — no spawn, no
 * network. Previously chrome-devtools-mcp was fetched with
 * `npx -y chrome-devtools-mcp@latest` at bridge startup, so a flag this CLI
 * passed could vanish between two runs of the same release, and nothing could
 * assert against a build that was not on disk.
 */

// <packageRoot>/build/src/bin/chrome-devtools-mcp.js → four levels up.
const mcpEntry = resolveBundledMcpPath();
const packageRoot = mcpEntry
  ? dirname(dirname(dirname(dirname(mcpEntry))))
  : null;

function readInstalled(...segments: string[]): string {
  if (!packageRoot)
    throw new Error("pinned chrome-devtools-mcp is not installed");
  return readFileSync(join(packageRoot, ...segments), "utf8");
}

describe("the pinned chrome-devtools-mcp dependency", () => {
  it("is installed and is the entry the bridge will spawn", () => {
    expect(mcpEntry).not.toBeNull();
    expect(mcpEntry!.endsWith("build/src/bin/chrome-devtools-mcp.js")).toBe(
      true,
    );
  });

  it("matches the exact version this package declares", () => {
    // An exact pin, not a caret: a floating MCP would let the browser-facing
    // half of this CLI change with no reviewed package.json diff behind it.
    const declared = JSON.parse(
      readFileSync(join(import.meta.dirname, "..", "package.json"), "utf8"),
    ) as { dependencies: Record<string, string> };
    const installed = JSON.parse(readInstalled("package.json")) as {
      version: string;
    };

    expect(declared.dependencies["chrome-devtools-mcp"]).toBe(
      installed.version,
    );
    expect(declared.dependencies["chrome-devtools-mcp"]).not.toMatch(/[\^~*]/);
  });

  it("really supports the --redactNetworkHeaders the CLI now passes", () => {
    // `network` prints request and response headers to the caller. The flag is
    // verified against the installed option table rather than a remembered
    // --help transcript, so a bump that renames or drops it fails here.
    const options = readInstalled("build", "src", "config", "mcp-options.js");
    expect(options).toContain("redactNetworkHeaders");
    expect(buildTransportArgs()).toContain("--redactNetworkHeaders");
  });

  it("really takes WebSocket headers only through argv", () => {
    // This is why CHROME_DEVTOOLS_AXI_WS_HEADERS is refused by default: the only
    // interface the pinned build offers puts the secret in the process table.
    const options = readInstalled("build", "src", "config", "mcp-options.js");
    expect(options).toContain("wsHeaders");
    expect(options).not.toContain("wsHeadersFile");
    expect(options).not.toMatch(/wsHeadersEnv/);
  });

  it("offers no shared-server or proxy flags of its own", () => {
    // The README documents CHROME_DEVTOOLS_AXI_MCP_SERVER_URL as bring-your-own-
    // server precisely because the official build has no listener or proxy flag.
    // If a future version adds one, this fails and the docs should stop calling
    // it unsupported.
    const options = readInstalled("build", "src", "config", "mcp-options.js");
    expect(options).not.toContain("serverUrl");
    expect(options).not.toContain("httpPort");
  });

  it("still emits the page-missing text src/client.ts matches on", () => {
    // `isMissingPageError` attributes a failed call to a closed or reissued page
    // by matching these two literals. That used to be an unverifiable assumption
    // — the comment in src/client.ts said so outright, because the MCP was
    // fetched with npx and there was no build on disk to assert against. With the
    // dependency pinned and installed, a bump that rewords them fails here
    // instead of quietly degrading every missing-page error into a generic one.
    const context = readInstalled("build", "src", "McpContext.js");
    expect(context).toContain("No page found");
    expect(context).toContain("The selected page has been closed.");
  });

  it("keeps the pinned specifier free of any floating version", () => {
    expect(PINNED_MCP_ENTRY).toBe(
      "chrome-devtools-mcp/build/src/bin/chrome-devtools-mcp.js",
    );
    expect(PINNED_MCP_ENTRY).not.toMatch(/latest|\*|\^|~/);
  });
});
