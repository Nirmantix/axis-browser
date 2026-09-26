<h1 align="center">Axis Browser</h1>

<p align="center">
  <a href="https://github.com/Nirmantix/axis-browser/actions/workflows/ci.yml"><img alt="CI" src="https://img.shields.io/github/actions/workflow/status/Nirmantix/axis-browser/ci.yml?style=flat-square&label=CI" /></a>
  <a href="https://github.com/Nirmantix/axis-browser"><img alt="Project" src="https://img.shields.io/badge/project-axis--browser-black?style=flat-square" /></a>
  <a href="#platform-support"><img alt="Platform" src="https://img.shields.io/badge/platform-macOS%20%7C%20Linux%20%7C%20Windows*-blue?style=flat-square" /></a>
  <a href="https://github.com/kunchenguid/chrome-devtools-axi"><img alt="Compatibility" src="https://img.shields.io/badge/compatibility-upstream--aligned-blue?style=flat-square" /></a>
</p>

<h3 align="center">Fast, token-efficient browser automation with an explicit connection mode</h3>

`Axis Browser` is a lightweight CLI for browser automation, debugging, and persistent-profile Chrome workflows.

It is optimized for:
- a browser Axis launches and owns — throwaway (`ephemeral`) or persistent-profile (`managed`)
- low-token page inspection
- repeatable debugging with console, network, and snapshots
- machine-readable preflight (`axis-browser doctor --json`) so an agent can repair its own environment
- read-only setup reports for Axis workflow readiness

