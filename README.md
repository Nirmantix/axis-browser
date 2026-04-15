<h1 align="center">Axis Browser</h1>

<p align="center">
  <a href="https://github.com/Nirmantix/axis-browser/actions/workflows/ci.yml"><img alt="CI" src="https://img.shields.io/github/actions/workflow/status/Nirmantix/axis-browser/ci.yml?style=flat-square&label=CI" /></a>
  <a href="https://github.com/Nirmantix/axis-browser"><img alt="Project" src="https://img.shields.io/badge/project-axis--browser-black?style=flat-square" /></a>
  <a href="#"><img alt="Platform" src="https://img.shields.io/badge/platform-macOS%20%7C%20Linux%20%7C%20Windows-blue?style=flat-square" /></a>
  <a href="https://github.com/kunchenguid/chrome-devtools-axi"><img alt="Compatibility" src="https://img.shields.io/badge/compatibility-upstream--aligned-blue?style=flat-square" /></a>
</p>

<h3 align="center">Fast, token-efficient browser automation for shared Chrome and CDP workflows</h3>

`Axis Browser` is a fast CLI for browser automation, debugging, and shared-session Chrome workflows.

It is built for the workflows that are awkward with heavier browser MCP stacks:
- shared Chrome on `9222`
- token-efficient page inspection
- repeatable debugging with console, network, and snapshots
- low-friction handoff between `axis-browser`, `axib`, Playwright, and other tooling

