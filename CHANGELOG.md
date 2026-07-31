# Changelog

This changelog tracks public changes for Axis Browser.

Versions `0.1.18` and below are inherited from the upstream `chrome-devtools-axi`
release history.

## Unreleased

### Security

* **bridge: reject non-loopback Host/Origin to block DNS rebinding**
  (GHSA-x439-jhfh-v9x2, merged from upstream `0.1.27`). The bridge exposed
  `GET /health`, `GET /tools`, and `POST /call` on loopback with no Host, Origin,
  or auth checks, and `POST /call` maps straight to `client.callTool` — arbitrary
  CDP execution. Any page the victim visited could DNS-rebind its own domain to
  `127.0.0.1` and drive CDP from the victim's browser. An anti-rebinding gate now
  runs first on every route, ahead of this fork's request try/catch backstop
* **keychain isolation for launched Chrome** (merged from upstream). Launch modes
  (`--isolated`, `CHROME_DEVTOOLS_AXI_USER_DATA_DIR`) now always pass
  `--use-mock-keychain` and `--password-store=basic`, so a browser this tool starts
  cannot reach the machine owner's OS password store. Attach modes
  (`AUTO_CONNECT`, `BROWSER_URL`, `wsEndpoint`) deliberately omit them — that
  browser's keychain policy belongs to whoever started it

### Fixed

* installing the fork from GitHub produced a broken CLI: `dist/` is not
  committed and npm builds git installs via `prepare`, but only
  `prepublishOnly` was defined — so the packed tarball held 3 files and every
  `bin` alias pointed at a missing `dist/bin/chrome-devtools-axi.js`. Build on
  `prepare` instead
* element refs no longer go stale on unrelated DOM activity. The page-reported
  generation folded in a `MutationObserver` count, so any mutation anywhere in
  the document invalidated every ref in the snapshot — a spinner tick or
  re-render between `snapshot` and `click` was enough. The tag now identifies
  the snapshot a ref came from, and stays per-page
* `run` scripts validated nothing: `page.click` / `page.fill` stripped the
  generation tag and acted on a stale tree instead of failing with `STALE_REF`.
  They now validate exactly like the CLI handlers
* stopping the bridge before it finished binding raised an unhandled rejection,
  exiting 1 — which `ensureBridge` reported as a *startup* failure with
  misleading Chrome guidance. A clean stop now exits 0
* `engines.node` was `>=20`, but `import.meta.dirname` requires 20.11; users on
  20.0-20.10 would crash. Corrected to `>=20.11`
* `console` / `network` truncate at 2000 chars with no full-output option, and
  `--full` is honored by 15 of 39 commands and silently dropped by the rest.
  Both are now documented rather than implied to be global
* `setup` looked for pi's skills at `~/.pi/skills`, which pi never reads — its
  skills root is `~/.pi/agent/skills`, alongside `agents/` and `extensions/`.
  A BrowserBay install there was reported as missing
* a tagged ref is now rejected when the current page reports no snapshot state.
  It had fallen back to the session counter, so after a navigation — which wipes
  that state — a ref minted against the previous document was silently accepted.
  A failed probe still falls back, since it proves nothing about the page
* the bridge's `/health` branch sat outside the request try/catch and was
  dispatched with a bare `void`, so a throw there would have killed the bridge
  rather than failing one request. Bridge teardown likewise ran three cleanups
  in one `try`, so a server-close error skipped the client and transport
* `callTool` parsed the bridge response to `any` and returned it through a
  `Promise<string>`, letting a non-string `result` escape as a string
* `eval` honors `--full` but its help omitted it, so the flag read as
  unsupported
* the `prompts/` entry points and the docs that mirror them invoked
  `bash "$BROWSER_BAY_DIR/scripts/..."` directly. `BROWSER_BAY_DIR` is unset on a
  fallback or legacy install — the discovery order the same files documented —
  so the command degraded to `bash "/scripts/..."` and failed with a path error
  that named nothing useful. All four prompts, `README.md`,
  `docs/better-workflow-lifecycle-design.md`, and the microsite now resolve the
  directory first — `BROWSER_BAY_DIR`, then `$AXIS_BROWSER_HOME/skills`,
  `$AXIS_PORTABLE_SKILLS_DIR`, `./skills`, and the standard agent skill roots —
  and exit 2 with a real message when none match. The prompt contract test pins
  the resolver and rejects raw `$BROWSER_BAY_DIR/` paths, so this cannot regress
  silently
