# Axis Browser Daily Workflow

This public guide explains the recommended Axis Browser operating model for browser
debugging from a shell.

## Scope

Source of truth split:

- `README.md` — install, commands, environment variables, runtime behavior, and development
- `docs/vibe-coding-browser-workflow.md` — the day-to-day workflow and troubleshooting habits
- `docs/shared-session-design.md` — why the connection model is shaped this way

**What that means for this guide.** It necessarily mentions `CHROME_DEVTOOLS_AXI_MODE`,
sessions, ports, timeouts, and auto-reaping in order to explain the workflow — but it does
not own their **semantics**. `README.md` is normative for what a flag, variable, command, or
value actually does. The examples here are kept current and are meant to be copy-pastable;
they are simply not the definition. If an example here disagrees with `README.md`, `README.md`
wins and the disagreement is a bug worth reporting, not a choice to make.

This guide is intentionally about Axis Browser and does not document unrelated local tool
stacks, shell aliases, or machine-specific helpers.

If this checkout includes `skills/browser-bay/`, use that nested skill for multi-tool browser
tasks, verified runs, reusable workflow scripts, protected site guidance, or tool comparison.
For skill portability and setup routes, use `project-guide-site/setup.html` or
`skills/browser-bay/README.md`.

If this checkout includes `prompts/`, the `;absetup`, `;abcheck`, `;abuse`, and `;abhealth`
text-expander prompts are thin wrappers around `skills/browser-bay/` and its scripts. They do
not replace this CLI guide and they do not create a second browser-tool router.

For the full machine → skill → project → task lifecycle, read
`docs/better-workflow-lifecycle-design.md`.

## Core Idea

Axis Browser is most useful when you want a compact CLI view into a real browser session:

- inspect page structure through accessibility snapshots
- interact with visible controls by `uid`
- inspect console messages
- inspect network requests
- reuse a logged-in profile when realism matters
- keep browser debugging low-token and repeatable from a shell

## Start Here: Let Axis Own The Browser

Axis launches and owns its browser. You do not start Chrome yourself, and you do not manage
a debugging port.

```bash
axis-browser doctor --json     # what mode am I actually in, and does it work?
axis-browser open http://localhost:3000
axis-browser snapshot
```

