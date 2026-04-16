# Axis Browser and Playwright for Vibe Coding

This guide explains how to use:

- `Axis Browser` (`axis-browser`, with `axib` and `chrome-devtools-axi` compatibility commands)
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
- Playwright CLI for executable end-to-end checks
- `agent-browser` only when a task is primarily visual and Axis Browser plus Playwright are not the easiest fit

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

### 2. Playwright CLI: Execution Tool

Use Playwright CLI when you want:
- a repeatable script
- end-to-end verification
- navigation assertions
- flow regression checks
- a second opinion separate from `Axis Browser`

Do not default to a Playwright MCP if a normal CLI script is enough.

### 3. Agent Browser: Optional Visual Fallback

Use `agent-browser` only when:
- the task is mainly visual
- a quick screenshot is easier than driving the shared browser
- you want a one-off layout or typography sanity check

Do not use it as the default logic debugger or first-choice interaction tool if `Axis Browser` is available.

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

Install the fork directly from GitHub:

```bash
bun add -g github:Nirmantix/axis-browser
```

or:

```bash
npm install -g github:Nirmantix/axis-browser
```

That install exposes these commands:
- primary command: `axis-browser`
- shorthand compatibility command: `axib`
- upstream compatibility command: `chrome-devtools-axi`

Important:
- `bun add -g chrome-devtools-axi` installs the upstream npm package, not this fork
- `npx -y chrome-devtools-axi` also resolves the upstream npm package
- the package name remains `chrome-devtools-axi` for compatibility, but the recommended install path for Axis Browser is the GitHub repo

If you are replacing an older upstream global install:

```bash
bun remove -g chrome-devtools-axi
bun add -g github:Nirmantix/axis-browser
```

or:

```bash
npm uninstall -g chrome-devtools-axi
npm install -g github:Nirmantix/axis-browser
```

Optional shorter daily alias:

```bash
alias axis='axis-browser'
```

For local-checkout install details, see:
- [../README.md](../README.md)

### Agent Browser (Optional)

Install globally only if you want the visual fallback available across projects:

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

If you want a shorter branded shell command, add:

```bash
alias axis='axis-browser'
```

The examples below prefer `axis` as the recommended daily shorthand. If you do not
define that alias, use `axis-browser` instead.

## Important Truth: `axis-init` Is Not A Built-In Command

Commands like:
- `axis-init`
- `axis-human`
- `axisb-init`
- `axisb-human`
- `axi-start`

are not built into `Axis Browser`.

They are user-defined shell aliases or helper functions.

That means:
- you can create them if they help your workflow
- you should document them as local shell helpers, not as product features

## Important Warning: `axis-init` Kills Browser Instances

Most `axis-init` helper functions are intentionally destructive.

They usually:
- kill running instances of the browser binary you chose for automation
- relaunch that browser with remote debugging on `9222`
- reuse the same persistent browser profile directory

That is convenient, but it also means `axis-init` is the wrong tool if that browser is
also your main day-to-day browser with unrelated tabs open.

## Recommended Browser Strategy

Use a dedicated Chromium-based browser for Axis Browser automation.

Good pattern:
- keep your normal daily browser separate
- use a second Chromium browser or a dedicated automation profile for `axis-init`

Examples:
- if Chrome is your normal browser, use Ulaa, Edge, Brave, or Chromium for Axis Browser
- if Ulaa is your normal browser, use Chrome for Axis Browser

The goal is simple:
- `axis-init` can safely kill and relaunch the automation browser
- your real daily browsing session is not disrupted

## Example Shared Chrome Setup

### macOS Example: Start Chrome With Remote Debugging

```bash
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --remote-debugging-port=9222 \
  --user-data-dir="$HOME/.axis-browser-data" \
  --no-first-run \
  --no-default-browser-check
```

That creates an isolated browser data directory and exposes Chrome DevTools on `9222`.

### Alternative: Use A Secondary Chromium Browser

If Chrome is your daily browser, point your automation workflow at another Chromium
browser instead.

Example using Ulaa:

```bash
"/Applications/Ulaa.app/Contents/MacOS/Ulaa" \
  --remote-debugging-port=9222 \
  --user-data-dir="$HOME/.axis-browser-data" \
  --no-first-run
```

The same idea applies in reverse:
- if Ulaa is your daily browser, use Chrome for Axis Browser automation
- if Brave is your daily browser, use Chrome or Chromium for automation

### Alternative: Reuse An Existing Secondary Browser Profile

If you already keep a separate Chromium "Work" profile, you can launch that profile
with remote debugging instead of using a brand-new `--user-data-dir`.

Example using a Ulaa profile:

```bash
"/Applications/Ulaa.app/Contents/MacOS/Ulaa" \
  --remote-debugging-port=9222 \
  --profile-directory="Default Work"
```

