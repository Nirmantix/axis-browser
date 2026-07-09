Task Shortcode: ;abcheck

Purpose: recurring target-project readiness check for the Axis Browser workflow.

Associated skill:
- ./skills/browser-bay when run from the axis-browser checkout, BROWSER_BAY_DIR when set, or AXIS_BROWSER_HOME/skills/browser-bay when AXIS_BROWSER_HOME is set

Run this from the target project where browser work will happen:

1. Resolve BROWSER_BAY_DIR:
   - Prefer the existing environment variable.
   - Otherwise use ./skills/browser-bay when running from the axis-browser repository root.
   - Otherwise use $AXIS_BROWSER_HOME/skills/browser-bay when AXIS_BROWSER_HOME is set.
   - Otherwise search standard agent skill locations and report if missing.

2. Load SKILL.md from the resolved skill path.

3. Project readiness gate (required; must run in the target project CWD, not $HOME):
   bash "$BROWSER_BAY_DIR/scripts/ensure-project-ready.sh"
   - Exit 0: project already ready — continue.
   - Exit 2: one-time setup needed — tell the operator, then with approval:
     bash "$BROWSER_BAY_DIR/scripts/setup.sh" --dry-run
     bash "$BROWSER_BAY_DIR/scripts/setup.sh"
     Re-run ensure-project-ready.sh until exit 0.

4. Verify available browser powers:
   bash "$BROWSER_BAY_DIR/scripts/check-prerequisites.sh"

5. If project-local Playwright is missing, do not treat that as a machine failure. Recommend it only when the project needs deterministic scripts, traces, CI, network interception, visual regression, or cross-browser testing.

Hard credential rules:
- NEVER write API keys, tokens, credential values, or shell exports to any file.
- NEVER modify .env, .env.local, shell rc files, MCP configs, or credential stores.
- NEVER print credential values.
- Only report credential presence/absence with values hidden.

Report:
- Target project path.
- Skill path used.
- .tmp and .gitignore readiness.
- Available browser tools.
- Missing optional tools.
- Whether project-local Playwright is recommended for this project.
