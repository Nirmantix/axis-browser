import { describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const run = promisify(execFile);
const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const prompts = ["absetup", "abcheck", "abuse", "abhealth"] as const;

async function promptBody(name: (typeof prompts)[number]) {
  return readFile(join(repoRoot, "prompts", `${name}.md`), "utf8");
}

/** The first ```bash fence in a prompt is its resolver block. */
function resolverBlock(body: string): string {
  const fence = body.match(/```bash\n([\s\S]*?)```/);
  if (!fence) throw new Error("no bash block found");
  return fence[1];
}

/**
 * Asserting on strings only proves a prompt *mentions* a resolver. It cannot
 * prove the loop assigns a usable directory — a prompt could contain every
 * expected fragment and still leave BB empty, which is the original defect.
 * So run the block the prompt actually ships and inspect what it resolved.
 */
async function resolveWith(
  block: string,
  env: NodeJS.ProcessEnv,
  cwd: string,
): Promise<{ bb: string; code: number; output: string }> {
  const argv = ["-c", `${block}\nprintf '%s' "$BB"`];
  const opts = { cwd, env: { PATH: process.env.PATH, ...env } };
  try {
    const { stdout } = await run("bash", argv, opts);
    return { bb: stdout.trim(), code: 0, output: stdout };
  } catch (error) {
    // The failure path is the interesting one: the resolver is supposed to exit
    // 2 *and say why*. Dropping stdout here would make that message untestable.
    const e = error as { code?: number; stdout?: string; stderr?: string };
    return {
      bb: "",
      code: e.code ?? 1,
      output: `${e.stdout ?? ""}${e.stderr ?? ""}`,
    };
  }
}

describe("Axis Browser workflow prompts", () => {
  for (const name of prompts) {
    it(`${name} has the required contract`, async () => {
      const body = await promptBody(name);

      expect(body).toContain(`Task Shortcode: ;${name}`);
      expect(body).toContain("Purpose:");
      expect(body).toContain("Associated skill");
      expect(
        body.includes("BROWSER_BAY_DIR") || body.includes("skills/browser-bay"),
      ).toBe(true);

      // The discovery sources are only useful if the commands resolve them.
      // An unset BROWSER_BAY_DIR must fall back, not degrade to "/scripts/...".
      expect(body).toContain(
        'for c in "${BROWSER_BAY_DIR:-}" "${BROWSER_SKILL_DIR:-}"',
      );
      expect(body).toContain("for p in");
      expect(body).toContain('[ -d "$BB" ] ||');
      // Both the bare and braced forms — `${BROWSER_BAY_DIR}/scripts/...` fails
      // exactly the same way as `$BROWSER_BAY_DIR/scripts/...` when it is unset.
      expect(body).not.toMatch(/\$\{?BROWSER_BAY_DIR\}?\//);

      expect(body).toContain("NEVER write API keys");
      expect(body).toContain("NEVER modify .env");
      expect(body).toContain("NEVER print credential values");
      expect(body.trim().split(/\r?\n/).length).toBeLessThanOrEqual(80);
    });
  }

  it("abuse is only a launcher", async () => {
    const body = await promptBody("abuse");

    expect(body).toContain('Load "$BB/SKILL.md"');
    expect(body).toContain("Follow SKILL.md for all routing");
    expect(body).toContain("No standalone tool routing table");
    expect(body).not.toMatch(/\bnpm\s+install\b/);
    expect(body).not.toMatch(/\bgit\s+clone\b/);
    expect(body).not.toMatch(/\bpip\s+install\b/);
    expect(body).not.toMatch(/\bbrew\s+install\b/);
  });

  describe("the shipped resolver block actually resolves", () => {
    for (const name of prompts) {
      it(`${name} finds a skill installed in a host location`, async () => {
        const root = mkdtempSync(join(tmpdir(), "prompt-resolver-"));
        try {
          const home = join(root, "home");
          const installed = join(home, ".claude", "skills", "browser-bay");
          mkdirSync(installed, { recursive: true });

          const { bb, code } = await resolveWith(
            resolverBlock(await promptBody(name)),
            { HOME: home },
            root,
          );

          expect(code).toBe(0);
          expect(bb).toBe(installed);
          // The whole point: the expansion must not degrade to "/scripts/...".
          expect(`${bb}/scripts/x.sh`.startsWith("/scripts/")).toBe(false);
        } finally {
          rmSync(root, { recursive: true, force: true });
        }
      });

      it(`${name} uses a configured BROWSER_BAY_DIR that exists`, async () => {
        const root = mkdtempSync(join(tmpdir(), "prompt-resolver-explicit-"));
        try {
          const home = join(root, "home");
          const configured = join(root, "configured-skill");
          mkdirSync(configured, { recursive: true });
          // Also present, and must lose: an explicit directory outranks discovery.
          mkdirSync(join(home, ".claude", "skills", "browser-bay"), {
            recursive: true,
          });

          const { bb, code } = await resolveWith(
            resolverBlock(await promptBody(name)),
            { HOME: home, BROWSER_BAY_DIR: configured },
            root,
          );

          expect(code).toBe(0);
          expect(bb).toBe(configured);
        } finally {
          rmSync(root, { recursive: true, force: true });
        }
      });

      it(`${name} exits 2 with a message when nothing is installed`, async () => {
        const root = mkdtempSync(join(tmpdir(), "prompt-resolver-none-"));
        try {
          const { bb, code, output } = await resolveWith(
            resolverBlock(await promptBody(name)),
            { HOME: join(root, "home") },
            root,
          );

          expect(code).toBe(2);
          expect(bb).toBe("");
          // A bare exit 2 is not enough — the operator has to be told what to set.
          expect(output).toContain(
            "browser-bay not found; set BROWSER_BAY_DIR",
          );
        } finally {
          rmSync(root, { recursive: true, force: true });
        }
      });

      it(`${name} honours the legacy BROWSER_SKILL_DIR`, async () => {
        // `resolveBrowserSkillDir` reads `BROWSER_BAY_DIR || BROWSER_SKILL_DIR`,
        // so the documented snippet has to accept the legacy name too.
        const root = mkdtempSync(join(tmpdir(), "prompt-resolver-legacy-"));
        try {
          const legacy = join(root, "legacy-skill");
          mkdirSync(legacy, { recursive: true });

          const { bb, code } = await resolveWith(
            resolverBlock(await promptBody(name)),
            {
              HOME: join(root, "home"),
              BROWSER_SKILL_DIR: legacy,
            },
            root,
          );

          expect(code).toBe(0);
          expect(bb).toBe(legacy);
        } finally {
          rmSync(root, { recursive: true, force: true });
        }
      });

      it(`${name} falls through a set-but-missing BROWSER_BAY_DIR`, async () => {
        // Matches resolveBrowserSkillDir, which continues to later candidates
        // when the configured directory does not exist.
        const root = mkdtempSync(join(tmpdir(), "prompt-resolver-stale-"));
        try {
          const home = join(root, "home");
          const installed = join(home, ".codex", "skills", "browser-bay");
          mkdirSync(installed, { recursive: true });

          const { bb, code } = await resolveWith(
            resolverBlock(await promptBody(name)),
            { HOME: home, BROWSER_BAY_DIR: join(root, "gone") },
            root,
          );

          expect(code).toBe(0);
          expect(bb).toBe(installed);
        } finally {
          rmSync(root, { recursive: true, force: true });
        }
      });
    }
  });
});