`doctor` comes first for the same reason it does everywhere else in this guide: it reports
the mode you are *actually* in, which is how an inherited connection variable gets caught
before it wastes an afternoon. See
[When Something Is Wrong, Ask The Tool](#when-something-is-wrong-ask-the-tool) for how to
read its output and which remedies need a human first.

That is `ephemeral` mode: a throwaway profile, discarded when the run ends. It is the right
default for anything that does not need a login.

When the task **does** need a login, switch to `managed` mode — same idea, but the profile
persists so you sign in once:

```bash
export CHROME_DEVTOOLS_AXI_MODE=managed      # profile: ~/.axis-browser-data
axis-browser login https://app.example.com   # one-time, interactive, needs a terminal
axis-browser open https://app.example.com    # silent from here on
```

Set the mode **per command or per project**. Do not export a connection variable from your
shell profile — see [Do Not Export A Connection Variable Globally](#do-not-export-a-connection-variable-globally).

### Why not launch Chrome yourself with a debugging port?

Because you do not need to, and doing so is how this goes wrong. Axis drives the browser over
`--remote-debugging-pipe` — file descriptors, so **Chrome's DevTools endpoint is not on a TCP
port at all** — and there is no debugging port to collide with or squat. (Axis's own bridge
still listens locally, on its documented port `9224`; pipe mode removes the *browser's*
debugging socket, not every listening socket.) A hand-launched `--remote-debugging-port=9222`
browser puts the DevTools endpoint back on a contended port, with a lifecycle you now own and
a failure mode where something else already holds it.

Earlier versions of this guide opened with exactly that pattern, including a copy-pasteable
`axis-init` helper. It is gone. See
[When You Genuinely Need To Attach](#when-you-genuinely-need-to-attach).

## When Something Is Wrong, Ask The Tool

```bash
axis-browser doctor          # human-readable
axis-browser doctor --json   # the contract to key on
```

`doctor` reports the active mode, the endpoint (actually probed, not assumed), the browser
binary, the profile and whether it is locked, bridge and orphan state, and a `remedies` array
where **every entry is a syntactically runnable command** — which is not the same as every
entry being safe to run unattended.

Sort the remedies before running any of them:

| Kind          | Examples                                                        | How to run                          |
| ------------- | --------------------------------------------------------------- | ----------------------------------- |
| Reversible    | `unset CHROME_DEVTOOLS_AXI_SESSION`, `unset CHROME_DEVTOOLS_AXI_EXECUTABLE_PATH` | run them                            |
| Destructive   | `axis-browser reap`, `axis-browser stop`, `rm <path>`           | confirm with a human first          |

`doctor` emits these fully resolved — `rm <path>` above stands for a real remedy line like
`rm ~/.axis-browser-data/sessions/default.pid` (absolute in the actual output), and
`axis-browser login <url>` for `axis-browser login https://app.example.com`. Angle brackets
appear in this table, not in the output; run what `doctor` printed, not what is written here.

The destructive ones kill processes or delete files, and `doctor` emits `axis-browser reap`
and the `rm` of a PID file together precisely when that file is unreadable — the one case
where a *live* bridge can look orphaned. Run `axis-browser reap --dry-run` and read the list
before the real thing.

Escalate to a human for exactly two conditions:

| Blocker                        | Why a human                                                     |
| ------------------------------ | --------------------------------------------------------------- |
| `NEEDS_INTERACTIVE_LOGIN`      | someone has to type a password — run `axis-browser login <url>` |
| `PORT_HELD_BY_FOREIGN_PROCESS` | killing someone's browser is their call, not the tool's         |

Anything else, run the reversible remedies; confirm the destructive ones.

> **Local CDP has no authentication.** If a connection to a local DevTools endpoint fails, the
> cause is never a missing token. Do not request credentials, API keys, or a `ws://` URL —
> there is nothing to supply. `doctor` says this in its own output because an agent once
> concluded otherwise and stopped work for a full day.

## Daily Debugging Flow

```bash
axis-browser open http://localhost:3000
axis-browser snapshot
axis-browser console
axis-browser network
```

Snapshot refs carry a generation prefix (e.g. `@g1:3`, not `@3`). Pass refs back exactly as
printed. If the page re-rendered between your snapshot and your action you get a clear
`STALE_REF` — re-snapshot and retry.

After each meaningful interaction, inspect actual browser state before changing application
code:

```bash
axis-browser snapshot
axis-browser console
axis-browser network
```

## Stop-Guessing Debug Protocol

When a browser feature breaks:

1. reproduce it
2. `axis-browser snapshot`
3. `axis-browser console`
4. `axis-browser network`
5. inspect the failing request or exception
6. only then change code

Especially useful for client-side state bugs, auth/session problems, silent button failures,
failed form submissions, and frontend/backend contract mismatches.

For an auditable handoff, capture the same evidence through
`skills/browser-bay/references/verified-run.md` when that optional skill is available. Axis
Browser supplies compact observations; the skill supplies the artifact contract and validation.

## Authentication And Session State

`axis-browser login <url>` is the sanctioned path and the only one that needs a human:

```bash
export CHROME_DEVTOOLS_AXI_MODE=managed
axis-browser login https://app.example.com
```

It opens a headed browser on the managed profile, waits for you to sign in, verifies something
landed, and stops the bridge on the way out so the profile lock is released. Every later run
reuses the profile silently.

Notes that save time:

- **It requires a terminal.** Non-interactively it refuses rather than opening a browser
  nobody can see or close.
- **Named sessions have their own profile.** `CHROME_DEVTOOLS_AXI_SESSION=worker-1` uses
  `~/.axis-browser-data/sessions/worker-1`, which starts logged out. Chrome locks a profile
  to one process, so concurrent sessions cannot share one. `doctor` reports this as
  `NEEDS_INTERACTIVE_LOGIN`.
- **SSO/MFA providers that dislike automation flags:** the profile is a normal Chrome profile
  on disk. Log in through `axis-browser login` (headed, no debugging port in the picture) and
  the cookies persist like any other browsing session.
- **Your real browser profile is refused.** A `user-data-dir` resolving inside Chrome's
  default profile, Edge, Brave, or Ulaa is rejected by `assertSafeUserDataDir` (`src/mode.ts`)
  **before Chrome is launched at all** — so this is Axis refusing, not Chrome failing. The
  reason is profile ownership: Chrome locks a profile to one process, so an automation run
  would contend with your own browser for that lock. It has nothing to do with ports;
  `managed` and `ephemeral` launch over `--remote-debugging-pipe` and open no debugging
  socket either way.

For local test sites, prefer provisioning a throwaway account through the app's own tooling
(`wp user create` → run → `wp user delete`) over reusing a human's session at all.

## When You Genuinely Need To Attach

`attach` and `autoconnect` point Axis at a browser it did not start. They are escape hatches:

```bash
CHROME_DEVTOOLS_AXI_MODE=attach \
CHROME_DEVTOOLS_AXI_BROWSER_URL=http://127.0.0.1:9333 \
  axis-browser pages
```

Understand what you give up. Axis cannot relaunch that browser, fix its flags, or reap it;
`--executablePath`, keychain isolation, and `--chrome-arg` do not apply; and its profile and
lifecycle belong to whoever started it. `doctor` probes the endpoint properly before anything
else runs — HTTP 200 alone is not accepted as proof, because a process that answers 200 with
unrelated JSON is worse than one that 404s.

### Do Not Export A Connection Variable Globally

```bash
# Do NOT put this in ~/.zshrc, ~/.bashrc, or any shell profile:
export CHROME_DEVTOOLS_AXI_BROWSER_URL=http://127.0.0.1:9222
```

A connection variable exported from a shell profile applies to **every** shell on the machine,
including the non-interactive shells coding agents run in — where nobody sees it and, before
`doctor` existed, nothing reported it. On 2026-07-30 that single line put every shell into
`attach` mode against a port held by an unrelated Chromium-based browser that served no
DevTools endpoint, and cost a full day. The post-mortem is `docs/shared-session-design.md`.

Scope connection settings to a command or a project. If you want a default, make it
`CHROME_DEVTOOLS_AXI_MODE=managed`, which owns its browser rather than depending on one.

## Ports

| Port   | Owner        | Default | Purpose                                                     |
| ------ | ------------ | ------- | ----------------------------------------------------------- |
| `9224` | Axis Browser | default | local Axis bridge server                                    |
| —      | Chrome       | none    | launch modes use `--remote-debugging-pipe`; **no TCP port** |

Named sessions derive their own bridge port automatically, so parallel agents do not collide.
Change the bridge port only if `9224` is taken:

```bash
CHROME_DEVTOOLS_AXI_PORT=9225 axis-browser start
```

Do not export `CHROME_DEVTOOLS_AXI_PORT` globally either — it forces every session onto one
port and reintroduces the collisions that per-session derivation exists to avoid.

## Troubleshooting

Start with `axis-browser doctor`. The entries below are the cases worth understanding.

### Bridge feels stale

```bash
axis-browser stop
axis-browser pages
```

The bridge uses deep health checks to detect when the attached browser target has gone away,
so in most cases simply running a command auto-recycles a stale bridge. A manual `stop` is
still the reliable way to force the **current** environment to be used: the bridge is
persistent, can outlive your shell, and captured the environment it was started with.

### Bridge startup is slow

The bridge no longer downloads `chrome-devtools-mcp` at startup — it runs the
exact version Axis pins as a dependency — so a cold `npx` fetch is not a cause
any more. If it still takes more than 30 seconds, Chrome's own launch is the
likely cost:

```bash
export CHROME_DEVTOOLS_AXI_BRIDGE_TIMEOUT_MS=60000 # extend the deadline
axis-browser doctor                                # name what is actually stuck
```

If the bridge reports that the pinned `chrome-devtools-mcp` is missing, reinstall
Axis Browser (`npm install -g github:Nirmantix/axis-browser`) instead of pointing
`CHROME_DEVTOOLS_AXI_MCP_PATH` at a global copy you did not review.

### Login state is missing

- confirm you are in `managed` mode — `doctor` prints the mode; `ephemeral` has no profile
- confirm the session name: a _named_ session has its own profile and starts logged out
- re-run `axis-browser login <url>`

### Bridges accumulating

A bridge killed with `SIGKILL` or lost to a crash never runs its own cleanup and leaks a
process group holding a browser you cannot see.

```bash
axis-browser reap --dry-run   # what would be cleaned
axis-browser reap             # clean it
```

This also happens automatically when a new bridge starts (own marker, unclaimed by any
session, ≥4h old). `CHROME_DEVTOOLS_AXI_AUTO_REAP=0` disables it.

### Wrong tab is selected

```bash
axis-browser pages
axis-browser open http://localhost:3000
```

## Built-In Commands

Built-in commands exposed by this project:

- `axis-browser`
- `axib`
- `chrome-devtools-axi` (legacy alias for the upstream base tool)

This guide uses `axis-browser` because it is the primary public command.

Not built in: `axis`, `axi`, `axisb`, `axis-init`, `axis-human`, `axisb-init`, `axisb-human`.
Those names are only local aliases or shell functions if a user creates them — and if you have
an `axis-init` that launches Chrome with `--remote-debugging-port` and exports
`CHROME_DEVTOOLS_AXI_BROWSER_URL`, retire it. That helper is the shape of the 2026-07-30
incident. Retire it in this order, because deleting a helper other scripts still call just
moves the outage:

1. Strip the Chrome launch and the `CHROME_DEVTOOLS_AXI_BROWSER_URL` export from it first —
   that alone ends the incident shape, and does it immediately.
2. Find the remaining callers — `grep -rn axis-init ~/.zshrc ~/.bashrc ~/bin` — then repeat
   that search from the root of each repository you actually work in. Point every caller at
   `axis-browser` directly.
3. Delete the helper once nothing calls it.

## Final Recommendation

- keep `axis-browser` as the documented command
- use `ephemeral` by default and `managed` when a login is needed
- run `axis-browser doctor --json` before a browser task; run its reversible remedies and
  confirm the destructive ones (`reap`, `stop`, `rm`) before executing them
- never export a connection variable from a shell profile
- reset the bridge when switching targets
- inspect snapshot, console, and network before changing app code
- use the optional browser-bay verified-run flow when the task needs a checkable evidence
  bundle
- keep local aliases and personal tool stacks out of public docs
