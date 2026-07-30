import { describe, expect, it } from "vitest";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

const RESOLVER_HEAD = 'BB="${BROWSER_BAY_DIR:-}"';

/**
 * The documented shell resolver must search the same roots as the CLI's own
 * `resolveBrowserSkillDir`. They drifted once: the docs told users to copy the
 * skill into `~/.claude/skills/`, and then the resolver they pasted stopped at
 * `./skills/browser-bay` and reported "browser-bay not found" for a skill that
 * was installed correctly. Reading the list out of the source keeps the two in
 * step instead of trusting a comment.
 */
async function cliSkillRoots(): Promise<string[]> {
  const source = await readFile(join(repoRoot, "src", "setup.ts"), "utf8");
  const block = source.match(
    /const STANDARD_AGENT_SKILL_PARENTS\s*=\s*\[([\s\S]*?)\]\s*as const;/,
  );
  if (!block) throw new Error("STANDARD_AGENT_SKILL_PARENTS not found");

  return [...block[1].matchAll(/\[([^\]]*)\]/g)].map((row) =>
    [...row[1].matchAll(/"([^"]+)"/g)].map((part) => part[1]).join("/"),
  );
}

/**
 * The prompt contract test bans `$BROWSER_BAY_DIR/` across whole prompt files.
 * That regex cannot be applied file-wide to README.md, the lifecycle doc, or
 * the microsite: those legitimately name the raw variable in prose explaining
 * the failure mode ("degrades to `bash \"/scripts/...\"`"). Scoping the ban to
 * code blocks keeps the prose and still guards the thing that actually runs.
 *
 * Each format is matched on how it presents a runnable command: fenced blocks
 * in markdown (so single-backtick inline prose stays legal) and <pre>/<code> in
 * HTML (the microsite renders commands as <code>, so it has to be covered).
 */
function markdownCodeBlocks(source: string): string[] {
  return source.match(/```[\s\S]*?```/g) ?? [];
}

function htmlCodeBlocks(source: string): string[] {
  return [
    ...(source.match(/<pre\b[\s\S]*?<\/pre>/g) ?? []),
    ...(source.match(/<code\b[\s\S]*?<\/code>/g) ?? []),
  ];
}

async function docFiles(): Promise<Array<{ path: string; blocks: string[] }>> {
  const files: Array<{ path: string; blocks: string[] }> = [];

  const markdown = [
    "README.md",
    "CHANGELOG.md",
    "SKILL.md",
    ...(await readdir(join(repoRoot, "docs")))
      .filter((name) => name.endsWith(".md"))
      .map((name) => join("docs", name)),
    ...(await readdir(join(repoRoot, "prompts")))
      .filter((name) => name.endsWith(".md"))
      .map((name) => join("prompts", name)),
  ];
  for (const path of markdown) {
    const source = await readFile(join(repoRoot, path), "utf8");
    files.push({ path, blocks: markdownCodeBlocks(source) });
  }

  const html = (await readdir(join(repoRoot, "project-guide-site")))
    .filter((name) => name.endsWith(".html"))
    .map((name) => join("project-guide-site", name));
  for (const path of html) {
    const source = await readFile(join(repoRoot, path), "utf8");
    files.push({ path, blocks: htmlCodeBlocks(source) });
  }

  return files;
}

describe("browser-bay path resolution in documented commands", () => {
  it("no runnable code block invokes an unresolved $BROWSER_BAY_DIR path", async () => {
    const offenders: string[] = [];

    for (const { path, blocks } of await docFiles()) {
      for (const block of blocks) {
        // The resolver definition itself contains `${BROWSER_BAY_DIR:-` with no
        // trailing slash, so it does not match and stays legal.
        // Both the bare and braced forms: `${BROWSER_BAY_DIR}/scripts/...` fails
        // exactly the same way as `$BROWSER_BAY_DIR/scripts/...` when it is unset.
        if (/\$\{?BROWSER_BAY_DIR\}?\//.test(block)) {
          const line = block
            .split(/\r?\n/)
            .find((candidate) => /\$\{?BROWSER_BAY_DIR\}?\//.test(candidate));
          offenders.push(`${path}: ${line?.trim()}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  it("every file whose commands use $BB also defines the resolver", async () => {
    const missing: string[] = [];

    for (const { path, blocks } of await docFiles()) {
      const usesBB = blocks.some((block) => block.includes('"$BB/'));
      if (!usesBB) continue;

      const source = await readFile(join(repoRoot, path), "utf8");
      if (!source.includes(RESOLVER_HEAD)) {
        missing.push(path);
      }
    }

    expect(missing).toEqual([]);
  });

  it("every documented resolver searches the same roots the CLI does", async () => {
    const roots = await cliSkillRoots();
    expect(roots.length).toBeGreaterThan(0);

    const gaps: string[] = [];

    for (const { path, blocks } of await docFiles()) {
      const resolver = blocks.find((block) => block.includes(RESOLVER_HEAD));
      if (!resolver) continue;

      for (const root of roots) {
        if (!resolver.includes(root)) gaps.push(`${path}: missing ${root}`);
      }
    }

    expect(gaps).toEqual([]);
  });
});
