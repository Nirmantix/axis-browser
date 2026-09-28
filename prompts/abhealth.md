Task Shortcode: ;abhealth

Purpose: monthly or biweekly Axis Browser workflow health audit.

Associated skills:
- Resolved in this order, explicit configuration before implicit location: BROWSER_BAY_DIR (or legacy BROWSER_SKILL_DIR), then $AXIS_BROWSER_HOME/skills, $AXIS_PORTABLE_SKILLS_DIR, ./skills when run from the axis-browser checkout, then the standard agent skill locations. The snippet below is the authority; this line only summarises it
- Use available review/documentation skills when the agent host provides them.

Run from the axis-browser repository root unless auditing another checkout.


Resolve the skill directory first — the discovery sources above are only useful if the
commands actually use them. `BROWSER_BAY_DIR` may be unset on a fallback or legacy install,
and an unresolved path would then run `bash "/scripts/..."` and fail with
a confusing path error:

```bash
BB=""
c="${BROWSER_BAY_DIR:-${BROWSER_SKILL_DIR:-}}"
[ -n "$c" ] && [ -d "$c" ] && BB="$c"
for p in "${AXIS_BROWSER_HOME:+$AXIS_BROWSER_HOME/skills}" "${AXIS_PORTABLE_SKILLS_DIR:-}" \
         ./skills "$HOME/.codex/skills" "$HOME/.config/agents/skills" \
         "$HOME/.claude/skills" "$HOME/.config/opencode/skills" \
         "$HOME/.pi/agent/skills" "$HOME/.agents/skills" \
         "$HOME/.cursor/skills" "$HOME/.kiro/skills" "$HOME/.gemini/skills"; do
  [ -n "$BB" ] && break
  [ -n "$p" ] || continue
  for n in browser-bay browser-skill; do
    if [ -d "$p/$n" ]; then BB="$p/$n"; break; fi
  done
done
[ -d "$BB" ] || { echo "browser-bay not found; set BROWSER_BAY_DIR"; exit 2; }

```

Use `"$BB"` in place of `"$BROWSER_BAY_DIR"` in the commands below.

Phase 1: tool update audit
- Load browser-bay/SKILL.md.
- Run:
  bash "$BB/scripts/check-prerequisites.sh" --update
- Treat this as report-first and permission-gated: it must not recommend
  re-installing Browser Harness as a required tool, nor attaching the ambient
  chrome://inspect default.
- Never update project-local dependencies from this repo-level audit.

Phase 2: content consistency audit
- Review prompts, SKILL.md, browser-bay references, scripts, README files, workflow docs, and microsite docs.
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
