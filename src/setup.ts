import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

type Env = NodeJS.ProcessEnv;

export interface SetupWorkflowArgs {
  action: "workflow";
  install: boolean;
  json: boolean;
  projectPath?: string;
  yes: boolean;
}

export interface SetupHooksArgs {
  action: "hooks";
}

export type ParsedSetupArgs = SetupWorkflowArgs | SetupHooksArgs;

export interface SetupCheck {
  status: "ok" | "missing" | "unknown";
  detail?: string;
  path?: string;
}

export interface BrowserSkillResolution {
  status: "found" | "missing";
  path?: string;
  source: string;
  sourceUrl?: string;
}

export interface RouterRun {
  command: string[];
  cwd: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

export interface SetupReport {
  version: 1;
  mode: "report" | "install" | "preview";
  projectPath: string;
  interactive: boolean;
  yes: boolean;
  checks: {
    node: SetupCheck;
    pnpm: SetupCheck;
    corepack: SetupCheck;
    chrome: SetupCheck;
    builtCli: SetupCheck;
    globalAliases: Record<string, SetupCheck>;
  };
  browserSkill: BrowserSkillResolution;
  router: {
    status: "absent" | "checked" | "previewed" | "installed" | "error";
    runs: RouterRun[];
  };
  nextSteps: string[];
}

interface SetupRuntime {
  cwd?: string;
  env?: Env;
  home?: string;
  isTTY?: boolean;
  platform?: NodeJS.Platform;
}

interface MutableSetupRuntime extends Required<SetupRuntime> {
  packageRoot: string;
}

interface RouterScriptContext {
  env: Env;
  report: SetupReport;
}

const STANDARD_AGENT_SKILL_PATHS = [
  [".codex", "skills", "browser-skill"],
  [".config", "agents", "skills", "browser-skill"],
  [".claude", "skills", "browser-skill"],
  [".config", "opencode", "skills", "browser-skill"],
  [".pi", "skills", "browser-skill"],
] as const;

export function parseSetupArgs(args: string[]): ParsedSetupArgs {
  if (args.length === 1 && args[0] === "hooks") {
    return { action: "hooks" };
  }

  const parsed: SetupWorkflowArgs = {
    action: "workflow",
    install: false,
    json: false,
    yes: false,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    switch (arg) {
      case "--install":
        parsed.install = true;
        break;
      case "--json":
        parsed.json = true;
        break;
      case "--yes":
      case "-y":
        parsed.yes = true;
        break;
      case "--project": {
        const value = args[++i];
        if (!value) {
          throw new Error("Missing value for --project");
        }
        parsed.projectPath = value;
        break;
      }
      default:
        throw new Error(`Unknown setup option: ${arg}`);
    }
  }

  return parsed;
}

export function resolveBrowserSkillDir(
  runtime: Pick<MutableSetupRuntime, "env" | "home" | "cwd">,
  exists: (path: string) => boolean = existsSync,
): BrowserSkillResolution {
  const { env, home, cwd } = runtime;
  const candidates: { source: string; path: string | undefined }[] = [
    { source: "BROWSER_SKILL_DIR", path: env.BROWSER_SKILL_DIR },
    {
      source: "AXIS_BROWSER_HOME",
      path: env.AXIS_BROWSER_HOME
        ? join(env.AXIS_BROWSER_HOME, "skills", "browser-skill")
        : undefined,
    },
    {
      source: "AXIS_PORTABLE_SKILLS_DIR",
      path: env.AXIS_PORTABLE_SKILLS_DIR
        ? join(env.AXIS_PORTABLE_SKILLS_DIR, "browser-skill")
        : undefined,
    },
    ...STANDARD_AGENT_SKILL_PATHS.map((parts) => ({
      source: "standard agent skill location",
      path: join(home, ...parts),
    })),
  ];

  for (const candidate of candidates) {
    if (candidate.path && exists(candidate.path)) {
      return {
        status: "found",
        path: resolve(candidate.path),
        source: candidate.source,
      };
    }
  }

  return {
    status: "missing",
    source: env.BROWSER_SKILL_SOURCE_URL
      ? "BROWSER_SKILL_SOURCE_URL"
      : "not configured",
    ...(env.BROWSER_SKILL_SOURCE_URL
      ? { sourceUrl: env.BROWSER_SKILL_SOURCE_URL }
      : {}),
  };
}

export function createSetupReport(
  args: SetupWorkflowArgs,
  runtime: SetupRuntime = {},
): SetupReport {
  const resolved = resolveRuntime(runtime);
  const projectPath = resolve(resolved.cwd, args.projectPath ?? ".");
  const reportMode = args.install
    ? resolved.isTTY || args.yes
      ? "install"
      : "preview"
    : "report";
  const browserSkill = resolveBrowserSkillDir({
    env: resolved.env,
    home: resolved.home,
    cwd: projectPath,
  });

  return {
    version: 1,
    mode: reportMode,
    projectPath,
    interactive: resolved.isTTY,
    yes: args.yes,
    checks: {
      node: commandCheck("node", ["--version"]),
      pnpm: commandCheck("pnpm", ["--version"]),
      corepack: commandCheck("corepack", ["--version"]),
      chrome: chromeCheck(resolved.platform),
      builtCli: builtCliCheck(resolved.packageRoot),
      globalAliases: {
        "axis-browser": commandCheck("axis-browser", ["--version"]),
        axib: commandCheck("axib", ["--version"]),
        "chrome-devtools-axi": commandCheck("chrome-devtools-axi", [
          "--version",
        ]),
      },
    },
    browserSkill,
    router: {
      status: browserSkill.status === "found" ? "checked" : "absent",
      runs: [],
    },
    nextSteps: nextStepsFor(browserSkill, reportMode, projectPath),
  };
}

export function runSetupWorkflow(
  args: SetupWorkflowArgs,
  runtime: SetupRuntime = {},
): SetupReport {
  const resolved = resolveRuntime(runtime);
  const report = createSetupReport(args, resolved);
  if (report.browserSkill.status !== "found" || !report.browserSkill.path) {
    return report;
  }

  const skillDir = report.browserSkill.path;
  const checkScript = join(skillDir, "scripts", "check-prerequisites.sh");
  const setupScript = join(skillDir, "scripts", "setup.sh");

  if (!existsSync(checkScript)) {
    report.router.status = "error";
    report.router.runs.push({
      command: ["bash", checkScript],
      cwd: report.projectPath,
      exitCode: null,
      stdout: "",
      stderr: "router check script not found",
    });
    return report;
  }

  const runsOk = () =>
    report.router.runs.length > 0 &&
    report.router.runs.every((run) => run.exitCode === 0);

  if (report.mode === "report") {
    report.router.runs.push(
      runRouterScript(checkScript, [], {
        env: resolved.env,
        report,
      }),
    );
    report.router.status = runsOk() ? "checked" : "error";
    return report;
  }

  if (report.mode === "preview") {
    if (existsSync(setupScript)) {
      report.router.runs.push(
        runRouterScript(setupScript, ["--dry-run"], {
          env: resolved.env,
          report,
        }),
      );
    }
    report.router.runs.push(
      runRouterScript(checkScript, ["--print-install-commands"], {
        env: resolved.env,
        report,
      }),
    );
    report.router.status = runsOk() ? "previewed" : "error";
    return report;
  }

  if (existsSync(setupScript)) {
    report.router.runs.push(
      runRouterScript(setupScript, [], {
        env: resolved.env,
        report,
      }),
    );
  }

  report.router.runs.push(
    runRouterScript(checkScript, ["--install"], {
      env: resolved.env,
      report,
    }),
  );
  report.router.status = runsOk() ? "installed" : "error";
  return report;
}

export function formatSetupReport(report: SetupReport): string {
  const lines = [
    "setup:",
    `  mode: ${report.mode}`,
    `  project: ${JSON.stringify(report.projectPath)}`,
    `  interactive: ${report.interactive}`,
    `  yes: ${report.yes}`,
    "checks:",
    `  node: ${formatCheck(report.checks.node)}`,
    `  pnpm: ${formatCheck(report.checks.pnpm)}`,
    `  corepack: ${formatCheck(report.checks.corepack)}`,
    `  chrome: ${formatCheck(report.checks.chrome)}`,
    `  builtCli: ${formatCheck(report.checks.builtCli)}`,
    "aliases:",
    ...Object.entries(report.checks.globalAliases).map(
      ([name, check]) => `  ${name}: ${formatCheck(check)}`,
    ),
    "browserSkill:",
    `  status: ${report.browserSkill.status}`,
    `  source: ${report.browserSkill.source}`,
  ];

  if (report.browserSkill.path) {
    lines.push(`  path: ${JSON.stringify(report.browserSkill.path)}`);
  }
  if (report.browserSkill.sourceUrl) {
    lines.push(`  sourceUrl: ${JSON.stringify(report.browserSkill.sourceUrl)}`);
  }

  lines.push("router:", `  status: ${report.router.status}`);
  for (const run of report.router.runs) {
    lines.push(
      `  - command: ${run.command.map(shellDisplay).join(" ")}`,
      `    cwd: ${JSON.stringify(run.cwd)}`,
      `    exitCode: ${run.exitCode ?? "unknown"}`,
    );
    if (run.stdout.trim()) {
      lines.push(indentBlock("    stdout:", run.stdout));
    }
    if (run.stderr.trim()) {
      lines.push(indentBlock("    stderr:", run.stderr));
    }
  }

  if (report.nextSteps.length > 0) {
    lines.push(
      `help[${report.nextSteps.length}]:`,
      ...report.nextSteps.map((step) => `  ${step}`),
    );
  }

  return lines.join("\n");
}

function resolveRuntime(runtime: SetupRuntime): MutableSetupRuntime {
  return {
    cwd: runtime.cwd ?? process.cwd(),
    env: runtime.env ?? process.env,
    home: runtime.home ?? homedir(),
    isTTY:
      runtime.isTTY ?? Boolean(process.stdin.isTTY && process.stdout.isTTY),
    platform: runtime.platform ?? process.platform,
    packageRoot: findPackageRoot(),
  };
}

function findPackageRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const candidate of [join(here, ".."), join(here, "..", "..")]) {
    if (existsSync(join(candidate, "package.json"))) {
      return candidate;
    }
  }
  return process.cwd();
}

