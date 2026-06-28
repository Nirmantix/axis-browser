# Axis Browser Workflow Lifecycle

This note records the current accepted lifecycle for using the Axis Browser
workflow. It does not replace `skills/browser-skill/SKILL.md`; the skill router
remains the operational source of truth for browser tasks.

## Current Model

Axis Browser has four layers:

1. **Machine setup** — install or update machine-level CLIs and runtimes.
2. **Skill availability** — make `skills/browser-skill/` available to the agent.
3. **Project readiness** — create `.tmp/` artifact folders and verify tools in
   the target project.
4. **Task use** — load `SKILL.md` and let it route the browser task.

The text-expander prompts under `prompts/` are thin entry points into those
layers:

| Prompt | Layer | Action |
|---|---|---|
| `;absetup` | Machine setup | Runs `check-prerequisites.sh --install` through browser-skill. |
| `;abcheck` | Project readiness | Runs `setup.sh`, then `check-prerequisites.sh`. |
| `;abuse` | Task use | Loads `SKILL.md`; it is not a router. |
| `;abhealth` | Maintenance | Runs `check-prerequisites.sh --update` and performs a read-only content audit. |

## Core Boundaries

- Axis Browser CLI is not the whole workflow. The workflow also includes
  `skills/browser-skill/`, references, scripts, prompts, and docs.
- `skills/browser-skill/` is portable. Browser tools are not bundled inside it.
- Global installs are for machine-level CLIs such as Axis Browser, Browser
  Harness, Microsoft Playwright CLI, Firecrawl CLI, and optional fallbacks.
- Playwright and CloakBrowser are project-local libraries when the target
  project needs them.
- Browserbase skills are a separate optional ecosystem for Browserbase cloud
  sessions and platform workflows. They are not the default Axis Browser route.
- Webwright remains an external pattern/plugin reference, not a dependency.

## Skill Availability

Agents can use the workflow only after `skills/browser-skill/` is visible to
the agent host. Use one of these routes:

- Point the session at an existing skill checkout with `BROWSER_SKILL_DIR`.
- Point the session at an Axis Browser workflow checkout with
  `AXIS_BROWSER_HOME`; agents then resolve
  `$AXIS_BROWSER_HOME/skills/browser-skill`.
- Copy or clone `skills/browser-skill/` into a host-supported skill location,
  such as `.agents/skills/browser-skill/`, `~/.codex/skills/browser-skill/`,
  `~/.claude/skills/browser-skill/`, or another path documented in the skill
  README.
- For hosts without native `SKILL.md` discovery, use the adapters under
  `skills/browser-skill/adapters/`.

Once available, `SKILL.md` remains the router. The prompt table above maps
shortcodes to setup, readiness, use, and maintenance entry points; it does not
replace the skill discovery step.

## Machine Setup

Machine setup is handled by:

```bash
bash "$BROWSER_SKILL_DIR/scripts/check-prerequisites.sh" --install
```

The install mode is interactive and permission-gated. It never writes API keys,
credential values, shell exports, `.env` files, shell rc files, MCP configs, or
credential stores.

The default Browser Harness checkout convention is:

```text
$HOME/Developer/browser-harness
```

Set `BROWSER_HARNESS_DIR` to override that path.

## Project Readiness

Project setup is handled inside the target project:

```bash
bash "$BROWSER_SKILL_DIR/scripts/setup.sh" --dry-run
bash "$BROWSER_SKILL_DIR/scripts/setup.sh"
bash "$BROWSER_SKILL_DIR/scripts/check-prerequisites.sh"
```

`setup.sh` writes only project artifact hygiene:

- `.tmp/screenshots/`
- `.tmp/scrapes/`
- `.tmp/traces/`
- `.tmp/reports/`
- `.tmp/verified-runs/`
- `.gitignore` entry for `.tmp/`

## Health Audits

Monthly or biweekly health checks use:

```bash
bash "$BROWSER_SKILL_DIR/scripts/check-prerequisites.sh" --update
```

`--update` is report-first and permission-gated. It records pre-update versions
under `.tmp/axis-browser-health/`, asks before each shared tool update, and does
not update project-local dependencies.

The `;abhealth` prompt adds the read-only content audit:

- prompts
- `SKILL.md`
- browser-skill references
- scripts
- README files
- workflow docs
- microsite pages

The audit phase does not edit tracked files, commit, push, or update tools.

## CI And Tests

The parent Axis Browser repo and nested browser-skill repo have separate test
ownership.

- Parent repo: `corepack pnpm test` covers CLI/runtime behavior and prompt
  contract tests.
- Nested `skills/browser-skill/` repo: `node --test test/*.node.mjs` covers
  verified-run and prerequisite script behavior.
- Microsite: open `project-guide-site/index.html` locally and check navigation
  links before publishing changed pages.

Do not claim the parent Vitest suite validates shell scripts or nested skill
behavior. Use the targeted tests above.

## Manual Fallback

The same workflow can be performed manually:

1. Read `skills/browser-skill/README.md`.
2. Export `BROWSER_SKILL_DIR`, or export `AXIS_BROWSER_HOME` and resolve
   `$AXIS_BROWSER_HOME/skills/browser-skill`.
3. Run `setup.sh` in the target project.
4. Run `check-prerequisites.sh`.
5. Use `SKILL.md` to choose the task reference.

The prompts are convenience wrappers, not a separate source of truth.
