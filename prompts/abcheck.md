Task Shortcode: ;abcheck

Purpose: recurring target-project readiness check for the Axis Browser workflow.

Associated skill:
- Resolved in this order, explicit configuration before implicit location: BROWSER_BAY_DIR (or legacy BROWSER_SKILL_DIR), then $AXIS_BROWSER_HOME/skills, $AXIS_PORTABLE_SKILLS_DIR, ./skills when run from the axis-browser checkout, then the standard agent skill locations. The snippet below is the authority; this line only summarises it

Run this from the target project where browser work will happen:

1. Resolve BROWSER_BAY_DIR:
   - Prefer the existing environment variable.
   - Otherwise use ./skills/browser-bay when running from the axis-browser repository root.
   - Otherwise use $AXIS_BROWSER_HOME/skills/browser-bay when AXIS_BROWSER_HOME is set.
   - Otherwise search standard agent skill locations and report if missing.

2. Load SKILL.md from the resolved skill path.


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

3. Project readiness gate (required; must run in the target project CWD, not $HOME):
   bash "$BB/scripts/ensure-project-ready.sh"
   - Exit 0: project already ready — continue.
   - Exit 2: one-time setup needed — tell the operator, then with approval:
     bash "$BB/scripts/setup.sh" --dry-run
     bash "$BB/scripts/setup.sh"
     Re-run ensure-project-ready.sh until exit 0.

4. Verify available browser powers:
   bash "$BB/scripts/check-prerequisites.sh"

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