function commandCheck(command: string, args: string[] = []): SetupCheck {
  const path = commandPath(command);
  if (!path) {
    return { status: "missing" };
  }

  const result = spawnSync(command, args, {
    encoding: "utf8",
    timeout: 5000,
  });
  const detail = `${result.stdout}${result.stderr}`.trim().split("\n")[0];
  return {
    status: result.status === 0 ? "ok" : "unknown",
    path,
    ...(detail ? { detail } : {}),
  };
}

function commandPath(command: string): string | undefined {
  const lookup =
    process.platform === "win32"
      ? `where ${command}`
      : `command -v ${shellQuote(command)}`;
  const result = spawnSync(lookup, {
    encoding: "utf8",
    shell: true,
    timeout: 5000,
  });
  if (result.status !== 0) {
    return undefined;
  }
  return result.stdout.trim().split("\n")[0];
}

function chromeCheck(platform: NodeJS.Platform): SetupCheck {
  const commandNames = [
    "google-chrome",
    "chromium",
    "chromium-browser",
    "chrome",
    "msedge",
  ];
  for (const command of commandNames) {
    const path = commandPath(command);
    if (path) {
      return { status: "ok", path };
    }
  }

  if (platform === "darwin") {
    for (const appPath of [
      "/Applications/Google Chrome.app",
      "/Applications/Chromium.app",
      "/Applications/Microsoft Edge.app",
    ]) {
      if (existsSync(appPath)) {
        return { status: "ok", path: appPath };
      }
    }
  }

  return { status: "missing" };
}