To find the correct internal profile name:
- open the browser in that profile
- visit `chrome://version` or the browser-specific equivalent such as `ulaa://version`
- copy the last segment from the reported Profile Path

This pattern is useful when:
- you want persistent cookies from a dedicated automation profile
- you do not want Axis Browser automation mixed into your main personal browser profile
- you are already using a non-default Chromium browser just for automation work

### Optional Shell Helper

If you want a convenience helper in your shell profile:

```bash
axis-init() {
  killall "Google Chrome" >/dev/null 2>&1 || true
  pkill -9 -i "Google Chrome" >/dev/null 2>&1 || true
  pkill -f "chrome-devtools-mcp" >/dev/null 2>&1 || true
  mkdir -p "$HOME/.axis-browser-data"

  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
    --remote-debugging-port=9222 \
    --user-data-dir="$HOME/.axis-browser-data" \
    --no-first-run \
    --no-default-browser-check >/dev/null 2>&1 &

  export CHROME_DEVTOOLS_AXI_BROWSER_URL=http://127.0.0.1:9222
}
```

Warning:
- this helper kills running instances of `Google Chrome` before relaunching
- only use this pattern with a dedicated automation browser or profile
- if you want the same pattern with Ulaa or another Chromium browser, swap the binary path and process name accordingly

Then:

```bash
axis-init
axis stop
axis pages
```

Why `axis stop`:
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
axis-human() {
  mkdir -p "$HOME/.axis-browser-data"
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
    --user-data-dir="$HOME/.axis-browser-data" \
    --no-first-run
}
```

Again: this is a local helper, not a built-in `Axis Browser` command.

## Daily Workflow

1. start your local dev server
2. launch or reuse the shared automation browser session on `9222`
3. log in manually if needed
4. use `Axis Browser` to inspect the current state
5. use Playwright CLI to verify flows after code changes
6. use `agent-browser` only if a quick visual-only check is easier than using Axis Browser and Playwright

## Axis Browser Workflow

Start with:

```bash
export CHROME_DEVTOOLS_AXI_BROWSER_URL=http://127.0.0.1:9222
axis stop
axis pages
axis snapshot
```

Useful commands:

```bash
axis open http://localhost:3000
axis snapshot
axis console
axis network
axis network-get 42
axis click @12
axis fill @18 hello@example.com
axis eval "document.title"
axis wait 2000
```

## Raw CDP Cross-Check

If tab discovery feels wrong, cross-check the browser directly:

```bash
curl -s http://127.0.0.1:9222/json/list
```

If raw CDP shows tabs that `axis pages` does not:

```bash
axis stop
axis pages
```

That is the correct recovery path.

## Debugging Protocol

When a browser-based feature is broken:

1. reproduce it with `Axis Browser`
2. run `axis console`
3. run `axis network`
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

## Agent Browser Workflow (Optional Fallback)

Use `agent-browser` when the question is mainly visual:
- is the page layout broken
- is spacing wrong
- is the font rendering correctly
- is the UI aesthetically correct

Do not use it as the default choice for data or state debugging.

## Suggested Tool Selection Rule

A simple heuristic:

- if the problem is logic, state, or network: use `Axis Browser`
- if the problem is regression-proof execution: use Playwright CLI
- if the problem is purely visual and the other two are overkill: use `agent-browser`

## Safe Prompting Conventions

Good shorthand for agents:

- "axis to http://localhost:3000"
- "axis snapshot"
- "axis console"
- "axis network"
- "write a Playwright CLI script and run it against the shared browser on 9222"
- "use agent-browser only if a visual check is easier than Axis Browser and Playwright"

Avoid vague prompts like:
- "debug the UI somehow"
- "use whatever browser tool you want"

Clear tool intent saves time and tokens.

## Troubleshooting

### Bridge Feels Stale

```bash
axis stop
axis pages
```

### Tabs Do Not Match What You See

```bash
curl -s http://127.0.0.1:9222/json/list
axis stop
axis pages
```

### Shared Login State Is Missing

- check that the browser was launched with the intended `--user-data-dir`
- make sure you reused the same profile folder between manual login and automated usage
- for SSO flows, log in manually first and relaunch with debugging enabled

### Basic Auth Keeps Prompting

- close all tabs for that origin
- retry in a fresh incognito window
- retry with a fresh `axis` bridge
- use an isolated Playwright check to confirm the server accepts the credentials

## Final Recommendation

If you want one default habit:

- use `Axis Browser` as the daily driver
- use Playwright CLI as the execution layer
- keep `agent-browser` as an optional visual specialist, not a required part of the workflow

That combination is usually the most efficient balance of:
- speed
- token cost
- reproducibility
- practicality
