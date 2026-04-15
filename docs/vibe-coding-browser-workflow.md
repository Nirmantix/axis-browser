# Axis Browser, Agent Browser, and Playwright for Vibe Coding

This guide explains how to use:

- `Axis Browser` (`axis-browser`, with `axib` and `chrome-devtools-axi` compatibility commands)
- `agent-browser`
- Playwright CLI

together in a practical, token-efficient workflow for day-to-day product development.

This document is intentionally public-safe:
- no personal account details
- no private filesystem paths
- no private browser profile names
- no machine-specific secrets

## The Core Idea

Use the right tool for the right job:

- `Axis Browser` for most logic and state debugging
- `agent-browser` for visual verification and screenshots
- Playwright CLI for executable end-to-end checks

That split saves tokens and reduces agent confusion.

## Recommended Tool Roles

### 1. Axis Browser: Primary Logic and State Tool

Use `Axis Browser` for:
- page structure inspection
- form interaction
- console inspection
- network inspection
- reproducing broken UI states
- verifying app state changes after actions

Why:
- it uses the accessibility tree instead of dumping raw DOM
- it is much lighter on tokens than many browser MCPs
- it is usually the fastest way to understand what the page is doing

Use it first for most debugging sessions.

### 2. Agent Browser: Secondary Visual Tool

Use `agent-browser` for:
- visual QA
- screenshot-based inspection
- layout checks
- style and aesthetic verification

Do not use it as the default logic debugger if `Axis Browser` is available.

### 3. Playwright CLI: Execution Tool

Use Playwright CLI when you want:
- a repeatable script
- end-to-end verification
- navigation assertions
- flow regression checks
- a second opinion separate from `Axis Browser`

Do not default to a Playwright MCP if a normal CLI script is enough.

## Why This Split Saves Tokens

The expensive pattern is using a browser MCP for every step:
- navigate
- inspect DOM
- click
- inspect DOM again
- scroll
- inspect DOM again

That creates repeated roundtrips and large payloads.

A cheaper pattern is:

1. use `Axis Browser` to understand the current state
2. fix the code
3. use Playwright CLI to verify the fixed flow

That keeps the browser-reading phase cheap and the execution phase scriptable.

## Installation

### Axis Browser

The upstream-compatible package name remains:
- package: `chrome-devtools-axi`

The installed commands are:
- primary command: `axis-browser`
- shorthand compatibility command: `axib`
- upstream compatibility command: `chrome-devtools-axi`

You can use the fork directly from source or point your active global binary at the local build.

See:
- [axis-browser-fork-guide.md](axis-browser-fork-guide.md)

### Agent Browser

Install globally if you want it available across projects:

```bash
bun add -g agent-browser
```

### Playwright CLI

Install globally if you want reusable CLI access:

```bash
bun add -g playwright
playwright install
```

If you prefer project-local installs, add Playwright to each repo instead.

## Shared Browser Workflow

The most useful pattern is a shared Chrome instance on port `9222`.

That gives you:
- one browser window you can log into manually
- persistent cookies
- a shared session that `Axis Browser` and Playwright can both reuse

The baseline environment variable is:

```bash
export CHROME_DEVTOOLS_AXI_BROWSER_URL=http://127.0.0.1:9222
```

## Important Truth: `axisb-init` Is Not A Built-In Command

Commands like:
- `axisb-init`
- `axisb-human`
- `axi-start`

are not built into `Axis Browser`.

They are user-defined shell aliases or helper functions.

That means:
- you can create them if they help your workflow
- you should document them as local shell helpers, not as product features

## Example Shared Chrome Setup

### macOS Example: Start Chrome With Remote Debugging

```bash
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --remote-debugging-port=9222 \
  --user-data-dir="$HOME/.chrome-axi-data" \
  --no-first-run \
  --no-default-browser-check
```

That creates an isolated browser data directory and exposes Chrome DevTools on `9222`.

### Optional Shell Helper

If you want a convenience helper in your shell profile:

```bash
axi_init() {
  pkill -f "chrome-devtools-mcp" >/dev/null 2>&1 || true
  mkdir -p "$HOME/.chrome-axi-data"

  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
    --remote-debugging-port=9222 \
    --user-data-dir="$HOME/.chrome-axi-data" \
    --no-first-run \
    --no-default-browser-check >/dev/null 2>&1 &

  export CHROME_DEVTOOLS_AXI_BROWSER_URL=http://127.0.0.1:9222
}
```

Then:

```bash
axi_init
axis-browser stop
axis-browser pages
```

Why `axis-browser stop`:
- the bridge is persistent
- if it was started under a different target config, you want a clean restart

## Authentication Workflow

### Standard Username/Password Or Magic-Link Flows

1. launch the shared Chrome session
2. open the app manually once
3. log in manually
4. keep the browser profile for later automated work

That is enough for most local development apps.

### Google SSO Or Other Sensitive SSO Providers

Some providers dislike browsers launched with debugging flags.

