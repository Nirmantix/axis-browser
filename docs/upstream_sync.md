# Upstream Sync Override Shield

This fork tracks upstream `kunchenguid/chrome-devtools-axi` while preserving
Axis Browser behavior. Use this file during upstream merges so fork-specific
logic is not overwritten by upstream defaults.

## Current Sync Target

- Fork repository: `Nirmantix/axis-browser`
- Upstream repository: `kunchenguid/chrome-devtools-axi`
- Current synced upstream version: `0.1.35`
- Integration strategy: merge the **tagged upstream release**
  (`chrome-devtools-axi-v0.1.35`) into the fork branch; do not rebase public
  fork history, and do not merge unreleased `upstream/main` commits. If the
  target tag cannot be fetched, stop rather than approximating release source.

## Must-Preserve Package Identity

`package.json` must keep:

- `"name": "chrome-devtools-axi"`
- `"version": "0.1.35"` for this sync
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

Keep the Axis state directory. There is exactly one definition to guard:

- `src/sessions.ts`: `STATE_DIR_NAME = ".axis-browser"`

`src/bridge.ts`, `src/client.ts`, and `src/generation.ts` do **not** define a
state path of their own — they resolve it through `resolveSessionStateDir()` /
`resolveSessionPidFile()` in `src/sessions.ts`. Guarding that one constant
covers all three.

Do not restore upstream `~/.chrome-devtools-axi` paths.

Named sessions (`CHROME_DEVTOOLS_AXI_SESSION`) live under
`~/.axis-browser/sessions/<name>/`, also derived from `STATE_DIR_NAME`.

## Fork UID Freshness Semantics

There is exactly one UID freshness module: `src/uid-freshness.ts`. The fork's
former `src/refs.ts` was deleted in the 0.1.35 sync — do not reintroduce a
second implementation, and do not let a merge restore `stampFresh`-style marker
code inside `src/cli.ts`.

Upstream 0.1.35 and this fork agree on the capture side and deliberately differ
on the validation side:

- Shared (upstream): `captureFreshSnapshot` bumps the generation, installs a
  `MutationObserver` marker on the page, captures, and re-captures once when the
  page was still mutating, so the stamped tree is settled.
- Fork-only: a nonzero mutation count does **not** invalidate a ref. Upstream
  re-added mutation counting to `parseUidFresh`, which is the behavior this fork
  removed because any DOM churn — a spinner tick, a re-render — staled every ref
  between `snapshot` and `click`. Staleness is decided by the `g<N>:` tag alone.
- Fork-only: untagged legacy refs are accepted and skip the page probe entirely.
  Upstream rejects them when the freshness marker is missing.
- Fork-only: a page that answers the probe with no state rejects a tagged ref
  (`STALE_REF`, "no snapshot from this session"), while a probe that *fails*
  stays permissive and defers to the session counter.

`test/interaction.test.ts` and `test/run.test.ts` pin all four rules; upstream
tests that assume mutation-based invalidation must be adapted, not adopted.

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
- `src/setup.ts` `chromeCheck`/`platformAppPaths` Windows detection: thread the
  `platform` argument into `commandPath` (not `process.platform`) and detect
  Windows Chrome and Edge under Program Files, Program Files (x86), and
  LOCALAPPDATA, plus Chromium under Program Files (x86) only.
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
- Resolve `browser-bay` in this order:
  `BROWSER_BAY_DIR`, `AXIS_BROWSER_HOME/skills/browser-bay`,
  `AXIS_PORTABLE_SKILLS_DIR/browser-bay`, then standard agent skill
  locations.
- Do not hardcode personal workstation paths.
- If the router is absent, report core Axis status and say the router source is
  not configured unless `BROWSER_BAY_SOURCE_URL` is set.
- Do not assume a public `browser-bay` repository URL until one exists.

## Rejected Upstream Skill And Infra

Do not accept these upstream paths into the fork:

- `skills/chrome-devtools-axi/`
- `src/skill.ts`
- `scripts/build-skill.ts`
- `test/skill.test.ts`
- `test/release-ci-exclusions.test.ts` (needs a root `yaml` dev dependency and
  `release-please-config.json`, neither of which this fork has)
