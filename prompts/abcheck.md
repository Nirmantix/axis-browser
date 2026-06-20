Task Shortcode: ;abcheck

Purpose: recurring target-project readiness check for the Axis Browser workflow.

Associated skill:
- ./skills/browser-skill when run from the axis-browser checkout, BROWSER_SKILL_DIR when set, or AXIS_BROWSER_HOME/skills/browser-skill when AXIS_BROWSER_HOME is set

Run this from the target project where browser work will happen:

1. Resolve BROWSER_SKILL_DIR:
   - Prefer the existing environment variable.
   - Otherwise use ./skills/browser-skill when running from the axis-browser repository root.
   - Otherwise use $AXIS_BROWSER_HOME/skills/browser-skill when AXIS_BROWSER_HOME is set.
   - Otherwise search standard agent skill locations and report if missing.

2. Load SKILL.md from the resolved skill path.

3. Preview and apply project-local artifact setup:
   bash "$BROWSER_SKILL_DIR/scripts/setup.sh" --dry-run
   bash "$BROWSER_SKILL_DIR/scripts/setup.sh"

4. Verify available browser powers:
   bash "$BROWSER_SKILL_DIR/scripts/check-prerequisites.sh"

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
