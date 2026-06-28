Task Shortcode: ;absetup

Purpose: one-off Axis Browser workflow machine setup/audit.

Associated skill:
- ./skills/browser-skill when run from the axis-browser checkout, BROWSER_SKILL_DIR when set, or AXIS_BROWSER_HOME/skills/browser-skill when AXIS_BROWSER_HOME is set

Run this from any shell on the target machine:

1. Resolve the skill path:
   - Prefer BROWSER_SKILL_DIR when set.
   - Otherwise use ./skills/browser-skill when running from the axis-browser repository root.
   - Otherwise use $AXIS_BROWSER_HOME/skills/browser-skill when AXIS_BROWSER_HOME is set.
   - Otherwise search standard agent skill locations and report if missing.

2. Load SKILL.md from the resolved skill path.

3. Run:
   bash "$BROWSER_SKILL_DIR/scripts/check-prerequisites.sh" --install

4. Treat install groups exactly this way:
   - Core machine tools: Axis Browser CLI, Browser Harness, Microsoft Playwright CLI.
   - Optional tools: Firecrawl CLI/MCP, BrowserAct, Notte, CloakBrowser, agent-browser.
   - Project-local libraries: Playwright and CloakBrowser must be installed inside target projects, not globally.
   - Webwright is an external pattern/plugin reference, not an Axis Browser workflow install target.

Hard credential rules:
- NEVER write API keys, tokens, credential values, or shell exports to any file.
- NEVER modify .env, .env.local, shell rc files, MCP configs, or credential stores.
- NEVER print credential values.
- Only show the operator what to add manually and validate presence without exposing values.

Report:
- Skill path used.
- Tools already installed.
- Install actions approved, skipped, or blocked.
- Project-local commands the operator should run later inside target projects.
- Credential setup still required, with values hidden.
