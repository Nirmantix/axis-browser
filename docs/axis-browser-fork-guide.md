# Axis Browser Fork Guide

This document explains how to install, use, and maintain the `Nirmantix/axis-browser` fork of `kunchenguid/chrome-devtools-axi`.

Fork URL:
- `https://github.com/Nirmantix/axis-browser`

Original upstream:
- `https://github.com/kunchenguid/chrome-devtools-axi`

## What This Fork Changes

This fork keeps the upstream package name for compatibility, but exposes `axis-browser`, `axib`, and `chrome-devtools-axi` as installed commands and adds one practical fix for shared Chrome/CDP workflows:

- the bridge now stores its launch/session fingerprint in `~/.chrome-devtools-axi/bridge.pid`
- the client compares the saved fingerprint with the current environment
- if the target session changed, the bridge is restarted instead of silently reusing a stale session

The fingerprint currently includes:
- `CHROME_DEVTOOLS_AXI_BROWSER_URL`
- `CHROME_DEVTOOLS_AXI_USER_DATA_DIR`
- headed vs headless mode
- forwarded Chrome args

This was added because the original bridge reuse logic could keep talking to an old MCP session even after the operator changed `CHROME_DEVTOOLS_AXI_BROWSER_URL`. In practice that caused:
- `axib pages` disagreeing with raw Chrome CDP targets
- unreliable attachment to already-open tabs
- confusion when switching between isolated and shared Chrome sessions

## Who Should Use This Fork

Use this fork if you:
- rely on `axis-browser`, `axib`, or `chrome-devtools-axi` against a persistent Chrome instance on `9222`
- switch between isolated and shared browser sessions
- need more reliable reuse of an already-open Chrome session across projects

If you only use one-off isolated browser sessions and never attach to a shared Chrome instance, upstream may be enough.

## Install Options

### Option 1: Use The Fork As A Local Repo Build

This is the best option when you want the patched behavior immediately and do not want to publish a separate npm package.

```bash
git clone https://github.com/Nirmantix/axis-browser.git
cd axis-browser
npm install
npm run build
```

Run directly without changing your global PATH:

```bash
node dist/bin/chrome-devtools-axi.js --help
node dist/bin/chrome-devtools-axi.js pages
```

If you want the commands available globally from this checkout, link the package:

```bash
npm link
```

Then the package exposes:

```bash
axis-browser --help
axib pages
chrome-devtools-axi pages
```

### Option 2: Make This Fork Your Active Global Axis Browser Install

If you already use `axis-browser` or `axib` from a global install and want this fork to be the active binary, point your existing wrapper or symlink at the built CLI.

Example on macOS/Linux:

```bash
ln -snf /absolute/path/to/axis-browser/dist/bin/chrome-devtools-axi.js ~/.bun/bin/chrome-devtools-axi
```

If your `axib` shim points to `~/.bun/bin/chrome-devtools-axi`, that is enough for `axib`.

If you also want `axis-browser` available as a first-class command, either:
- reinstall/link this fork so your package manager creates all declared bin shims, or
- create an additional wrapper that points at the same built CLI target

Verify:

```bash
readlink ~/.bun/bin/chrome-devtools-axi
axib --version
```

Important:
- changing the symlink changes which build backs the command
- it does not automatically replace an already-running bridge process
- after switching builds, stop the old bridge once and let it restart:

```bash
axib stop
```

Then start fresh:

```bash
export CHROME_DEVTOOLS_AXI_BROWSER_URL=http://127.0.0.1:9222
axib pages
```

### Option 3: Use It Per Project Without Replacing Your Global Install

If you want to keep the upstream global package but use this fork in one project or one shell session:

```bash
node /absolute/path/to/axis-browser/dist/bin/chrome-devtools-axi.js pages
```

Or add a shell alias:

```bash
alias axisb-fork='node /absolute/path/to/axis-browser/dist/bin/chrome-devtools-axi.js'
```

Then:

```bash
export CHROME_DEVTOOLS_AXI_BROWSER_URL=http://127.0.0.1:9222
axisb-fork pages
```

## Everyday Usage

For shared Chrome on port `9222`, use this baseline flow:

```bash
export CHROME_DEVTOOLS_AXI_BROWSER_URL=http://127.0.0.1:9222
axib stop
axib pages
axib snapshot
```