> **Attaching to a browser you did not launch is an escape hatch, not the default.** Earlier
> versions of this README led with a shared Chrome on port `9222`. That advice caused a
> full-day work stoppage on 2026-07-30 and has been removed — see
> [Connection Modes](#connection-modes) and
> [docs/shared-session-design.md](docs/shared-session-design.md).

## Documentation Map

This repo keeps a small set of public docs with distinct roles:

- `README.md` — source of truth for install, commands, environment variables, runtime behavior, and development
- `docs/setup_and_dev.md` — setup, build, usage, troubleshooting, and teardown lifecycle for the CLI
- `docs/vibe-coding-browser-workflow.md` — day-to-day agent workflow and troubleshooting habits
- `docs/shared-session-design.md` — why the connection model looks the way it does: the 2026-07-30 incident, the mode/profile design, and the verification receipts
- `upstream/README.md` — third-party sources vendored for reading and CodeGraph queries (never built, never tested, never committed)
- `docs/better-workflow-lifecycle-design.md` — source of truth for the broader Axis Browser workflow lifecycle: machine setup, skill availability, project readiness, task use, and health audits
- `docs/browseract-mcp-per-project.md` — project-scoped BrowserAct remote MCP setup, and how it differs from machine CLI auth
- `docs/upstream_sync.md` — fork override shield for future upstream merges

The optional `skills/browser-bay/` folder is intentionally ignored by the
parent Axis Browser repo and is maintained as its own standalone nested Git
repo when present. Its own `README.md` and `SKILL.md` are the source of truth
for the host-neutral browser automation skill; this README remains the source
of truth for the Axis Browser CLI itself.

If you see old notes that mention different paths, aliases, or helper scripts, prefer this README and the workflow guide.

## BrowserBay Companion

This checkout may include `skills/browser-bay/`, a companion Agent Skills
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
cd skills/browser-bay
bash scripts/check-prerequisites.sh --print-install-commands
```

Portability note:
- On a workstation with this repo checked out, other local projects can point at
  the checkout's skill with `BROWSER_BAY_DIR=/path/to/axis-browser/skills/browser-bay`
  or set `AXIS_BROWSER_HOME=/path/to/axis-browser` so setup can resolve
  `$AXIS_BROWSER_HOME/skills/browser-bay`.
- That gives the agent the workflow router and scripts, not a bundled runtime.
  Global tools such as `axis-browser` and `browser-harness` must already be
  installed on the machine, and Playwright should still be installed
  project-local when reusable scripts, traces, network interception, visual
  regression, or CI are needed.
- For direct script calls, resolve the skill directory first, then run the
  project gate inside each target app (not `$HOME`). Resolving matters: on a
  fallback or legacy install `BROWSER_BAY_DIR` is unset, and
  `bash "$BROWSER_BAY_DIR/scripts/..."` degrades to `bash "/scripts/..."` with a
  confusing path error. The chain below searches the same places
  `axis-browser setup` does, so a skill copied into a host skill location
  resolves here too.

  ```bash
  BB=""
  c="${BROWSER_BAY_DIR:-${BROWSER_SKILL_DIR:-}}"
  [ -n "$c" ] && [ -d "$c" ] && BB="$c"
  for p in "${AXIS_BROWSER_HOME:+$AXIS_BROWSER_HOME/skills}" "${AXIS_PORTABLE_SKILLS_DIR:-}" \
           ./skills "$HOME/.codex/skills" "$HOME/.config/agents/skills" \
           "$HOME/.claude/skills" "$HOME/.config/opencode/skills" \
           "$HOME/.pi/agent/skills" "$HOME/.agents/skills" \
           "$HOME/.cursor/skills" "$HOME/.kiro/skills" "$HOME/.gemini/skills"; do
    [ -n "$BB" ] && break
    [ -n "$p" ] || continue
    for n in browser-bay browser-skill; do
      if [ -d "$p/$n" ]; then BB="$p/$n"; break; fi
    done
  done
  [ -d "$BB" ] || { echo "browser-bay not found; set BROWSER_BAY_DIR"; exit 2; }

  bash "$BB/scripts/ensure-project-ready.sh"; rc=$?      # read-only gate
  if [ "$rc" = 2 ]; then                                 # 2 = one-time setup needed
    bash "$BB/scripts/setup.sh" || exit $?               # the only writing step; needs operator approval
    bash "$BB/scripts/ensure-project-ready.sh"; rc=$?    # re-check once
  fi
  [ "$rc" = 0 ] || exit "$rc"                            # any other status is a real error
  ```

  Branch on the exit code rather than running both in sequence: the gate exits `0` when
  the project is already ready, and `setup.sh` is the only step that writes. Let a failing
  `setup.sh` exit — do not fall through to the re-check, or a gate that passes on the retry
  will report success over a setup that failed. Exit `2` on the re-check means setup did not
  finish the job; read its output rather than looping.

  The legacy alias `BROWSER_SKILL_DIR` is still honoured by `axis-browser setup`
  itself; prefer `BROWSER_BAY_DIR` in new shells.
- **BrowserAct**: machine CLI auth is separate from optional **project-scoped**
  remote MCP (published workflows). See
  [docs/browseract-mcp-per-project.md](docs/browseract-mcp-per-project.md) and
  the skill's `references/credentials-setup.md` when the nested skill is
  present. (That path lives under the gitignored `skills/` tree, so it exists
  only in a local checkout — not on GitHub.)
- Text-expander prompts live under `prompts/` when present:
  `;absetup` for machine setup/audit, `;abcheck` for target-project readiness
  (gate + setup), `;abuse` for the browser-bay router (includes project gate),
  and `;abhealth` for periodic maintenance audits. These prompts are wrappers
  around the skill and scripts; they are not a second browser routing system.

## Command Names

Built-in commands exposed by this project:
- `axis-browser` — the command. Use this one; it is what the docs, the CLI's own help, and BrowserBay all refer to.
- `axib` — built-in shorthand
- `chrome-devtools-axi` — legacy alias, kept so scripts written against the upstream base tool keep working. Not documented elsewhere; prefer `axis-browser`.

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
The `axis-browser setup` report detects Windows Chrome and Edge installs (machine-wide under `Program Files`/`Program Files (x86)` and per-user under `LOCALAPPDATA`), plus Chromium (machine-wide under `Program Files (x86)`).

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
- Node.js `22.13+` for this CLI. Standalone BrowserBay (the router skill)
  still runs on Node 20 without Axis; only the Axis CLI needs the newer floor.
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

Axis Browser posts the lowest input tokens, cost, duration, and turn count of all 7 conditions, with 100% task success. (The benchmark measures the upstream `chrome-devtools-axi` base tool; Axis Browser is that same engine plus this fork's changes, so the numbers carry over.)

| Condition                            | Avg Input Tokens | Avg Cost/Task | Avg Duration | Avg Turns | Success  |
| ------------------------------------ | ---------------- | ------------- | ------------ | --------- | -------- |
| **Axis Browser** (upstream engine\*) | **79,141**       | **$0.074**    | **21.5s**    | **4.5**   | **100%** |
| dev-browser                          | 82,532           | $0.078        | 28.6s        | 4.9       | 99%      |
| agent-browser (Vercel)               | 93,074           | $0.088        | 24.6s        | 4.8       | 99%      |
| chrome-devtools-mcp + compressor CLI | 130,779          | $0.091        | 29.7s        | 7.6       | 100%     |
| chrome-devtools-mcp + ToolSearch     | 133,712          | $0.096        | 29.4s        | 7.5       | 99%      |
| chrome-devtools-mcp (raw MCP)        | 184,711          | $0.101        | 26.0s        | 6.2       | 99%      |
| chrome-devtools-mcp code execution   | 129,606          | $0.120        | 36.2s        | 6.4       | 100%     |

\* These are **inherited upstream results**, not an independent measurement of this fork: the
benchmark ran `chrome-devtools-axi`, the engine Axis Browser is built on. The numbers have not
been re-run against this fork, so treat them as an upstream reference point rather than a
measurement of what you will observe here.

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
help[2]:
  Run `axis-browser click @g1:1` to click the "More information..." link
  Use `axis-browser eval <expr>` for JS expressions. For multi-statement code, pass a function: `eval "() => { ...; return result }"`
```

Refs in snapshot output carry a `g<N>:` generation prefix that bumps every time a new accessibility tree is captured. Pass refs back exactly as printed — if the page re-rendered between snapshot and action, the action fails loudly with `STALE_REF` instead of silently no-op'ing, so the agent re-snapshots and retries.
Unrelated DOM churn alone does not stale a ref: the tag names the snapshot it came from, not the document's revision count. A capture taken while the page is still mutating is re-taken once, so the tree you receive is a settled one.
After a state-changing action, confirm the outcome with a fresh `snapshot`, `eval`, or `screenshot` before reporting success. A current ref can still produce no visible page change; `STALE_REF` only catches stale refs.

## Setup Axis Workflow

Run the bootstrap report from any project:

```bash
axis-browser setup
```

The default command is read-only. It checks Node, pnpm/Corepack,
Chrome/Chromium, the local build, global Axis aliases, and whether the optional
`browser-bay` workflow router is available. For machine-readable status:

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

- `BROWSER_BAY_DIR` (legacy alias: `BROWSER_SKILL_DIR`)
- `AXIS_BROWSER_HOME/skills/browser-bay` (legacy folder: `skills/browser-skill`)
- `AXIS_PORTABLE_SKILLS_DIR/browser-bay` (legacy folder name also accepted)
- standard agent skill locations (`browser-bay`, then legacy `browser-skill`)

If no router is configured, `axis-browser setup` still succeeds with core Axis
status and reports that the router source is not configured. Set
`BROWSER_BAY_SOURCE_URL` (legacy: `BROWSER_SKILL_SOURCE_URL`) if your
environment has an approved source URL for the router.

Agent hook setup remains explicit:

```bash
axis-browser setup hooks
```

## Persistent Login Quick Start

When a task needs a logged-in session, use `managed` mode. Axis launches and owns a Chrome
on a profile that survives between runs, so you sign in **once**:

```bash
export CHROME_DEVTOOLS_AXI_MODE=managed      # profile: ~/.axis-browser-data
axis-browser login https://example.com       # one-time, interactive, needs a terminal
axis-browser open https://example.com/app    # every later run is silent
```

`login` opens a visible browser, waits for you to sign in, verifies something landed, then
stops the bridge so the profile lock is released. It refuses to run non-interactively rather
than opening a browser nobody can see or close.

If a run is not authenticated, ask the tool instead of guessing:

```bash
axis-browser doctor --json
```

It reports the active mode, the profile in use and whether it is locked, bridge state, and a
`remedies` array of **syntactically runnable commands** — which is not the same as safe to
run unattended. Run the reversible ones (`unset …`) directly; confirm the destructive ones
(`axis-browser reap`, `axis-browser stop`, `rm <path>`) with a human first, and prefer
`axis-browser reap --dry-run` before the real thing. Only two conditions need a human
outright: `NEEDS_INTERACTIVE_LOGIN` and `PORT_HELD_BY_FOREIGN_PROCESS`.

Why stop the bridge before changing connection settings:
- the bridge is persistent and can outlive your shell session
- it captured the environment it was started with, so a stale bridge silently ignores new
  settings — `axis-browser stop` then re-running guarantees the current environment is used

> **Why there is no shared-`9222` quick start any more.** This section used to export
> `CHROME_DEVTOOLS_AXI_BROWSER_URL=http://127.0.0.1:9222`. Exporting that from a shell
> profile put *every* shell — including every agent's non-interactive shell — permanently
> into `attach` mode, and on a machine where another Chromium-based browser already held
> `9222`, every browser command failed with a diagnostic that named neither the mode nor the
> port holder. `axis-browser doctor` now names both in about two seconds. The full account
> is in [docs/shared-session-design.md](docs/shared-session-design.md).

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
`skills/browser-bay/` companion when present:

- `references/verified-run.md` defines a single-pass evidence workflow with
  `STEP_PASS`, `STEP_FAIL`, and `STEP_SKIP` validation.
- `references/reusable-workflow.md` defines the craft pattern for turning a
  working browser flow into a rerunnable local script.
- Webwright is documented there as a pattern source, not as a dependency or a
  replacement for Playwright.

## How It Works

The bridge keeps one persistent MCP session across CLI invocations. With no
shared URL (or a blank one), standalone mode uses the local stdio process chain
below. See [Configuration](#configuration) for the shared-service choices,
which need an MCP server you start and maintain yourself.

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

In URL-only shared mode — an advanced choice, not a default — the bridge speaks
Streamable HTTP to a server you run yourself instead of starting a local one:

```text
┌───────────────────────┐
│    Axis Browser       │  CLI — parse args, format output
└──────────┬────────────┘
           │ HTTP (localhost:9224)
           ▼
┌───────────────────────┐
│     Bridge Server     │  Persistent per-session MCP client
└──────────┬────────────┘
           │ Streamable HTTP
           ▼
┌───────────────────────┐
│  Shared MCP service   │  One remote MCP process + Chrome
└───────────────────────┘
```

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

### Diagnostics And Session

| Command                    | Description                                                                    |
| -------------------------- | ------------------------------------------------------------------------------ |
| `doctor`                   | Preflight report: mode, endpoint, browser, profile, bridges, blockers, remedies |
| `doctor --json`            | The same report as JSON — the contract agents should key on                     |
| `login <url>`              | One-time interactive sign-in on the managed profile (requires a terminal)       |
| `reap`                     | Kill orphaned bridges (claimed by no session, older than 4h)                    |
| `reap --dry-run`           | Report what would be reaped without killing anything                            |
| `reap --min-age-hours <n>` | Override the age floor                                                          |

Run `doctor --json` **before** a browser task. Every entry in its `remedies` array is a
command you can execute verbatim; escalate to a human only for `NEEDS_INTERACTIVE_LOGIN` or
`PORT_HELD_BY_FOREIGN_PROCESS`. **Local CDP has no authentication — never request
credentials, tokens, or a `ws://` URL to reach it.**

Orphaned bridges are also reaped automatically when a new bridge starts: only processes
carrying our own bridge marker, claimed by no session, and at least four hours old. Set
`CHROME_DEVTOOLS_AXI_AUTO_REAP=0` to disable. If a session PID file is unreadable, automatic
reaping is suppressed entirely (an unparseable claim is not an absent one) and `doctor`
reports it.

### Maintenance

| Command          | Description                                            |
| ---------------- | ------------------------------------------------------ |
| `update`         | Show GitHub update guidance for this fork              |
| `update --check` | Show GitHub update guidance without contacting npm     |

Running with no command shows the CLI home view. It prepends `bin` and `description` metadata, then includes the current snapshot when a browser session is active or the no-session status/help block when one is not.

### Flags

`--help`, `-v`, `-V`, and `--version` are top-level options. All other flags
are command-specific; the CLI rejects a flag that is not listed by
`chrome-devtools-axi <command> --help`.

| Flag                        | Description                                 |
| --------------------------- | ------------------------------------------- |
| `--help`                    | Show usage information                      |
| `-v`, `-V`, `--version`     | Show the installed CLI version              |
| `--check`                   | Show GitHub update guidance (update)        |
| `--full`                    | Show complete output without truncation (open, snapshot, click, fill, type, press, scroll, back, eval, hover, drag, fillform, upload, newpage, selectpage) |
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

`--full` is accepted only by the commands listed above; other commands strip it
and ignore it silently. Note that `console` and `network` always truncate at
2000 characters and have no full-output option — use `--limit` and `--page` to
page through more, or `--response-file`/`--request-file` on `network-get` to
capture a body in full.

Local output paths for `screenshot`, `heap`, `network-get --response-file`/`--request-file`, `lighthouse --output-dir`, and `perf-start`/`perf-stop --file` resolve against the directory where you invoke the CLI.
Saved-path output uses the resolved absolute path.

`console --type` accepts `log`, `debug`, `info`, `error`, `warn`, `dir`, `dirxml`, `table`, `trace`, `clear`, `startGroup`, `startGroupCollapsed`, `endGroup`, `assert`, `profile`, `profileEnd`, `count`, `timeEnd`, `verbose`, `issue`, and `all`.
`network --type` accepts `document`, `stylesheet`, `image`, `media`, `font`, `script`, `texttrack`, `xhr`, `fetch`, `prefetch`, `eventsource`, `websocket`, `manifest`, `signedexchange`, `ping`, `cspviolationreport`, `preflight`, `fedcm`, `other`, and `all`.
For both commands, `all` or an omitted `--type` returns every item.

## Configuration

### Connection Modes

There are four, and you can now name the one you want instead of having it inferred:

| Mode | Browser | Profile | Use it when |
| --- | --- | --- | --- |
| `ephemeral` | Axis launches it | throwaway (`--isolated`) | the default; nothing to remember between runs |
| `managed` | Axis launches it | persistent, Axis-owned | the task needs a logged-in session |
| `attach` | someone else's | theirs | you deliberately want a browser Axis did not start |
| `autoconnect` | your running Chrome | your real profile | Chrome 144+ `chrome://inspect` debugging |

```bash
export CHROME_DEVTOOLS_AXI_MODE=managed
```

**Explicit beats inferred.** With `CHROME_DEVTOOLS_AXI_MODE` unset, the historical inference
still applies unchanged — `AUTO_CONNECT` → `BROWSER_URL` → `USER_DATA_DIR` → `ephemeral` — so
existing setups behave exactly as before. Setting the variable overrides all of it, and a
mode that cannot be satisfied (`attach` with no `BROWSER_URL`) fails immediately with the fix,
rather than ~30s later inside `chrome-devtools-mcp` with a diagnostic that names neither the
mode nor the cause.

`attach` and `autoconnect` point at a browser Axis does not own: it cannot relaunch it, fix
its flags, or reap it, and `--executablePath` / keychain isolation / `--chrome-arg` do not
apply. Prefer `managed`.

#### Profiles are per session

`managed` resolves `CHROME_DEVTOOLS_AXI_USER_DATA_DIR` (default `~/.axis-browser-data`) for
the **default** session, and `<dir>/sessions/<name>` for any *named*
`CHROME_DEVTOOLS_AXI_SESSION`. Chrome locks a profile to one process, so two concurrent named
sessions sharing one directory would not merely interfere — the second fails to launch.

Two consequences worth knowing before they surprise you:
- A **named** session starts logged out even if the default profile is signed in. `doctor`
  reports this as `NEEDS_INTERACTIVE_LOGIN` rather than failing opaquely.
- A `user-data-dir` that resolves inside a **real** browser profile (yours, Chrome's default,
  Edge, Brave, Ulaa) is **refused**. Chrome accepts `--remote-debugging-port` on a default
  profile and then silently never binds it, and an automation run would fight your own browser
  for the profile lock. Symlinks are dereferenced before the check.

### Environment Variables

| Variable | Purpose |
| --- | --- |
| `CHROME_DEVTOOLS_AXI_MODE` | `ephemeral` \| `managed` \| `attach` \| `autoconnect`. Overrides inference |
| `CHROME_DEVTOOLS_AXI_EXECUTABLE_PATH` | Absolute path to the Chrome/Chromium binary to launch. Launch modes only |
| `CHROME_DEVTOOLS_AXI_AUTO_REAP` | Set to `0` to disable automatic cleanup of orphaned bridges on bridge startup |
| `CHROME_DEVTOOLS_AXI_AUTO_CONNECT` | Set to `1` to attach to the user's running Chrome through Chrome 144+ auto-connect |
| `CHROME_DEVTOOLS_AXI_BROWSER_URL` | Connect to an existing Chrome instance instead of launching one |
| `CHROME_DEVTOOLS_AXI_WS_HEADERS` | JSON headers for authenticated `ws://` / `wss://` browser endpoints |
| `CHROME_DEVTOOLS_AXI_USER_DATA_DIR` | Use a persistent Chrome profile instead of `--isolated` |
| `CHROME_DEVTOOLS_AXI_HEADED` | Set to `1` to run the managed browser in headed mode |
| `CHROME_DEVTOOLS_AXI_CHROME_ARGS` | Whitespace-separated Chrome flags forwarded to the browser |
| `CHROME_DEVTOOLS_AXI_PORT` | Override the bridge port (default: `9224`) |
| `CHROME_DEVTOOLS_AXI_MCP_PATH` | Absolute path to a local `chrome-devtools-mcp` binary (skips npx) |
| `CHROME_DEVTOOLS_AXI_BRIDGE_TIMEOUT_MS` | Bridge readiness deadline in ms (default: `30000`; useful for slow npx bootstrap) |
| `BROWSER_BAY_DIR` | Absolute path to a local `browser-bay` checkout. Highest setup resolver priority |
| `AXIS_BROWSER_HOME` | Axis Browser checkout root; setup looks for `skills/browser-bay` below it |
| `AXIS_PORTABLE_SKILLS_DIR` | Directory containing portable skills; setup looks for `browser-bay` below it |
| `BROWSER_BAY_SOURCE_URL` | Approved source URL shown when no local router is configured; no public router URL is assumed |

Examples:

```bash
export CHROME_DEVTOOLS_AXI_MODE=managed
export CHROME_DEVTOOLS_AXI_PORT=9225
export CHROME_DEVTOOLS_AXI_HEADED=1
export CHROME_DEVTOOLS_AXI_CHROME_ARGS="--enable-gpu --ignore-gpu-blocklist"
export CHROME_DEVTOOLS_AXI_EXECUTABLE_PATH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
```

Set these **per command or per project**, not in a shell profile. A globally exported
connection variable applies to every shell on the machine — including the non-interactive
shells agents run in, where nobody sees it and nothing reports it.

### Shared MCP service (advanced, bring your own server)

To share one long-lived Chrome DevTools MCP service across Axis sessions on the
same host, set `CHROME_DEVTOOLS_AXI_MCP_SERVER_URL` to the service's Streamable
HTTP endpoint. The combination with `CHROME_DEVTOOLS_AXI_MCP_PATH` selects how
Axis reaches it:

1. **Direct:** the shared URL is nonblank and `CHROME_DEVTOOLS_AXI_MCP_PATH` is
   absent or blank. The bridge constructs a `StreamableHTTPClientTransport`
   directly, starts no local MCP child, and validates that the URL is an absolute
   `http://` or `https://` endpoint. The shared service must already be running
   and reachable. Each bridge still gets its own remote MCP session and
   selected-page state.
2. **Stdio proxy:** the shared URL and `CHROME_DEVTOOLS_AXI_MCP_PATH` are both
   nonblank. Axis checks that executable's `--help` for `--serverUrl`, then starts
   it with only `--server-url=<URL>` — one proxy child per named bridge.

**Neither mode works with the official `chrome-devtools-mcp` build this fork pins.**
Verified against `chrome-devtools-mcp@1.9.0`: its CLI exposes no `--http-port` and
no `--server-url`/`--serverUrl`, so a shared endpoint requires a server build that
adds them (for example the proxy mode proposed in
[ChromeDevTools/chrome-devtools-mcp#2733](https://github.com/ChromeDevTools/chrome-devtools-mcp/pull/2733)).
Treat this as an opt-in integration you operate, not as a supported default — and
note that a remote server redacts nothing on your behalf: `--redactNetworkHeaders`
applies to the local child Axis starts, so a shared service must redact for itself.

If `CHROME_DEVTOOLS_AXI_MCP_SERVER_URL` is absent or blank, Axis keeps its
standalone stdio behavior and launches or attaches Chrome according to the local
settings below. A nonblank `CHROME_DEVTOOLS_AXI_MCP_PATH` without a shared URL is
still local stdio mode.

`CHROME_DEVTOOLS_AXI_MCP_SERVER_URL` takes precedence over the local Chrome launch
and attach settings. Run any shared service on the same host and filesystem as
Axis, and keep its endpoint loopback-only, so saved artifact paths refer to the
same local files.

Stop the bridges for those session names before switching between these
configurations: a running bridge retains the transport settings it started with.
`CHROME_DEVTOOLS_AXI_SESSION=<name> axis-browser stop` stops that session's bridge
and any Axis-owned proxy child; the shared service's lifecycle stays yours.

Connect to an existing Chrome instance instead of launching one:

`CHROME_DEVTOOLS_AXI_BROWSER_URL` (attach mode) accepts both HTTP(S) and WebSocket endpoints:
- `http(s)://` uses `--browserUrl` and discovers the WebSocket URL via `/json/version`
- `ws(s)://` uses `--wsEndpoint` directly

Authenticated WebSocket example:

```bash
export CHROME_DEVTOOLS_AXI_BROWSER_URL=wss://cluster.example/launch
export CHROME_DEVTOOLS_AXI_WS_HEADERS='{"Authorization":"Bearer token"}'
```

Pick which installed Chrome release channel to target with
`CHROME_DEVTOOLS_AXI_CHANNEL` — `stable` (the default), `beta`, `canary`, or
`dev`:

```bash
export CHROME_DEVTOOLS_AXI_AUTO_CONNECT=1
export CHROME_DEVTOOLS_AXI_CHANNEL=beta
```

This selects which Chrome `--autoConnect` attaches to, and which one is launched in
`ephemeral` and `managed` modes. It is ignored **only in `attach` mode**, which connects to
an explicit endpoint regardless of channel.

Note the precedence: `CHROME_DEVTOOLS_AXI_AUTO_CONNECT` outranks
`CHROME_DEVTOOLS_AXI_BROWSER_URL`, so with both set the mode is `autoconnect` and the channel
**still applies**. Only a resolved mode of `attach` drops it.

Chrome 144+ auto-connect example:

```bash
export CHROME_DEVTOOLS_AXI_AUTO_CONNECT=1
```

When auto-connect is enabled, it takes precedence over
`CHROME_DEVTOOLS_AXI_BROWSER_URL` and `CHROME_DEVTOOLS_AXI_USER_DATA_DIR`.

### Keychain isolation

When Axis Browser launches Chrome itself — the default `--isolated` mode and
`CHROME_DEVTOOLS_AXI_USER_DATA_DIR` — it always passes `--use-mock-keychain` and
`--password-store=basic`. An automation browser has no business reading, writing,
or offering to reset your OS password store, so it is kept off it entirely.
Password autofill and saved-password access are therefore intentionally
unavailable inside browsers this tool launches. On macOS this also means the
browser can never raise the system "Keychain Not Found … Reset To Defaults"
panel, which Chrome triggers when it tries to store its `Chrome Safe Storage` key
and no default keychain can be resolved for the process.

Your own externally launched Chrome is unaffected: its saved passwords remain
available and untouched, because this tool does not read, write, move, or reset
the login keychain or its `Chrome Safe Storage` item. The isolation flags apply
only to browsers this tool starts, and are deliberately not sent in the
`CHROME_DEVTOOLS_AXI_AUTO_CONNECT`, `CHROME_DEVTOOLS_AXI_BROWSER_URL`, and
`wsEndpoint` modes, where the browser belongs to whoever launched it.
A shared MCP service is externally launched the same way: its operator owns
Chrome's keychain policy.

Run multiple isolated bridges at once with `CHROME_DEVTOOLS_AXI_SESSION` — one
per agent session, worktree, or test worker:

```bash
CHROME_DEVTOOLS_AXI_SESSION=worker-1 axis-browser open https://example.com
CHROME_DEVTOOLS_AXI_SESSION=worker-2 axis-browser open https://example.org
```

Each session name gets its own bridge process, port (auto-derived from the name,
or pinned with `CHROME_DEVTOOLS_AXI_PORT`), and on-disk state under
`~/.axis-browser/` (named sessions nest under `sessions/<name>/`).
A session name does not choose a connection mode or a profile: for a locally
launched persistent browser, give each session its own
`CHROME_DEVTOOLS_AXI_USER_DATA_DIR`.

In the default isolated and `CHROME_DEVTOOLS_AXI_USER_DATA_DIR` launch modes each
bridge also launches its own Chrome, so concurrent sessions share neither browser
state nor each other's stale-ref tracking. Sessions that attach to the same
external browser (shared CDP / auto-connect on one Chrome) are isolated only at
the bridge level.

Do not export `CHROME_DEVTOOLS_AXI_PORT` globally when running concurrent
sessions: it overrides the per-session derived port and forces every session onto
the same port. Rely on per-session default ports, or set
`CHROME_DEVTOOLS_AXI_PORT` only inline per command.

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

## Security

### The bridge is unauthenticated by design, and guarded against DNS rebinding

The bridge is a persistent loopback HTTP service on a known port, and it has no
authentication — anything that can reach it gets full control of the browser through CDP.
Binding to `127.0.0.1` does **not** protect it: in a DNS-rebinding attack a malicious page
re-points its own domain at `127.0.0.1`, and the victim's browser then issues same-origin
requests that arrive on loopback like any other.

The one thing a rebound request cannot hide is that it carries the attacker's domain in its
`Host` (and `Origin`) header, and page JavaScript cannot forge either. Every request to
`/health`, `/tools`, and `/call` is therefore rejected with `403 {"error":"Forbidden host"}`
unless both headers name loopback. This addresses **GHSA-x439-jhfh-v9x2** in the upstream
project.

```bash
curl -H 'Host: evil.attacker.com' http://127.0.0.1:9224/health
# {"error":"Forbidden host"}
```

### Local CDP has no authentication — do not go looking for credentials

If a connection to a local DevTools endpoint fails, the cause is never a missing token. An
agent that reads a bare connection failure and concludes the endpoint needs credentials will
escalate to a human for something no human can supply. `axis-browser doctor` states this
explicitly in its output for exactly that reason.

### Automation browsers never touch your profile or your keychain

- A `user-data-dir` resolving inside a real browser profile (yours, Chrome's default, Edge,
  Brave, Ulaa) is **refused**, symlinks dereferenced first.
- Every browser Axis launches gets `--use-mock-keychain` and `--password-store=basic`, so an
  automation run cannot reach — or offer to reset — your login keychain.
- Neither applies in `attach`/`autoconnect`: that browser belongs to whoever started it, and
  its policy is theirs to set.

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
