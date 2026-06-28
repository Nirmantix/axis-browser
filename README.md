<h1 align="center">Axis Browser</h1>

<p align="center">
  <a href="https://github.com/Nirmantix/axis-browser/actions/workflows/ci.yml"><img alt="CI" src="https://img.shields.io/github/actions/workflow/status/Nirmantix/axis-browser/ci.yml?style=flat-square&label=CI" /></a>
  <a href="https://github.com/Nirmantix/axis-browser"><img alt="Project" src="https://img.shields.io/badge/project-axis--browser-black?style=flat-square" /></a>
  <a href="#platform-support"><img alt="Platform" src="https://img.shields.io/badge/platform-macOS%20%7C%20Linux%20%7C%20Windows*-blue?style=flat-square" /></a>
  <a href="https://github.com/kunchenguid/chrome-devtools-axi"><img alt="Compatibility" src="https://img.shields.io/badge/compatibility-upstream--aligned-blue?style=flat-square" /></a>
</p>

<h3 align="center">Fast, token-efficient browser automation for shared Chrome and CDP workflows</h3>

`Axis Browser` is a lightweight CLI for browser automation, debugging, and shared-session Chrome workflows.

It is optimized for:
- shared Chrome on `9222`
- low-token page inspection
- repeatable debugging with console, network, and snapshots
- practical shared-Chrome debugging with `axis-browser`
- read-only setup reports for Axis workflow readiness

## Documentation Map

This repo keeps a small set of public docs with distinct roles:

- `README.md` — source of truth for install, commands, environment variables, runtime behavior, and development
- `docs/setup_and_dev.md` — setup, build, usage, troubleshooting, and teardown lifecycle for the CLI
- `docs/vibe-coding-browser-workflow.md` — source of truth for the Axis Browser shared-`9222` workflow and troubleshooting habits
- `docs/better-workflow-lifecycle-design.md` — source of truth for the broader Axis Browser workflow lifecycle: machine setup, skill availability, project readiness, task use, and health audits
- `docs/upstream_sync.md` — fork override shield for future upstream merges

The optional `skills/browser-skill/` folder is intentionally ignored by the
parent Axis Browser repo and is maintained as its own standalone nested Git
repo when present. Its own `README.md` and `SKILL.md` are the source of truth
for the host-neutral browser automation skill; this README remains the source
of truth for the Axis Browser CLI itself.

If you see old notes that mention different paths, aliases, or helper scripts, prefer this README and the workflow guide.

## Browser Skill Companion

This checkout may include `skills/browser-skill/`, a companion Agent Skills
package for browser-driven work across Claude Code, Codex, OpenCode, Pi, Kiro,
and AGENTS.md hosts. It routes tasks across Browser Harness, Playwright, Axis
Browser, Notte, CloakBrowser, BrowserAct, Firecrawl, and related tools.

Key boundaries:
- The skill is not shipped as part of the parent Axis Browser package.
- The parent repo keeps `skills/` ignored on purpose.
- Publish or share the skill from its nested repo, not from the Axis Browser
  release flow.
- Global vs project install paths, credentials guidance, and Browserbase
  comparison live in the skill's own `README.md`.
- Optional Notte, CloakBrowser, BrowserAct, Firecrawl, Webwright comparison,
  verified-run, and reusable-workflow guidance also live in the nested skill
  repo.
- For tool setup guidance, run the skill's checker. Use
  `--print-install-commands` for read-only guidance, `--install` for
  permission-gated machine setup, and `--update` for permission-gated health
  audits:

```bash
cd skills/browser-skill
bash scripts/check-prerequisites.sh --print-install-commands
```

Portability note:
- On a workstation with this repo checked out, other local projects can point at
  the checkout's skill with `BROWSER_SKILL_DIR=/path/to/axis-browser/skills/browser-skill`
  or point at the workflow checkout with `AXIS_BROWSER_HOME=/path/to/axis-browser`.
- That gives the agent the workflow router and scripts, not a bundled runtime.
  Global tools such as `axis-browser` and `browser-harness` must already be
  installed on the machine, and Playwright should still be installed
  project-local when reusable scripts, traces, network interception, visual
  regression, or CI are needed.
