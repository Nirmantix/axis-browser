# Axis Browser — Operator-Free Session Design

**Status:** Phases 0-3 and the 0.1.27 upstream sync are **APPLIED and verified** — Phase 0/1 and the sync in §12, Phase 2 in §13, Phase 3 (browser-bay doctrine + ego lite routing) in §14.
**Update 2026-09-27:** the fork has since synced to **0.1.35** (see `docs/upstream_sync.md`); §9 numbers below are the dated 0.1.27-era record. Mode handling now lives in `src/mode.ts` — the "nowhere in axis's own source" claims later in this doc were true at writing and are superseded.
**Author:** Dev A (this session), with Nitesh
**Date:** 2026-07-30
**Context:** post-mortem of the `127.0.0.1:9222` escalation + permanent fix

---

## 1. TL;DR

An agent blocked a verification run asking the operator for "an authenticated CDP
endpoint or credentials." There is **no authentication on local CDP** — the request was
impossible to satisfy because it was based on a false premise.

Root cause was a single line in `~/.zshrc` that pinned every shell on the machine to
`CHROME_DEVTOOLS_AXI_BROWSER_URL=http://127.0.0.1:9222`, an endpoint owned by **Ulaa**
(the operator's daily Chromium browser), which listens on 9222 but serves no DevTools
HTTP endpoint.

**The key finding of this review:** axis-browser already supports a fully
operator-free persistent-session mode (`--userDataDir`), and in that mode
chrome-devtools-mcp drives Chrome over **`--remote-debugging-pipe`, not a TCP port**.
That makes the entire port-squatting failure class *structurally impossible*.

> **Verified end-to-end 2026-07-30** (§12). An earlier draft asserted this from
> inference; it has since been executed. The launched Chrome carries
> `--remote-debugging-pipe` and has **no TCP LISTEN socket anywhere in its process tree**
> (checked on the main pid and every child, since page-fetch networking runs in the
> network-service child), and a cookie survived a full bridge + Chrome restart on the same
> profile. `CHROME_DEVTOOLS_AXI_MODE` and the string
> `remote-debugging-pipe` still appear **nowhere in axis's own source** — the transport is
> supplied by upstream `chrome-devtools-mcp`, which is why it needed proving rather than
> asserting.
>
> *(Superseded 2026-09-27: `CHROME_DEVTOOLS_AXI_MODE` is now first-class in
> `src/mode.ts`, read by the bridge, CLI, and doctor. The transport still comes from
> `chrome-devtools-mcp`, pinned at exactly 1.9.0 and spawned package-locally.)*

That mode was never reachable, because `CHROME_DEVTOOLS_AXI_BROWSER_URL` shadows it at
`src/bridge.ts:494`. *(at writing; mode inference is now `resolveMode()` in `src/mode.ts`,
where explicit `MODE` wins over stale `BROWSER_URL`)* The permanent fix is therefore mostly **configuration and doctrine**,
plus one genuinely missing passthrough (`--executablePath`) and a preflight/hygiene layer.

---

## 2. What actually happened

Verified on the machine, not inferred:

| Observation | Evidence |
|---|---|
| Ulaa held `127.0.0.1:9222` | `lsof`: `Ulaa 96228 127.0.0.1:9222 (LISTEN)` |
| It is not a CDP endpoint | `GET /json/version` → **404**; `GET /` → **404** |
| Real Chrome could not bind a debug port | PID 93563 ran `--remote-debugging-port=39411` on the **default profile**; zero listening sockets. Chrome refuses remote debugging on the default `user-data-dir`. |
| Stale evidence misled diagnosis | `~/Library/Application Support/Google/Chrome/DevToolsActivePort` still read `9222` from an older launch |
| Bridges leaked continuously | 5 orphaned `chrome-devtools-axi-bridge` process groups (Wed, Fri, 19:40, 20:42, 23:00, 00:16) |
| "Stuck Chrome" | orphaned `--headless=new` Chrome (PID 68059) pinning framework **150.0.7871.187** after Chrome updated to **151.0.7922.72** — no window, so Cmd-Q did nothing |

### The causal chain

1. `~/.zshrc` unconditionally exported `CHROME_DEVTOOLS_AXI_BROWSER_URL` (line 439
   *before* the Phase 1 fix; that line no longer exists — see §8 Phase 1).
2. That export puts axis-browser in **attach mode**, which by design disables all
   browser lifecycle management (`src/bridge.ts:494`).
3. Ulaa squats 9222 — the universal Chromium default that *every* fork claims.
4. Attach mode does zero identity verification, so it connected at TCP level and
   failed at the CDP handshake with no useful diagnosis.
5. `buildBridgeEarlyExitError` (`src/client.ts:333`) has no attach-mode branch, so it
   emitted *"Chrome failed to launch; confirm a usable Chrome is installed"* — actively
   misleading, since nothing was ever launched.
6. The recovery helpers (`axis-init` / `axis-reinit`) are **zsh functions**. Agents run
   non-interactive `bash`. **The breaking half of the config is inherited via `export`;
   the fixing half is not.**
7. `browser-bay/SKILL.md:187` states shared Chrome is *"an endpoint the operator already
   started"* set via *"an env var the operator provides"* — so the agent escalated
   exactly as instructed.
8. With no vocabulary for local CDP, the agent invented an auth requirement.

Escalation was *correct behavior under the given inputs*. Every input was wrong.

---

## 3. The reframe

The design error, present in both the zshrc and the skill:

> "Shared session" was modeled as **an endpoint a human provides**.

It isn't. A shared session is just **a browser profile that outlives one run**.
Nothing about that needs a human. axis-browser can own the whole lifecycle: launch,
health-check, restart, and keep the profile on disk so logins persist.

The only step genuinely requiring a human is the **first interactive login to a given
site** — and that should be a one-time explicit handoff, not a per-run blocker.

---

## 4. Target model — three modes (shipped as four)

> **As shipped:** this section proposed three modes; `autoconnect` was split out as a
> fourth during implementation. `CHROME_DEVTOOLS_AXI_MODE` accepts
> `ephemeral` / `managed` / `attach` / `autoconnect`. The proposal is kept as written
> below for the record.

| Mode | Profile | Transport | Lifecycle owner | Operator needed |
|---|---|---|---|---|
| **`ephemeral`** *(default)* | temp, auto-deleted | `--remote-debugging-pipe` | axis | **never** |
| **`managed`** *(new default for auth work)* | dedicated dir, persists | `--remote-debugging-pipe` | axis | only first login per site |
| **`attach`** *(escape hatch)* | someone else's | TCP `/json/version` | external | yes, explicitly |

Modes 1 and 2 **both use a pipe, not a port** — verified, not assumed (§12): the managed
Chrome runs with `--remote-debugging-pipe` and exposes no TCP LISTEN socket anywhere in
its process tree. Under them, "port 9222 is taken" cannot occur. Mode 3 is the only one exposed to port collisions, and the only one
that should ever escalate.

`ephemeral` and `managed` already work today (`src/bridge.ts:524-533`); `managed` was
unreachable **only** because the `browserUrl` branch at `src/bridge.ts:494` wins the
`else if` chain — removing that export (Phase 1) is sufficient to reach it.

**Naming caveat (updated):** these mode *names* began as this document's vocabulary. They
are now the real thing — `CHROME_DEVTOOLS_AXI_MODE` shipped in Phase 2.3 (`src/mode.ts`) and
accepts exactly `ephemeral` / `managed` / `attach` / `autoconnect`. Implicit selection from
whichever env var happens to be set is retained only as the fallback when `MODE` is unset.

### Mode selection today (broken precedence)

```
autoConnect  →  browserUrl  →  userDataDir  →  isolated
                ^^^^^^^^^^
                globally exported in ~/.zshrc, so nothing below is ever reached
```

### Proposed

Introduce one authoritative variable:

```
CHROME_DEVTOOLS_AXI_MODE = ephemeral | managed | attach     # default: ephemeral
                           (shipped with `autoconnect` as a fourth value)
```

Legacy inference retained for back-compat: `BROWSER_URL` set + `MODE` unset → `attach`,
**but now gated behind a preflight probe**.

---

## 5. Decision: which browser

> **Revised after review.** An earlier draft proposed Chrome for Testing for
> `ephemeral` and Chrome stable for `managed`. That split was incoherent: it justified
> Chrome for Testing on determinism grounds while simultaneously rejecting it on
> staleness grounds, and it made axis depend on a binary another tool owns. Corrected
> below.

**Axis uses Google Chrome (stable) for both modes. Modes differ by _profile_, not by
binary.**

| Mode | Binary | Profile | Rationale |
|---|---|---|---|
| `ephemeral` | Google Chrome stable | temp dir, auto-deleted | Determinism comes from the **fresh profile**, not a pinned binary. |
| `managed` | Google Chrome stable | `~/.axis-browser-data` | Holds real login cookies → must receive security patches. |
| — | **Ulaa, Helium** | — | **Never.** Reserved for the human. |

### Why not a dedicated binary at all?

A pinned binary only pays for itself when you need byte-identical rendering across runs
and machines — i.e. **visual regression**. Browser-bay's own routing table
(`SKILL.md`) sends visual regression to **Playwright**, which manages its own pinned
chromium in `~/Library/Caches/ms-playwright/`. Axis's actual job is compact diagnostics:
`snapshot`, `console`, `network`, `lighthouse`, `perf-*`, `heap`. **None of that needs a
pinned binary.**

Against that marginal benefit, a second binary costs: a second update path, a second
thing `doctor` must verify, a second stale-version failure mode, and — decisively —
a **cross-tool ownership conflict** (§6).

Sharing the Chrome stable *binary* with other tools is not a conflict. Multiple Chrome
processes with distinct `--user-data-dir` values coexist cleanly; that is the entire
isolation mechanism. Conflict arises from sharing a **profile dir**, a **port**, or a
**managed download** — none of which this design does.

`CHROME_DEVTOOLS_AXI_EXECUTABLE_PATH` (§8 Phase 2.1) still ships, as an **unset-by-default
escape hatch** for CI/Linux/pinning. It is a capability, not a policy.

### What we still get without a dedicated binary

The three benefits claimed for a dedicated binary are obtained another way:

1. **Version stability** — irrelevant once the profile is dedicated. The 150/151 split
   was caused by an *orphan surviving an update*, not by the update. Fixed by `reap` (§7).
2. **Safe process identification** — solved properly by **pid-file ownership**, not by
   `pkill` pattern-matching on binary names. Pattern-matching was always the fragile
   approach; see §6 on `pkill -f chrome-devtools-mcp`.
3. **No default-profile lock** — comes from the dedicated `--user-data-dir`, which we
   have regardless of binary.

### Port policy

In `ephemeral` and `managed` there is **no CDP port** — chrome-devtools-mcp drives
Chrome over `--remote-debugging-pipe`. For `attach` only: **abandon 9222 permanently.**
It is the universal Chromium default, which is exactly why Ulaa claimed it — and
CloakBrowser's CDP server mode is another routine claimant. Use **9333**, and never
trust a bare port: verify identity (§8 Phase 2.2).

---

## 6. Cross-tool conflict analysis (BrowserBay)

BrowserBay routes to many third-party tools, and **all seven are installed on this
machine** (`cloakbrowser`, `browser-act`, `notte`, `firecrawl`, `playwright`,
`agent-browser`, `browser-harness` all resolve on `PATH` — §12 receipts). So conflicts
here are live, not hypothetical.

Each row is tagged with how it was established. **V** = verified on this machine this
session; **D** = documented in the browser-bay skill but not verified here.

| Tool | Binary | Profile / state | Ports |
|---|---|---|---|
| **agent-browser** (vercel-labs) | **V** `~/.agent-browser/browsers/chrome-147.0.7727.50` (Chrome for Testing) | **V** `~/.agent-browser/*.{config,engine,pid,sock}` | **V** `--remote-debugging-port=0` (random) |
| **Playwright** / MS Playwright CLI | **V** `~/Library/Caches/ms-playwright/chromium-*` | project-local | **D** random |
| **CloakBrowser** | **V** installed at `~/.local/bin/cloakbrowser`; own stealth Chromium | own | **D** "CDP server mode" per `tool-stack.md`. **Default port NOT VERIFIED THIS SESSION** — `cloakbrowser --help` returned nothing usable. Treat as a *possible* port claimant; do not assume 9222. |
| **Browser Harness** | **V** `~/.local/bin/browser-harness`, Playwright-backed | **D** `$AXIS_BROWSER_HOME/browser-harness` | **D** n/a |
| **Notte / BrowserAct / Firecrawl** | **V** installed; cloud-backed | remote | **D** n/a |
| **Ulaa** (operator daily driver) | **V** `/Applications/Ulaa.app` | default | **V** holds `127.0.0.1:9222` (pid 96228) |
| **Axis Browser** *(this design)* | `/Applications/Google Chrome.app` | `~/.axis-browser-data` + OS temp | bridge only; **no CDP port** |

> An earlier draft asserted CloakBrowser "may claim 9222" in a table captioned as
> machine-verified. The skill docs say only "CDP server mode" and never name a port.
> Corrected above — the port-avoidance argument does not depend on it: 9222 is the
> Chromium-wide default, and Ulaa holding it is verified independently.

**Correction to an earlier draft:** `~/.agent-browser/browsers/` belongs to
**agent-browser (vercel-labs)** — not Browser Harness. It carries its own engine/pid/sock
files. Axis borrowing that Chrome for Testing would have created precisely the cross-tool
conflict this section exists to prevent. Another reason the §5 revision is correct.

### Conflicts this design actively avoids

- **Never** use `~/.agent-browser/browsers/*` — agent-browser's managed download; it is
  swapped on upgrade.
- **Never** use `~/Library/Caches/ms-playwright/*` — Playwright's.
- **Never** claim 9222 — contested by Ulaa, CloakBrowser, and every Chromium fork.
- **Never** globally export `CHROME_DEVTOOLS_AXI_PORT` — `src/cli.ts:76-82` warns it
  defeats per-session port derivation and forces concurrent sessions onto one port.

### Conflict found here — since fixed

**Resolved.** Recorded as found, with the fix noted inline; see the closing status list.

`~/.zshrc` `axis-reinit` **used to** run:

```zsh
pkill -f "chrome-devtools-mcp"        # ← killed EVERY chrome-devtools-mcp on the machine
```

`chrome-devtools-mcp` is a widely-used standalone MCP server. Nothing scoped that to
axis's own processes. Nothing was co-installed at the time (verified), so it never bit —
but it was a live cross-tool hazard. It has been **replaced with pid/group ownership**,
the same discipline `removePidFile` (`src/bridge.ts:108`) already applies: only act on
processes we recorded as ours. `axis-reinit` now resolves its targets with
`pgrep -f 'chrome-devtools-axi-bridge'` and kills those process groups. Verified against
`~/.zshrc`.

The two agent-browser Chrome trees seen during cleanup (PIDs 11920, 84441) are **not
orphans** — each has a live `agent-browser-darwin-arm64` parent (11919/84440), which is
agent-browser's normal persistent-daemon model. Axis must not touch them; their lifecycle
belongs to agent-browser.

---

## 7. Exact configuration per mode

### `ephemeral` — the default for everything that does not need a login

```zsh
# Shell: export NOTHING. This is the default.
```

| | |
|---|---|
| Trigger | no `MODE`, no `BROWSER_URL`, no `USER_DATA_DIR` |
| mcp args | `--isolated --headless` |
| Binary | Google Chrome stable (chrome-devtools-mcp default resolution) |
| Profile | temp dir, auto-deleted on close |
| Transport | `--remote-debugging-pipe` — **no TCP port** |
| Operator | **never** |
| Code path | `src/bridge.ts:529` (`--isolated`), `:532` (`--headless`) |

Add `CHROME_DEVTOOLS_AXI_HEADED=1` to watch it run. Already works today.

### `managed` — persistent shared session, still zero operator

```zsh
export CHROME_DEVTOOLS_AXI_MODE=managed
export CHROME_DEVTOOLS_AXI_USER_DATA_DIR="$HOME/.axis-browser-data"
# no URL, no port — nothing else
```

| | |
|---|---|
| Trigger | `USER_DATA_DIR` set (and `BROWSER_URL` **not** set) |
| mcp args | `--userDataDir=$HOME/.axis-browser-data --headless` |
| Binary | Google Chrome stable |
| Profile | `~/.axis-browser-data`, **persists across runs → cookies survive** |
| Transport | `--remote-debugging-pipe` — **no TCP port** |
| Operator | only `axis-browser login <url>`, once per site |
| Code path | `src/bridge.ts:527` |

This is what "shared session" should have meant all along. chrome-devtools-mcp launches
and owns Chrome; the profile on disk is what is shared, not an endpoint. **Works today
the moment `BROWSER_URL` stops shadowing it** (`src/bridge.ts:494`).

Concurrency caveat: Chrome locks a profile dir to one process. Concurrent sessions need
per-session profile dirs (§8 Phase 2.8).

### `attach` — escape hatch, the only mode that may escalate

```zsh
export CHROME_DEVTOOLS_AXI_MODE=attach
export CHROME_DEVTOOLS_AXI_BROWSER_URL=http://127.0.0.1:9333   # NOT 9222
```

| | |
|---|---|
| mcp args | `--browserUrl=…` or `--wsEndpoint=…` |
| Binary/profile | **not ours** — owned by whoever launched it |
| Transport | TCP; identity **must** be probed first |
| Operator | yes, explicitly |
| Code path | `src/bridge.ts:494-523` |

Note upstream `aa162e8` deliberately withholds keychain-isolation flags in attach mode:
*"that browser's keychain policy belongs to whoever started it."* Upstream is signalling
the same thing this document argues — **launch modes are the owned, hardened path;
attach is the unowned one.** Treat `attach` as a last resort, not a default.

---

## 8. Implementation plan

### Phase 0 — machine hygiene *(done during this review)*

- [x] Reaped 5 orphaned bridge process groups (26735, 7862, 9374, 68031, 11562)
- [x] Reaped the orphaned headless Chrome — the "stuck Chrome"; all `Google Chrome`
      processes now gone, Ulaa untouched
- [x] ~~2 orphaned `Google Chrome for Testing` trees remain (PIDs 11920, 84441) — owned by
      Browser Harness. Reap separately.~~ **Withdrawn — wrong on both counts.** They belong
      to **agent-browser** (vercel-labs), not Browser Harness, and they are **not orphaned**:
      each has a live parent (`agent-browser-darwin-arm64`, PIDs 11919/84440). That is
      agent-browser's normal persistent-daemon model. **Do not reap them** — killing them
      disrupts live agent-browser sessions.

### Phase 1 — config *(APPLIED 2026-07-30; zero code)*

`~/.zshrc:435-565` (block was `436-509` before the rewrite). Backup at
`~/.zshrc.bak-20260730-134827`.

Removed — each of these was globally exported into every shell, including agents':

```zsh
export CHROME_DEVTOOLS_AXI_BROWSER_URL="$CHROME_AUTOMATION_CDP_URL"  # forced attach mode
export BU_CDP_URL="$CHROME_AUTOMATION_CDP_URL"                       # no consumer found
export CHROME_AUTOMATION_CDP_URL="http://127.0.0.1:${CHROME_AUTOMATION_PORT}"
export CHROME_DEVTOOLS_AXI_PORT="${CHROME_DEVTOOLS_AXI_PORT:-9224}"  # see src/cli.ts:76-82
```

Added:

```zsh
export CHROME_DEVTOOLS_AXI_USER_DATA_DIR="${CHROME_DEVTOOLS_AXI_USER_DATA_DIR:-$HOME/.axis-browser-data}"
export CHROME_AUTOMATION_PORT="${CHROME_AUTOMATION_PORT:-9333}"   # attach-mode only, off 9222
```

> `CHROME_DEVTOOLS_AXI_MODE=managed` was **deliberately not set** when Phase 1 was applied,
> because `MODE` did not exist yet and exporting it would have been inert and misleading.
> **That constraint is gone** — Phase 2.3 shipped it (`resolveMode`, `src/mode.ts`). Managed
> mode is still reachable via `USER_DATA_DIR` alone; setting `MODE` explicitly is now the
> clearer option, and it is what `doctor` reports. Scope it per command or project, never as
> a global shell export — that is the failure this whole document is about.

Helpers restructured so no recovery path lives only in interactive zsh:
`axis-init` now reports status only; `axis-login` does the interactive login handoff and
warns about the Chrome profile lock; `axis-attach`/`axis-detach` make attach mode explicit
and **probe endpoint identity**, naming the port holder via `lsof` instead of guessing;
`axis-reinit`'s `pkill -f chrome-devtools-mcp` — which matched *any* tool's MCP server —
is now scoped to axis's own bridge process groups (§6).

**Verified this session** (receipts in §12): clean-env probe shows `BROWSER_URL`, `AXI_PORT`,
and `BU_CDP_URL` all unset, `USER_DATA_DIR` set, `CHROME_AUTOMATION_PORT=9333`.

**Operator action still required:** restart the terminal and any running agent session.
Processes launched before the edit keep the old exports; this is not observable from
inside such a session.

### Phase 2 — axis-browser code *(IMPLEMENTED 2026-07-30)*

All eight items are built, tested, and exercised live. New modules: `src/mode.ts`,
`src/target.ts`, `src/doctor.ts`, `src/reap.ts`. New commands: `doctor [--json]`,
`reap [--dry-run] [--min-age-hours N]`, `login <url>`. Suite 483 -> 559.

| Item | Status | Where |
|---|---|---|
| 2.1 `--executablePath` passthrough | done | `src/bridge.ts buildTransportArgs` |
| 2.2 endpoint identity probe | done | `src/target.ts` |
| 2.3 explicit mode dispatch | done | `src/mode.ts` + `buildTransportArgs` |
| 2.4 mode-aware errors | done | `src/client.ts buildBridgeEarlyExitError` |
| 2.5 `doctor [--json]` | done | `src/doctor.ts` |
| 2.6 `reap` + auto-reap on bridge start | done | `src/reap.ts` |
| 2.7 `login <url>` | done | `src/cli.ts handleLogin` |
| 2.8 profile-lock guards | done | `src/mode.ts` (per-session dirs + real-profile veto) |

Two decisions worth recording, both departures from the letter of the plan:

- **Auto-reap is on by default but strictly bounded** (open question 2). It fires only on
  the bridge-*spawn* path — never on the reuse fast path — and only against processes
  carrying our own bridge marker, claimed by no session, and at least 4 h old.
  `CHROME_DEVTOOLS_AXI_AUTO_REAP=0` disables it.
- **A locked profile is only reported as a blocker when this session's bridge is not
  answering.** The first live run flagged managed mode's own healthy browser as a problem;
  a field that cries wolf during normal operation trains readers to ignore it.
- **An unreadable session PID file suppresses automatic reaping** (Dev B's review, and he
  is right). A file that cannot be parsed is an *unverifiable* claim, not an absent one —
  a live bridge whose PID file was truncated by a crash would otherwise be group-killed at
  the age floor. Manual `axis-browser reap` still acts on it, and `doctor` reports both the
  file and the suppression, because a safety mechanism that switches itself off silently is
  how the next incident starts.

> **Behaviour change to watch — per-session profiles relocate state.** 2.8 derives
> `<base>/sessions/<name>` for any *named* session. Before this change a named session with
> `CHROME_DEVTOOLS_AXI_USER_DATA_DIR=/x` used `/x` directly; it now uses
> `/x/sessions/<name>` and therefore starts logged **out**. This is deliberate — Chrome
> locks a profile to one process, so two concurrent named sessions on one directory do not
> merely interfere, the second fails to launch — but it means the shared logged-in profile
> is inherited only by the **default** session. `doctor` lands this case explicitly
> (`NEEDS_INTERACTIVE_LOGIN` plus `axis-browser login <url>`) rather than failing opaquely.
> If agents are expected to share one logged-in profile, they must share the default
> session name and run one at a time.


**2.1 `--executablePath` passthrough** — the one genuinely missing feature.
`src/bridge.ts:482 buildTransportArgs()`. chrome-devtools-mcp supports `-e,
--executablePath`; axis exposes no equivalent. Add
`CHROME_DEVTOOLS_AXI_EXECUTABLE_PATH` → `--executablePath=<p>`. Required to pin Chrome
for Testing in `ephemeral` mode. Document in `src/cli.ts` `TOP_HELP` (~line 64-98).

**2.2 New `src/target.ts` — endpoint identity**

```ts
probeCdpEndpoint(baseUrl, timeoutMs)
  → { ok: true, browser, wsUrl }
  | { ok: false, reason: 'NO_LISTENER'|'NOT_CDP'|'WRONG_BROWSER'|'TIMEOUT', holder? }

describePortHolder(port) → { pid, command } | null      // lsof; no-op on win32
```

Validity = HTTP 200 **and** parseable JSON **and** `webSocketDebuggerUrl` present
**and** `Browser` matches `/^(Headless)?Chrome\//`. A 200 alone is not proof — Ulaa
returned 404s, but a squatter returning 200 would have been worse.

**2.3 Mode selection** — `src/bridge.ts:482`. Replace the implicit `else if` chain
with explicit `CHROME_DEVTOOLS_AXI_MODE` dispatch. In `attach`, **probe before
spawning the transport**; abort with the holder identity rather than letting
chrome-devtools-mcp fail opaquely 30s later.

**2.4 Mode-aware errors** — `src/client.ts:333 buildBridgeEarlyExitError()`. Must never
suggest Chrome-launch remedies in `attach`/`managed`. Add a literal line to attach-mode
failures:

> Local CDP has no authentication. Do not request credentials, tokens, or a ws:// URL.

This kills the hallucination at the source.

**2.5 `axis-browser doctor [--json]`** — the highest-leverage anti-escalation lever.
Machine-readable preflight an agent runs *first*:

```json
{ "mode": "managed", "endpoint": {...}, "binary": {...}, "profile": {...},
  "bridges": [...], "orphans": [...], "remedies": ["axis-browser reap", ...] }
```

**Every remedy must be a runnable command, not prose.** The agent should receive a
fix, not a diagnosis. Reuse `chromeCheck()` (`src/setup.ts:441`) — brand detection
already exists there and has never been wired to the runtime path.

**2.6 `axis-browser reap`** — kill orphaned bridge process-groups and managed Chromes
older than N hours. Call it from `ensureBridge()` (`src/client.ts:381`) with a
conservative threshold. `runBridge` already kills its own process group on exit
(`src/bridge.ts:716-724`); the leak is from bridges killed with `SIGKILL` or lost to
crashes, which never run that handler. Six orphan trees accumulated in ~5 days.

**2.7 `axis-browser login <url>`** — the *only* sanctioned operator touchpoint. Opens the
managed profile **headed**, waits for human login, verifies the cookie landed, exits.
One-time per site; every run after is silent.

**2.8 Profile-lock guards.** Chrome locks a `user-data-dir` to one process. Two
concurrent sessions on one profile will fail. Derive per-session profile dirs alongside
the existing per-session port derivation, and have `doctor` report a held lock
explicitly. Also hard-refuse any `userDataDir` resolving inside
`~/Library/Application Support/Google/Chrome` — that is the silent-no-bind trap.

### Phase 3 — browser-bay skill doctrine

Rewrite `~/.claude/skills/browser-bay/SKILL.md:183-201`. Current text *mandates*
escalation. Replace with:

1. Run `axis-browser doctor --json` before any browser task.
2. Execute `remedies[]` — they are runnable.
3. Escalate **only** for `NEEDS_INTERACTIVE_LOGIN` (profile has never logged into this
   site) or `PORT_HELD_BY_FOREIGN_PROCESS` (killing the operator's browser is their call).
4. State explicitly: **local CDP has no auth — never request credentials, tokens, or
   ws:// URLs.**

Also promote the other session agent's independent discovery to doctrine, ranked **above** escalation:
when a run needs an authenticated session and none exists, **provision a throwaway
account via the app's own tooling** (`wp-cli user create` → run → `wp user delete`)
rather than borrowing a human session. That was the correct instinct and should be the
documented default for local test sites.

---

## 9. Upstream sync — 0.1.26 → 0.1.27 *(APPLIED — commit `c9d1429`)*

`upstream = github.com/kunchenguid/chrome-devtools-axi`. We are on **0.1.26**; upstream
`main` is **7 commits ahead** at **0.1.27**.

### Two commits matter directly

**`4ee5a49` — `fix(bridge): reject non-loopback Host/Origin` (GHSA-x439-jhfh-v9x2). SECURITY.**

> **The advisory ID is real — verified 2026-07-30.** It was challenged in review as
> hallucinated because `github.com/advisories/GHSA-x439-jhfh-v9x2` returns 404 and it is
> absent from `ChromeDevTools/chrome-devtools-mcp`'s advisories. Both observations are
> correct and neither is evidence of forgery: it is a **repository-level** advisory on
> **`kunchenguid/chrome-devtools-axi`** (this fork's actual upstream — *not* the
> chrome-devtools-mcp repo), and it carries **no CVE**, so it is not indexed in the global
> advisory database. Receipt:
>
> ```
> $ gh api /repos/kunchenguid/chrome-devtools-axi/security-advisories \
>     --jq '.[] | {ghsa_id, state, severity, published_at, cve_id, summary}'
> {"cve_id":null,"ghsa_id":"GHSA-x439-jhfh-v9x2","published_at":"2026-07-22T04:52:11Z",
>  "severity":"high","state":"published",
>  "summary":"DNS rebinding against the unauthenticated local bridge yields full control
>             of the user's Chrome session via arbitrary CDP commands"}
> ```
>
> Published, high severity, and the summary matches this fix exactly. **Do not remove or
> replace the citation.** Checking the global index or the wrong upstream repo will keep
> producing a false negative — check the repo advisories endpoint above.

> The bridge exposes `GET /health`, `GET /tools`, `POST /call` on 127.0.0.1:9224 with no
> Host, Origin, or auth checks. `POST /call` maps straight to `client.callTool`, i.e.
> arbitrary CDP execution. Any page the victim visits can DNS-rebind its own domain to
> 127.0.0.1 and drive CDP from the victim's browser (read authenticated pages, exfiltrate
> cookies, navigate, SSRF). Binding to loopback does not stop this.

**This fork is vulnerable today.** The fix adds an anti-rebinding gate checked first on
every route. This alone justifies prioritising the sync above all Phase 2 work.

Note the interaction with this design: `managed` mode makes the bridge *more* valuable to
an attacker, because the browser behind it is logged in. Ship the sync **before** the
persistent profile.

**`aa162e8` — `fix(bridge): enforce keychain isolation for launched Chrome`.**
Launch modes (`--isolated` / `--userDataDir`) now pass `--use-mock-keychain` and
`--password-store=basic`, so a browser axis starts cannot reach the operator's OS
password store. Attach modes deliberately omit them. Directly hardens `managed` mode and
independently corroborates §7's ownership argument.

### Scope of the sync — smaller than first estimated

> **Correction.** An earlier draft cited "101 files, +4328/−7688, `src/setup.ts` deleted
> upstream." That was the **total fork↔upstream divergence** (which includes all of this
> fork's own work), not the merge delta. Measured properly from the merge base
> (`27e291a`, 0.1.26), upstream's 7 commits touch **18 files**:

| Upstream change since merge base | Notes |
|---|---|
| `src/bridge.ts` (+140) | The rebinding gate + keychain flags. **The only source file touched.** |
| `test/bridge.test.ts` (+276), `test/keychain-isolation.test.ts` (+162, new) | Coverage for both |
| `README.md`, `CHANGELOG.md`, `AGENTS.md`, `VISION.md`, `.no-mistakes/**`, CI, release manifest | Docs + upstream process artifacts |

**`src/skill.ts` was not touched by upstream at all**, so the fork's `src/setup.ts`
(its divergent descendant) is unaffected. Phase 2.5's plan to reuse `chromeCheck()` at
`src/setup.ts:441` **stands** — nothing deletes that file.

### Resolution record

| Conflict | Resolution |
|---|---|
| `AGENTS.md`, `.release-please-manifest.json`, `.github/workflows/no-mistakes-required.yml` (modify/delete) | Kept deleted — fork removed these deliberately (`4b00a5b`) |
| `.no-mistakes/**`, `VISION.md` (upstream additions) | Dropped — fork carries no upstream process artifacts |
| `CHANGELOG.md` | Kept fork's header + format; logged both upstream fixes under `## Unreleased → ### Security` rather than importing release-please's format |
| `README.md` | Kept fork's line; placed upstream's *Keychain isolation* section after the auto-connect block, rebranded to "Axis Browser" |
| `src/bridge.ts` **#1** — anti-rebinding gate vs fork's request `try/catch` | **Both kept.** Gate runs first (upstream's stated intent: checked first on every route), fork's try/catch wraps routing behind it |
| `src/bridge.ts` **#2** — `void handleBridgeRequest(…, logBridgeMessage)` vs fork's `.catch()` backstop | **Both kept.** Passes `logBridgeMessage` as `logForbidden` *and* retains the `.catch()` so one failed request cannot kill the bridge |

### Verification

- `tsc --noEmit` clean; **477/477 tests pass** (incl. upstream's 11 keychain + 81 bridge tests).
- `createBridgeServer` has **no upstream unit coverage**, and conflict #2 lives there — so
  it was verified by a purpose-written e2e: loopback/localhost Host → 200; `evil.example.com`
  Host → **403** (on `/tools` *and* `/health`); non-loopback `Origin` → **403**; refusals
  logged to stderr (proving the `logForbidden` wiring); a throwing client → **500** with the
  bridge still serving (proving the fork's backstop survived).

---

### Hard ordering constraint (raised by Dev B — accepted)

**The anti-rebinding fix must be on `main` before managed mode is adopted there.**

`nirmantix/main` is `ee397f9` — **pre-patch**. The installed `axis-browser` that agents
invoke is built from it, so it runs the vulnerable bridge today; `c9d1429` is still only on
`sync/upstream-0.1.27`. Managed mode makes that bridge strictly more valuable to an
attacker, because the browser behind it holds real login cookies. Shipping managed mode
onto an unpatched `main` would enlarge the blast radius of an unfixed DNS-rebinding hole.

This also corrects an overstatement earlier in this document: managed mode is not
*currently* raising the attack surface, because `BROWSER_URL` made it unreachable until
Phase 1. The added value to an attacker arrives **with** managed adoption — which is
exactly why this is a hard ordering constraint and not a preference.

---

## 10. Phasing

| Phase | Effort | Unblocks |
|---|---|---|
| 0 — hygiene | done | stuck Chrome, leaked bridges |
| 1 — zshrc | ~15 min | **the entire incident class**, immediately |
| 2.1 — executablePath | done | dedicated binary pinning |
| 2.2-2.4 — probe + errors | done | no more misleading diagnostics |
| 2.5-2.6 — doctor + reap | done | agent self-service; leak stops |
| 2.7-2.8 — login + locks | done | first-login handoff, concurrency |
| 3 — skill doctrine | ~1 h | agents stop escalating by instruction |

Phase 1 alone would have prevented the incident. Phase 2.5 is what makes future
unknowns self-serviceable.

---

## 11. Open questions — resolved 2026-07-30

Answered during Phase 2 implementation. Recorded here so they are not re-litigated.

0. **Upstream sync ownership.** ~~Blocks Phase 2.~~ **Moot.** The premise was wrong:
   `src/setup.ts` was *not* deleted upstream (595 lines, present) and there is no
   `src/skill.ts`. The 0.1.27 merge touched 18 files, only `src/bridge.ts` in source.
   Nothing blocked Phase 2.
1. **`CHROME_DEVTOOLS_AXI_MODE` vs inference.** **Both.** `MODE` is explicit and wins;
   inference is retained verbatim as the fallback, so every existing setup behaves
   identically. An unsatisfiable explicit mode (`attach` with no URL) throws at the front
   door instead of failing opaquely ~30 s later inside chrome-devtools-mcp.
2. **Automatic `reap` inside `ensureBridge`?** **Yes, bounded.** Spawn path only, our own
   bridge marker only, unclaimed only, ≥4 h only; `CHROME_DEVTOOLS_AXI_AUTO_REAP=0` opts
   out. The reuse fast path is untouched, so nothing can reap a bridge a command wants.
3. ~~Chrome for Testing sourcing.~~ **Resolved (§5):** axis uses Chrome stable for both
   modes and sources no browser of its own.
4. **Is `CHROME_DEVTOOLS_AXI_EXECUTABLE_PATH` worth shipping?** **Yes.** Shipped. Linux/CI
   have no `/Applications/Google Chrome.app` and there was previously no escape hatch at
   all. `doctor` reports it and errors when the path does not exist, so the added surface
   is self-diagnosing.
5. **Where does `doctor` live post-sync?** **`src/doctor.ts`**, a sibling module. It reuses
   `chromeCheck()` from the surviving `src/setup.ts` — the brand detection that had never
   been wired to the runtime path.
6. **Ulaa on 9222.** **Leave it.** We moved off 9222 entirely. `doctor` now names it as the
   port holder rather than guessing, which is all we needed from it. Confirmed live: the
   listener answers HTTP 404 on `/json/version`.

---

## 12. Verification receipts — 2026-07-30 session

Every runnable claim in this document, with the command that established it. Anything
not listed here is **NOT VERIFIED THIS SESSION** and is labelled as such inline.

### Repo gate (post-merge, commit `c9d1429`)

```
$ pnpm run typecheck        # tsc --noEmit -p tsconfig.check.json
(no output — clean)

$ pnpm run format:check
Checking formatting... All matched files use Prettier code style!

$ pnpm run build
BUILD OK

$ pnpm test
Test Files  21 passed (21)
     Tests  477 passed (477)

$ git log -1 --format="%h parents: %p"
c9d1429 parents: ca3db17 aa162e8      # both merge parents recorded
```

> `format:check` **failed** on the first audit pass — the hand-merged
> `handleBridgeRequest(...).catch(...)` call in `src/bridge.ts` violated Prettier.
> Fixed with `prettier --write` and folded into the merge commit via `--amend`.
> The original commit would have failed CI.

### Anti-rebinding gate (GHSA-x439-jhfh-v9x2), through `createBridgeServer`

**Coverage, stated precisely** (an earlier draft said "no upstream unit coverage", which
under-counted it): the *gate itself* has committed regression coverage — `test/bridge.test.ts`
unit-tests `extractHostHeaderHostname`, `isAllowedBridgeHost`, and `isRequestOriginAllowed`
(from :775), plus HTTP-level 403s through `handleBridgeRequest`. What has **no** committed
coverage is `createBridgeServer` — no test spins up its `Server` (`grep -n createBridgeServer
test/bridge.test.ts` → no matches) — and that is exactly where merge conflict #2 lived, so it
was exercised directly against a live server with a fake MCP client:

```
PASS  loopback Host allowed → got 200, want 200
PASS  localhost Host allowed → got 200, want 200
PASS  REBOUND Host rejected → got 403, want 403
PASS  REBOUND Host rejected on /health too → got 403, want 403
PASS  non-loopback Origin rejected → got 403, want 403
PASS  throwing client → 500, bridge survives → got 500, want 500
PASS  bridge still serving after a throw → got 503, want 503
[axis-browser] Rejected request with disallowed host: host=evil.example.com origin= GET /tools
```

The stderr line proves `logBridgeMessage` is wired through as `logForbidden`; the last
two lines prove the fork's `.catch()` backstop survived the merge. Harness was run from
the scratchpad and removed — it is not committed.

### Phase 1 shell config

```
$ env -i HOME=$HOME PATH=$PATH TERM=xterm zsh -ic 'echo ...'
BROWSER_URL=[<unset>]              # the root cause — gone
USER_DATA_DIR=[$HOME/.axis-browser-data]   # real output showed the expanded absolute path;
                                           # written as $HOME here because test/setup.test.ts
                                           # forbids machine-specific paths anywhere under docs/
AXI_PORT=[<unset>]                 # per-session derivation restored
AUTOMATION_PORT=[9333]             # off the contested 9222
BU_CDP_URL=[<unset>]
```

`env -i` matters: a plain `zsh -ic` **still reported the old values**, because this
session inherited them at launch. The first check was a false negative.

```
$ zsh -ic 'axis-attach 9222'
❌ Port 9222 is held by Ulaa (pid 96228), which is not a CDP endpoint.
   Pick another port or stop that process. Refusing to guess.
EXIT=1
# and: nothing on 9333, zero Chrome on the axis profile — it refused without launching

$ zsh -ic 'axis-reinit'    # with no bridges running (empty pgrep)
EXIT=0                     # no error on empty input
```

The `axis-attach 9222` output is the original incident's exact failure, now naming the
holder instead of escalating.

### Cross-tool inventory

```
$ command -v cloakbrowser browser-act notte firecrawl playwright agent-browser browser-harness
# all seven resolve
$ ls -d ~/.agent-browser ~/Library/Caches/ms-playwright
# both exist
$ lsof -nP -iTCP:9222 -sTCP:LISTEN
Ulaa  96228  nites  192u  IPv4  TCP 127.0.0.1:9222 (LISTEN)
$ curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:9222/json/version
404
```

### Managed mode, end-to-end — VERIFIED (was the doc's weakest premise)

Previously listed here as *not verified*; Dev B correctly pushed back that the doc
asserted pipe transport and cookie persistence as fact on inference alone. Executed:

```
$ env -u CHROME_DEVTOOLS_AXI_BROWSER_URL -u CHROME_DEVTOOLS_AXI_PORT \
    CHROME_DEVTOOLS_AXI_SESSION=verifymanaged \
    CHROME_DEVTOOLS_AXI_USER_DATA_DIR=<scratch>/axis-managed-test \
    node dist/bin/chrome-devtools-axi.js open https://example.com
page: title: Example Domain            # managed mode launches its own Chrome

# transport flags on the launched Chrome:
--remote-debugging-pipe --headless=new --use-mock-keychain --password-store=basic

# A CDP port would be a LISTEN socket. Checked on the main pid AND every child
# (Chrome's page-fetch networking lives in the network-service child, so a check
# scoped to the main pid alone would not be conclusive):
$ lsof -nP -iTCP -sTCP:LISTEN -a -p <main_pid>
(none)
$ lsof -nP -iTCP -sTCP:LISTEN -a -p <main_pid>,<all_children>
(none anywhere in the tree)             # no listener at all — no port to squat

# cookie persistence across a full restart:
$ ... eval 'document.cookie = "axisverify=persisted123; path=/; max-age=3600"'
result: "axisverify=persisted123; path=/; max-age=3600"
chrome pid before stop: 39094
$ ... stop            -> status: stopped ; pid 39094 gone
$ ... open https://example.com
chrome pid after restart: 39330        # genuinely a new browser
$ ... eval 'document.cookie'
result: "axisverify=persisted123"      # SURVIVED
```

`env -u` is load-bearing: this session inherited `BROWSER_URL=…9222` at launch, so
without it the run would have tested *attach* mode. Upstream's keychain-isolation flags
are confirmed live in managed mode. Test profile deleted; no leftover Chrome or bridge;
Ulaa (pid 96228) untouched.

**Caveat that remains:** the pipe transport is supplied by upstream `chrome-devtools-mcp`,
not by axis. An upstream change to its default launch could still alter behavior without
any axis change — which is why the fork pins `chrome-devtools-mcp` at exactly **1.9.0**,
spawns it package-locally, and has `doctor` assert mode and transport explicitly.
*(Updated 2026-09-27: `CHROME_DEVTOOLS_AXI_MODE` now lives in `src/mode.ts`; the "nowhere
in `src/`" sentence was true at writing and is no longer.)*

### Still not verified this session

- **CloakBrowser's default CDP port** — `cloakbrowser --help` returned nothing usable.
- ~~**Phase 2 code** — not written; this document is the plan for it.~~ **Superseded.** Phase 2 is
  implemented and verified — see §8 Phase 2 and the receipts in §13. `src/mode.ts`, `src/doctor.ts`,
  `src/reap.ts`, and `src/target.ts` exist, and `login` / `doctor --json` / `reap` /
  `CHROME_DEVTOOLS_AXI_MODE` are all present in the installed 0.1.27 CLI. This bullet was left
  behind when §8 was updated in place; corrected during the Phase 3 pass.

---

## 13. Phase 2 verification receipts — 2026-07-30

Every line below was produced by a command run this session.

**Gate.** `format:check` clean; `tsc --noEmit -p tsconfig.check.json` rc=0; `build OK`;
`Test Files 25 passed (25)` / `Tests 559 passed (559)` (was 483 — +76).

**`doctor` diagnosing the original incident, live.** Run in a shell that still carried the
pre-fix export, it reproduced the whole diagnosis in about two seconds:

```
status: error
mode: attach
endpoint: http://127.0.0.1:9222 - NOT_CDP (HTTP 404)
  held by: Ulaa (pid 96228)
blockers:
  - The port is held by Ulaa (pid 96228) - that is not a CDP server, so attaching cannot work.
  - Local CDP has no authentication. Do not request credentials, tokens, or a ws:// URL.
  - PORT_HELD_BY_FOREIGN_PROCESS
remedies (runnable):
  $ unset CHROME_DEVTOOLS_AXI_BROWSER_URL
  $ export CHROME_DEVTOOLS_AXI_MODE=managed
  $ axis-browser start
```

**The remedies were then executed verbatim** and the result was a working managed session:
`status: ready port: 9232`, `doctor` -> `status: ok`, and `axis-browser open` returned a
real snapshot (`title: Voxel - Just another WordPress site`, 25 refs). The per-session
profile directory (`.../sessions/phase2check`) was created by that run, confirming 2.8.

**Two defects found by live testing, both fixed and regression-tested:**

1. *`reap` would have killed live bridges.* A bridge is a three-process chain
   (`npm exec tsx` -> tsx CLI -> bridge) and only the innermost writes the PID file, so the
   two ancestors of a healthy bridge read as unclaimed. At >4 h they would have been
   group-killed, taking the live bridge with them. Found by running
   `reap --min-age-hours 0 --dry-run` against a live session and seeing it name that
   session's own npx/tsx pids. Fixed by claiming the whole process tree
   (`expandClaimedToTrees`); re-run at the same aggressive setting now reports
   `orphans: []`.
2. *`doctor` cried wolf about its own browser.* Managed mode reported the profile lock held
   by this session's healthy bridge as a blocker. Now only reported when the session's
   bridge is not answering.

**Interactive-only guard.** `axis-browser login` under a non-TTY refuses with instructions
rather than opening a browser nobody can see or close.

**No leaks.** After the live runs: zero bridge processes, zero test-profile Chromes, Ulaa
untouched.

---

## 14. Phase 3 — browser-bay skill doctrine *(APPLIED 2026-07-30)*

§8 Phase 3 is implemented. All edits are inside `skills/browser-bay/`; nothing outside the skill
changed except this document.

### What landed

| File | Change |
|---|---|
| `SKILL.md` | Connection Mode block replaced: `doctor --json` first (**scoped** to Axis/login tasks), execute `remedies[]`, escalate only for `NEEDS_INTERACTIVE_LOGIN` / `PORT_HELD_BY_FOREIGN_PROCESS`, and the no-credentials rule verbatim. Four axis modes documented, with `attach` + `autoconnect` grouped as unowned-browser escape hatches. Two-axis profile rule added. Parallel-task block now uses `env -u CHROME_DEVTOOLS_AXI_PORT`. |
| `SKILL.md` | Five ego-primary routing rows, ego lite under Optional tools, precedence rule over ego's own skill description, two imported Safety Rules (credential refusal, handoff hard-stop). |
| `references/auth-flow-testing.md` | The `--remote-debugging-port=9222` walkthrough and the "shared 9222" fallback row are **deleted**. Replaced by the ranked three-rung credential ladder, a login-page detection pattern, and a clearly-fenced "throwaway accounts on dev environments only" section for the autotyping examples. |
| `references/ego-browser.md` | **New.** Thin handoff doc; defers all API semantics to ego's own app-owned `SKILL.md`. |
| `scripts/check-prerequisites.sh` | Read-only `ego_signal()` reporting presence *and liveness*, wired into both the default report and the capability summary. |
| `references/tool-stack.md`, `tool-comparison.md` | ego lite added, plus rows for headless/CI, Lighthouse, login reuse, human handoff, parallel contexts, drivability, platform. |
| `references/ui-ux-review.md`, `form-flows.md` | Write-probe rule imported as tool-agnostic doctrine; ui-ux-review gained a "reviewing behind a login" section. |

### The two-axis profile trap (the reason Phase 3 needed more than a doctor call)

Login state is reachable only when **both** axes are right. The canonical statement of this rule for
agents lives in `skills/browser-bay/SKILL.md` → *Connection Mode Decision · Step 2*; this section is
the rationale behind it. **Citations below name symbols, not line numbers** — `src/mode.ts`,
`src/doctor.ts`, and `src/cli.ts` are actively edited, and an earlier draft of this section carried
line numbers that went stale within the hour.

- **Mode** — a profile exists only in `managed` (`resolveUserDataDir` returns `null` for every other
  mode), and `login` forces `managed` for its own invocation only (`handleLogin` in `src/cli.ts`
  assigns `process.env.CHROME_DEVTOOLS_AXI_MODE`). Inference cannot be relied on: `inferMode`
  (`src/mode.ts`) resolves `AUTO_CONNECT` → `BROWSER_URL` → `USER_DATA_DIR` → `ephemeral`, so a
  non-interactive shell that never inherited `USER_DATA_DIR` but *did* inherit a stale `BROWSER_URL`
  lands in **`attach`** — the original incident. Explicit `CHROME_DEVTOOLS_AXI_MODE=managed` wins
  over inference, makes `buildTransportArgs` (`src/bridge.ts`) skip its
  `mode === "attach" && browserUrl` branch, and resolves the default profile with no other variable
  set.
- **Session** — the default session maps to `~/.axis-browser-data`; any *named* session maps to
  `~/.axis-browser-data/sessions/<name>` (the `sessionName === DEFAULT_SESSION_NAME` branch of
  `resolveUserDataDir`), which starts empty.

These compose into a self-reinforcing loop the doctrine now defuses: a locked profile makes `doctor`
emit `CHROME_DEVTOOLS_AXI_SESSION=<name>-2 axis-browser start` → a fresh empty profile → the next
`doctor` pushes the `NEEDS_INTERACTIVE_LOGIN (profile has no state yet)` blocker → the agent
escalates for a login the operator already completed. Both strings are in `buildDoctorReport`
(`src/doctor.ts`). The skill now marks that remedy as concurrency-only and tells the agent to
resolve the lock instead.

### Verified during this pass

```
$ axis-browser doctor --json                    # inherited stale BROWSER_URL
  status: error · mode: attach · NOT_CDP (HTTP 404) · PORT_HELD_BY_FOREIGN_PROCESS (Ulaa, pid 96228)

$ CHROME_DEVTOOLS_AXI_MODE=managed axis-browser doctor --json    # same shell, stale var left set
  status: ok · mode: managed · blockers: [] · remedies: []
  profile: { dir: ~/.axis-browser-data, exists: true }
```

The `profile` object is emitted **only** in managed mode (`buildDoctorReport` assigns
`report.profile` inside its `mode === "managed"` branch), so its presence — not `mode` alone — is the
assertion worth gating on: an unsafe directory throws in `assertSafeUserDataDir` and leaves `profile`
unset, so `profile.dir` proves both *managed* and *safely resolved*.

**Do not assert on `profile.locked`.** It is transient — it reads `true` whenever any healthy axis
bridge currently holds the profile, which is the normal state mid-session, and `doctor` still reports
`status: ok` in that case because the holder is our own bridge. Gate on `profile.dir` /
`profile.exists` only.

### ego lite decisions

- **Specialist, never a global default.** Primary for five bands: authenticated interactive work,
  human handoff, parallel authenticated workspaces, rich editors, authenticated recurring
  extraction. Never for headless/CI, cross-browser, measurement, diagnostics, or public-page scrapes.
- **Routed to, not absorbed.** `~/.claude/skills/ego-browser` is a symlink into
  `/Applications/ego lite.app`, recreated on every launch and version bump, so folding it into
  browser-bay is impossible and editing it is futile. Precedence therefore lives in browser-bay.
  Same pattern browser-bay already uses for browser-act.
- **Chrome-under-axis keeps the middle ground.** ego cannot run headless, has no CDP port (nothing
  else can drive it), and offers no Lighthouse/perf/heap — so `managed` mode remains the default for
  authenticated-but-reproducible work. Split by consumer: a schedule → axis; a human → ego.
- **API drift is pinned.** The installed build exposes flat helpers + `cliLog`; the public repo's
  `main` is an unreleased v2 (facades, `console.log`, options-object `screenshot`). Examples are
  written against the installed skill, and `upstream/ego-lite` is pinned at `f260b21`.
- **Runtime-verified gotchas** now documented in `references/ego-browser.md`, none of them in ego's
  own `SKILL.md`. All five were established by running the installed build, and three were found
  only during the post-implementation self-audit:
  1. ego's `cwd` is `/`, so evidence paths must be absolute.
  2. `captureScreenshot` takes a **positional** path; an options object throws `ERR_INVALID_ARG_TYPE`.
  3. `listTaskSpaces()` reads stale immediately after `completeTaskSpace()`.
  4. **Full-page capture is `{ full: true }`, not `{ fullPage: true }` — and the wrong key fails
     *silently*.** On a 2600px-tall page, `{ full: true }` → `1701x2600` while `{ fullPage: true }`,
     `{ fullpage: true }`, and a bare `true` all returned `1716x1345` (viewport only) with no error.
     `fullPage` is the unreleased-v2 spelling. An earlier draft of the reference asserted `fullPage`;
     that was wrong and is corrected.
  5. **The caller's environment is not inherited.** `FOO=bar ego-browser nodejs …` leaves
     `process.env.FOO` undefined — the script runs inside the ego lite app process and sees the
     *app's* env (83 vars, incl. `HOME`), not the shell's. Same root cause as `cwd: /`. So the
     heredoc text is the only channel in: use unquoted `<<EOF` for path interpolation and escape any
     `$` the JavaScript needs as `\$`.

### Not done here (out of scope, still open)

- ~~`~/.zshrc` `axis-reinit` still runs `pkill -f "chrome-devtools-mcp"` unscoped (§6).~~
  **Done — this contradicted §8.** `axis-reinit` now reaps only axis's own bridge process
  groups (`pgrep -f 'chrome-devtools-axi-bridge'`, then a group-scoped `kill`); it no longer
  pattern-matches every `chrome-devtools-mcp` on the machine. Verified against `~/.zshrc`.
- The agent environment exports `CHROME_DEVTOOLS_AXI_PORT=9224`, which §6 forbids because it defeats
  per-session port derivation. It fails loudly (`BRIDGE_PORT_IN_USE_EXIT_CODE` → `BRIDGE_NOT_READY`,
  the `BRIDGE_PORT_IN_USE_EXIT_CODE` branch of `buildBridgeEarlyExitError` in `src/client.ts`), so
  the skill now prescribes `env -u CHROME_DEVTOOLS_AXI_PORT` for
  parallel work rather than changing the operator's environment.
