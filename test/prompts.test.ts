import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const prompts = ["absetup", "abcheck", "abuse", "abhealth"] as const;

async function promptBody(name: (typeof prompts)[number]) {
  return readFile(join(repoRoot, "prompts", `${name}.md`), "utf8");
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
      expect(body).toContain('BB="${BROWSER_BAY_DIR:-}"');
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
});
