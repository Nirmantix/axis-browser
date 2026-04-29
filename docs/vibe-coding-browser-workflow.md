# Shared Chrome Workflow and Tool Selection

This guide explains how to choose between Axis Browser, Browser Harness, Playwright CLI, and agent-browser in day-to-day coding-agent work.

## Scope

This file is the workflow guide, not the product reference.

Source of truth split:
- `README.md` — install, commands, environment variables, runtime behavior, development
- `docs/vibe-coding-browser-workflow.md` — tool selection, shared-`9222` workflow, cross-tool strategy, Playwright handoff, and troubleshooting habits

If an old note, prompt, or helper snippet disagrees with this guide or the README, prefer those two repo docs.

## The Core Idea

Most modern browser tools overlap on the surface:
- open pages
- click and fill
- take screenshots
- inspect page state
- reuse sessions
- drive Chrome through CDP

What differs is **what they optimize for**.

Use the right tool for the right job:
- `Browser Harness` for unconstrained, agent-written, screenshot/CDP-heavy browser work
- `Axis Browser` for compact diagnostics, shared-Chrome debugging, console, network, and low-token state inspection
- `Playwright CLI` for repeatable verification, regression checks, traces, video, and Playwright-aligned execution
- `agent-browser` as an optional fallback when its native CLI surface or screenshot-oriented flow is simply the easiest path

These tools are not four copies of the same thing.
They sit at different points on the spectrum of:
- freedom vs structure
- realism vs reproducibility
- diagnostics vs execution
- local shared session vs isolated automation

## Why These Tools Exist

## Axis Browser

Axis Browser exists because a compact, persistent, shared-Chrome CLI is useful for coding agents.

It was forked from `chrome-devtools-axi` to preserve a practical workflow around:
- a persistent local bridge
- shared Chrome on `9222`
- stable reuse of real login state and cookies
- safer target switching and stale-bridge recovery
- low-token accessibility snapshots plus console/network debugging

Axis Browser is best thought of as:
- a browser diagnostics CLI
- a shared-session Chrome companion
- a low-token state inspection tool

## Browser Harness

Browser Harness exists because some browser tasks are too messy for a fixed command set.

Its core idea is:
- let the agent drive the browser directly through CDP
- let the agent write missing helper code mid-task
- let the agent store domain-specific skills it learned
- prefer freedom over rails

Browser Harness is best thought of as:
- an agent runtime for unconstrained browser work
- a screenshot/CDP-heavy browser tool
- a good fit when the agent may need to improvise

## Playwright CLI

Playwright CLI exists because coding agents often need Playwright power without the overhead of a long-running MCP loop.

It provides:
- a token-efficient CLI surface
- Playwright-native sessions
- snapshots with refs
- traces, video, and dashboards
- a clean path from ad hoc browser work to reproducible Playwright automation

Playwright CLI is best thought of as:
- an execution and verification layer
- a QA/devtools/test automation companion
- the easiest path when the final output should be a repeatable script or test

## agent-browser

agent-browser exists because some users want a broad, native, standalone browser CLI for agents.

Its emphasis is:
- fast native binary
- broad command surface
- semantic locators plus screenshots
- practical general-purpose automation

agent-browser is best thought of as:
- a broad browser-control utility for agents
- a capable fallback when its command surface is more convenient than the other tools

## Big Comparison Table

