import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * One command name in everything user-facing: `axis-browser`, the fork's
 * primary bin — never the upstream-inherited `chrome-devtools-axi` alias
 * presented as the thing to type. A CodeRabbit round caught the alias inside
 * the unknown-flag suggestion and the README flags note after earlier sweeps
 * had cleaned other strings; this test holds the whole repo to the rule so
 * the class cannot reappear one string at a time.
 *
 * The alias is still *allowed* where it is the subject rather than the
 * command: the upstream package name, provenance comments, the bridge process
 * marker (`chrome-devtools-axi-bridge`), and demo blocks that list all three
 * bins together with the primary named first.
 */

const SCAN_ROOTS = [
  "src",
  "README.md",
  "docs",
  "prompts",
  "project-guide-site",
];

/** An invocation shape: the alias followed by something you would type. */
const INVOCATION = /chrome-devtools-axi\s+[-<[A-Za-z]/;

/** Contexts where the alias is the topic, not the instruction. */
const ALLOWED_CONTEXT =
  /axis-browser|axib|upstream|npm|package|registry|github|Nirmantix|kunchenguid/;

/** Violations in one file's already-read lines. */
function scanLines(lines: string[], file = "synthetic"): string[] {
  const violations: string[] = [];
  lines.forEach((line, index) => {
    if (!INVOCATION.test(line)) return;
    const context = lines.slice(Math.max(0, index - 2), index + 2).join("\n");
    if (ALLOWED_CONTEXT.test(context)) return;
    violations.push(`${file}:${index + 1}: ${line.trim()}`);
  });
  return violations;
}

function listFiles(root: string): string[] {
  const entries = readdirSync(root, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...listFiles(path));
    else if (/\.(ts|md|html)$/.test(entry.name)) files.push(path);
  }
  return files;
}

const REPO_FILES = SCAN_ROOTS.flatMap((root) =>
  root.endsWith(".md") ? [root] : listFiles(root),
);

describe("user-facing command name", () => {
  it("flags the alias presented as a command", () => {
    expect(
      scanLines(["Run `chrome-devtools-axi doctor --help` to see flags"]),
    ).toEqual([
      "synthetic:1: Run `chrome-devtools-axi doctor --help` to see flags",
    ]);
    expect(
      scanLines(["listed by `chrome-devtools-axi <command> --help`."]),
    ).toHaveLength(1);
  });

  it("allows the alias as the subject, never the instruction", () => {
    expect(scanLines(["`chrome-devtools-axi-bridge` is the marker"])).toEqual(
      [],
    );
    expect(
      scanLines(["Installing `chrome-devtools-axi` from npm gets upstream"]),
    ).toEqual([]);
    expect(scanLines(["the chrome-devtools-axi package version"])).toEqual([]);
    expect(
      scanLines(["merged from upstream chrome-devtools-axi 0.1.35"]),
    ).toEqual([]);
    expect(
      scanLines(['"chrome-devtools-axi": commandCheck("chrome-devtools-axi")']),
    ).toEqual([]);
  });

  it("allows a demo that lists all three bins with the primary named first", () => {
    // The context rule is what permits the alias-demo blocks, not the single
    // line: on its own the third line would be a violation.
    expect(
      scanLines([
        "axis-browser --version",
        "axib --version",
        "chrome-devtools-axi --version",
      ]),
    ).toEqual([]);
    expect(scanLines(["chrome-devtools-axi --version"])).toHaveLength(1);
  });

  it("holds every scanned file to the primary command name", () => {
    expect(REPO_FILES.length).toBeGreaterThan(10);
    const violations = REPO_FILES.flatMap((file) =>
      scanLines(readFileSync(file, "utf8").split("\n"), file),
    );
    expect(violations).toEqual([]);
  });
});