- Run `bash "$BROWSER_SKILL_DIR/scripts/setup.sh"` once inside each target
  project so `.tmp/` evidence folders and `.gitignore` hygiene are created in
  the right repository.
- Text-expander prompts live under `prompts/` when present:
  `;absetup` for machine setup/audit, `;abcheck` for target-project readiness,
  `;abuse` for loading the browser-skill router, and `;abhealth` for periodic
  maintenance audits. These prompts are wrappers around the skill and scripts;
  they are not a second browser routing system.

## Command Names

Built-in commands exposed by this project:
- `axis-browser` — primary documented command
- `axib` — built-in shorthand compatibility command
- `chrome-devtools-axi` — upstream-compatible command name

Not built in:
- `axis`
- `axi`
- `axisb`
- `axis-init`
- `axis-human`
- `axisb-init`
- `axisb-human`

Those are only user-defined aliases or shell helpers if you create them yourself.

## Platform Support

- `macOS`: supported
- `Linux`: supported for the core CLI and bridge workflow
- `Windows`: partially supported today

Current Windows gaps:
- stale bridge recovery relies on Unix-specific process inspection (`lsof` / `ps`) for some edge cases
- the documented shared-session helper snippets are shell-first examples, not native PowerShell helpers
- there is no Windows CI coverage in this repo yet

## Why Axis Browser Exists

Axis Browser is designed around three practical goals:
- fast feedback while debugging live browser state
- low token overhead for agent-driven workflows
- stable attachment to already-running Chrome sessions

The fork-specific behavior is intentionally small:
- Axis Browser branding and compatibility aliases (`axis-browser`, `axib`)
- runtime state under `~/.axis-browser` instead of `~/.chrome-devtools-axi`
- cross-platform-safe build chmod step

## Install

Requirements:
- Node.js `20+`
- Bun or npm
- Chrome or Chromium for browser automation

The recommended install path for this fork is GitHub, not the upstream npm package.

### Install From GitHub

With Bun:

```bash
bun add -g github:Nirmantix/axis-browser
```

With npm:

```bash
npm install -g github:Nirmantix/axis-browser
```

That install exposes:
- `axis-browser`
- `axib`
- `chrome-devtools-axi`

Verify:

```bash
axis-browser --version
axib --version
chrome-devtools-axi --version
```

Important:
- `bun add -g chrome-devtools-axi` installs the upstream npm package, not this fork
- `npx -y chrome-devtools-axi` also resolves the upstream npm package
- the package name remains `chrome-devtools-axi` for compatibility, but this fork should be installed from GitHub

### Replace An Existing Upstream Global Install

With Bun:

```bash
bun remove -g chrome-devtools-axi
bun add -g github:Nirmantix/axis-browser
```

With npm:

```bash
npm uninstall -g chrome-devtools-axi
npm install -g github:Nirmantix/axis-browser
```

### Install From A Local Checkout

```bash
git clone https://github.com/Nirmantix/axis-browser.git
cd axis-browser
pnpm install
pnpm run build
```

Run from the checkout:

```bash
node dist/bin/chrome-devtools-axi.js --help
node dist/bin/chrome-devtools-axi.js pages
```

Expose the commands globally from the checkout:

```bash
npm link
```

## Benchmarks