function builtCliCheck(packageRoot: string): SetupCheck {
  const builtPath = join(packageRoot, "dist", "bin", "chrome-devtools-axi.js");
  if (existsSync(builtPath)) {
    return { status: "ok", path: builtPath };
  }
  return {
    status: "missing",
    detail: "run pnpm run build from the Axis Browser checkout",
  };
}

function runRouterScript(
  scriptPath: string,
  args: string[],
  context: RouterScriptContext,
): RouterRun {
  const command = ["bash", scriptPath, ...args];
  const result = spawnSync(command[0], command.slice(1), {
    cwd: context.report.projectPath,
    encoding: "utf8",
    env: {
      ...context.env,
      BROWSER_SKILL_DIR: context.report.browserSkill.path,
      SKILL_DIR: context.report.browserSkill.path,
    },
    maxBuffer: 1024 * 1024,
    timeout: 120000,
  });

  return {
    command,
    cwd: context.report.projectPath,
    exitCode: result.status,
    stdout: result.stdout ?? "",
    stderr: result.error?.message ?? result.stderr ?? "",
  };
}

function nextStepsFor(
  browserSkill: BrowserSkillResolution,
  mode: SetupReport["mode"],
  projectPath: string,
): string[] {
  if (browserSkill.status === "missing") {
    const source = browserSkill.sourceUrl
      ? `Install browser-skill from ${browserSkill.sourceUrl}, then rerun \`axis-browser setup\``
      : "Configure BROWSER_SKILL_DIR, AXIS_BROWSER_HOME, AXIS_PORTABLE_SKILLS_DIR, or BROWSER_SKILL_SOURCE_URL for router setup";
    return [
      source,
      "Run `axis-browser setup --json` for machine-readable status",
    ];
  }

  if (mode === "preview") {
    return [
      "Rerun in an interactive terminal or add `--yes` only after reviewing the printed commands",
      `Target project: ${projectPath}`,
    ];
  }

  if (mode === "install") {
    return [
      "Review router output for any project-local dependency recommendations",
      `Target project: ${projectPath}`,
    ];
  }

  return [
    "Run `axis-browser setup --install` to preview or perform permission-gated setup",
    "Run `axis-browser setup hooks` to install Claude Code and Codex SessionStart hooks",
  ];
}

function formatCheck(check: SetupCheck): string {
  const parts: string[] = [check.status];
  if (check.detail) parts.push(`(${check.detail})`);
  if (check.path) parts.push(`at ${JSON.stringify(check.path)}`);
  return parts.join(" ");
}

function indentBlock(label: string, text: string): string {
  const body = text
    .trimEnd()
    .split("\n")
    .map((line) => `      ${line}`)
    .join("\n");
  return `${label}\n${body}`;
}

function shellDisplay(value: string): string {
  return /[\s"']/.test(value) ? shellQuote(value) : value;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}