A safe pattern is:

1. launch the same user-data-dir without remote debugging
2. log in manually
3. fully quit the browser
4. relaunch the same user-data-dir with `--remote-debugging-port=9222`

The shared browser profile keeps the session cookies.

### Example Human-Login Helper

```bash
axisb_human() {
  mkdir -p "$HOME/.chrome-axi-data"
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
    --user-data-dir="$HOME/.chrome-axi-data" \
    --no-first-run
}
```

Again: this is a local helper, not a built-in `Axis Browser` command.

## Daily Workflow

1. start your local dev server
2. launch or reuse the shared Chrome session on `9222`
3. log in manually if needed
4. use `Axis Browser` to inspect the current state
5. use Playwright CLI to verify flows after code changes
6. use `agent-browser` only for visual or aesthetic checks

## Axis Browser Workflow

Start with:

```bash
export CHROME_DEVTOOLS_AXI_BROWSER_URL=http://127.0.0.1:9222
axis-browser stop
axis-browser pages
axis-browser snapshot
```

Useful commands:

```bash
axis-browser open http://localhost:3000
axis-browser snapshot
axis-browser console
axis-browser network
axis-browser network-get 42
axis-browser click @12
axis-browser fill @18 hello@example.com
axis-browser eval "document.title"
axis-browser wait 2000
```

## Raw CDP Cross-Check

If tab discovery feels wrong, cross-check the browser directly:

```bash
curl -s http://127.0.0.1:9222/json/list
```

If raw CDP shows tabs that `axis-browser pages` does not:

```bash
axis-browser stop
axis-browser pages
```

That is the correct recovery path.

## Debugging Protocol

When a browser-based feature is broken:

1. reproduce it with `Axis Browser`
2. run `axis-browser console`
3. run `axis-browser network`
4. inspect the failing request or exception
5. only then change code

Do not guess first.

## Example Prompt Pattern For Agents

```text
Target URL: http://localhost:3000/dashboard
Issue: The "Retry Install" button fails silently.

Use Axis Browser to:
1. open the page
2. snapshot the DOM
3. reproduce the issue
4. capture console and network output
5. report the actual failure before proposing code changes
```

## Playwright CLI Workflow

Use Playwright when you want a reusable test or scripted verification.

### Shared-Session Playwright Pattern

```ts
import { chromium } from "playwright";

(async () => {
  const browser = await chromium.connectOverCDP("http://localhost:9222");
  const contexts = browser.contexts();
  const pages = contexts.flatMap((context) => context.pages());

  let page = pages.find((p) => /localhost:3000/.test(p.url()));
  if (!page) {
    page = pages[0];
  }

  // do work

  await browser.disconnect();
})();
```

Rules:
- do not assume `pages()[0]` is the right tab in multi-tab sessions
- do not call `browser.close()` if you attached to the shared browser
- use `disconnect()` instead

## When To Use Isolated Playwright Instead

Use an isolated Playwright run when:
- you want a second opinion independent of the shared session
- you want clean browser state
- you want a one-off screenshot or verification check

Do not confuse that with the shared user session.

## Agent Browser Workflow

Use `agent-browser` when the question is mainly visual:
- is the page layout broken
- is spacing wrong
- is the font rendering correctly
- is the UI aesthetically correct

Do not use it as the default choice for data or state debugging.

## Suggested Tool Selection Rule

A simple heuristic:

- if the problem is logic, state, or network: use `Axis Browser`
- if the problem is layout, aesthetics, or screenshots: use `agent-browser`
- if the problem is regression-proof execution: use Playwright CLI

## Safe Prompting Conventions

Good shorthand for agents:

- "axis-browser to http://localhost:3000"
- "axis-browser snapshot"
- "axis-browser console"
- "axis-browser network"
- "write a Playwright CLI script and run it against the shared browser on 9222"
- "use agent-browser for a visual check only"

Avoid vague prompts like:
- "debug the UI somehow"
- "use whatever browser tool you want"

Clear tool intent saves time and tokens.

## Troubleshooting

### Bridge Feels Stale

```bash
axis-browser stop
axis-browser pages
```

### Tabs Do Not Match What You See

```bash
curl -s http://127.0.0.1:9222/json/list
axis-browser stop
axis-browser pages
```

### Shared Login State Is Missing

- check that the browser was launched with the intended `--user-data-dir`
- make sure you reused the same profile folder between manual login and automated usage
- for SSO flows, log in manually first and relaunch with debugging enabled

### Basic Auth Keeps Prompting

- close all tabs for that origin
- retry in a fresh incognito window
- retry with a fresh `axis-browser` bridge
- use an isolated Playwright check to confirm the server accepts the credentials

## Final Recommendation

If you want one default habit:

- use `Axis Browser` as the daily driver
- use Playwright CLI as the execution layer
- keep `agent-browser` as a visual specialist

That combination is usually the most efficient balance of:
- speed
- token cost
- reproducibility
- practicality
