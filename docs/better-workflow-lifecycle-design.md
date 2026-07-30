# Axis Browser Workflow Lifecycle

This note records the current accepted lifecycle for using the Axis Browser
workflow. It does not replace `skills/browser-bay/SKILL.md`; the skill router
remains the operational source of truth for browser tasks.

## Current Model

Axis Browser has four layers:

1. **Machine setup** — install or update machine-level CLIs and runtimes.
2. **Skill availability** — make `skills/browser-bay/` available to the agent.
3. **Project readiness** — create `.tmp/` artifact folders and verify tools in
   the target project.
   *Install readiness is not runtime readiness.* `axis-browser doctor --json`
   answers the second question — active connection mode, probed endpoint,
   profile lock, orphaned bridges — and returns runnable remedies. Run it before
   browser work, not just after something breaks.
4. **Task use** — load the browser-bay `SKILL.md` and let it route the browser
   task. (Always path-qualify it: a bare `SKILL.md` at the repo root resolves to
   the Axis Browser setup skill, which is not the router. See
   [Skill Availability](#skill-availability) for how to resolve the directory.)

The text-expander prompts under `prompts/` are thin entry points into those
layers:

| Prompt | Layer | Action |
|---|---|---|
| `;absetup` | Machine setup | Runs `check-prerequisites.sh --install` through browser-bay. |
| `;abcheck` | Project readiness | Runs the read-only `ensure-project-ready.sh` gate, then `check-prerequisites.sh`. On gate exit 2, runs `setup.sh` only with operator approval. |
| `;abuse` | Task use | Resolves the skill directory, loads its `SKILL.md`, and lets it route the browser task. |
| `;abhealth` | Maintenance | Runs `check-prerequisites.sh --update` and performs a read-only content audit. |

## Core Boundaries

- Axis Browser CLI is not the whole workflow. The workflow also includes
  `skills/browser-bay/`, references, scripts, prompts, and docs.
- `skills/browser-bay/` is portable. Browser tools are not bundled inside it.
- Global installs are for machine-level CLIs such as Axis Browser, Browser
  Harness, Microsoft Playwright CLI, Firecrawl CLI, and optional fallbacks.
- Playwright and CloakBrowser are project-local libraries when the target
  project needs them.
- Browserbase skills are a separate optional ecosystem for Browserbase cloud
  sessions and platform workflows. They are not the default Axis Browser route.
- Webwright remains an external pattern/plugin reference, not a dependency.

## Skill Availability

Agents can use the workflow only after `skills/browser-bay/` is visible to
the agent host. Use one of these routes:

- Point the session at an existing skill checkout with `BROWSER_BAY_DIR`.
- Point the session at an Axis Browser workflow checkout with
  `AXIS_BROWSER_HOME`; agents then resolve
  `$AXIS_BROWSER_HOME/skills/browser-bay`.
- Copy or clone `skills/browser-bay/` into a host-supported skill location,
  such as `.agents/skills/browser-bay/`, `~/.codex/skills/browser-bay/`,
  `~/.claude/skills/browser-bay/`, or another path documented in the skill
  README.
- For hosts without native `SKILL.md` discovery, use the adapters under
  `skills/browser-bay/adapters/`.

### Resolve the directory before running anything

The routes above are only useful if the commands actually use them.
`BROWSER_BAY_DIR` is unset on a fallback or legacy install, and
`bash "$BROWSER_BAY_DIR/scripts/..."` would then run `bash "/scripts/..."` and
fail with a confusing path error. Resolve it once per shell:

```bash
BB="${BROWSER_BAY_DIR:-}"
for p in "${AXIS_BROWSER_HOME:+$AXIS_BROWSER_HOME/skills}" "${AXIS_PORTABLE_SKILLS_DIR:-}" \
         ./skills "$HOME/.codex/skills" "$HOME/.config/agents/skills" \
         "$HOME/.claude/skills" "$HOME/.config/opencode/skills" "$HOME/.pi/agent/skills"; do
  [ -n "$BB" ] && break
  if [ -n "$p" ] && [ -d "$p/browser-bay" ]; then BB="$p/browser-bay"; fi
done
[ -d "$BB" ] || { echo "browser-bay not found; set BROWSER_BAY_DIR"; exit 2; }

```

Every command below uses `"$BB"`. The same three lines appear in the `prompts/`
entry points, so agents and operators resolve the path identically.

Once available, `$BB/SKILL.md` remains the router. The prompt table above maps
shortcodes to setup, readiness, use, and maintenance entry points; it does not
replace the skill discovery step.

## Machine Setup

Machine setup is handled by:

```bash
bash "$BB/scripts/check-prerequisites.sh" --install
```

The install mode is interactive and permission-gated. It never writes API keys,
credential values, shell exports, `.env` files, shell rc files, MCP configs, or
credential stores.

For an Axis Browser workflow checkout, the Browser Harness checkout convention is:

```text
$AXIS_BROWSER_HOME/browser-harness
```

Set `BROWSER_HARNESS_DIR` to override that path. A standalone BrowserBay install
without either environment variable retains `$HOME/Developer/browser-harness`
as its portable fallback.

## Project Readiness

Project readiness is gated, and the gate is read-only. Run it inside the target
project (its CWD must be the project, not `$HOME`):

```bash
bash "$BB/scripts/ensure-project-ready.sh"
```

- **Exit 0** — the project is ready; continue straight to
  `check-prerequisites.sh`. Nothing is written.
- **Exit 2** — one-time setup is needed. Tell the operator and, **only with
  their approval**, run `setup.sh`, then re-run the gate until it exits 0:

  ```bash
  bash "$BB/scripts/setup.sh" --dry-run
  bash "$BB/scripts/setup.sh"
  bash "$BB/scripts/ensure-project-ready.sh"
  ```

```bash
bash "$BB/scripts/check-prerequisites.sh"
```

`setup.sh` is the only writing step here, which is why it sits behind the gate
and behind operator approval rather than running unconditionally. It writes only
project artifact hygiene:

- `.tmp/screenshots/`
- `.tmp/scrapes/`
- `.tmp/traces/`
- `.tmp/reports/`
- `.tmp/verified-runs/`
- `.gitignore` entry for `.tmp/`

## Health Audits

Monthly or biweekly health checks use:

```bash
bash "$BB/scripts/check-prerequisites.sh" --update
```

`--update` is report-first and permission-gated. It records pre-update versions
under `.tmp/axis-browser-health/`, asks before each shared tool update, and does
not update project-local dependencies.

The `;abhealth` prompt adds the read-only content audit:

- prompts
- `SKILL.md`
- browser-bay references
- scripts
- README files
- workflow docs
- microsite pages

The audit phase does not edit tracked files, commit, push, or update tools.

## CI And Tests

The parent Axis Browser repo and nested browser-bay repo have separate test
ownership.

- Parent repo: `corepack pnpm test` covers CLI/runtime behavior and prompt
  contract tests.
- Nested `skills/browser-bay/` repo: `node --test test/*.node.mjs` covers
  verified-run and prerequisite script behavior.
- Microsite: open `project-guide-site/index.html` locally and check navigation
  links before publishing changed pages.

Do not claim the parent Vitest suite validates shell scripts or nested skill
behavior. Use the targeted tests above.

## Manual Fallback

The same workflow can be performed manually:

1. Read `skills/browser-bay/README.md`.
2. Resolve `BB` with the snippet above (export `BROWSER_BAY_DIR`, or export
   `AXIS_BROWSER_HOME`, or rely on the host skill locations it searches).
3. Run `ensure-project-ready.sh` in the target project. On exit 2, run
   `setup.sh` (with approval) and re-run the gate until it exits 0.
4. Run `check-prerequisites.sh`.
5. Run `axis-browser doctor --json`. Steps 3-4 prove the project and the machine
   are set up; only this one proves a browser command will work right now. Run
   its reversible remedies (`unset …`); confirm the destructive ones
   (`axis-browser reap`, `axis-browser stop`, `rm <path>`) before executing.
6. Use `$BB/SKILL.md` to choose the task reference.

The prompts are convenience wrappers, not a separate source of truth.
