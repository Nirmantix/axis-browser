# Axis Browser Setup And Development Lifecycle

This is the operational lifecycle for the Axis Browser CLI. The project is a
Node.js TypeScript command-line package that wraps `chrome-devtools-mcp` behind
a persistent local bridge.

## Requirements

- Node.js `22.13+`
- `pnpm` `12.5.1` through Corepack (`corepack pnpm@12.5.1 …`) or a compatible
  local install
- Chrome or Chromium
- Optional: npm or Bun for global GitHub installs

No `.env` file is required. Runtime configuration is done with environment
variables.

## Environment Variables

Keep this lifecycle table in sync with the canonical environment reference in
`README.md`.

| Variable | Required | Purpose |
| --- | --- | --- |
| `CHROME_DEVTOOLS_AXI_MODE` | No | `ephemeral` \| `managed` \| `attach` \| `autoconnect`. Overrides mode inference. Unset keeps the historical inference (`AUTO_CONNECT` → `BROWSER_URL` → `USER_DATA_DIR` → `ephemeral`). Set it per command or project — never in a shell profile. |
| `CHROME_DEVTOOLS_AXI_EXECUTABLE_PATH` | No | Absolute path to the Chrome/Chromium binary to launch. Launch modes only; ignored when attaching. |
| `CHROME_DEVTOOLS_AXI_AUTO_REAP` | No | Set to `0` to disable automatic cleanup of orphaned bridges on bridge startup. |
| `CHROME_DEVTOOLS_AXI_AUTO_CONNECT` | No | Set to `1` to attach to Chrome 144+ auto-connect. |
| `CHROME_DEVTOOLS_AXI_SESSION` | No | Named session for concurrent isolation. Each name gets its own bridge process, state dir, and a port derived from the name. Default: `default`. An explicit `CHROME_DEVTOOLS_AXI_PORT` overrides that derivation for **every** session, so exporting one globally forces all sessions onto a single port — set it per session, or not at all. |
| `CHROME_DEVTOOLS_AXI_CHANNEL` | No | Chrome release channel: `stable` (default), `beta`, `canary`, or `dev`. Ignored only in `attach` mode. `AUTO_CONNECT` outranks `BROWSER_URL`, so with both set the mode is `autoconnect` and the channel still applies. |
| `CHROME_DEVTOOLS_AXI_BROWSER_URL` | No | Attach to an existing HTTP(S) or WS(S) CDP endpoint. |
| `CHROME_DEVTOOLS_AXI_WS_HEADERS` | No | JSON object of headers for WS(S) endpoints. Refused unless `CHROME_DEVTOOLS_AXI_ALLOW_WS_HEADERS_ARGV=1`, because `chrome-devtools-mcp` only accepts them via argv, which other local processes can read. Do not commit secret values. |
| `CHROME_DEVTOOLS_AXI_USER_DATA_DIR` | No | Persistent Chrome profile for a managed launch. Default `~/.axis-browser-data`; a *named* session uses `<dir>/sessions/<name>`. A path inside a real browser profile is refused. |
| `CHROME_DEVTOOLS_AXI_HEADED` | No | Set to `1` to launch Chrome headed. |
| `CHROME_DEVTOOLS_AXI_CHROME_ARGS` | No | Whitespace-separated Chrome flags. Flags with spaces are not supported. |
| `CHROME_DEVTOOLS_AXI_PORT` | No | Local bridge server port. Default: `9224`. |
| `CHROME_DEVTOOLS_AXI_MCP_PATH` | No | Optional absolute path to a `chrome-devtools-mcp` build you reviewed. Unset, the bridge runs the exact version this package pins as a dependency; there is no global-install scan and no `npx …@latest` fetch. |
| `CHROME_DEVTOOLS_AXI_BRIDGE_TIMEOUT_MS` | No | Bridge readiness timeout. Default: `30000`; minimum accepted value: `1000`. |

Workflow setup uses these optional environment variables:

| Variable | Required | Purpose |
| --- | --- | --- |
| `BROWSER_BAY_DIR` | No | Absolute path to a local `browser-bay` checkout. Highest setup resolver priority. |
| `AXIS_BROWSER_HOME` | No | Axis Browser checkout root; setup looks for `skills/browser-bay` below it. |
| `AXIS_PORTABLE_SKILLS_DIR` | No | Directory containing portable skills; setup looks for `browser-bay` below it. |
| `BROWSER_BAY_SOURCE_URL` | No | Approved source URL to show when no local router is configured. The CLI does not assume a public router URL. |

## Setup And Build

Install dependencies:

```bash
pnpm install
```

Build the package:

```bash
pnpm run build
```

Run the test suite:

```bash
pnpm test
```

Run targeted tests while editing:

```bash
pnpm exec vitest run test/main.test.ts test/cli.test.ts test/cli-runtime.test.ts
```

Run the TypeScript entrypoint without a global install:

```bash
pnpm run dev -- --help
```

Run the compiled CLI after building:

```bash
node dist/bin/chrome-devtools-axi.js --help
node dist/bin/chrome-devtools-axi.js --version
```

Check Axis workflow readiness from the current project:

```bash
axis-browser setup
```

Get machine-readable setup status:

```bash
axis-browser setup --json
```

Target a different project:

```bash
axis-browser setup --project /path/to/project
```

Preview or run permission-gated project setup:

```bash
axis-browser setup --install --project /path/to/project
```