Compatibility notes:
- maintained by `Nirmantix`
- tracks [`kunchenguid/chrome-devtools-axi`](https://github.com/kunchenguid/chrome-devtools-axi) closely so upgrades stay simple
- installed commands: `axis-browser`, `axib`, and `chrome-devtools-axi`
- npm package name remains upstream-compatible: `chrome-devtools-axi`

## Why Axis Browser

Axis Browser is designed around three practical goals:

- fast feedback while debugging live browser state
- low token overhead for agent-driven workflows
- stable attachment to already-running Chrome sessions

That combination is especially useful when you want a single browser window to be shared across manual work, agent inspection, and Playwright verification.

## Shared-Session Reliability

Axis Browser hardens the shared-Chrome workflow where a stale MCP session can survive longer than the browser target you meant to use.

In practice that caused:
- `axib pages` disagreeing with raw Chrome CDP targets
- unreliable attachment to already-open tabs
- confusion when switching between isolated and shared browser sessions

This matters most in workflows that reuse a live Chrome on `http://127.0.0.1:9222`.

## What Axis Browser Adds

Axis Browser adds bridge target fingerprinting and safer local bridge recovery:

- the bridge writes its launch/session config into `~/.axis-browser/bridge.pid`
- the bridge uses a dedicated `chrome-devtools-mcp` cache under `~/.axis-browser/npm-cache`
- the client compares the saved config with the current environment
- if the target changed, the bridge is restarted instead of being silently reused
- stale local bridge wrappers on `9224` can now be shut down and recovered more reliably

That fingerprint currently includes:
- `CHROME_DEVTOOLS_AXI_BROWSER_URL`
- `CHROME_DEVTOOLS_AXI_USER_DATA_DIR`
- headed vs headless mode
- forwarded Chrome args

Detailed install and maintenance notes live here:
- [docs/axis-browser-fork-guide.md](docs/axis-browser-fork-guide.md)

## Maintenance Model

Axis Browser should stay intentionally small and upgrade-friendly.

- prefer upstream behavior whenever upstream is sufficient
- carry repo-specific patches only when they solve a concrete shared-session reliability problem
- rebase or merge upstream updates regularly
- remove repo-specific code when upstream adopts an equivalent fix

For installation, usage, and long-term maintenance details, see:
- [docs/axis-browser-fork-guide.md](docs/axis-browser-fork-guide.md)
- [docs/vibe-coding-browser-workflow.md](docs/vibe-coding-browser-workflow.md)

Recommended workflow guide:
- [docs/vibe-coding-browser-workflow.md](docs/vibe-coding-browser-workflow.md) explains the practical "best results" setup for using Axis Browser with a shared Chrome session, `agent-browser` for visual checks, and Playwright CLI for low-token verification.
- Read it if you want the shortest path to a reliable daily workflow, Google SSO handling, shared-session debugging, and token-efficient browser automation habits.

- **Token-efficient** — TOON-encoded output stays compact compared with raw JSON or DOM-heavy browser flows
- **Combined operations** — one command navigates, captures, and suggests next steps
- **Contextual suggestions** — every response includes actionable next-step hints

## Quick Start

```sh
$ axis-browser open https://example.com
page: {title: "Example Domain", url: "https://example.com", refs: 1}
snapshot:
RootWebArea "Example Domain"
  heading "Example Domain"
  paragraph "This domain is for use in illustrative examples..."
  uid=1 link "More information..."
help[1]:
  Run `axis-browser click @1` to click the "More information..." link

$ axis-browser click @1
page: {title: "IANA — IANA-Managed Reserved Domains", refs: 12}
snapshot:
...
```

## Install

Axis Browser does **not** currently publish a separate npm package under a new name.

The repo is branded as `Axis Browser`, but the executable and package identity stay upstream-compatible:
- package name: `chrome-devtools-axi`
- primary command: `axis-browser`
- compatibility commands: `axib`, `chrome-devtools-axi`

If you want to use this repository rather than the upstream npm package, see:
- [docs/axis-browser-fork-guide.md](docs/axis-browser-fork-guide.md)

For quick evaluation of the upstream-compatible interface, you can still run:

```
npx -y chrome-devtools-axi --help
```

Important:
- that command resolves the upstream npm package, not this repository checkout
- use this repo via `npm link`, a local build, or your own package workflow if you want the Axis Browser bridge fix

When installed from this repository, it exposes all of these commands:
- `axis-browser`
- `axib`
- `chrome-devtools-axi`

## How It Works

```
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

- **Persistent bridge** — a detached process keeps the MCP session alive across commands, so the DevTools transport doesn't restart every invocation
- **Auto-lifecycle** — the bridge starts on first command and writes a PID file to `~/.axis-browser/bridge.pid`
- **Snapshot parsing** — accessibility tree snapshots are extracted and analyzed for interactive elements (`uid=` refs)
- **TOON encoding** — structured metadata uses [TOON format](https://www.npmjs.com/package/@toon-format/toon) for compact, token-efficient output

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

`eval` wraps plain input as `() => (<expr>)` before sending it to DevTools. For multi-statement logic, pass an arrow function, `function`, or IIFE yourself.

```sh
axis-browser eval "document.title"
axis-browser eval "(() => { const rows = [...document.querySelectorAll('tr')]; return rows.map((row) => row.textContent) })()"
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

### Performance

| Command                     | Description                   |
| --------------------------- | ----------------------------- |
| `lighthouse`                | Run a Lighthouse audit        |
| `perf-start`                | Start a performance trace     |
| `perf-stop`                 | Stop the performance trace    |
| `perf-insight <set> <name>` | Analyze a performance insight |
| `heap <path>`               | Capture a heap snapshot       |

### Bridge

| Command | Description             |
| ------- | ----------------------- |
| `start` | Start the bridge server |
| `stop`  | Stop the bridge server  |

Running with no command shows the CLI home view. It prepends `bin` and
`description` metadata, then includes the current snapshot when a browser
session is active or the no-session status/help block when one is not.

### Flags

| Flag                        | Description                                 |
| --------------------------- | ------------------------------------------- |
| `--help`                    | Show usage information                      |
| `-v`, `-V`, `--version`     | Show the installed CLI version              |
| `--full`                    | Show complete output without truncation     |
| `--background`              | Open new page in background (newpage)       |
| `--uid @<uid>`              | Target a specific element (screenshot)      |
| `--full-page`               | Capture entire scrollable page (screenshot) |
| `--format <fmt>`            | Image format: png, jpeg, webp (screenshot)  |
| `--viewport <spec>`         | Viewport like "390x844x3,mobile" (emulate)  |
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

## Configuration

The bridge server port defaults to `9224`. Override it with an environment variable:

```sh
export CHROME_DEVTOOLS_AXI_PORT=9225
```

State is stored in `~/.axis-browser/`:

| File         | Purpose                            |
| ------------ | ---------------------------------- |
| `bridge.pid` | PID and port of the running bridge |
| `npm-cache/` | Dedicated cache used for `npx chrome-devtools-mcp@latest` |

Axis Browser uses its own managed npm cache under `~/.axis-browser/npm-cache/` when spawning `chrome-devtools-mcp`.
That prevents bridge startup from depending on a broken or machine-specific global npm cache configuration.

### Session Hooks

On supported agents, the packaged CLI also installs a `SessionStart` hook in `~/.claude/settings.json` and `~/.codex/hooks.json`, and enables `codex_hooks` in `~/.codex/config.toml`.

Set `CHROME_DEVTOOLS_AXI_DISABLE_HOOKS=1` to skip that auto-install behavior.

Development entrypoints such as `npm run dev` and `bin/chrome-devtools-axi.ts` do not modify those hook files.

## Development

```sh
npm run build      # Compile TypeScript to dist/
npm run dev        # Run CLI directly with tsx
npm test           # Run tests with vitest
npm run test:watch # Run tests in watch mode
```
