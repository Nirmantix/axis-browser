# Axis Browser Maintenance Playbook

Use this file as the single source of truth for maintaining `Nirmantix/axis-browser` as a minimal fork of `kunchenguid/chrome-devtools-axi`.

If a user says any variation of:
- "update the fork from upstream"
- "sync latest upstream changes"
- "maintain axis-browser"
- "check if upstream released anything new"

an agent should follow this document exactly.

## Branch Policy

This repo should stay simple:

- `main` is the only long-lived branch
- do **not** keep a permanent `develop` branch unless the owner explicitly asks for one later
- use short-lived task branches for update work
- delete short-lived branches after merge

Recommended branch naming for maintenance:

- `codex/upstream-sync-YYYYMMDD`
- `codex/upstream-sync-v0.1.16`

## Current Reality

This repository is intentionally:

- publicly branded as `Axis Browser`
- still a GitHub fork of `kunchenguid/chrome-devtools-axi`
- still upstream-compatible at the package level

Non-negotiable compatibility rules:

- keep package name: `chrome-devtools-axi`
- keep commands exposed: `axis-browser`, `axib`, `chrome-devtools-axi`
- keep runtime state directory: `~/.chrome-devtools-axi`
- keep `origin` pointed at `Nirmantix/axis-browser`
- keep `upstream` pointed at `kunchenguid/chrome-devtools-axi`

## Current Fork-Specific Delta

At the time this file was written, the meaningful fork-only behavior is:

- bridge config fingerprinting in `src/bridge.ts`
- bridge fingerprint comparison and forced restart in `src/client.ts`
- public branding/docs for `Axis Browser`
- additional bin aliases in `package.json`

The fork must stay small. Do not add unrelated product features here.

## Maintenance Goal

When upstream changes land, the job is:

1. pull in safe upstream changes
2. detect breaking changes before they hit `main`
3. preserve only the intentional fork delta
4. avoid regressions in branding, install flow, bridge behavior, or CLI compatibility

## Default Maintenance Workflow

An agent performing maintenance should do this in order.

### 1. Sync local knowledge

Confirm remotes:

```bash
git remote -v
```

Expected:

```bash
origin   https://github.com/Nirmantix/axis-browser.git
upstream https://github.com/kunchenguid/chrome-devtools-axi.git
```

Fetch everything:

```bash
git checkout main
git fetch origin
git fetch upstream --tags
```

### 2. Check whether upstream actually changed

Use these commands:

```bash
git log --oneline origin/main..upstream/main
git diff --stat origin/main..upstream/main
git tag --sort=-version:refname | head
```

If there are no meaningful upstream commits ahead of `origin/main`, stop and report that no maintenance update is needed.

### 3. Create a short-lived update branch

Never do upstream maintenance directly on `main`.

Example:

```bash
git checkout -b codex/upstream-sync-YYYYMMDD
```

### 4. Inspect for breaking changes before merging

Do **not** blindly merge first and think later.

Review upstream changes in these areas first:

- `package.json`
- `src/cli.ts`
- `src/client.ts`
- `src/bridge.ts`
- `src/run.ts`
- `src/hooks.ts`
- `test/`
- `.github/workflows/`
- release notes / tags if available

High-risk breaking-change checks:

- package name changed
- bin names changed
- CLI help text or output structure changed
- bridge PID/state-file format changed
- state directory changed
- environment variable names changed
- bridge startup lifecycle changed
- upstream added new required dependencies
- upstream dropped or renamed commands
- upstream changed tests in ways that invalidate fork behavior

### 5. Merge upstream into the branch

Prefer merge for safety unless the owner explicitly asks for rebase:

```bash
git merge upstream/main
```

If conflicts occur:

- resolve them deliberately
- preserve the fork-specific delta only where it is still needed
- do not automatically keep the fork version of everything

### 6. Re-assert fork invariants

After merging, verify these are still true:

- package name is still `chrome-devtools-axi`
- commands still include `axis-browser`, `axib`, and `chrome-devtools-axi`
- branding still presents `Axis Browser` publicly
- runtime state directory is still `~/.chrome-devtools-axi`
- bridge fingerprint logic still works
- docs do not falsely claim the fork is a separate npm package

### 7. Check whether upstream made the fork patch obsolete

This is mandatory.

If upstream now fully covers the stale-bridge/session-target issue:

- remove the fork-only bridge patch
- remove redundant tests and docs that only existed for that patch
- keep branding/docs only if still explicitly wanted by the owner

Do not carry duplicate logic forever just because it already exists here.

### 8. Run validation

Minimum required validation:

```bash
npm test
npm run build
```

If the change touches bridge/session logic, also run:

```bash
npm test -- --run test/bridge.test.ts test/client.test.ts
```

If the change touches CLI copy/help/command names, also run:

```bash
npm test -- --run test/cli-runtime.test.ts test/main.test.ts test/run.test.ts
```

If validation fails:

- fix the code or docs
- rerun validation
- do not leave known failures behind

### 9. Prepare the update for review

Before opening or updating a PR, confirm:

```bash
git status --short
git diff --stat origin/main...HEAD
```

Then push the branch:

```bash
git push -u origin HEAD
```

Open a PR against `main`.

### 10. Clean up after merge

After the PR is merged:

- delete the short-lived branch locally and on GitHub
- keep `main` current
- do not leave stale maintenance branches around

## Rules For Any Agent

When maintaining this fork, an agent must:

- read this file first
- read `docs/axis-browser-fork-guide.md`
- inspect actual upstream diff instead of guessing
- preserve only intentional fork behavior
- avoid unrelated feature work
- avoid direct pushes to `main` unless the user explicitly demands it

An agent must **not**:

- invent release notes
- claim the fork is a separately published npm package unless that becomes true
- rename the package away from `chrome-devtools-axi`
- move runtime state from `~/.chrome-devtools-axi` without an explicit migration plan
- keep extra long-lived branches around unnecessarily

## Recommended Branch Cleanup Right Now

Operational rule:

- if a short-lived branch is already merged into `main`, delete it
- if a short-lived branch is still under review, keep it until merge or close

For this repository, the intended steady state is:

- keep `main`
- keep at most one active PR/update branch at a time when practical

## Expected Output From A Maintenance Agent

After doing a maintenance pass, the agent should report:

1. whether upstream changed
2. whether any breaking changes were found
3. what fork-specific logic was preserved, removed, or adjusted
4. what tests/build checks were run
5. whether the branch is ready for PR/merge

## One-Sentence Trigger

If the user says: "Follow `maintainance.md` and update Axis Browser from upstream safely," the agent should start the full maintenance workflow above without needing more process instructions.
