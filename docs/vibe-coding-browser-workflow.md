# Axis Browser Shared Chrome Workflow

This public guide explains the recommended Axis Browser operating model for shared Chrome debugging.

## Scope

Source of truth split:

- `README.md` — install, commands, environment variables, runtime behavior, and development
- `docs/vibe-coding-browser-workflow.md` — Axis Browser shared-browser workflow, `9222` usage, and troubleshooting habits

This guide is intentionally about Axis Browser and does not document unrelated local tool stacks, shell aliases, or machine-specific helpers.

If this checkout includes `skills/browser-skill/`, use that nested skill for
multi-tool browser tasks, verified runs, reusable workflow scripts, protected
site guidance, or tool comparison. This guide stays focused on the Axis Browser
shared-Chrome workflow. For skill portability and setup routes, use
`project-guide-site/setup.html` or `skills/browser-skill/README.md`: a
workstation with this repo checked out can point projects at
`/path/to/axis-browser/skills/browser-skill`, while a new machine must install
the machine-level browser tools first.

If this checkout includes `prompts/`, the `;absetup`, `;abcheck`, `;abuse`, and
`;abhealth` text-expander prompts are thin wrappers around `skills/browser-skill/`
and its scripts. They do not replace this CLI guide and they do not create a
second browser-tool router.

For the full machine → skill → project → task lifecycle, read
`docs/better-workflow-lifecycle-design.md`.

## Core Idea

Axis Browser is most useful when you want a compact CLI view into a real browser session:

- inspect page structure through accessibility snapshots
- interact with visible controls by `uid`
- inspect console messages
- inspect network requests
- reuse a logged-in Chrome profile when realism matters
- keep browser debugging low-token and repeatable from a shell

## Shared Chrome Baseline

The standard shared-browser pattern is a dedicated Chrome instance exposing Chrome DevTools Protocol on `9222`:

```bash
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --remote-debugging-port=9222 \
  --user-data-dir="$HOME/.axis-browser-data" \
  --no-first-run \
  --no-default-browser-check
```

Then point Axis Browser at it:

```bash
export CHROME_DEVTOOLS_AXI_BROWSER_URL=http://127.0.0.1:9222
axis-browser stop
axis-browser pages
axis-browser snapshot
```

Why `axis-browser stop` first:

- the bridge is persistent
- it can outlive your current shell
- stopping it guarantees the next command uses the current environment

## Dedicated Profile Recommendation

Prefer a dedicated automation profile instead of your everyday browser profile.

Good default:

```text
~/.axis-browser-data
```

Benefits:

- manual login can persist across debugging sessions
- automation does not disturb your normal browser profile
- destructive tests are less likely to damage personal browsing state
- the same profile can be relaunched with or without remote debugging for SSO flows

## Built-In Commands

Built-in commands exposed by this project:

- `axis-browser`
- `axib`
- `chrome-devtools-axi`

This guide uses `axis-browser` because it is the primary public command.

Not built in:

- `axis`
- `axi`
- `axisb`
- `axis-init`
- `axis-human`
- `axisb-init`
- `axisb-human`

Those names are only local aliases or shell functions if a user creates them.

## Daily Debugging Flow

```bash
export CHROME_DEVTOOLS_AXI_BROWSER_URL=http://127.0.0.1:9222
axis-browser stop
axis-browser pages
axis-browser open http://localhost:3000
axis-browser snapshot
axis-browser console
axis-browser network
```

Snapshot refs now carry a generation prefix (e.g., `@g1:3` instead of `@3`). Always pass refs back exactly as printed. If the page re-rendered between your snapshot and action, you get a clear `STALE_REF` error — just re-snapshot and retry.

After each meaningful interaction, inspect actual browser state before changing application code:

```bash
axis-browser snapshot
axis-browser console
axis-browser network
```

## Stop-Guessing Debug Protocol

When a browser feature breaks:

1. reproduce it in the shared browser
2. run `axis-browser snapshot`
3. run `axis-browser console`
4. run `axis-browser network`
5. inspect the failing request or exception
6. only then change code

This is especially useful for:

