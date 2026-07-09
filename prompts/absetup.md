Task Shortcode: ;absetup

Purpose: one-off Axis Browser workflow machine setup/audit.

Associated skill:
- ./skills/browser-bay when run from the axis-browser checkout, BROWSER_BAY_DIR when set, or AXIS_BROWSER_HOME/skills/browser-bay when AXIS_BROWSER_HOME is set

Run this from any shell on the target machine:

1. Resolve the skill path:
   - Prefer BROWSER_BAY_DIR when set.
   - Otherwise use ./skills/browser-bay when running from the axis-browser repository root.
   - Otherwise use $AXIS_BROWSER_HOME/skills/browser-bay when AXIS_BROWSER_HOME is set.
   - Otherwise search standard agent skill locations and report if missing.

2. Load SKILL.md from the resolved skill path.

3. Run:
   bash "$BROWSER_BAY_DIR/scripts/check-prerequisites.sh" --install

4. Treat install groups exactly this way:
   - Core machine tools: Axis Browser CLI, Browser Harness, Microsoft Playwright CLI.
   - Optional tools: Firecrawl CLI/MCP, BrowserAct CLI (+ skill handshake via
     `browser-act get-skills main` / `get-skills core --skill-version`), Notte,
     CloakBrowser, agent-browser.
   - BrowserAct **remote MCP** is optional and should be **project-scoped**
     (`claude mcp add --scope project`), not a global install — see
     docs/browseract-mcp-per-project.md when present.
   - Project-local libraries: Playwright and CloakBrowser must be installed inside target projects, not globally.
   - Webwright is an external pattern/plugin reference, not an Axis Browser workflow install target.
   - Remind: project `.tmp/` hygiene is **not** machine setup — each app needs
     `ensure-project-ready.sh` / `setup.sh` in its own CWD.

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