* the microsite rendered inline code as literal backtick characters. Seven of the
  eight pages wrote markdown-style `` `x` `` into HTML, where it has no meaning —
  `index.html` and `safety.html` had 60+ each and no `<code>` element at all, so
  readers saw the punctuation instead of styled code. 176 spans across the site
  are now real `<code>` elements, which `styles.css` has always styled
* a documented command block could rely on a resolver defined in a *different*
  block on the same page. `workflow.html`'s craft-mode snippet did exactly that,
  so copying that block alone still produced `node "/scripts/..."` — the file-level
  guard was green throughout. Every microsite `<pre>` that runs `$BB` now carries
  its own resolver, enforced per block rather than per file
* every documented resolver probed `browser-bay/` only, while the CLI has always
  accepted `browser-skill/` too (`SKILL_FOLDER_NAMES`). A legacy install resolved
  through `axis-browser setup` and reported "browser-bay not found" from every
  documented command. All five copies now probe both names, `browser-bay` first,
  and a test pins that dimension to the source the same way the roots already were
* `resolveBrowserSkillDir` had no coverage for the standard-location branch at
  all. Each entry in `STANDARD_AGENT_SKILL_PARENTS` is now tested, along with the
  legacy folder name and the `browser-bay`-wins-over-`browser-skill` precedence
* the lifecycle design doc advertised `.agents/skills/browser-bay/` as an install
  location. Nothing searches it: `STANDARD_AGENT_SKILL_PARENTS` (`src/setup.ts`)
  did not list it. `~/.agents/skills/` is now a supported location, appended so it
  cannot change which skill an existing install already resolves to, and the doc
  says plainly that these are `$HOME` paths — a `.agents/` directory at a project
  root is still not searched
* the CI `build-and-test (20.11)` matrix entry could never pass. `packageManager`
  is `pnpm@11.1.1`, which requires Node >=22.13, so `pnpm install` failed on the
  toolchain before any of this project's code ran — a permanently-red check that
  verified nothing. The floor `engines.node` claims is now verified by a dedicated
  `engines-floor` job that packs on a supported Node, then installs that tarball
  into a clean directory on 20.11 with plain npm and runs every documented alias
  from it. It installs rather than executing `dist/` in place because running
  `dist/` by path skips the `bin` wiring — the exact thing that broke once before
* the documented resolver stopped on a set-but-missing `BROWSER_BAY_DIR`, while
  `resolveBrowserSkillDir` continues to later candidates when the configured
  directory does not exist. A stale export therefore made every documented command
  exit 2 for a skill `axis-browser setup` resolves fine. All eight copies now accept
  `BROWSER_BAY_DIR` (and the legacy `BROWSER_SKILL_DIR`) only when it exists, then
  fall through — verified against the CLI across six scenarios
* `resolveSessionName` read `process.env` directly while `buildDoctorReport` is
  parameterised on `env`, so a session name passed to `doctor` was silently ignored
  and the report described a different environment than the one it was handed. It
  now takes an optional env, defaulting to `process.env`, and `doctor` passes its own
* the prompt tests asserted on shell fragments only, which cannot prove the resolver
  assigns a usable directory — a prompt could contain every expected string and still
  leave `BB` empty. They now execute the block each prompt actually ships and assert
  the resolved path, the exit-2 path, and the fall-through
### Changed

* the CLI presents itself as `axis-browser` everywhere — help, usage, examples,
  suggestions, error hints, and bridge logs. `chrome-devtools-axi` is the
  upstream base tool, and is named only where that distinction is the point
  (the `update` guidance warning that the npm package is not this fork). The
  `chrome-devtools-axi` and `axib` aliases still work
* blocked publishing (`private: true`): the package name belongs to upstream on
  npm, and this fork is distributed from GitHub
* refreshed dependencies, clearing 33 advisories (1 critical, 6 high) — all
  transitive through `@modelcontextprotocol/sdk` and a stale lockfile, with no
  SDK bump required
* `setup hooks` now writes `axis-browser` as the SessionStart command instead of
  `chrome-devtools-axi`, so the hook a user finds in their own agent config
  names the tool they installed. This is also the marker the SDK matches managed
  hooks by, so `setup hooks` first removes entries written under the previous
  marker — upgrading otherwise left both installed and fired two session hooks.
  The orphaned `axi-chrome-devtools-axi.js` opencode plugin is removed too.
  Unrelated hooks, including `chrome-devtools-mcp`, are untouched

