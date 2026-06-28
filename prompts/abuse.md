Task Shortcode: ;abuse

Purpose: use the Axis Browser workflow for a browser-related task.

Associated skill:
- ./skills/browser-skill when run from the axis-browser checkout, BROWSER_SKILL_DIR when set, or AXIS_BROWSER_HOME/skills/browser-skill when AXIS_BROWSER_HOME is set

Launcher rules:
- Resolve BROWSER_SKILL_DIR.
- Load "$BROWSER_SKILL_DIR/SKILL.md".
- Pass the operator's browser task through verbatim.
- Follow SKILL.md for all routing, tools, references, fallbacks, safety rules, and reporting.

Do not add routing here:
- No standalone tool routing table.
- No install commands.
- No Browserbase decision logic.
- No Webwright workflow logic.

Browserbase note:
- Browserbase skills are separate and only relevant when SKILL.md or the operator explicitly asks for Browserbase cloud/session/platform workflows.

Hard credential rules:
- NEVER write API keys, tokens, credential values, or shell exports to any file.
- NEVER modify .env, .env.local, shell rc files, MCP configs, or credential stores.
- NEVER print credential values.

Report:
- Skill path used.
- Task understood.
- SKILL.md reference selected.
- Tool selected by SKILL.md.
- Evidence paths under .tmp/.
