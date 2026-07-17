# Changelog

This changelog tracks public changes for Axis Browser.

Versions `0.1.18` and below are inherited from the upstream `chrome-devtools-axi`
release history.

## Unreleased

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
  `--full` is honored by 15 of 36 commands and silently dropped by the rest.
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
