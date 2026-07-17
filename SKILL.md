---
name: axis-browser-setup
description: >-
  Install, configure, or health-check the Axis Browser CLI itself — machine
  setup, workflow install, readiness reporting, and Claude Code / Codex
  SessionStart hook installation. Triggers: "set up Axis Browser", "install the
  Axis workflow", "check browser workflow readiness", "axis-browser setup".
  This is setup only, not a browser task router: to actually drive a browser
  (screenshots, scraping, E2E), use the browser-bay skill instead.
---

# Axis Browser

When a user asks to set up Axis Browser, install the Axis workflow, use Axis
Browser, check browser workflow readiness, or similar, run:

```bash
axis-browser setup
```

Use `axis-browser setup --json` when machine-readable status is needed.
Use `axis-browser setup --project <path>` when the target project is not the
current working directory. Use `axis-browser setup --install` only when the user
has asked for setup actions, and add `--yes` only after reviewing the reported
actions in a non-interactive agent context.

Use `axis-browser setup hooks` only for Claude Code and Codex SessionStart hook
installation or repair.
