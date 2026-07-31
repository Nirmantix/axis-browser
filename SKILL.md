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

## Runtime readiness is a different question from install readiness

`setup` reports whether the machine is *installed* correctly. It does not report
whether a browser command will actually work right now. For that:

```bash
axis-browser doctor --json
```

It reports the active connection mode, the endpoint (probed, not assumed), the
browser binary, the profile and whether it is locked, and bridge/orphan state —
plus a `remedies` array in which every entry is a syntactically runnable command
— which is not the same as safe to run unattended.

- Run the reversible remedies (`unset …`) directly.
- **Never** run `axis-browser reap`, `axis-browser stop`, or any `rm <path>`
  without a human confirming it, whatever the reported status. These kill
  processes and delete files.
- Two blockers additionally need a human before you can make progress at all:
  `NEEDS_INTERACTIVE_LOGIN` (someone must type a password — run
  `axis-browser login <url>`) and `PORT_HELD_BY_FOREIGN_PROCESS` (killing
  someone else's browser is their call).

The last point is not the complete list of times to ask. It is the list of times
you are *blocked*; the destructive-command rule above applies independently.

When `doctor` reports orphaned bridges, `axis-browser reap --dry-run` lists what
would be killed and `axis-browser reap` kills it. **Always run `--dry-run` first
and read the list.** A bridge is treated as an orphan when no session PID file
claims it — so a PID file that is truncated or unreadable makes its *live*
bridge look orphaned. Automatic cleanup refuses to run at all in that case, but
a manual `reap` you invoke yourself does not: it reports the malformed files
alongside what it killed. `--dry-run` is what turns that into a warning instead
of a dead session.

**Local CDP has no authentication.** A failed connection to a local DevTools
endpoint is never a missing token — never request credentials, API keys, or a
`ws://` URL.
