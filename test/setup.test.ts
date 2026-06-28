import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createSetupReport,
  parseSetupArgs,
  resolveBrowserSkillDir,
  runSetupWorkflow,
  type SetupWorkflowArgs,
} from "../src/setup.js";

const temps: string[] = [];

afterEach(() => {
  for (const dir of temps.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "axis-setup-test-"));
  temps.push(dir);
  return dir;
}

function makeBrowserSkill(root: string): string {
  const skillDir = join(root, "browser-skill");
  const scripts = join(skillDir, "scripts");
  mkdirSync(scripts, { recursive: true });
  writeFileSync(
    join(scripts, "check-prerequisites.sh"),
    [
      "#!/usr/bin/env bash",
      'printf \'check:%s:%s\\n\' "$PWD" "$*"',
      "exit 0",
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(scripts, "setup.sh"),
    [
      "#!/usr/bin/env bash",
      'printf \'setup:%s:%s\\n\' "$PWD" "$*"',
      "exit 0",
      "",
    ].join("\n"),
  );
  return skillDir;
}

function workflowArgs(args: string[]): SetupWorkflowArgs {
  const parsed = parseSetupArgs(args);
  if (parsed.action !== "workflow") {
    throw new Error("expected workflow setup args");
  }
  return parsed;
}

describe("parseSetupArgs", () => {
  it("parses read-only setup by default", () => {
    expect(parseSetupArgs([])).toEqual({
      action: "workflow",
      install: false,
      json: false,
      yes: false,
    });
  });

  it("preserves setup hooks as a separate action", () => {
    expect(parseSetupArgs(["hooks"])).toEqual({ action: "hooks" });
  });

  it("parses install, project, json, and yes flags", () => {
    expect(
      parseSetupArgs(["--install", "--project", "../app", "--json", "--yes"]),
    ).toEqual({
      action: "workflow",
      install: true,
      json: true,
      projectPath: "../app",
      yes: true,
    });
  });

  it("rejects unknown setup options", () => {
    expect(() => parseSetupArgs(["--wat"])).toThrow(
      "Unknown setup option: --wat",
    );
  });
});

describe("resolveBrowserSkillDir", () => {
  it("uses the documented resolver precedence", () => {
    const root = tempDir();
    const home = join(root, "home");
    const cwd = join(root, "project");
    const envSkill = makeBrowserSkill(join(root, "env"));
    const axisHome = join(root, "axis-home");
    const portable = join(root, "portable");
    const standard = join(home, ".codex", "skills");
    makeBrowserSkill(join(axisHome, "skills"));
    makeBrowserSkill(portable);
    makeBrowserSkill(standard);

    const env = {
      BROWSER_SKILL_DIR: envSkill,
      AXIS_BROWSER_HOME: axisHome,
      AXIS_PORTABLE_SKILLS_DIR: portable,
    };

    expect(resolveBrowserSkillDir({ env, home, cwd }).path).toBe(
      resolve(envSkill),
    );

    delete env.BROWSER_SKILL_DIR;
    expect(resolveBrowserSkillDir({ env, home, cwd }).path).toBe(
      resolve(join(axisHome, "skills", "browser-skill")),
    );

    delete env.AXIS_BROWSER_HOME;
    expect(resolveBrowserSkillDir({ env, home, cwd }).path).toBe(
      resolve(join(portable, "browser-skill")),
    );

    delete env.AXIS_PORTABLE_SKILLS_DIR;
    expect(resolveBrowserSkillDir({ env, home, cwd }).path).toBe(
      resolve(join(standard, "browser-skill")),
    );
  });

  it("reports source not configured unless BROWSER_SKILL_SOURCE_URL is set", () => {
    const root = tempDir();
    const missing = resolveBrowserSkillDir({
      env: {},
      home: join(root, "home"),
      cwd: join(root, "project"),
    });
    expect(missing).toEqual({
      status: "missing",
      source: "not configured",
    });

    const configured = resolveBrowserSkillDir({
      env: { BROWSER_SKILL_SOURCE_URL: "https://example.test/skill.git" },
      home: join(root, "home"),
      cwd: join(root, "project"),
    });
    expect(configured.source).toBe("BROWSER_SKILL_SOURCE_URL");
    expect(configured.sourceUrl).toBe("https://example.test/skill.git");
  });

  it("does not discover project-local browser-skill outside the approved resolver order", () => {
    const root = tempDir();
    const project = join(root, "project");
    makeBrowserSkill(join(project, "skills"));

    expect(
      resolveBrowserSkillDir({
        env: {},
        home: join(root, "home"),
        cwd: project,
      }),
    ).toEqual({
      status: "missing",
      source: "not configured",
    });
  });
});

describe("runSetupWorkflow", () => {
  it("returns a read-only report when browser-skill is absent", () => {
    const root = tempDir();
    const report = createSetupReport(workflowArgs([]), {
      cwd: root,
      env: {},
      home: join(root, "home"),
      isTTY: false,
    });

    expect(report.mode).toBe("report");
    expect(report.browserSkill.status).toBe("missing");
    expect(report.router.status).toBe("absent");
    expect(report.browserSkill.source).toBe("not configured");
    expect(report.nextSteps.join("\n")).toContain("BROWSER_SKILL_SOURCE_URL");
  });

  it("delegates read-only checks to browser-skill when present", () => {
    const root = tempDir();
    const project = join(root, "project");
    mkdirSync(project);
    const skillDir = makeBrowserSkill(join(root, "skill"));
    const report = runSetupWorkflow(workflowArgs([]), {
      cwd: root,
      env: { BROWSER_SKILL_DIR: skillDir },
      home: join(root, "home"),
      isTTY: false,
    });

    expect(report.router.status).toBe("checked");
    expect(report.router.runs).toHaveLength(1);
    expect(report.router.runs[0].command).toEqual([
      "bash",
      join(skillDir, "scripts", "check-prerequisites.sh"),
    ]);
  });

  it("previews install actions in non-interactive mode without --yes", () => {
    const root = tempDir();
    const skillDir = makeBrowserSkill(join(root, "skill"));
    const report = runSetupWorkflow(workflowArgs(["--install"]), {
      cwd: root,
      env: { BROWSER_SKILL_DIR: skillDir },
      home: join(root, "home"),
      isTTY: false,
    });

    expect(report.mode).toBe("preview");
    expect(report.router.status).toBe("previewed");
    expect(report.router.runs[0].command).toContain("--dry-run");
    expect(report.router.runs[1].command).toContain("--print-install-commands");
  });

  it("scopes router setup to --project", () => {
    const root = tempDir();
    const project = join(root, "target-project");
    mkdirSync(project);
    const skillDir = makeBrowserSkill(join(root, "skill"));
    const report = runSetupWorkflow(
      workflowArgs(["--install", "--yes", "--project", project]),
      {
        cwd: root,
        env: { BROWSER_SKILL_DIR: skillDir },
        home: join(root, "home"),
        isTTY: false,
      },
    );

    expect(report.projectPath).toBe(project);
    expect(report.router.runs[0].cwd).toBe(project);
    expect(report.router.runs[0].stdout).toContain("setup:");
    expect(report.router.runs[0].stdout).toContain("target-project");
  });
});

describe("setup docs and source portability", () => {
  it("does not hardcode personal workstation paths", () => {
    const repo = resolve(fileURLToPath(new URL("..", import.meta.url)));
    const files = collectFiles(repo, ["README.md", "SKILL.md", "docs", "src"]);
    const haystack = files.map((file) => readFileSync(file, "utf8")).join("\n");

    // No machine-specific absolute home path may appear in shipped source or docs.
    expect(haystack).not.toMatch(/\/(?:Users|home)\/[^/\s"']+/);
  });
});

function collectFiles(root: string, names: string[]): string[] {
  const out: string[] = [];
  for (const name of names) {
    const path = join(root, name);
    try {
      const entries = readdirSync(path, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) {
          out.push(...collectFiles(path, [entry.name]));
        } else if (entry.isFile()) {
          out.push(join(path, entry.name));
        }
      }
    } catch {
      out.push(path);
    }
  }
  return out;
}
