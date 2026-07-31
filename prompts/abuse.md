Task Shortcode: ;abuse

Purpose: use the Axis Browser workflow for a browser-related task.

Associated skill:
- ./skills/browser-bay when run from the axis-browser checkout, BROWSER_BAY_DIR when set, or AXIS_BROWSER_HOME/skills/browser-bay when AXIS_BROWSER_HOME is set


Resolve the skill directory first — the discovery sources above are only useful if the
commands actually use them. `BROWSER_BAY_DIR` may be unset on a fallback or legacy install,
and an unresolved path would then run `bash "/scripts/..."` and fail with
a confusing path error:

```bash
BB=""
for c in "${BROWSER_BAY_DIR:-}" "${BROWSER_SKILL_DIR:-}"; do
  [ -z "$BB" ] && [ -n "$c" ] && [ -d "$c" ] && BB="$c"
done
for p in "${AXIS_BROWSER_HOME:+$AXIS_BROWSER_HOME/skills}" "${AXIS_PORTABLE_SKILLS_DIR:-}" \
         ./skills "$HOME/.codex/skills" "$HOME/.config/agents/skills" \
         "$HOME/.claude/skills" "$HOME/.config/opencode/skills" \
         "$HOME/.pi/agent/skills" "$HOME/.agents/skills"; do
  [ -n "$BB" ] && break
  [ -n "$p" ] || continue
  for n in browser-bay browser-skill; do
    if [ -d "$p/$n" ]; then BB="$p/$n"; break; fi
  done
done
[ -d "$BB" ] || { echo "browser-bay not found; set BROWSER_BAY_DIR"; exit 2; }

```

Use `"$BB"` in place of `"$BROWSER_BAY_DIR"` in the commands below.

Launcher rules:
- Resolve "$BB" with the snippet above.
- Load "$BB/SKILL.md".
- Ensure cwd is the target product project (not $HOME).
- Run bash "$BB/scripts/ensure-project-ready.sh" before browser work.
  If exit 2, stop and ask the operator to approve setup.sh in that project first.
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