| Tool | Core reason for existing | Best at | Main limitations | Typical mode |
| --- | --- | --- | --- | --- |
| Axis Browser | Compact shared-Chrome diagnostics with persistent bridge and low-token output | Console/network debugging, page state inspection, shared-session Chrome workflows | Less open-ended than Browser Harness; not primarily a test artifact tool | Command-driven CLI over a persistent bridge |
| Browser Harness | Maximum agent freedom through direct CDP, screenshots, helper editing, and domain skills | Weird sites, unconstrained workflows, agent-written helpers, visual/CDP exploration | Less opinionated diagnostics surface; more free-form; easier to become messy without discipline | Python snippets + editable helper/runtime workspace |
| Playwright CLI | Playwright power exposed as a token-efficient CLI for coding agents | Reproducible execution, traces, video, dashboards, locator generation, test-adjacent automation | More test/dev workflow oriented than pure exploratory debugging | Playwright-backed CLI sessions |
| agent-browser | Native browser automation CLI for agents with a broad general command set | Standalone browser control, semantic locators, screenshots, practical general automation | Less specialized than Axis for diagnostics and less adaptive than Browser Harness for self-extension | Native CLI with broad browser action surface |

## Where They Overlap

All four can do some version of:
- open/navigate
- click/fill/type
- screenshot
- keep session state alive across commands
- talk to a browser via CDP or browser automation internals
- help an agent complete real browser tasks

Because of that overlap, the best question is not:
- "Which tool can click a button?"

The better question is:
- "What kind of browser work am I doing right now?"

## Where They Actually Differ

### 1. Structured diagnostics vs unconstrained freedom

- `Axis Browser` is optimized for structured diagnostics
- `Browser Harness` is optimized for unconstrained execution

If you want:
- `snapshot`
- `console`
- `network`
- low-token inspection

use Axis.

If you want:
- arbitrary Python
- screenshots first
- raw CDP
- agent-written helpers
- domain skills

use Browser Harness.

### 2. Exploration vs repeatable execution

- `Browser Harness` and `Axis Browser` are often better during messy exploration
- `Playwright CLI` becomes better when you want a reproducible proof or regression check

### 3. Real user session vs clean isolated browser

- shared Chrome is better when realism matters
- isolated Playwright or an isolated browser tool is better when reproducibility matters

### 4. Diagnostic UX vs artifact generation

- `Axis Browser` has the strongest built-in diagnostics feel in this repo's stack
- `Playwright CLI` has the strongest artifact and verification surface
  - traces
  - video
  - locator generation
  - dashboard

### 5. Self-extension

- `Browser Harness` is uniquely built around the idea that the agent may write what is missing
- the others are more fixed-surface tools

## Tool Roles In Practice

## 1. Browser Harness — Primary Unconstrained Driver

Use Browser Harness first when:
- the site is weird
- you expect iframe, shadow DOM, or non-semantic UI pain
- the task may need custom helpers
- the agent may need to learn and store reusable domain knowledge
- screenshot-driven exploration is easier than ref-driven interaction

Browser Harness is often the best daily choice when your main goal is simply:
- "make the browser task work"

Use cases:
- admin dashboards with inconsistent markup
- vendor portals
- scraping tasks with odd flows
- repetitive site-specific operational work
- flows where the agent may need to create helper code or reusable domain skills

Limits:
- not the cleanest built-in console/network/perf UX
- easier to produce ad hoc one-off logic if you are not disciplined
- less naturally compact than Axis Browser for repeated diagnostic loops

## 2. Axis Browser — Primary Diagnostic Tool

Use Axis Browser first when:
- the problem is logic, state, console, or network
- you want to know what the page is actually doing right now
- you are debugging a live app in a real logged-in browser
- you want compact output and low token overhead
- you want a stable shared-Chrome workflow around `9222`

Axis Browser is especially good for:
- reproducing product bugs
- inspecting page state after an action
- checking whether a request actually failed
- validating which tab the bridge is attached to
- debugging silent UI failures before changing app code

Use cases:
- Next.js server action issues
- auth flow debugging
- frontend state bugs
- network failures
- page inspection in a live user-like session

Limits:
- less open-ended than Browser Harness
- not a full test harness by itself
- not the best choice when your main goal is generating Playwright artifacts

## 3. Playwright CLI — Execution and Verification Tool

Use Playwright CLI when:
- you want a repeatable script
- you want a reusable regression check
- you want traces, videos, or locator generation
- the final output should feel like maintainable test automation
- you need a second opinion independent from the shared browser

