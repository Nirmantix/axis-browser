# AGENTS.md

This file gives repository-scoped instructions to coding agents working inside this project.

## Repo Identity

- public repo: `Nirmantix/axis-browser`
- upstream repo: `kunchenguid/chrome-devtools-axi`
- repo type: small, upgrade-friendly fork
- primary public product name: `Axis Browser`
- package name must remain: `chrome-devtools-axi`

## Path Independence

Do **not** assume this repo lives at a fixed local path.

If this folder is renamed or moved locally, these instructions still apply.
Always detect the repo root dynamically, for example:

```bash
git rev-parse --show-toplevel
```

If you find older notes that mention a previous local path, treat those path references as stale.

## Default Maintenance Intent

If a user says anything that naturally means:
- update this repo
- update this project
- update axis browser
- sync this fork
- keep this fork aligned with upstream
- check upstream and apply updates
- update dependencies and keep things current
- check for upstream releases or breaking changes

then interpret that as permission to run the **full upstream maintenance workflow**.

Do not wait for the user to phrase it perfectly.

## Full Upstream Maintenance Workflow

When doing maintenance or update work for this repo:

1. inspect upstream first
2. check for new tags, commits, release notes, dependency bumps, workflow changes, and breaking changes
3. create a short-lived branch instead of changing `main` directly
4. merge or otherwise apply safe upstream changes deliberately
5. preserve only the intentional Axis Browser fork delta
6. remove stale repo-specific patches if upstream now covers them
7. validate the result
8. open or update a PR into `main`

## Required Upstream Checks

Before deciding whether work is needed, check at least:

```bash
git remote -v
git checkout main
git fetch origin
git fetch --prune origin
git fetch upstream --tags
git ls-remote --tags upstream
git log --oneline origin/main..upstream/main
git diff --stat origin/main..upstream/main
```

Also inspect:
- `package.json`
- `package-lock.json`
- `src/`
- `test/`
- `.github/workflows/`
- `README.md`
- `docs/`
- upstream changelog / release notes if available

## High-Risk Breaking Change Checklist

Explicitly check whether upstream changed:
- package name
- bin names or CLI entrypoints
- command names
- environment variable names or precedence
- bridge startup or shutdown behavior
- PID/state-file format
- runtime state directory
- dependency requirements
- Node version expectations
- install flow
- output/help text
- hook installation behavior
- CI / release automation

## Fork Invariants You Must Preserve

Keep these true unless the owner explicitly asks otherwise:
- package name stays `chrome-devtools-axi`
- commands stay `axis-browser`, `axib`, and `chrome-devtools-axi`
- runtime state stays under `~/.axis-browser`
- public branding stays `Axis Browser`
- install guidance prefers GitHub for this fork
- public docs stay honest that Windows support is partial
- `axis`, `axi`, `axisb`, `axis-init`, `axis-human`, `axisb-init`, and `axisb-human` are **not** built-in commands unless clearly labeled as user-defined helpers

## Current Public Docs Split

Keep public docs clean and unambiguous:
- `README.md` = source of truth for install, commands, env vars, runtime behavior, development
- `docs/vibe-coding-browser-workflow.md` = source of truth for workflow, shared `9222` usage, Playwright handoff, and troubleshooting habits

If docs drift, consolidate them instead of duplicating conflicting guidance.

## Current Intentional Fork Delta

At the time of writing, the meaningful fork-specific behavior is:
- bridge config fingerprinting
- bridge restart when the effective target changes
- dedicated `chrome-devtools-mcp` cache under `~/.axis-browser/npm-cache`
- stale local bridge recovery on `9224`
- Axis Browser branding and compatibility aliases
- cross-platform-safe build chmod step

Do not keep fork-only code if upstream makes it unnecessary.

## Validation Requirements

Minimum required validation after maintenance work:

```bash
npm test
npm run build
```

If bridge / session logic changed, also run:

```bash
npm test -- --run test/bridge.test.ts test/client.test.ts
```

If CLI copy / help / command behavior changed, also run:

```bash
npm test -- --run test/cli-runtime.test.ts test/main.test.ts test/run.test.ts
```

## Git / PR Flow

- never push maintenance changes straight to protected `main`
- use a short-lived branch, e.g. `codex/upstream-sync-YYYYMMDD`
- push the branch
- open or update a PR into `main`
- wait for required checks and review
- merge only through the protected GitHub flow

## Private Notes

There is also a local private playbook named `maintainance.md` in this repo root.
If it exists, follow it for extra local maintenance detail.
If this `AGENTS.md` and that private file differ on path assumptions, prefer path-independent behavior based on the current repo root.