In non-interactive shells, `--install` previews router commands and does not
prompt unless `--yes` is explicitly passed. The CLI itself never writes
secrets, `.env` files, shell rc files, MCP credential files, or user credential
stores.
On Windows the report detects Chrome and Edge under `Program Files`, `Program
Files (x86)`, and the per-user `LOCALAPPDATA` locations; Chromium under
`Program Files (x86)` only.

Expose the local checkout globally:

```bash
npm link
```

## Install Or Update The Fork

Install from GitHub with npm:

```bash
npm install -g github:Nirmantix/axis-browser
```

Install from GitHub with Bun:

```bash
bun add -g github:Nirmantix/axis-browser
```

Do not use these for the fork:

```bash
npm install -g chrome-devtools-axi
bun add -g chrome-devtools-axi
npx -y chrome-devtools-axi
```

Those commands resolve the upstream npm package, not `Nirmantix/axis-browser`.
The local `axis-browser update` command intentionally prints GitHub update
guidance instead of invoking the SDK npm self-updater.

## Usage

Basic navigation:

```bash
axis-browser open https://example.com
axis-browser snapshot
axis-browser click @g1:1
```

Persistent-login (managed) workflow:

```bash
export CHROME_DEVTOOLS_AXI_MODE=managed
axis-browser login https://example.com   # one-time, interactive
axis-browser open https://example.com
axis-browser snapshot
```

Preflight before a browser task — every remedy it prints is runnable:

```bash
axis-browser doctor --json
```

Install or repair agent session hooks:

```bash
axis-browser setup hooks
```

Inspect workflow readiness without changing the project:

```bash
axis-browser setup
axis-browser setup --json
```

Check the installed version through all supported aliases:

```bash
axis-browser --version
axib --version
chrome-devtools-axi --version
```

## Troubleshooting

Bridge and runtime state live under:

```text
~/.axis-browser/
```

Known state files:

| Path | Purpose |
| --- | --- |
| `~/.axis-browser/bridge.pid` | PID and port for the persistent local bridge. |
| `~/.axis-browser/snapshot-generation` | Current generation counter for stale ref detection. |

If the CLI appears attached to an old browser session:

```bash
axis-browser stop
axis-browser pages
```

If the state is unclear, ask the tool rather than probing a port by hand — launch modes drive
the browser over `--remote-debugging-pipe`, so the browser's CDP endpoint has no TCP address
to curl at all. (The Axis bridge still listens on its documented local port; it is the
*browser's* debugging endpoint that is off TCP.)

```bash
axis-browser doctor
axis-browser pages
```

If bridges have accumulated (a bridge lost to `SIGKILL` or a crash never cleans up after
itself):

```bash
axis-browser reap --dry-run
axis-browser reap
```

Startup no longer fetches `chrome-devtools-mcp` over the network: the bridge runs
the exact version this package pins as a dependency, resolved from its own
`node_modules`. If the bridge reports that the pinned dependency is missing, the
fix is to reinstall this package rather than to point at a global copy:

```bash
npm install -g github:Nirmantix/axis-browser   # or pnpm install in a checkout
```

Set `CHROME_DEVTOOLS_AXI_MCP_PATH` only to run a build you reviewed yourself.

If Chrome itself is slow to launch, extend the bridge readiness timeout:

```bash
export CHROME_DEVTOOLS_AXI_BRIDGE_TIMEOUT_MS=60000
```

If a ref is rejected with `STALE_REF`, re-run:

```bash
axis-browser snapshot
```

Then retry with the newly printed `@g<N>:<uid>` ref.

If `axis-browser setup` reports `browserSkill.status: missing` and
`source: not configured`, point the CLI at a local router checkout:

```bash
export BROWSER_BAY_DIR=/path/to/browser-bay
axis-browser setup
```

Or set an approved source URL for human guidance:

```bash
export BROWSER_BAY_SOURCE_URL=https://example.invalid/browser-bay.git
axis-browser setup
```

If `axis-browser setup --install` runs in a non-interactive agent session, read
the printed preview commands. Re-run from a terminal, or add `--yes` only after
reviewing the project-local actions.

For large network bodies, write data to disk instead of the terminal:

```bash
axis-browser network-get <id> --response-file .tmp/response-body.txt
axis-browser network-get <id> --request-file .tmp/request-body.txt
```

## Teardown And Removal

Stop the persistent bridge:

```bash
axis-browser stop
```

Remove a global npm install:

```bash
npm uninstall -g chrome-devtools-axi
```

Remove a global Bun install:

```bash
bun remove -g chrome-devtools-axi
```

Remove local checkout build artifacts:

```bash
rm -rf dist coverage
```

Remove project-local browser workflow artifacts created by the optional
`browser-bay` router only when they are no longer needed:

```bash
rm -rf .tmp/screenshots .tmp/scrapes .tmp/traces .tmp/reports .tmp/verified-runs
```

If `axis-browser setup hooks` installed SessionStart hooks, remove the
`chrome-devtools-axi` hook entries from these files manually:

```text
~/.claude/settings.json
~/.codex/hooks.json
~/.codex/config.toml
```

Remove local runtime state only when no Axis Browser bridge is running:

```bash
axis-browser stop
rm -rf ~/.axis-browser
```

Remove a dedicated shared Chrome automation profile only if you no longer need
its login state:

```bash
rm -rf ~/.axis-browser-data
```

Do not delete a normal personal Chrome profile as part of Axis Browser teardown.