### Removed

* dead exports with no caller in `src/` or `bin/`, which nothing outside could
  reach either — the package publishes no library entrypoint, only `bin`:
  `installHooks` (superseded by the explicit `setup hooks` command),
  `getHookTargets` (also incomplete — it omitted the opencode plugin the SDK
  writes), `computeHookUpdate` / `computeCodexConfigUpdate` (thin pass-throughs
  to `axi-sdk-js`; their tests now drive the SDK directly), `resetGeneration`,
  and `parseUid`. Also dropped a `wrapJsExpression` re-export that existed only
  so a test could import it from `cli.ts` rather than its real home

### Added

* **`axis-browser doctor [--json]`** — machine-readable preflight. Reports the
  active connection mode, the endpoint (probed for real: HTTP 200 *and* parseable
  JSON *and* a `webSocketDebuggerUrl` *and* a Chrome-shaped `Browser` string), the
  profile and whether it is locked, bridge and orphan state, and a `remedies` array
  in which **every entry is a runnable command, not prose**. Only two conditions
  escalate to a human: `NEEDS_INTERACTIVE_LOGIN` and `PORT_HELD_BY_FOREIGN_PROCESS`.
  Failures also state that local CDP has no authentication, because an agent that
  read a bare connection failure previously concluded it needed credentials and
  stopped work to ask for a `ws://` URL that does not exist
* **`axis-browser login <url>`** — one-time interactive sign-in on the managed
  profile. Opens a headed browser, waits, verifies something landed, then stops the
  bridge so the profile lock is released. Refuses to run without a TTY rather than
  opening a browser nobody can see or close
* **`axis-browser reap [--dry-run] [--min-age-hours N]`** — kill orphaned bridges.
  An orphan is defined structurally: a live process carrying our own bridge marker
  that no session's PID file claims. `runBridge` reaps its own process group on a
  clean exit, so the leak comes from bridges lost to `SIGKILL` or a crash — six such
  trees accumulated in about five days on one machine, each holding a port and an
  invisible browser
* **`CHROME_DEVTOOLS_AXI_MODE`** — `ephemeral` | `managed` | `attach` |
  `autoconnect`. The mode was previously only ever *inferred* from whichever
  variable happened to be set, in a silent `else if` chain, and no command's output
  ever named it. An explicit mode wins over inference; inference is unchanged when
  the variable is unset, so existing setups behave identically. An unsatisfiable
  mode (`attach` with no `BROWSER_URL`) now fails immediately with the fix instead
  of ~30s later inside `chrome-devtools-mcp`
* **`CHROME_DEVTOOLS_AXI_EXECUTABLE_PATH`** — pin the Chrome/Chromium binary to
  launch. Launch modes only; meaningless when attaching to a browser somebody else
  started. Linux and CI have no `/Applications/Google Chrome.app`, and there was
  previously no escape hatch at all
* **`CHROME_DEVTOOLS_AXI_AUTO_REAP`** — set to `0` to disable the automatic
  orphan cleanup that now runs when a bridge is spawned (own marker, unclaimed,
  ≥4h old, spawn path only — never the bridge-reuse fast path)

### Changed (connection model)

* **Named sessions get their own Chrome profile.** `managed` resolves
  `CHROME_DEVTOOLS_AXI_USER_DATA_DIR` for the default session and
  `<dir>/sessions/<name>` for any named `CHROME_DEVTOOLS_AXI_SESSION`. Chrome locks
  a profile to one process, so two concurrent named sessions on one directory did
  not merely interfere — the second failed to launch. **Migration:** a named session
  that previously used the base directory now starts logged out; `doctor` reports
  this as `NEEDS_INTERACTIVE_LOGIN` rather than failing opaquely
* **A `user-data-dir` inside a real browser profile is refused** (Chrome's default,
  Chromium, Edge, Brave, Ulaa; symlinks dereferenced before the check). Chrome
  accepts `--remote-debugging-port` on a default profile and then silently never
  binds it, and an automation run would contend for that profile's lock against the
  browser you use yourself
* **Bridge startup failures are mode-aware.** `attach` and `autoconnect` failures no
  longer suggest Chrome-launch remedies for a browser this tool never launched, and
  both state the no-authentication rule outright
* `pnpm typecheck` — the build config excludes `test/`, so tests were never
  typechecked and could reference symbols that no longer exist
