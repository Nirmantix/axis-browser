import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const prompts = ["absetup", "abcheck", "abuse", "abhealth"] as const;

async function promptBody(name: (typeof prompts)[number]) {
  return readFile(path.join(root, "prompts", `${name}.md`), "utf8");
}

describe("Axis Browser workflow prompts", () => {
  for (const name of prompts) {
    it(`${name} has the required contract`, async () => {
      const body = await promptBody(name);

      expect(body).toContain(`Task Shortcode: ;${name}`);
      expect(body).toContain("Purpose:");
      expect(body).toContain("Associated skill");
      expect(body.includes("BROWSER_SKILL_DIR") || body.includes("skills/browser-skill")).toBe(true);
      expect(body).toContain("NEVER write API keys");
      expect(body).toContain("NEVER modify .env");
      expect(body).toContain("NEVER print credential values");
      expect(body.trim().split(/\r?\n/).length).toBeLessThanOrEqual(80);
    });
  }

  it("abuse is only a launcher", async () => {
    const body = await promptBody("abuse");

    expect(body).toContain("Load \"$BROWSER_SKILL_DIR/SKILL.md\"");
    expect(body).toContain("Follow SKILL.md for all routing");
    expect(body).toContain("No standalone tool routing table");
    expect(body).not.toMatch(/\bnpm\s+install\b/);
    expect(body).not.toMatch(/\bgit\s+clone\b/);
    expect(body).not.toMatch(/\bpip\s+install\b/);
    expect(body).not.toMatch(/\bbrew\s+install\b/);
  });
});
