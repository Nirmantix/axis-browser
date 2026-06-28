# Changelog

This changelog tracks public changes for Axis Browser.

Versions `0.1.18` and below are inherited from the upstream `chrome-devtools-axi`
release history.

## 0.1.25 (2026-06-27)

### Added

* sync upstream `0.1.23`-`0.1.25` runtime and test updates
* add `axis-browser setup` as a read-only Axis workflow bootstrap report with
  `--json`, `--project`, and non-interactive-safe `--install` modes
* detect Windows Chrome and Edge installs (machine-wide and per-user) and
  Chromium (machine-wide) in the `axis-browser setup` readiness report
* add optional `browser-skill` router detection through `BROWSER_SKILL_DIR`,
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
* add local `browser-skill` — host-neutral browser automation Agent Skills
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
