import { describe, expect, it } from "vitest";
import {
  assertCommandFlagsAllowed,
  getCommandHelp,
  isAllPositionalText,
  listCommands,
} from "../src/cli.js";

/**
 * Every flag a command documents must be a flag it accepts.
 *
 * Upstream 0.1.34 added strict per-command flag rejection. Its allow-list had no
 * entry for the fork-owned commands, so merging it silently broke
 * `update --check`, `doctor --json`, `reap --dry-run --min-age-hours <n>` and
 * `setup --install --yes --project <path>`: each printed
 * `Unknown flag … VALIDATION_ERROR` instead of running. Nothing caught it, because
 * the help text and the validator are two lists nobody compared.
 *
 * So compare them. The flags under test are parsed out of the help the CLI itself
 * prints, which means a command whose help gains a flag the validator does not
 * know about fails here rather than in a user's shell.
 */

/** Flags named in a command's `usage:` lines and `flags:` block. */
function documentedFlags(help: string): string[] {
  const flags: string[] = [];
  let inFlagsBlock = false;
  for (const line of help.split("\n")) {
    if (/^(args|flags|actions|examples):/.test(line)) {
      inFlagsBlock = line.startsWith("flags:");
      continue;
    }
    if (line.trim() === "") {
      inFlagsBlock = false;
      continue;
    }
    if (line.startsWith("usage:")) {
      // [--full], [--project <path>], [--format png|jpeg|webp]
      for (const bracket of line.matchAll(/\[(--?[A-Za-z0-9-]+)/g)) {
        flags.push(bracket[1]);
      }
      continue;
    }
    if (inFlagsBlock) {
      // "  --dry-run            Report what would be reaped…" and "--yes, -y  …"
      for (const defined of line.matchAll(/(^|\s)(--?[A-Za-z0-9-]+)/g)) {
        flags.push(defined[2]);
      }
    }
  }
  return [...new Set(flags)];
}

/** Flags that take a separate value, so a bare flag would look like a mistake. */
const VALUE_FLAG_ARGS: Record<string, string> = {
  "--project": "/tmp/target-project",
  "--min-age-hours": "1",
  "--uid": "@g7:1",
  "--format": "png",
  "--viewport": "1280x720",
  "--color-scheme": "dark",
  "--network": "3g",
  "--cpu": "4",
  "--geolocation": "1,2",
  "--user-agent": "ua",
  "--type": "all",
  "--limit": "10",
  "--page": "1",
  "--response-file": "/tmp/r.json",
  "--request-file": "/tmp/q.json",
  "--device": "mobile",
  "--mode": "navigation",
  "--output-dir": "/tmp/out",
  "--file": "/tmp/trace.json",
};

describe("documented flags are accepted flags", () => {
  const commands = listCommands();

  it("dispatches a non-trivial command set", () => {
    // Guards the test itself: an empty or truncated list would pass every case
    // below while asserting nothing.
    expect(commands.length).toBeGreaterThan(30);
    for (const name of ["update", "doctor", "reap", "setup", "login", "open"]) {
      expect(commands, `${name} must be dispatched`).toContain(name);
    }
  });

  it.each(listCommands())("%s documents help", (command) => {
    const help = getCommandHelp(command);
    expect(help, `${command} has no help text`).not.toBeNull();
    expect(help).toContain(`usage: axis-browser ${command}`);
  });

  it.each(listCommands())("%s accepts every flag it documents", (command) => {
    const help = getCommandHelp(command)!;
    for (const flag of documentedFlags(help)) {
      const argv = VALUE_FLAG_ARGS[flag]
        ? [flag, VALUE_FLAG_ARGS[flag]]
        : [flag];
      expect(
        () => assertCommandFlagsAllowed(command, argv),
        `${command} rejects its own documented ${flag}`,
      ).not.toThrow();
    }
  });

  it.each(listCommands())(
    "%s handles an undocumented flag the way its own syntax says",
    (command) => {
      // The mirror image: an allow-list that accepted everything would satisfy
      // the case above while protecting nothing.
      const bogus = ["--definitely-not-a-real-flag"];
      if (isAllPositionalText(command)) {
        // Every argument is free text from position 0 (`type --literal`,
        // `eval --counter`), so a leading `--` is the text itself rather than a
        // flag. Rejecting it would break those commands, which is upstream's own
        // contract — hence the exception is read from the validator's table and
        // not restated here as a command list.
        expect(() => assertCommandFlagsAllowed(command, bogus)).not.toThrow();
        return;
      }
      expect(() => assertCommandFlagsAllowed(command, bogus)).toThrow(
        /Unknown flag --definitely-not-a-real-flag/,
      );
    },
  );

  it("really has free-text commands, so that exception is not vacuous", () => {
    const freeText = listCommands().filter(isAllPositionalText);
    expect(freeText.length).toBeGreaterThan(0);
    expect(freeText).toContain("type");
    expect(freeText).toContain("eval");
  });
});

describe("the fork-owned commands upstream's allow-list never covered", () => {
  const cases: ReadonlyArray<{ argv: string[]; name: string }> = [
    { argv: ["update", "--check"], name: "update --check" },
    { argv: ["doctor", "--json"], name: "doctor --json" },
    { argv: ["reap", "--dry-run"], name: "reap --dry-run" },
    {
      argv: ["reap", "--dry-run", "--min-age-hours", "1"],
      name: "reap --dry-run --min-age-hours 1",
    },
    { argv: ["setup", "--install"], name: "setup --install" },
    { argv: ["setup", "--json"], name: "setup --json" },
    { argv: ["setup", "--install", "--yes"], name: "setup --install --yes" },
    { argv: ["setup", "--install", "-y"], name: "setup --install -y" },
    {
      argv: ["setup", "--install", "--project", "/tmp/target"],
      name: "setup --install --project <path>",
    },
    { argv: ["login", "https://example.com"], name: "login <url>" },
  ];

  it.each(cases)("$name is allowed", ({ argv }) => {
    expect(() =>
      assertCommandFlagsAllowed(argv[0], argv.slice(1)),
    ).not.toThrow();
  });

  it("still rejects an unknown update option", () => {
    expect(() =>
      assertCommandFlagsAllowed("update", ["--install-everything"]),
    ).toThrow(/Unknown flag --install-everything for `update`/);
  });
});

describe("--help never runs the command", () => {
  it.each(listCommands())("%s has help text to print", (command) => {
    // The SDK prints getCommandHelp(command) when `--help` is present and falls
    // through to the handler when it is null. `reap --help` used to take that
    // fall-through and terminate bridges instead of describing them, so a null
    // here is not a missing doc — it is a command that acts on `--help`.
    expect(getCommandHelp(command)).not.toBeNull();
  });

  it("documents the destructive commands' flags in their own help", () => {
    // `reap` terminates processes and `doctor` is the read-only alternative that
    // names what holds a port or profile, so both have to be discoverable from
    // the CLI rather than only from the README.
    expect(getCommandHelp("reap")).toContain("--dry-run");
    expect(getCommandHelp("reap")).toContain("--min-age-hours <n>");
    expect(getCommandHelp("doctor")).toContain("--json");
    expect(getCommandHelp("login")).toContain("<url>");
  });
});