Use cases:
- verifying a flow after a bug fix
- creating a regression script
- recording a trace for later inspection
- monitoring multiple browser sessions
- attaching to an existing Chrome via CDP when needed

Limits:
- overkill for quick one-off page state inspection
- not the best first tool for low-token browser debugging if Axis Browser already answers the question
- less adaptive than Browser Harness when the agent needs to invent helpers

## 4. agent-browser — Optional Fallback Utility

Use agent-browser when:
- its native CLI surface is the easiest route
- you need a broad standalone browser-control utility
- annotated screenshots or its built-in browser controls are more convenient than the other tools
- you need a fallback and do not want to stop to hand-roll code

Use cases:
- quick screenshot-driven sanity checks
- broad browser control from one utility
- situations where its command set is simply the fastest path

In this repo's recommended stack, agent-browser is **not** the default daily driver.
That is not because it is weak.
It is because Browser Harness, Axis Browser, and Playwright CLI usually cover the workflow with clearer specialization.

## Shared Chrome Baseline

The most useful local setup for realistic browser work is a shared Chrome instance on port `9222`.

That gives you:
- one browser window you can log into manually
- persistent cookies
- a shared session that multiple tools can reuse
- realistic state for app debugging
- easy handoff between manual browsing and agent automation

Baseline environment for Axis Browser:

```bash
export CHROME_DEVTOOLS_AXI_BROWSER_URL=http://127.0.0.1:9222
```

Built-in commands exposed by this repo:
- `axis-browser`
- `axib`
- `chrome-devtools-axi`

This guide uses `axis-browser` in examples because it is the primary documented command.

## Important: Shared Chrome Is Not Axis-Specific

A shared browser on `9222` is **not** the same thing as "using Axis Browser."

Think of it this way:
- the shared Chrome profile is the **browser state**
- Axis Browser, Browser Harness, and Playwright can all be **clients** of that state

`axis-init` is only a local convenience helper some users define to start a dedicated automation browser/profile on `9222`.
It is **not** a built-in command, and it is **not required** for Browser Harness or Playwright.

You can:
- use Browser Harness without Axis Browser at all
- use Playwright without Axis Browser at all
- still choose to point them at the same shared browser when realism matters

## When You Should Use A Shared Chrome Profile

Use a shared Chrome profile when any of these are true:

- you need real authenticated state
- you need persistent cookies across commands and tools
- the user must log in manually once and then let the agent continue
- the site uses SSO, magic links, MFA, or CAPTCHAs that are easier to satisfy manually
- you want manual + agent handoff in the same browser
- you want Browser Harness, Axis Browser, and Playwright to see the same tabs/session
- the bug only reproduces in a real lived-in browser profile
- you want to debug a local app while staying inside a real logged-in browser session

Typical examples:
- admin dashboard debugging
- SaaS apps with complex login state
- internal tools behind SSO
- verifying bugs that depend on existing cookies or session context
- reproducing auth-sensitive issues across multiple tools

## When You Should Not Use A Shared Chrome Profile

Do **not** default to shared Chrome when any of these are more important:

- clean reproducibility
- destructive tests that should not touch your real session
- parallel multi-agent runs that should not fight over the same tabs/profile
- CI or headless automation
- a task that does not need login state at all
- you need a clean second opinion independent from the user's browser
- you want one isolated browser per task
- you are using a remote Browser Harness cloud browser instead of a local shared browser

Typical examples:
- regression tests
- clean signup flow checks
- screenshot baseline tests
- headless server automation
- parallel jobs that should not interfere with each other

## Shared Profile vs Isolated Browser Decision Table