Agent ergonomics is measurable.
The [axi benchmark](https://axi.md) runs the same 14 real-world browsing tasks (Wikipedia research, GitHub navigation, multi-site comparison, and more) through 7 browser automation setups - 5 repeats each, with `claude-sonnet-4-6` as the agent and an LLM judge scoring task success.

Axis Browser's upstream-compatible `chrome-devtools-axi` command posts the lowest input tokens, cost, duration, and turn count of all 7 conditions, with 100% task success:

| Condition                            | Avg Input Tokens | Avg Cost/Task | Avg Duration | Avg Turns | Success  |
| ------------------------------------ | ---------------- | ------------- | ------------ | --------- | -------- |
| **Axis Browser / chrome-devtools-axi** | **79,141**       | **$0.074**    | **21.5s**    | **4.5**   | **100%** |
| dev-browser                          | 82,532           | $0.078        | 28.6s        | 4.9       | 99%      |
| agent-browser (Vercel)               | 93,074           | $0.088        | 24.6s        | 4.8       | 99%      |
| chrome-devtools-mcp + compressor CLI | 130,779          | $0.091        | 29.7s        | 7.6       | 100%     |
| chrome-devtools-mcp + ToolSearch     | 133,712          | $0.096        | 29.4s        | 7.5       | 99%      |
| chrome-devtools-mcp (raw MCP)        | 184,711          | $0.101        | 26.0s        | 6.2       | 99%      |
| chrome-devtools-mcp code execution   | 129,606          | $0.120        | 36.2s        | 6.4       | 100%     |

Against raw chrome-devtools-mcp - the very server this CLI wraps - that is 57% fewer input tokens, 26% lower cost, and 27% fewer agent turns.

## Quick Start

```bash
axis-browser open https://example.com
axis-browser click @g1:1
```

Example output:

```text
page: {title: "Example Domain", url: "https://example.com", refs: 1}
snapshot:
RootWebArea "Example Domain"
  heading "Example Domain"
  paragraph "This domain is for use in illustrative examples..."
  uid=g1:1 link "More information..."
help[1]:
  Run `axis-browser click @g1:1` to click the "More information..." link
```

Refs in snapshot output carry a `g<N>:` generation prefix that bumps every time a new accessibility tree is captured. Pass refs back exactly as printed — if the page re-rendered between snapshot and action, the action fails loudly with `STALE_REF` instead of silently no-op'ing, so the agent re-snapshots and retries.
After a state-changing action, confirm the outcome with a fresh `snapshot`, `eval`, or `screenshot` before reporting success. A current ref can still produce no visible page change; `STALE_REF` only catches stale refs.

## Setup Axis Workflow

Run the bootstrap report from any project:

```bash
axis-browser setup
```

The default command is read-only. It checks Node, pnpm/Corepack,
Chrome/Chromium, the local build, global Axis aliases, and whether the optional
`browser-skill` workflow router is available. For machine-readable status:

```bash
axis-browser setup --json
```

Target a project explicitly:

```bash
axis-browser setup --project /path/to/project
```

Permission-gated setup is opt-in:

```bash
axis-browser setup --install --project /path/to/project
```

In non-interactive agent runs, `--install` previews commands and does not hang
on prompts. Add `--yes` only after reviewing the printed actions. Setup never
writes secrets, `.env` files, shell rc files, MCP credential files, or user
credential stores.

Router discovery order:

- `BROWSER_SKILL_DIR`
- `AXIS_BROWSER_HOME/skills/browser-skill`
- `AXIS_PORTABLE_SKILLS_DIR/browser-skill`
- standard agent skill locations

If no router is configured, `axis-browser setup` still succeeds with core Axis
status and reports that the router source is not configured. Set
`BROWSER_SKILL_SOURCE_URL` if your environment has an approved source URL for
the router.

Agent hook setup remains explicit:

```bash
axis-browser setup hooks
```

## Shared Chrome Quick Start

For the shared-`9222` workflow:

```bash
export CHROME_DEVTOOLS_AXI_BROWSER_URL=http://127.0.0.1:9222
axis-browser stop
axis-browser pages
axis-browser snapshot
```

Why stop first:
- the bridge is persistent
- the bridge can outlive your shell session
- a clean restart guarantees the current environment is what the bridge actually uses

If the bridge view and raw Chrome CDP disagree:

```bash
curl -s http://127.0.0.1:9222/json/list
axis-browser stop
axis-browser pages
```

For the full public shared-browser operating model, read:
- [docs/vibe-coding-browser-workflow.md](docs/vibe-coding-browser-workflow.md)

## Session Hook Setup

To install or repair ambient `SessionStart` hooks for supported agents:

```bash
axis-browser setup hooks
```

This installs guidance for Claude Code and Codex so a new agent
session can see current Axis Browser session context. Restart the agent session
after running it. Development entrypoints such as `pnpm run dev` and
`bin/chrome-devtools-axi.ts` are guarded from accidental hook installation.

## Updating Axis Browser

Axis Browser is distributed from GitHub. The upstream npm package named
`chrome-devtools-axi` is not this fork, so the SDK npm self-updater is disabled
in this project.

Update with npm:

```bash
npm install -g github:Nirmantix/axis-browser
```

Update with Bun:

```bash
bun add -g github:Nirmantix/axis-browser
```

Running `axis-browser update` or `axis-browser update --check` prints this
GitHub update guidance instead of installing from npm.

## Evidence-Backed Agent Workflows

Axis Browser itself is a CLI, not an LLM loop. Host agents compose commands such
as `snapshot`, `console`, `network`, and `eval` into their own workflow.

For browser tasks that need auditable evidence, use the optional
`skills/browser-skill/` companion when present:

- `references/verified-run.md` defines a single-pass evidence workflow with
  `STEP_PASS`, `STEP_FAIL`, and `STEP_SKIP` validation.
- `references/reusable-workflow.md` defines the craft pattern for turning a
  working browser flow into a rerunnable local script.
- Webwright is documented there as a pattern source, not as a dependency or a
  replacement for Playwright.

## How It Works

```text
┌───────────────────────┐
│    Axis Browser       │  CLI — parse args, format output
└──────────┬────────────┘
           │ HTTP (localhost:9224)
           ▼
┌───────────────────────┐
│     Bridge Server     │  Persistent process, manages MCP session
└──────────┬────────────┘
           │ stdio
           ▼
┌───────────────────────┐
│  chrome-devtools-mcp  │  DevTools MCP transport to Chrome
└───────────────────────┘
```

- **Persistent bridge** — keeps one MCP session alive across CLI calls
- **Auto-lifecycle** — starts on demand, writes state to `~/.axis-browser/bridge.pid`, recycles stale CDP targets after a deep health check, and reaps child processes on stop
- **Snapshot parsing** — extracts accessibility-tree refs (`uid=`) for lightweight interaction
- **Generation tagging** — refs carry a `g<N>:` prefix; stale refs from prior snapshots are rejected with `STALE_REF`
- **TOON encoding** — keeps structured output compact compared with heavier browser payloads

## CLI Reference

### Navigation

| Command           | Description                                  |
| ----------------- | -------------------------------------------- |
| `open <url>`      | Navigate to URL and snapshot                 |
| `snapshot`        | Capture current page state                   |
| `screenshot <p>`  | Save a screenshot to a file                  |
| `scroll <dir>`    | Scroll: up, down, top, bottom                |
| `back`            | Navigate back                                |
| `wait <ms\|text>` | Wait for time or text to appear              |
| `eval <js>`       | Evaluate a JavaScript expression or function |
| `run`             | Execute a multi-step script from stdin       |

`eval` wraps plain input as `() => (<expr>)` before sending it to DevTools. For multi-statement logic, pass an arrow function or `function`. No-arg IIFE form `(...)()` is accepted too and unwrapped automatically.

```sh
axis-browser eval "document.title"
axis-browser eval "() => { const rows = [...document.querySelectorAll('tr')]; return rows.map((row) => row.textContent) }"
```

### Interaction

| Command                    | Description                    |
| -------------------------- | ------------------------------ |
| `click @<uid>`             | Click an element by ref        |
| `fill @<uid> <text>`       | Fill a form field              |
| `type <text>`              | Type text at current focus     |
| `press <key>`              | Press a keyboard key           |
| `hover @<uid>`             | Hover over an element          |
| `drag @<from> @<to>`       | Drag an element onto another   |
| `fillform @<uid>=<val>...` | Fill multiple form fields      |
| `dialog <accept\|dismiss>` | Handle a browser dialog        |
| `upload @<uid> <path>`     | Upload a file through an input |

### Page Management

| Command           | Description                 |
| ----------------- | --------------------------- |
| `pages`           | List all open tabs          |
| `newpage <url>`   | Open a new tab              |
| `selectpage <id>` | Switch to a tab by ID       |
| `closepage <id>`  | Close a tab by ID           |
| `resize <w> <h>`  | Resize the browser viewport |

### Emulation

| Command   | Description                     |
| --------- | ------------------------------- |
| `emulate` | Emulate device/network/viewport |

### DevTools Debugging

| Command            | Description                    |
| ------------------ | ------------------------------ |
| `console`          | List console messages          |
| `console-get <id>` | Get a specific console message |
| `network`          | List network requests          |
| `network-get [id]` | Get a specific network request |

For large request or response bodies, prefer `network-get <id> --response-file <path>` or `--request-file <path>` so the body goes to disk instead of flooding agent context.

### Performance

| Command                     | Description                   |
| --------------------------- | ----------------------------- |
| `lighthouse`                | Run a Lighthouse audit        |
| `perf-start`                | Start a performance trace     |
| `perf-stop`                 | Stop the performance trace    |
| `perf-insight <set> <name>` | Analyze a performance insight |
| `heap <path>`               | Capture a heap snapshot       |

### Bridge

| Command       | Description                   |
| ------------- | ----------------------------- |
| `start`       | Start the bridge server       |
| `stop`        | Stop the bridge server        |
| `setup hooks` | Install or repair agent hooks |

### Maintenance

| Command          | Description                                            |
| ---------------- | ------------------------------------------------------ |
| `update`         | Show GitHub update guidance for this fork              |
| `update --check` | Show GitHub update guidance without contacting npm     |

Running with no command shows the CLI home view. It prepends `bin` and `description` metadata, then includes the current snapshot when a browser session is active or the no-session status/help block when one is not.

### Flags

| Flag                        | Description                                 |
| --------------------------- | ------------------------------------------- |
| `--help`                    | Show usage information                      |
| `-v`, `-V`, `--version`     | Show the installed CLI version              |
| `--check`                   | Show GitHub update guidance (update)        |
| `--full`                    | Show complete output without truncation     |
| `--background`              | Open new page in background (newpage)       |
| `--uid @<uid>`              | Target a specific element (screenshot)      |
| `--full-page`               | Capture entire scrollable page (screenshot) |
| `--format <fmt>`            | Image format: png, jpeg, webp (screenshot)  |
| `--viewport <spec>`         | Viewport like `390x844x3,mobile` (emulate)  |
| `--color-scheme <value>`    | dark, light, or auto (emulate)              |
| `--network <condition>`     | Network throttle: Slow 3G, etc. (emulate)   |
| `--cpu <rate>`              | CPU throttling rate 1-20 (emulate)          |
| `--geolocation <lat>x<lon>` | Set geolocation (emulate)                   |
| `--user-agent <string>`     | Custom user agent (emulate)                 |
| `--type <type>`             | Filter by type (console, network)           |
| `--limit <n>`               | Max items to return (console, network)      |
| `--page <n>`                | Pagination (console, network)               |
| `--device <device>`         | desktop or mobile (lighthouse)              |
| `--mode <mode>`             | navigation or snapshot (lighthouse)         |
| `--output-dir <path>`       | Directory for reports (lighthouse)          |
| `--no-reload`               | Skip page reload (perf-start)               |
| `--no-auto-stop`            | Disable auto-stop (perf-start)              |
| `--file <path>`             | Save trace data to file (perf-start/stop)   |
| `--response-file <path>`    | Save response body (network-get)            |
| `--request-file <path>`     | Save request body (network-get)             |

`console --type` accepts `log`, `debug`, `info`, `error`, `warn`, `dir`, `dirxml`, `table`, `trace`, `clear`, `startGroup`, `startGroupCollapsed`, `endGroup`, `assert`, `profile`, `profileEnd`, `count`, `timeEnd`, `verbose`, `issue`, and `all`.
`network --type` accepts `document`, `stylesheet`, `image`, `media`, `font`, `script`, `texttrack`, `xhr`, `fetch`, `prefetch`, `eventsource`, `websocket`, `manifest`, `signedexchange`, `ping`, `cspviolationreport`, `preflight`, `fedcm`, `other`, and `all`.
For both commands, `all` or an omitted `--type` returns every item.

## Configuration

### Connection Mode Precedence

Axis Browser uses these connection modes in order:
1. `CHROME_DEVTOOLS_AXI_AUTO_CONNECT=1`
2. `CHROME_DEVTOOLS_AXI_BROWSER_URL=...`
3. managed browser launch using `CHROME_DEVTOOLS_AXI_USER_DATA_DIR` or an isolated temp profile

### Environment Variables

| Variable | Purpose |
| --- | --- |
| `CHROME_DEVTOOLS_AXI_AUTO_CONNECT` | Set to `1` to attach to the user's running Chrome through Chrome 144+ auto-connect |
| `CHROME_DEVTOOLS_AXI_BROWSER_URL` | Connect to an existing Chrome instance instead of launching one |
| `CHROME_DEVTOOLS_AXI_WS_HEADERS` | JSON headers for authenticated `ws://` / `wss://` browser endpoints |
| `CHROME_DEVTOOLS_AXI_USER_DATA_DIR` | Use a persistent Chrome profile instead of `--isolated` |
| `CHROME_DEVTOOLS_AXI_HEADED` | Set to `1` to run the managed browser in headed mode |
| `CHROME_DEVTOOLS_AXI_CHROME_ARGS` | Whitespace-separated Chrome flags forwarded to the browser |
| `CHROME_DEVTOOLS_AXI_PORT` | Override the bridge port (default: `9224`) |
| `CHROME_DEVTOOLS_AXI_MCP_PATH` | Absolute path to a local `chrome-devtools-mcp` binary (skips npx) |
| `CHROME_DEVTOOLS_AXI_BRIDGE_TIMEOUT_MS` | Bridge readiness deadline in ms (default: `30000`; useful for slow npx bootstrap) |
| `BROWSER_SKILL_DIR` | Absolute path to a local `browser-skill` checkout. Highest setup resolver priority |
| `AXIS_BROWSER_HOME` | Axis Browser checkout root; setup looks for `skills/browser-skill` below it |
| `AXIS_PORTABLE_SKILLS_DIR` | Directory containing portable skills; setup looks for `browser-skill` below it |
| `BROWSER_SKILL_SOURCE_URL` | Approved source URL shown when no local router is configured; no public router URL is assumed |

Examples:

```bash
export CHROME_DEVTOOLS_AXI_BROWSER_URL=http://127.0.0.1:9222
export CHROME_DEVTOOLS_AXI_PORT=9225
export CHROME_DEVTOOLS_AXI_HEADED=1
export CHROME_DEVTOOLS_AXI_CHROME_ARGS="--enable-gpu --ignore-gpu-blocklist"
```

`CHROME_DEVTOOLS_AXI_BROWSER_URL` accepts both HTTP(S) and WebSocket endpoints:
- `http(s)://` uses `--browserUrl` and discovers the WebSocket URL via `/json/version`
- `ws(s)://` uses `--wsEndpoint` directly

Authenticated WebSocket example:

```bash
export CHROME_DEVTOOLS_AXI_BROWSER_URL=wss://cluster.example/launch
export CHROME_DEVTOOLS_AXI_WS_HEADERS='{"Authorization":"Bearer token"}'
```

Chrome 144+ auto-connect example:

```bash
export CHROME_DEVTOOLS_AXI_AUTO_CONNECT=1
```

When auto-connect is enabled, it takes precedence over `CHROME_DEVTOOLS_AXI_BROWSER_URL` and `CHROME_DEVTOOLS_AXI_USER_DATA_DIR`.

### Runtime State

State is stored in `~/.axis-browser/`:

| File                  | Purpose                                    |
| --------------------- | ------------------------------------------ |
| `bridge.pid`          | PID and port of the running bridge         |
| `snapshot-generation` | Counter used to detect stale uid refs      |

### Session Hooks

Run `axis-browser setup hooks` to install or repair a `SessionStart` hook in:
- `~/.claude/settings.json`
- `~/.codex/hooks.json`

It also enables `hooks` in:
- `~/.codex/config.toml`

Development entrypoints such as `pnpm run dev` and `bin/chrome-devtools-axi.ts` do not modify those hook files.

Do not copy user-local agent config such as `.codex/`, `.claude/`,
`.opencode/`, `.agents/`, `.pi/`, hooks, cookies, API keys, or MCP credentials
into this repo. If any credential-bearing config is committed or shared, remove
it according to the project's incident process and rotate the affected secrets.

## Development

```bash
pnpm install
pnpm run build
pnpm run dev
pnpm test
pnpm run test:watch
```

For the full setup, troubleshooting, and teardown lifecycle, read
[docs/setup_and_dev.md](docs/setup_and_dev.md). For future upstream merges,
protect the fork-specific overrides listed in
[docs/upstream_sync.md](docs/upstream_sync.md).
