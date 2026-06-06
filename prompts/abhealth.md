Task Shortcode: ;abhealth

Purpose: monthly or biweekly Axis Browser workflow health audit.

Associated skills:
- ./skills/browser-skill when run from the axis-browser checkout, or BROWSER_SKILL_DIR when set
- Use available review/documentation skills when the agent host provides them.

Run from the axis-browser repository root unless auditing another checkout.

Phase 1: tool update audit
- Load browser-skill/SKILL.md.
- Run:
  bash "$BROWSER_SKILL_DIR/scripts/check-prerequisites.sh" --update
- Treat this as report-first and permission-gated.
- Never update project-local dependencies from this repo-level audit.

Phase 2: content consistency audit
- Review prompts, SKILL.md, browser-skill references, scripts, README files, workflow docs, and microsite docs.
- Use official sources for latest tool behavior, install commands, changelogs, and deprecations.
- Identify outdated, missing, conflicting, or hallucination-prone instructions.

Hard mutation rules:
- NEVER edit tracked files during the audit phase.
- NEVER commit or push.
- NEVER update tools unless the operator approves a separate apply step per tool.
- ONLY write reports to .tmp/axis-browser-health/.

Hard credential rules:
- NEVER write API keys, tokens, credential values, or shell exports to any file.
- NEVER modify .env, .env.local, shell rc files, MCP configs, or credential stores.
- NEVER print credential values.

Report:
- Tool versions and update recommendations.
- Changelog items that affect skills/scripts/prompts/docs.
- Conflicting or stale instructions found.
- Proposed follow-up edits, grouped by risk.
- Any upgrades applied only after explicit approval.
