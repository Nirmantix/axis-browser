# Shared Chrome Workflow and Tool Selection

This guide explains the recommended operating model for Axis Browser in day-to-day product work.

## Scope

This file is the workflow guide, not the product reference.

Source of truth split:
- `README.md` — install, commands, environment variables, runtime behavior, development
- `docs/vibe-coding-browser-workflow.md` — tool selection, shared-`9222` workflow, Playwright handoff, and troubleshooting habits

If an old note, prompt, or helper snippet disagrees with this guide or the README, prefer those two repo docs.

## The Core Idea

Use the right tool for the right job:
- `Axis Browser` for state, logic, console, network, and lightweight interaction
- Playwright CLI for scripted verification and repeatable end-to-end checks
- `agent-browser` only for mainly visual checks

That split is faster, cheaper on tokens, and less ambiguous than using one heavy browser tool for everything.

## Tool Roles

### 1. Axis Browser — Primary Diagnostic Tool

Use Axis Browser first for:
- page structure inspection
- form interaction
- console inspection
- network inspection
- reproducing broken UI states
- verifying app state after an action

Why:
- it uses the accessibility tree instead of dumping the full DOM
- it is much lighter on tokens than many browser MCP stacks
- it is usually the fastest way to learn what the page is actually doing

### 2. Playwright CLI — Execution Tool

Use Playwright CLI when you want:
- a reusable script
- a repeatable end-to-end flow
- a regression check
- an independent second opinion

Do not default to a Playwright MCP if a normal CLI script is enough.

### 3. agent-browser — Optional Visual Fallback

Use `agent-browser` only when:
- the question is mainly visual
- a screenshot is easier than driving the shared browser
- you want a quick layout, spacing, or typography sanity check

Do not use it as the default logic debugger.

## Shared Chrome Baseline

The most useful setup is a shared Chrome instance on port `9222`.

That gives you:
- one browser window you can log into manually
- persistent cookies
- a shared session that Axis Browser and Playwright can both reuse

Baseline environment:

```bash
export CHROME_DEVTOOLS_AXI_BROWSER_URL=http://127.0.0.1:9222
```

Built-in commands you can use:
- `axis-browser`
- `axib`
- `chrome-devtools-axi`

This guide uses `axis-browser` in examples because it is the primary documented command.

## Shared-Session Operating Rules

### 1. Reset the bridge when switching targets

The bridge is persistent.

If you are switching from:
- an isolated Axis Browser session
- one shared Chrome target
- one browser URL or websocket endpoint
- manual `AUTO_CONNECT` vs `BROWSER_URL`

to a different effective target, reset first:

```bash
axis-browser stop
```

Then run the next command you actually want, for example:

```bash
axis-browser pages
axis-browser snapshot
```

`start` is rarely needed; normal commands auto-start the bridge.

### 2. Treat raw CDP as the tab source of truth

If tab attachment matters, cross-check raw Chrome CDP:

```bash
curl -s http://127.0.0.1:9222/json/list
```

If raw CDP and Axis Browser disagree:

```bash
axis-browser stop
axis-browser pages
```

### 3. Prefer a fresh controlled tab over guessing

If attachment to an already-open tab feels flaky, stop guessing.

Reset the bridge and open a fresh controlled tab:

```bash
axis-browser stop
axis-browser open http://localhost:3000
```

That is often more reliable than trying to reason about a stale attachment.

## Daily Shared-Browser Flow

```bash
export CHROME_DEVTOOLS_AXI_BROWSER_URL=http://127.0.0.1:9222
axis-browser stop
axis-browser pages
axis-browser snapshot
```

Useful follow-ups:

```bash
axis-browser open http://localhost:3000
axis-browser console
axis-browser network
axis-browser click @12
axis-browser fill @18 hello@example.com
axis-browser eval "document.title"
```

## Stop-Guessing Debug Protocol

When a browser-based feature breaks, do not rewrite code on assumptions.

Use this sequence:
1. reproduce the issue with Axis Browser
2. run `axis-browser console`
3. run `axis-browser network`
4. inspect the failing request or exception
5. only then change code

This is especially important for:
- Next.js server actions
- client-side state bugs
- network failures
- auth flows
- silent button failures

## Browser Setup Strategy

Use a dedicated Chromium-based browser or dedicated automation profile for this workflow.

Good pattern:
- keep your normal day-to-day browser separate
- use a second Chromium browser or a dedicated automation profile for shared automation work

That way destructive helper scripts do not destroy your normal browsing session.

### Example: Start Chrome With Remote Debugging

```bash
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --remote-debugging-port=9222 \
  --user-data-dir="$HOME/.axis-browser-data" \
  --no-first-run \
  --no-default-browser-check
```