* `pnpm format:check`, plus a CI quality job and a Node 20/22/24 matrix
  covering the range `engines` actually claims

## 0.1.26 (2026-07-09)

### Added

* sync upstream `0.1.26` runtime and test updates
* `CHROME_DEVTOOLS_AXI_CHANNEL` to select Chrome release channel (`stable` /
  `beta` / `canary` / `dev`) for auto-connect and launch modes
* `CHROME_DEVTOOLS_AXI_SESSION` for concurrent bridge isolation (per-session
  port and `~/.axis-browser/sessions/<name>/` state)
* resolve screenshot and other output paths from the caller cwd
* document project-scoped BrowserAct remote MCP setup
  (`docs/browseract-mcp-per-project.md`, `.mcp.browseract.example.json`);
  ignore local `.mcp.json` secrets in `.gitignore`
* BrowserBay shortcodes/prompts: `ensure-project-ready` gate before browser work

### Changed

* package version `0.1.26`; runtime state remains under `~/.axis-browser`
* reject upstream skill package and release-please artifacts from the merge
* rename the companion Agent Skills router from `browser-skill` to **BrowserBay**
  (`browser-bay`); setup still accepts legacy `BROWSER_SKILL_DIR`,
  `BROWSER_SKILL_SOURCE_URL`, and `skills/browser-skill` install paths
* prefer env `BROWSER_BAY_DIR` / `BROWSER_BAY_SOURCE_URL` for router discovery
* align `;abcheck` / `;abuse` and parent README with BrowserBay project gate

## 0.1.25 (2026-06-27)

### Added

* sync upstream `0.1.23`-`0.1.25` runtime and test updates
* add `axis-browser setup` as a read-only Axis workflow bootstrap report with
  `--json`, `--project`, and non-interactive-safe `--install` modes
* detect Windows Chrome and Edge installs (machine-wide and per-user) and
  Chromium (machine-wide) in the `axis-browser setup` readiness report
* add optional `browser-bay` router detection through `BROWSER_BAY_DIR`,
  `AXIS_BROWSER_HOME`, `AXIS_PORTABLE_SKILLS_DIR`, and standard agent skill
  locations
* add explicit `setup hooks` command for repairing agent `SessionStart` hooks
* add a fork-safe `update` command that prints GitHub update guidance instead of
  invoking the upstream npm self-updater
* add root `SKILL.md` discovery guidance that points agents to
  `axis-browser setup`
* add lifecycle documentation in `docs/setup_and_dev.md`
* add fork override documentation in `docs/upstream_sync.md`

### Changed

* update runtime dependencies, including `axi-sdk-js` `0.1.8`

### Removed

* remove the upstream generated Agent Skill package from the shipped fork

### Fixed

* prevent the SDK npm self-updater from routing Axis Browser users to upstream
  `chrome-devtools-axi`

### Preserved Fork Delta

* package name remains `chrome-devtools-axi` for compatibility
* install guidance remains GitHub-first for `Nirmantix/axis-browser`
* runtime state directory remains `~/.axis-browser`
* bin aliases remain `axis-browser`, `axib`, and `chrome-devtools-axi`
* release-please and upstream-only agent infrastructure remain disabled

## 0.1.22 (2026-05-15)

### Features

* sync upstream `0.1.19`–`0.1.22` updates (generation-tagged refs, deep health
  checks, stale bridge recycling, IIFE unwrapping, Codex hooks feature flag)
* add `CHROME_DEVTOOLS_AXI_MCP_PATH` env var for custom MCP binary path
* add `CHROME_DEVTOOLS_AXI_BRIDGE_TIMEOUT_MS` env var for slow npx bootstrap
* auto-detect globally-installed `chrome-devtools-mcp` for faster bridge startup
  (skips ~30s npx bootstrap when the package is installed globally)
* generation-tagged snapshot refs (`g<N>:uid`) with `STALE_REF` error on mismatch
* deep health checks (`/health?deep=1`) detect stale CDP targets automatically
* switch build system to pnpm (following upstream)
* add local `browser-bay` — host-neutral browser automation Agent Skills
  package maintained in an ignored nested repo when present; install it into
  the appropriate global or project agent skills location (`~/.codex/skills/`,
  `~/.claude/skills/`, `~/.config/opencode/skills/`,
  `~/.config/agents/skills/`, `.agents/skills/`, or via Kiro / AGENTS.md
  adapters) rather than through the Axis Browser package; the nested skill
  README is the source of truth for the full Claude Code, Codex, OpenCode, Pi,
  Kiro, AGENTS.md, and neutral `.agents` install matrix plus optional Notte and
  CloakBrowser guidance