Why `axib stop` first:
- the bridge is persistent
- the bridge can outlive your shell session
- restarting once ensures the current env is what the bridge is actually using

When tab attachment matters, do not trust `axib pages` blindly. Cross-check raw CDP:

```bash
curl -s http://127.0.0.1:9222/json/list
```

If raw CDP and `axib pages` disagree:

```bash
axib stop
axib pages
```

If attachment is still flaky, open a fresh controlled tab:

```bash
axib open https://example.com
```

## Basic Auth Sites

For HTTP basic-auth sites:
- do not treat the native browser auth prompt as the only proof path
- prefer a pre-authenticated URL, a controlled tab, or Playwright `httpCredentials`

If the browser prompt loops even with known-good credentials:
- close all tabs for that origin
- retry in incognito
- retry with a fresh `axib` bridge
- confirm the server path independently with Playwright or curl

## Playwright With Shared Chrome

When you need Playwright to reuse the same shared Chrome session:

```ts
import { chromium } from "playwright";

(async () => {
  const browser = await chromium.connectOverCDP("http://localhost:9222");
  const contexts = browser.contexts();
  const pages = contexts.flatMap((context) => context.pages());

  let page = pages.find((p) => /example\.com|localhost:3000/.test(p.url()));
  if (!page) {
    for (const candidate of pages) {
      if (/Dashboard|App|Admin/i.test(await candidate.title())) {
        page = candidate;
        break;
      }
    }
  }
  page ??= pages[0];

  // do work

  await browser.disconnect();
})();
```

Do not assume `pages()[0]` is the right tab.

## Local Development In The Fork

Clone and set up:

```bash
git clone https://github.com/Nirmantix/axis-browser.git
cd axis-browser
npm install
```

Run tests:

```bash
npm test
```

Build:

```bash
npm run build
```

Useful targeted test runs:

```bash
npm test -- --run test/bridge.test.ts test/client.test.ts
```

## Recommended Git Remote Layout

Use this remote layout in your local clone:

- `origin` -> your fork
- `upstream` -> original repo

Example:

```bash
git remote -v
```

Expected shape:

```bash
origin   https://github.com/Nirmantix/axis-browser.git
upstream https://github.com/kunchenguid/chrome-devtools-axi.git
```

## Keeping The Fork Up To Date

The fork should stay close to upstream. The goal is not to create a permanent hard fork with lots of divergence.

Baseline sync flow:

```bash
git checkout main
git fetch origin
git fetch upstream --tags
git checkout -b codex/upstream-sync-YYYYMMDD
git merge upstream/main
```

Do not perform routine upstream maintenance directly on `main`.
Merge upstream into a short-lived branch, validate the result, and open a PR back into `main`.

## Carrying The Patch Forward

When upstream releases new changes:

1. fetch `upstream/main`
2. create or refresh a short-lived maintenance branch
3. merge upstream into that branch
4. reapply or adjust fork-specific behavior only if still needed
5. run tests
6. rebuild
7. push the branch and open a PR into `main`

Example:

```bash
git checkout main
git fetch origin
git fetch upstream --tags
git checkout -b codex/upstream-sync-v0.1.16
git merge upstream/main
# reapply or adjust fork-specific changes if needed
npm test
npm run build
git push -u origin codex/upstream-sync-v0.1.16
```

If the PR is merged, delete the short-lived branch locally and on GitHub.

## When To Drop The Fork Patch

If upstream adopts equivalent logic for bridge target fingerprinting:
- compare the upstream implementation with this fork
- remove the fork-only delta if upstream fully covers the stale-bridge case
- prefer going back to upstream behavior rather than carrying duplicate custom code forever

That is the correct end state.

## What To Document In Future Fork Changes

Every fork-specific behavior should answer three things:

1. what changed
2. why upstream behavior was insufficient
3. how to know when the fork-specific patch can be removed

If a future patch cannot justify those three points, it probably does not belong in the fork.

## Current Fork-Specific Delta

At the time this document was written, the meaningful fork-specific delta is:

- bridge config fingerprinting in `src/bridge.ts`
- bridge fingerprint comparison and forced restart in `src/client.ts`
- regression tests in `test/bridge.test.ts` and `test/client.test.ts`

This is intentionally small and targeted.
