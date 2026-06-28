# Upstream Sync Override Shield

This fork tracks upstream `kunchenguid/chrome-devtools-axi` while preserving
Axis Browser behavior. Use this file during upstream merges so fork-specific
logic is not overwritten by upstream defaults.

## Current Sync Target

- Fork repository: `Nirmantix/axis-browser`
- Upstream repository: `kunchenguid/chrome-devtools-axi`
- Current synced upstream version: `0.1.25`
- Integration strategy: merge upstream into the fork branch; do not rebase
  public fork history.

## Must-Preserve Package Identity

`package.json` must keep:

- `"name": "chrome-devtools-axi"`
- `"version": "0.1.25"` for this sync
- `bin.chrome-devtools-axi`
- `bin.axis-browser`
- `bin.axib`
- cross-platform `scripts.build` using `node -e` and `fs.chmodSync`
- no `build:skill` script
- no `skills/chrome-devtools-axi` entry in `files`
- `files`: `dist`, `LICENSE`, `README.md`

The package name remains upstream-compatible by design. Installation guidance
must still point users to `github:Nirmantix/axis-browser`, not npm
`chrome-devtools-axi`.

## Fork Runtime State

Keep the Axis state directory:

- `src/bridge.ts`: `STATE_DIR = join(homedir(), ".axis-browser")`
- `src/client.ts`: `STATE_DIR = join(homedir(), ".axis-browser")`
- `src/generation.ts`: `STATE_DIR = join(homedir(), ".axis-browser")`

Do not restore upstream `~/.chrome-devtools-axi` paths.

## Fork-Owned Update Command

`axi-sdk-js` provides an SDK built-in `update` command that targets the package
name on npm. That is wrong for this fork because npm `chrome-devtools-axi`
resolves upstream.

Keep the fork-owned command in:

- `src/cli.ts`: `handleUpdate`
- `src/cli.ts`: `COMMANDS.update = withoutFullFlag(handleUpdate)`
- `src/cli.ts`: `COMMAND_HELP.update`
- `src/cli.ts`: top-level help listing `update`

Required behavior:

- `axis-browser update` prints GitHub reinstall guidance.
- `axis-browser update --check` prints the same GitHub guidance.
- `axis-browser update --help` prints fork guidance, not SDK npm updater help.
- Top-level `--help` must not advertise "latest published npm version".
- No update path may run npm, Bun, or `npx` automatically.

Regression coverage:

- `test/main.test.ts`
- `test/cli.test.ts`
- `test/cli-runtime.test.ts`

## Explicit Hook Setup

Hook installation is now explicit:

- `src/cli.ts`: `setup hooks`
- `src/hooks.ts`: hook installer implementation

Do not restore automatic hook installation on normal CLI startup. Development
entrypoints must not mutate user agent config.

## Fork-Owned Setup Command

`setup` is fork-owned Axis workflow bootstrap behavior, not an upstream hook-only
command. Preserve:

- `src/setup.ts` as the setup engine for parsing, detection, router resolution,
  report formatting, and safe router script delegation.
- `src/cli.ts`: `handleSetup` must route `setup hooks` to
  `installHooksOrThrow()` and all other setup modes to `runSetupWorkflow`.
- `test/setup.test.ts` coverage for parser behavior, resolver precedence,
  absent-router reporting, non-interactive install preview, and project scoping.
- `axis-browser setup` as a read-only bootstrap report.
- `axis-browser setup --install` as opt-in, permission-gated setup behavior.
- `axis-browser setup --project <path>` for target project scoping.
- `axis-browser setup --json` as stable machine-readable status.
- `axis-browser setup hooks` as the existing Claude Code and Codex hook
  installer.

Required setup behavior:

- Default setup must not mutate files.
- Non-interactive `--install` must not hang on prompts; it previews commands
  unless the operator explicitly passes `--yes`.
- Setup must never write secrets, `.env` files, shell rc files, MCP credential
  files, or user credential stores.
- Resolve `browser-skill` in this order:
  `BROWSER_SKILL_DIR`, `AXIS_BROWSER_HOME/skills/browser-skill`,
  `AXIS_PORTABLE_SKILLS_DIR/browser-skill`, then standard agent skill
  locations.
- Do not hardcode personal workstation paths.
- If the router is absent, report core Axis status and say the router source is
  not configured unless `BROWSER_SKILL_SOURCE_URL` is set.
- Do not assume a public `browser-skill` repository URL until one exists.

## Rejected Upstream Skill And Infra

Do not accept these upstream paths into the fork:

- `skills/chrome-devtools-axi/`
- `src/skill.ts`
- `scripts/build-skill.ts`
- `test/skill.test.ts`
- `AGENTS.md`
- `.airlock/`
- `.agents/`
- `.no-mistakes/`
- `.github/workflows/release-please.yml`

`CLAUDE.md` is allowed only as optional fork-owned public onboarding if added
intentionally. Do not accept an upstream-generated Claude file by default.

If upstream reintroduces any of them, remove them from the merge result. Do not
rely on `.gitignore` to evict tracked files; use `git rm` for tracked upstream
paths.

## Dependency Policy

Runtime dependencies for this sync:

- `@modelcontextprotocol/sdk` `^1.29.0`
- `@toon-format/toon` `^2.3.0`
- `axi-sdk-js` `^0.1.8`

Dev dependencies stay same-major unless a separate migration is approved:

- TypeScript remains `5.x`
- Vitest remains `3.x`
- `@types/node` remains `22.x`
- no root `yaml` dev dependency unless a tracked source file imports it

Use caret-respecting updates for dev dependencies. Do not run a broad
`pnpm update --latest` during an upstream sync.

## Ignore Rules

Keep fork ignore hygiene:

- `skills/` remains ignored for local or nested skill work.
- `.local-docs/`, `.airlock/`, `.codex/`, `.claude/`, `.agents/`, `.pi/`, and
  `.tmp/` remain ignored.
- `browserbase-skills/` and `skills-main.zip` stay ignored.

## Verification Before Landing

Run:

```bash
pnpm install --frozen-lockfile
pnpm run build
pnpm test
node dist/bin/chrome-devtools-axi.js --version
pnpm exec axis-browser --version
pnpm exec axib --version
pnpm exec chrome-devtools-axi --version
node dist/bin/chrome-devtools-axi.js update
node dist/bin/chrome-devtools-axi.js update --check
node dist/bin/chrome-devtools-axi.js update --help
```

Expected version output for this sync:

```text
0.1.25
```