### Example: Reuse a Secondary Profile

```bash
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --remote-debugging-port=9222 \
  --profile-directory="Work"
```

Use `chrome://version` to inspect the internal profile name if needed.

## Local Helper Scripts Are Optional

Helpers like these are not part of Axis Browser itself:
- `axis-init`
- `axis-human`
- `axisb-init`
- `axisb-human`
- `axi-start`

They are only user-defined shell helpers.

### Example Destructive Helper

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

Important:
- this is a local helper example, not a built-in command
- it is destructive
- use it only with a dedicated automation browser or dedicated automation profile

If you use a helper like this, follow it with:

```bash
axis-browser stop
axis-browser pages
```

## Authentication and Session State

### Standard username/password or magic-link flows

1. launch the shared browser session
2. open the app manually once
3. log in manually
4. keep the profile for later automated work

### Google SSO or other sensitive SSO flows

Some providers dislike browsers launched with debugging flags.

Safe pattern:
1. launch the same user-data-dir without remote debugging
2. log in manually
3. fully quit the browser
4. relaunch the same user-data-dir with `--remote-debugging-port=9222`

### Human-login helper example

```bash
axis-human() {
  mkdir -p "$HOME/.axis-browser-data"
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
    --user-data-dir="$HOME/.axis-browser-data" \
    --no-first-run
}
```

Again: local helper, not a built-in command.

## Playwright Rules

### Shared-session Playwright

When the user's real authenticated session matters, attach to the existing Chrome session on `9222`.

Use this pattern:

```ts
import { chromium } from "playwright";

(async () => {
  const browser = await chromium.connectOverCDP("http://localhost:9222");

  const contexts = browser.contexts();
  const pages = contexts.flatMap((context) => context.pages());

  let page = pages.find((p) => /localhost:3000/.test(p.url()));
  if (!page) {
    for (const candidate of pages) {
      if (/Dashboard|Open WebUI/i.test(await candidate.title())) {
        page = candidate;
        break;
      }
    }
  }
  page ??= pages[0];

  // your automation here

  await browser.disconnect();
})();
```

Rules:
- do not assume `pages()[0]` is the right tab
- enumerate pages and select by URL or title
- use `disconnect()`, not `browser.close()`, when attached to the shared browser
- do not use `chromium.launch()` when you need the user's real shared session
- do not use a Playwright MCP server when a CLI script is enough

### Isolated Playwright

Use isolated Playwright when:
- you want a clean second opinion
- you want clean browser state
- you want one-off verification independent of the shared session

Treat isolated Playwright as an independent browser, not as proof that the shared user session is healthy.

### Basic Auth rule

For HTTP basic-auth sites, do not rely on the native browser prompt as the main automation path.

Prefer:
- a pre-authenticated URL for one-off checks
- Playwright `httpCredentials` in an isolated context
- or a shared-session tab that is already authenticated

## agent-browser Rule

Use `agent-browser` only when the task is mostly visual:
- layout checks
- spacing checks
- font rendering checks
- screenshot-oriented sanity checks

Do not use it for primary state debugging, network debugging, or routine interaction when Axis Browser is sufficient.

## Tool Selection Heuristic

Use this quick rule:
- if the problem is logic, state, console, or network: use Axis Browser
- if the problem is repeatable execution or verification: use Playwright CLI
- if the problem is purely visual: use `agent-browser`

## Prompt Patterns For Agents

Good prompts:
- "Use Axis Browser to reproduce the issue and inspect console and network first"
- "Open the shared browser on `9222`, snapshot the page, and report the actual failing request"
- "Write a Playwright CLI script and run it against the shared browser on `9222`"
- "Use `agent-browser` only if a visual check is easier than Axis Browser and Playwright"

Bad prompts:
- "debug the UI somehow"
- "use whatever browser tool you want"

## Troubleshooting

### The bridge feels stale

```bash
axis-browser stop
axis-browser pages
```

### Tabs do not match what you see

```bash
curl -s http://127.0.0.1:9222/json/list
axis-browser stop
axis-browser pages
```

### Shared login state is missing

- confirm you reused the intended `--user-data-dir` or profile
- confirm you logged into that same profile manually first
- for SSO flows, log in manually first and relaunch with debugging enabled

### Basic auth keeps prompting

- close all tabs for that origin
- retry in a fresh incognito window
- retry after `axis-browser stop`
- use one isolated Playwright check to confirm the server accepts the credentials at all

## Final Recommendation

If you want one default habit:
- use Axis Browser as the daily driver
- use Playwright CLI as the execution layer
- keep `agent-browser` as an optional visual specialist

That is usually the best balance of:
- speed
- token cost
- reproducibility
- practical debugging