- `AGENTS.md`
- `CONTRIBUTING.md` (upstream release-please workflow)
- `.airlock/`
- `.agents/`
- `.no-mistakes/`
- `.release-please-manifest.json`
- `release-please-config.json`
- `.github/workflows/release-please.yml`
- `.github/workflows/guard-generated-files.yml`
- `.github/workflows/no-mistakes-required.yml`
- the `pull_request.paths-ignore` block upstream adds to `.github/workflows/ci.yml`
  (it exists only to suppress release-please runs) and the `.no-mistakes/evidence/`
  ignore rule

`CLAUDE.md` is allowed only as optional fork-owned public onboarding if added
intentionally. Do not accept an upstream-generated Claude file by default.

If upstream reintroduces any of them, remove them from the merge result. Do not
rely on `.gitignore` to evict tracked files; use `git rm` for tracked upstream
paths.

## Dependency Policy

The 0.1.35 sync carried a **separately reviewed major-version modernization** of
the toolchain, approved apart from the upstream merge. Runtime dependencies:

- `@modelcontextprotocol/sdk` `^1.30.0`
- `@toon-format/toon` `^4.1.1`
- `axi-sdk-js` `^0.1.12`
- `chrome-devtools-mcp` `1.9.0` — exact, no caret: the bridge resolves and spawns
  this package-local install instead of a global one or `npx …@latest`

Dev dependencies:

- TypeScript `^7.0.2` (needs explicit `"types": ["node"]` in `tsconfig.json`;
  TS 7 no longer auto-includes `node_modules/@types`)
- Vitest `^5.0.1` (its `configDefaults.exclude` shrank to `node_modules` and
  `.git`, so `vitest.config.ts` re-states `dist/**`, `upstream/**`, `**/.*/**`)
- `@types/node` `^22.20.4`, `prettier` `^3.9.8`, `tsx` `^4.23.13`
- `packageManager` `pnpm@12.5.1`
- no root `yaml` dev dependency unless a tracked source file imports it

`engines.node` is `>=22.13`. This **drops** the old `>=20.11` promise, which had
no browser-path CI coverage; CI now proves the floor on a packed tarball under
Node 22.13. Neither MCP 1.9.0 (`^20.19.0 || ^22.12.0 || >=23`) nor pnpm 12.5.1
(`>=18`) independently requires 22.13 — it is an alignment decision, not a
transitive minimum. Standalone BrowserBay still supports Node 20 without Axis.

TOON is a **wire-format** dependency, not an inert one: `src/cli.ts` feeds every
machine-readable block through `encode`. `test/toon-output.test.ts` pins the
exact bytes, so any future TOON bump must be reviewed against those goldens.

Future routine upstream syncs stay within these reviewed majors. Do not run a
broad `pnpm update --latest` during a sync, and keep the seven-day
`minimumReleaseAge` policy in `pnpm-workspace.yaml`.

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
pnpm run format:check
pnpm run typecheck
pnpm run build
pnpm test
node dist/bin/chrome-devtools-axi.js --version
pnpm exec axis-browser --version
pnpm exec axib --version
node dist/bin/chrome-devtools-axi.js update
node dist/bin/chrome-devtools-axi.js update --check
node dist/bin/chrome-devtools-axi.js update --help
```

`pnpm exec chrome-devtools-axi --version` does **not** work inside this
workspace: pnpm will not link a bin whose name equals the workspace package's
own name, so `pnpm exec` tries to resolve it as a dependency and reports
"Command not found". That is a pnpm self-reference artifact, not a broken alias.
Verify the third alias the way a user gets it — from a packed install, which is
also what CI's packed-artifact job does:

```bash
npm pack --pack-destination /tmp/axis-pack && cd /tmp/axis-pack
npm install ./chrome-devtools-axi-*.tgz
./node_modules/.bin/chrome-devtools-axi --version
./node_modules/.bin/axis-browser --version
./node_modules/.bin/axib --version
```

Expected version output for this sync:

```text
0.1.35
```