### Bug Fixes

* recycle stale bridge processes via deep health probe instead of config fingerprinting
* handle function eval input wrapping (IIFE unwrapping)
* reject stale generation-tagged refs
* make `--type all` clear prior filters in console/network commands
* enable Codex hooks with hooks feature flag

### Removed

* bridge config fingerprinting (upstream stale-bridge recycling supersedes it)
* dedicated `~/.axis-browser/npm-cache` (upstream handles MCP resolution directly)
* `/shutdown` bridge endpoint (upstream removed it)

### Preserved Fork Delta

* runtime state directory remains `~/.axis-browser`
* bin aliases: `axis-browser`, `axib`, `chrome-devtools-axi`
* cross-platform-safe build chmod step
* Axis Browser branding and public docs

## 0.1.18 (2026-04-25)

### Features

* sync upstream `0.1.16`–`0.1.18` updates while preserving Axis Browser
  branding, compatibility commands, and `~/.axis-browser` runtime state
* support `CHROME_DEVTOOLS_AXI_AUTO_CONNECT` for Chrome 144+ auto-connect
* support `ws://` and `wss://` browser endpoints plus
  `CHROME_DEVTOOLS_AXI_WS_HEADERS`
* brand the public CLI and docs as Axis Browser while keeping upstream-compatible
  package identity and commands (`axis-browser`, `axib`, and
  `chrome-devtools-axi`)
* restart the bridge when the shared Chrome target changes instead of silently
  reusing a stale session

### Bug Fixes

* harden bridge startup with dedicated `~/.axis-browser` runtime state,
  managed `chrome-devtools-mcp` cache, stale bridge recovery on port `9224`,
  and installed-build preference for the compiled bridge entrypoint
* keep bridge fingerprinting aligned with the effective connection mode,
  including auto-connect and websocket headers

## [0.1.17](https://github.com/kunchenguid/chrome-devtools-axi/compare/chrome-devtools-axi-v0.1.16...chrome-devtools-axi-v0.1.17) (2026-04-16)

### Bug Fixes

* **ws:** support websocket browser endpoints and validate ws headers ([#37](https://github.com/kunchenguid/chrome-devtools-axi/issues/37))

## [0.1.16](https://github.com/kunchenguid/chrome-devtools-axi/compare/chrome-devtools-axi-v0.1.15...chrome-devtools-axi-v0.1.16) (2026-04-16)

### Features

* add CHROME_DEVTOOLS_AXI_AUTO_CONNECT for Chrome 144+ autoConnect ([#33](https://github.com/kunchenguid/chrome-devtools-axi/issues/33))
* support ws:// and wss:// browser URLs plus CHROME_DEVTOOLS_AXI_WS_HEADERS

## [0.1.15](https://github.com/kunchenguid/chrome-devtools-axi/compare/chrome-devtools-axi-v0.1.14...chrome-devtools-axi-v0.1.15) (2026-04-11)

### Features

* add BROWSER_URL and USER_DATA_DIR env vars for persistent sessions ([#30](https://github.com/kunchenguid/chrome-devtools-axi/issues/30))

## [0.1.14](https://github.com/kunchenguid/chrome-devtools-axi/compare/chrome-devtools-axi-v0.1.13...chrome-devtools-axi-v0.1.14) (2026-04-10)

### Features

* add headed mode, custom Chrome args, and GPU docs ([#25](https://github.com/kunchenguid/chrome-devtools-axi/issues/25))

## [0.1.13](https://github.com/kunchenguid/chrome-devtools-axi/compare/chrome-devtools-axi-v0.1.12...chrome-devtools-axi-v0.1.13) (2026-04-10)

### Bug Fixes

* **homeview:** reduce verbosity in home view ([#26](https://github.com/kunchenguid/chrome-devtools-axi/issues/26))

## [0.1.12](https://github.com/kunchenguid/chrome-devtools-axi/compare/chrome-devtools-axi-v0.1.11...chrome-devtools-axi-v0.1.12) (2026-04-03)

### Features

* migrate CLI to axi-sdk-js ([#21](https://github.com/kunchenguid/chrome-devtools-axi/issues/21))