| Situation | Better choice |
| --- | --- |
| Need real login, cookies, or manual SSO handoff | Shared Chrome profile |
| Need a clean regression check | Isolated Playwright or isolated browser session |
| Need multiple parallel agents | Separate isolated sessions or remote browsers |
| Need to inspect a live user-like bug | Shared Chrome profile |
| Need disposable automation state | Isolated browser |
| Need Browser Harness remote cloud browser | Usually skip local shared Chrome |
| Need a reproducible failing artifact | Usually isolated Playwright |

## What `axis-init` Actually Means

`axis-init`-style helpers are local shell helpers, not built-in commands.

Their real job is usually:
- kill stale local Chrome automation state
- launch a dedicated browser or dedicated automation profile with `--remote-debugging-port=9222`
- point Axis Browser at that port

That means `axis-init` is useful when you want:
- a known-good dedicated automation profile
- one reusable local browser state shared across tools
- a quick reset of the automation browser

It is **not** required when:
- Browser Harness can already attach to your running browser through its own setup flow
- Playwright is running isolated
- you are using a remote Browser Harness browser
- the task does not need shared local session state

## Browser Setup Strategy

Use a dedicated Chromium-based browser or dedicated automation profile for shared local automation.

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

## How Browser Harness Fits With Shared Chrome

## Browser Harness without `axis-init`

This is completely valid.

Use Browser Harness directly when:
- its own setup flow can attach to the browser you want
- you do not need a shared `9222` convention
- you are using its remote/cloud browser features
- the task is local but does not need cross-tool continuity

This is often the simplest Browser Harness path.

## Browser Harness with a shared local profile

Use Browser Harness against the same shared browser when:
- you want the same cookies/tabs used by Axis Browser and Playwright
- you logged in manually and want the harness to continue in that same browser
- the bug depends on real existing state

In practice, the important part is the shared browser itself, not Axis Browser.
Browser Harness can benefit from the same shared Chrome even if Axis Browser is never called.

## Browser Harness with a remote browser instead

Prefer Browser Harness remote/cloud mode when:
- you need isolation
- you need proxies
- you need multiple parallel browsers
- you want a disposable remote environment
- local shared Chrome is unnecessary

If you still need auth state in that remote browser, Browser Harness has its own profile-sync workflow for cookies.
That is a different strategy from a local shared Chrome profile.

## Browser Harness mode guide

A good practical Browser Harness model is:
- start with the harness directly when it can attach cleanly on its own
- switch to a shared local Chrome only when real local session state matters
- use an isolated local or remote browser when you want quiet, disposable automation

### Mode 0 — Direct Browser Harness attach

Use this when:
- Browser Harness can already attach through its own setup flow
- you do not care about sharing state with Axis Browser or Playwright
- you do not need a dedicated `9222` convention
- you are okay with Browser Harness managing the attach story itself

This is often the simplest Browser Harness path.

### Mode 1 — Shared visible Chrome via a local `axis-init`-style helper

Use this when you need:
- existing cookies
- logged-in sessions
- OAuth / SSO state
- wp-admin or other persistent admin sessions
- one visible browser window shared across tools
- manual + agent handoff in the same local browser

Typical flow:

```bash
axis-init
curl -s http://127.0.0.1:9222/json/version
```

Then point Browser Harness at that shared browser.

For a local Chrome DevTools HTTP endpoint, prefer `BU_CDP_URL` because Browser Harness can resolve `/json/version` itself:

```bash
BU_CDP_URL=http://127.0.0.1:9222 browser-harness -c '
new_tab("https://example.com")
wait_for_load()
print(page_info())
'
```

If you already have the exact WebSocket URL, `BU_CDP_WS` is also valid:

```bash
WS=$(curl -s http://127.0.0.1:9222/json/version | node -e 'let s=""; process.stdin.on("data", d => s += d); process.stdin.on("end", () => console.log(JSON.parse(s).webSocketDebuggerUrl))')
BU_CDP_WS="$WS" browser-harness -c '
new_tab("https://example.com")
wait_for_load()
print(page_info())
'
```

