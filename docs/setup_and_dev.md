# Axis Browser Setup And Development Lifecycle

This is the operational lifecycle for the Axis Browser CLI. The project is a
Node.js TypeScript command-line package that wraps `chrome-devtools-mcp` behind
a persistent local bridge.

## Requirements

- Node.js `20+`
- `pnpm` `11.1.1` through Corepack or a compatible local install
- Chrome or Chromium
- Optional: npm or Bun for global GitHub installs

No `.env` file is required. Runtime configuration is done with environment
variables.

## Environment Variables

Keep this lifecycle table in sync with the canonical environment reference in
`README.md`.

| Variable | Required | Purpose |
| --- | --- | --- |
| `CHROME_DEVTOOLS_AXI_AUTO_CONNECT` | No | Set to `1` to attach to Chrome 144+ auto-connect. |
| `CHROME_DEVTOOLS_AXI_BROWSER_URL` | No | Attach to an existing HTTP(S) or WS(S) CDP endpoint. |
| `CHROME_DEVTOOLS_AXI_WS_HEADERS` | No | JSON object of headers for WS(S) endpoints. Do not commit secret values. |
| `CHROME_DEVTOOLS_AXI_USER_DATA_DIR` | No | Use a persistent Chrome profile for a managed launch. |
| `CHROME_DEVTOOLS_AXI_HEADED` | No | Set to `1` to launch Chrome headed. |
| `CHROME_DEVTOOLS_AXI_CHROME_ARGS` | No | Whitespace-separated Chrome flags. Flags with spaces are not supported. |
| `CHROME_DEVTOOLS_AXI_PORT` | No | Local bridge server port. Default: `9224`. |
| `CHROME_DEVTOOLS_AXI_MCP_PATH` | No | Absolute path to a local `chrome-devtools-mcp` script. |
| `CHROME_DEVTOOLS_AXI_BRIDGE_TIMEOUT_MS` | No | Bridge readiness timeout. Default: `30000`; minimum accepted value: `1000`. |

Workflow setup uses these optional environment variables:

| Variable | Required | Purpose |
| --- | --- | --- |
| `BROWSER_SKILL_DIR` | No | Absolute path to a local `browser-skill` checkout. Highest setup resolver priority. |
| `AXIS_BROWSER_HOME` | No | Axis Browser checkout root; setup looks for `skills/browser-skill` below it. |
| `AXIS_PORTABLE_SKILLS_DIR` | No | Directory containing portable skills; setup looks for `browser-skill` below it. |
| `BROWSER_SKILL_SOURCE_URL` | No | Approved source URL to show when no local router is configured. The CLI does not assume a public router URL. |

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

Shared Chrome workflow:

```bash
export CHROME_DEVTOOLS_AXI_BROWSER_URL=http://127.0.0.1:9222
axis-browser stop
axis-browser pages
axis-browser snapshot
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

If shared Chrome is the source of truth, compare raw CDP tabs:

```bash
curl -s http://127.0.0.1:9222/json/list
```

If startup is slow because `npx chrome-devtools-mcp` is cold:

```bash
npm install -g chrome-devtools-mcp
export CHROME_DEVTOOLS_AXI_MCP_PATH="$(npm prefix -g)/lib/node_modules/chrome-devtools-mcp/build/src/bin/chrome-devtools-mcp.js"
```

Or extend the bridge readiness timeout:

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
export BROWSER_SKILL_DIR=/path/to/browser-skill
axis-browser setup
```

Or set an approved source URL for human guidance:

```bash
export BROWSER_SKILL_SOURCE_URL=https://example.invalid/browser-skill.git
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
`browser-skill` router only when they are no longer needed:

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