- client-side state bugs
- auth/session problems
- silent button failures
- failed form submissions
- frontend/backend contract mismatches

For an auditable handoff, capture the same evidence through
`skills/browser-skill/references/verified-run.md` when that optional skill is
available. Axis Browser supplies compact observations; the skill supplies the
artifact contract and validation.

## Tab Source Of Truth

Raw Chrome CDP is the source of truth for tabs:

```bash
curl -s http://127.0.0.1:9222/json/list
```

If raw CDP and Axis Browser disagree:

```bash
axis-browser stop
axis-browser pages
```

If attachment to an old tab is unclear, open a fresh controlled tab:

```bash
axis-browser stop
axis-browser open http://localhost:3000
```

## Authentication And Session State

### Normal login flows

1. launch the dedicated shared Chrome profile
2. open the app manually once
3. log in manually
4. keep using the same `--user-data-dir` for future debugging

### SSO, MFA, or sensitive providers

Some providers dislike browser sessions launched with debugging flags.

Safer pattern:

1. launch the same `--user-data-dir` without `--remote-debugging-port`
2. log in manually
3. fully quit Chrome
4. relaunch the same `--user-data-dir` with `--remote-debugging-port=9222`
5. point Axis Browser at `http://127.0.0.1:9222`

## Local Helper Functions Are Optional

A user may create shell helpers to launch a dedicated shared browser, but these helpers are not part of Axis Browser.

Example local helper:

```bash
axis-init() {
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

- this is an example only
- it is not a built-in command
- use it with a dedicated automation browser/profile
- if Chrome is already running with a different profile or port, quit that automation browser before relaunching it

## Changing Ports

There are two separate ports:

| Port | Owner | Default | Purpose |
| --- | --- | --- | --- |
| `9222` | Chrome | convention only | Chrome DevTools Protocol endpoint |
| `9224` | Axis Browser | default | local Axis bridge server |

Usually, keep both defaults.

Change Chrome's CDP port only if `9222` is already in use:

```bash
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --remote-debugging-port=9333 \
  --user-data-dir="$HOME/.axis-browser-data"

export CHROME_DEVTOOLS_AXI_BROWSER_URL=http://127.0.0.1:9333
axis-browser stop
axis-browser pages
```

Change the Axis bridge port only if `9224` is already in use:

```bash
export CHROME_DEVTOOLS_AXI_PORT=9225
axis-browser stop
axis-browser pages
```

Do not change ports casually. Every tool and shell that talks to the shared browser must use the same Chrome CDP port.

## Troubleshooting

### Bridge feels stale

```bash
axis-browser stop
axis-browser pages
```

The bridge now uses deep health checks to detect when the attached Chrome target has gone away. In most cases, simply running a command will auto-recycle a stale bridge without needing a manual stop.

### Bridge startup is slow

If the bridge takes more than 30 seconds to start (common on cold systems using npx):

```bash
# Option 1: Install chrome-devtools-mcp globally for ~1-2s startup
npm install -g chrome-devtools-mcp

# Option 2: Extend the timeout
export CHROME_DEVTOOLS_AXI_BRIDGE_TIMEOUT_MS=60000
```

### Chrome CDP is not reachable

```bash
curl -s http://127.0.0.1:9222/json/version
```

If that fails, Chrome was not launched with the expected `--remote-debugging-port`, or another process/profile is using the port.

### Login state is missing

- confirm the same `--user-data-dir` was reused
- confirm the login happened in that exact profile
- for SSO, log in without remote debugging first, then relaunch the same profile with remote debugging

### Wrong tab is selected

```bash
curl -s http://127.0.0.1:9222/json/list
axis-browser stop
axis-browser pages
axis-browser open http://localhost:3000
```

## Final Recommendation

For public Axis Browser usage:

- keep `axis-browser` as the documented command
- use a dedicated shared Chrome profile when real login state matters
- reset the bridge when switching targets
- inspect snapshot, console, and network before changing app code
- use the optional browser-skill verified-run flow when the task needs a
  checkable evidence bundle
- keep local aliases and personal tool stacks out of public docs