Caveats:
- this can open tabs in your visible shared browser
- it can interact with the same logged-in session you are using manually
- it is the right choice only when shared local state matters more than isolation

### Mode 2 — Isolated local headless Chrome

Use this when you want:
- quiet backend scraping
- public page checks
- discovery workflows
- repeatable automation without touching your visible browser
- no keyboard/mouse interference
- no clutter in your shared Chrome

Generic pattern:

```bash
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
TMP_PROFILE=$(mktemp -d /tmp/browser-harness-profile-XXXXXX)
PORT=9333

"$CHROME" \
  --headless=new \
  --disable-gpu \
  --no-first-run \
  --no-default-browser-check \
  --remote-debugging-port="$PORT" \
  --user-data-dir="$TMP_PROFILE" \
  about:blank &
```

Then connect Browser Harness to that isolated browser:

```bash
BU_CDP_URL="http://127.0.0.1:$PORT" browser-harness -c '
new_tab("https://example.com")
wait_for_load()
print(page_info())
'
```

Use `BU_CDP_WS` instead only if you specifically want to resolve and pin the exact WebSocket yourself.

Caveats:
- this is usually the better mode for public scraping and disposable checks
- you are responsible for cleanup of the temporary profile and background Chrome process
- this gives up your real local logged-in session state by design

### Mode 3 — Browser Harness remote/cloud browser

Use this when you need:
- strong isolation
- multiple parallel agent browsers
- proxies
- a disposable remote browser
- no dependence on your local Chrome at all

This is often better than a local shared browser when realism of your local profile is not required.

## Browser Harness rule of thumb

- need login, cookies, or the user's real local session: use a shared local Chrome and point Browser Harness at it
- need quiet backend scraping or disposable checks: use an isolated local headless Chrome
- need scalable isolation, proxies, or parallel browsers: use Browser Harness remote/cloud mode
- if Browser Harness can already attach directly and none of the above constraints matter: just use it directly

## How Playwright Fits With Shared Chrome

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
- do not use a Playwright MCP server when a normal CLI script is enough

### Isolated Playwright

Use isolated Playwright when:
- you want a clean second opinion
- you want clean browser state
- you want one-off verification independent of the shared session
- you need reproducibility more than realism

Treat isolated Playwright as an independent browser, not as proof that the shared user session is healthy.

## Cross-Tool Workflow Patterns

## Pattern A — Browser Harness first, shared profile only when needed

This is a good pattern if you already prefer Browser Harness.

Use it like this:
1. start with Browser Harness for general browser work
2. if the task needs real auth or cross-tool continuity, move to a shared Chrome profile
3. use Axis Browser when you need compact diagnostics
4. use Playwright CLI when you need repeatable verification or artifacts
5. use agent-browser only if its command surface is the easiest remaining route

This is often the best default if your instinct is:
- "I want Browser Harness to do most things"

## Pattern B — Axis first for diagnostics, Playwright second for proof

Use it like this:
1. reproduce with Axis Browser
2. inspect console and network
3. fix or understand the issue
4. confirm with Playwright CLI

This is ideal for frontend debugging and app-state diagnosis.

## Pattern C — Shared local session across multiple tools

Use this when all of these matter:
- real login state
- manual + agent handoff
- cross-checking the same session in multiple tools

Example flow:
1. launch dedicated automation Chrome/profile on `9222`
2. log in manually
3. inspect with Axis Browser
4. continue hard UI work with Browser Harness
5. verify the fix with Playwright attached to the same session

## Pattern D — No shared profile at all

Use this when realism is not the goal.

Example flow:
1. Browser Harness remote browser or local isolated session for exploration
2. Playwright CLI isolated session for repeatable validation
3. no shared `9222` browser involved

## Daily Shared-Browser Flow

```bash
export CHROME_DEVTOOLS_AXI_BROWSER_URL=http://127.0.0.1:9222
axis-browser stop
axis-browser pages
axis-browser snapshot
```

Useful Axis follow-ups:

```bash
axis-browser open http://localhost:3000
axis-browser console
axis-browser network
axis-browser click @12
axis-browser fill @18 hello@example.com
axis-browser eval "document.title"
```

Possible companion flows:

- Browser Harness: attach to the same browser if you need freer interaction
- Playwright CLI: attach via CDP when you need repeatable verification
- agent-browser: connect only if its command surface is the most convenient for the moment

## Stop-Guessing Debug Protocol

When a browser-based feature breaks, do not rewrite code on assumptions.

Use this sequence:
1. reproduce the issue with Axis Browser or Browser Harness
2. if the issue is unclear, use Axis Browser for `console` and `network`
3. inspect the failing request or exception
4. only then change code
5. if you need proof, write or run a Playwright CLI check afterwards

This is especially important for:
- Next.js server actions
- client-side state bugs
- network failures
- auth flows
- silent button failures

## Authentication and Session State

### Standard username/password or magic-link flows

1. launch the shared browser session if realism matters
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

## Basic Auth Rule

For HTTP basic-auth sites, do not rely on the native browser prompt as the main automation path.

Prefer:
- a pre-authenticated URL for one-off checks
- Playwright `httpCredentials` in an isolated context
- or a shared-session tab that is already authenticated

## agent-browser Rule

Use `agent-browser` only when it wins on convenience for the current task.

In this repo's default stack, that usually means:
- mainly visual checks
- screenshot-oriented sanity checks
- a fallback when Browser Harness, Axis Browser, and Playwright are not the clearest fit

It can do much more than that.
It is just not the primary recommendation here.

## Tool Selection Heuristic

Use this quick rule:
- if the job is unconstrained browser work on a messy site: use Browser Harness
- if the job is logic, state, console, or network: use Axis Browser
- if the job is repeatable execution or verification: use Playwright CLI
- if the job is mostly a convenience/visual/native fallback: use `agent-browser`
- if real cookies/login state matter across tools: use a shared Chrome profile
- if clean reproducibility matters more: do not use a shared Chrome profile

## Prompt Patterns For Agents

Good prompts:
- "Use Browser Harness first, but switch to Axis Browser for console and network if the issue is unclear"
- "Open the shared browser on `9222`, snapshot the page, and report the actual failing request"
- "Use Browser Harness for the messy UI work, then write a Playwright CLI verification script"
- "Use `agent-browser` only if a visual/native shortcut is easier than Browser Harness, Axis Browser, and Playwright"
- "Use the shared Chrome profile only if real login state matters; otherwise stay isolated"

Bad prompts:
- "debug the UI somehow"
- "use whatever browser tool you want"
- "always use shared Chrome"
- "always use isolated browsers"

## Troubleshooting

### The Axis bridge feels stale

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
- if using Browser Harness remote mode, remember that local shared Chrome and remote browser profiles are different strategies

### Shared session feels unsafe for destructive work

- stop using the shared profile for that task
- switch to isolated Playwright or an isolated browser session
- keep the shared browser only for realistic debugging and authenticated inspection

### Browser Harness does not need Axis Browser, but you still want the same local session

- start the shared Chrome profile first
- attach Browser Harness to that browser instead of launching an unrelated isolated browser
- treat the shared browser as the common state layer, not Axis Browser itself

## Final Recommendations

If you want one practical default stack for coding-agent browser work:
- use Browser Harness as the unconstrained driver when you want maximum flexibility
- use Axis Browser as the compact diagnostic tool
- use Playwright CLI as the execution and verification layer
- keep `agent-browser` as an optional fallback utility

If you want one practical default rule for shared state:
- use a shared Chrome profile only when real login state, cookies, or manual+agent continuity actually matter
- otherwise prefer isolated browser sessions

That is usually the best balance of:
- realism
- reproducibility
- speed
- token cost
- practical debugging
- cross-tool flexibility
