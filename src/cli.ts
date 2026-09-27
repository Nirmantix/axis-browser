import { encode } from "@toon-format/toon";
import { runAxiCli } from "axi-sdk-js";
import {
  CdpError,
  callTool,
  ensureBridge,
  getSessionSnapshotIfRunning,
  stopBridge,
} from "./client.js";
import { isRecoverableOpenError } from "./errors.js";
import { readStdin, runScript, wrapJsExpression } from "./run.js";
import {
  formatSetupReport,
  parseSetupArgs,
  runSetupWorkflow,
  type ParsedSetupArgs,
} from "./setup.js";

import {
  countRefs,
  extractTitle,
  stripSnapshotHeader,
  truncateSnapshot,
  truncateText,
} from "./snapshot.js";
import { getSuggestions } from "./suggestions.js";
import { buildDoctorReport, renderDoctorReport } from "./doctor.js";
import { resolveUserDataDir } from "./mode.js";
import {
  DEFAULT_REAP_MIN_AGE_MS,
  findOrphanBridges,
  reapBridges,
  scanSessionPidFiles,
} from "./reap.js";
import { resolveSessionName } from "./sessions.js";
import { installHooksOrThrow } from "./hooks.js";
import { parsePagesList } from "./pages.js";
import { overlaySessionSelected } from "./selected-page.js";
import { resolveOutputPath } from "./paths.js";
import { PRIMARY_COMMAND_NAME, VERSION } from "./version.js";
import { captureFreshSnapshot, parseUidFresh } from "./uid-freshness.js";

export { parsePagesList };

const HOME_DESCRIPTION =
  "Axis Browser is a fast, agent-first CLI for Chrome automation and shared CDP workflows. Also runs as the `axib` shorthand.";

const RAW_STDOUT_MARKER = "__CHROME_DEVTOOLS_AXI_RAW__";

type CliStdout = Pick<NodeJS.WriteStream, "write">;

export type MainOptions = {
  argv?: string[];
  stdout?: CliStdout;
};

export const TOP_HELP = `usage: axis-browser [command] [args] [flags]
commands[39]:
  open <url>, snapshot, screenshot <path>, click @<uid>, fill @<uid> <text>,
  type <text>, press <key>, scroll <dir>, back, wait <ms|text>, eval <js>,
  run,
  hover @<uid>, drag @<from> @<to>, fillform @<uid>=<val>..., dialog <action>,
  upload @<uid> <path>, pages, newpage <url>, selectpage <id>, closepage <id>,
  resize <w> <h>, emulate, console, console-get <id>, network,
  network-get [id], lighthouse, perf-start, perf-stop,
  perf-insight <set> <name>, heap <path>, start, stop, setup, setup hooks, update,
  doctor [--json], reap [--dry-run] [--min-age-hours N], login <url>

flags[2]:
  --help, -v/-V/--version

preflight:
  Run \`axis-browser doctor --json\` before a browser task. It reports the active mode,
  the endpoint/profile/bridge state, and a list of REMEDIES that are runnable commands.
  Execute them. Escalate to a human only for NEEDS_INTERACTIVE_LOGIN (run
  \`axis-browser login <url>\`) or PORT_HELD_BY_FOREIGN_PROCESS (killing someone's
  browser is their call). Local CDP has no authentication — never request credentials,
  tokens, or a ws:// URL to reach it.

environment:
  CHROME_DEVTOOLS_AXI_MODE          Connection mode, stated explicitly instead of inferred:
                                    ephemeral (throwaway profile), managed (persistent profile
                                    axis owns), attach (a browser someone else runs), or
                                    autoconnect (your running Chrome via chrome://inspect).
                                    Unset = inferred from the variables below, as before.
  CHROME_DEVTOOLS_AXI_EXECUTABLE_PATH
                                    Absolute path to the Chrome/Chromium binary to launch.
                                    Launch modes only — ignored when attaching to a browser
                                    somebody else started.
  CHROME_DEVTOOLS_AXI_AUTO_REAP     Set to 0 to disable automatic cleanup of orphaned bridges
                                    (>4h old, claimed by no session) on bridge startup.
  CHROME_DEVTOOLS_AXI_AUTO_CONNECT  Set to 1 to connect to the user's running Chrome (144+)
                                    via chrome://inspect/#remote-debugging instead of launching
                                    a new browser. Requires remote debugging enabled in Chrome.
  CHROME_DEVTOOLS_AXI_CHANNEL       Chrome release channel to target: stable (default), beta,
                                    canary, or dev. Selects which installed Chrome --autoConnect
                                    attaches to, and which one is launched in ephemeral and
                                    managed modes. Ignored only in attach mode. When MODE is
                                    unset and the mode is inferred, AUTO_CONNECT outranks
                                    BROWSER_URL, so that combination infers autoconnect and
                                    still applies the channel; an explicit MODE=attach does
                                    not, and is authoritative.
  CHROME_DEVTOOLS_AXI_HEADED        Set to 1 to run Chrome in headed (visible) mode
  CHROME_DEVTOOLS_AXI_CHROME_ARGS   Whitespace-separated Chrome flags forwarded to the browser
                                    (no shell-style quoting; flags with spaces are not supported)
                                    e.g. "--enable-gpu --ignore-gpu-blocklist"
  CHROME_DEVTOOLS_AXI_PORT          Bridge server port (default: 9224)
  CHROME_DEVTOOLS_AXI_SESSION       Named session for concurrent isolation. Each session name gets
                                    its own bridge process, port (auto-derived from the name, or set
                                    CHROME_DEVTOOLS_AXI_PORT), and on-disk state, so multiple sessions
                                    run at once without colliding. Connection mode and profile are
                                    unchanged. Defaults to "default" (port 9224, legacy state paths).
                                    e.g. CHROME_DEVTOOLS_AXI_SESSION=worker-1
  CHROME_DEVTOOLS_AXI_BROWSER_URL   Connect to an existing Chrome instance instead of launching one.
                                    http(s):// uses --browserUrl (fetches /json/version).
                                    ws(s):// uses --wsEndpoint (direct WebSocket).
                                    e.g. "http://127.0.0.1:9222" or "wss://cluster.example/launch"
  CHROME_DEVTOOLS_AXI_WS_HEADERS    JSON headers for ws(s):// endpoints (only with BROWSER_URL=wss?://).
                                    Refused by default: chrome-devtools-mcp accepts these only as a
                                    command-line argument, which any other local process can read
                                    from the process table. Opt in per invocation with
                                    CHROME_DEVTOOLS_AXI_ALLOW_WS_HEADERS_ARGV=1. The value is never
                                    echoed back.
                                    e.g. '{"Authorization":"Bearer token"}'
  CHROME_DEVTOOLS_AXI_USER_DATA_DIR Persistent Chrome profile directory (skips --isolated mode)
                                    e.g. "/path/to/.chrome-profile"
  CHROME_DEVTOOLS_AXI_MCP_PATH      Absolute path to a chrome-devtools-mcp build you reviewed
                                    yourself. Optional — by default the bridge spawns the
                                    chrome-devtools-mcp this package pins as its own dependency.
                                    There is no global-install scan and no 'npx …@latest' download,
                                    so what runs is what this release was tested against.
                                    With MCP_SERVER_URL also set, selects stdio proxy mode:
                                    the executable must advertise --serverUrl in --help.
  CHROME_DEVTOOLS_AXI_MCP_SERVER_URL
                                    Shared MCP service URL — bring your own server. With MCP_PATH,
                                    starts a verified stdio proxy and passes --server-url=<URL>.
                                    Without MCP_PATH, connects directly over Streamable HTTP (no
                                    local MCP child); use an absolute http(s) MCP endpoint.
                                    The pinned official chrome-devtools-mcp advertises neither
                                    --serverUrl nor an HTTP listener, so both modes require a server
                                    build that adds them, and that server must redact sensitive
                                    headers itself. If unset or blank, the bridge uses standalone
                                    stdio mode.
  CHROME_DEVTOOLS_AXI_BRIDGE_TIMEOUT_MS
                                    Bridge readiness deadline in ms (default: 30000, min: 1000)

gpu:
  Headless Chrome cannot access hardware GPU on most Linux systems.
  For GPU-accelerated WebGL, use headed mode with GPU flags:
    CHROME_DEVTOOLS_AXI_HEADED=1
    CHROME_DEVTOOLS_AXI_CHROME_ARGS="--enable-gpu --ignore-gpu-blocklist"
  For WebGPU, Vulkan must also be enabled (required for the Dawn backend):
    CHROME_DEVTOOLS_AXI_CHROME_ARGS="--enable-gpu --ignore-gpu-blocklist --enable-unsafe-webgpu --enable-features=Vulkan"

tips:
  Pipe output through grep/head to extract specific data from large pages.
`;

const COMMAND_HELP: Record<string, string> = {
  open: `usage: axis-browser open <url> [--full]
Navigate to a URL and capture an accessibility snapshot.

args:
  <url>   URL to navigate to (required)

flags:
  --full  Show complete snapshot without truncation

examples:
  axis-browser open https://example.com
  axis-browser open https://example.com --full`,

  screenshot: `usage: axis-browser screenshot <path> [--uid @<uid>] [--full-page] [--format png|jpeg|webp]
Save a screenshot to a file.

args:
  <path>  File path to save the screenshot (required)

Relative output paths resolve against the directory where you run the CLI.
Output reports the resolved absolute path.

flags:
  --uid @<uid>    Capture a specific element instead of the full viewport.
                  Refs are generation-tagged (e.g. @g3:12) - pass them back
                  exactly as printed. A stale ref returns STALE_REF.
  --full-page     Capture the entire scrollable page
  --format <fmt>  Image format: png (default), jpeg, or webp

examples:
  axis-browser screenshot ./page.png
  axis-browser screenshot ./element.png --uid @g1:3
  axis-browser screenshot ./full.png --full-page --format jpeg`,

  snapshot: `usage: axis-browser snapshot [--full]
Capture the current page accessibility snapshot.

flags:
  --full  Show complete snapshot without truncation

examples:
  axis-browser snapshot
  axis-browser snapshot --full`,

  click: `usage: axis-browser click @<uid> [--full]
Click an interactive element by its ref from the snapshot.

args:
  @<uid>  Element ref from snapshot (required). Refs are generation-tagged
          (e.g. @g3:12) - pass them back exactly as printed. A stale ref
          (older generation) returns a STALE_REF error so you know to re-snapshot.

flags:
  --full  Show complete snapshot without truncation

examples:
  axis-browser click @g1:1
  axis-browser click @g2:12 --full`,

  fill: `usage: axis-browser fill @<uid> <text> [--full]
Fill a form field with text.

args:
  @<uid>  Element ref from snapshot (required). Refs are generation-tagged
          (e.g. @g3:12) - pass them back exactly as printed. A stale ref
          returns a STALE_REF error so you know to re-snapshot.
  <text>  Text to fill (required)

flags:
  --full  Show complete snapshot without truncation

examples:
  axis-browser fill @g1:3 "hello world"
  axis-browser fill @g2:3 "search query" --full`,

  type: `usage: axis-browser type <text> [--full]
Type text at the currently focused element.

args:
  <text>  Text to type (required)

flags:
  --full  Show complete snapshot without truncation

examples:
  axis-browser type "hello"
  axis-browser type "search query" --full`,

  press: `usage: axis-browser press <key> [--full]
Press a keyboard key.

args:
  <key>  Key name, e.g. Enter, Tab, Escape, ArrowDown (required)

flags:
  --full  Show complete snapshot without truncation

examples:
  axis-browser press Enter
  axis-browser press Tab --full`,

  scroll: `usage: axis-browser scroll <direction> [--full]
Scroll the page in a direction.

args:
  <direction>  up, down, top, or bottom (default: down)

flags:
  --full  Show complete snapshot without truncation

examples:
  axis-browser scroll down
  axis-browser scroll top --full`,

  back: `usage: axis-browser back [--full]
Navigate back in browser history.

flags:
  --full  Show complete snapshot without truncation

examples:
  axis-browser back
  axis-browser back --full`,

  wait: `usage: axis-browser wait <ms|text>
Wait for a duration or for text to appear on the page.

args:
  <ms>    Milliseconds to wait (numeric)
  <text>  Text to wait for (string)

examples:
  axis-browser wait 2000
  axis-browser wait "Submit"`,

  eval: `usage: axis-browser eval <js> [--full]
Evaluate a JavaScript expression in the page context and return the result.
A bare expression is wrapped as () => (<js>); pass a function (arrow or
function-keyword) for multi-statement logic. No-arg IIFE form (...)() is
also accepted and unwrapped automatically.

args:
  <js>  JavaScript expression (required)

flags:
  --full  Show complete output without truncation

examples:
  axis-browser eval "document.title"
  axis-browser eval "document.querySelectorAll('a').length"
  axis-browser eval "() => { const rows = [...document.querySelectorAll('tr')]; return rows.map(r => r.textContent) }"`,

  run: `usage: axis-browser run <<'EOF'
  ...script...
  EOF

Execute a JavaScript script from stdin against the current browser session.
The script gets a global \`page\` object. Only the script's stdout is returned.
Pipe a script via heredoc or stdin — no file path needed.

script API (available as global \`page\`):
  await page.open(url)              Navigate, returns { url, status }
  await page.eval(jsOrFn)           Evaluate JS in the page, returns the value
  await page.snapshot()             Get the generation-tagged accessibility tree
  await page.wait(ms)               Wait by duration
  await page.wait(selector)         Wait for CSS selector (30s timeout)
  await page.wait(selector, ms)     Wait for CSS selector with timeout
  await page.click("@uid")          Click an element by fresh ref
  await page.click(selector)        Click via CSS selector
  await page.fill("@uid", text)     Fill a form field by fresh ref
  await page.fill(selector, text)   Fill via CSS selector, including controlled fields
  await page.type(text)             Type at the focused element
  await page.press(key)             Press a keyboard key
  await page.back()                 Navigate back

click and fill accept either @uid refs (from snapshot) or CSS selectors. A tagged @uid ref goes stale only when the page's snapshot generation has moved past it — a later snapshot or a navigation — so unrelated DOM mutations do not invalidate it; untagged legacy refs are accepted without a freshness check.
page.eval accepts functions, arrow functions, and bare expression strings; no-arg IIFE strings are unwrapped automatically.

examples:
  axis-browser run <<'EOF'
  await page.open("https://example.com");
  console.log(await page.eval(() => document.title));
  EOF

  axis-browser run <<'EOF'
  await page.open("https://en.wikipedia.org/wiki/Ada_Lovelace");
  await page.click("a[href='/wiki/Charles_Babbage']");
  await page.wait(".mw-page-title-main");
  console.log(await page.eval(() => document.title));
  EOF

  axis-browser run <<'EOF'
  const { status } = await page.open("https://httpbin.org/status/404");
  console.log("status:", status);
  EOF`,

  start: `usage: axis-browser start
Start the bridge server (launches headless Chrome).

examples:
  axis-browser start`,

  stop: `usage: axis-browser stop
Stop the bridge server and close the browser.

examples:
  axis-browser stop`,

  doctor: `usage: axis-browser doctor [--json]
Preflight the machine, profile, and bridge state before a browser task.

Read-only: it changes nothing. Reports the active mode, the profile in use and
whether another process holds its lock, bridge state, and a "remedies" array of
syntactically runnable commands. Runnable is not the same as safe to run
unattended — confirm the destructive ones with a human first.

flags:
  --json  Emit the report as JSON instead of the rendered summary

examples:
  axis-browser doctor
  axis-browser doctor --json`,

  reap: `usage: axis-browser reap [--dry-run] [--min-age-hours <n>]
Stop abandoned Axis bridges: ones no session claims, older than the threshold.

Destructive — it terminates processes. Preview with --dry-run first, and prefer
"axis-browser doctor" to name what is actually holding a port or a profile.

flags:
  --dry-run            Report what would be reaped without signaling anything
  --min-age-hours <n>  Age threshold in hours (default: 4)

examples:
  axis-browser reap --dry-run
  axis-browser reap --min-age-hours 1`,

  login: `usage: axis-browser login <url>
One-time interactive sign-in to the managed profile in a visible browser.

Forces managed mode and headed Chrome for this invocation, waits for you to sign
in, verifies that something actually landed, then stops the bridge so the profile
lock is released. Needs a terminal: it refuses to run non-interactively rather
than open a browser nobody can see or close.

args:
  <url>  URL to open for the sign-in (required)

examples:
  axis-browser login https://example.com`,

  // Page management
  pages: `usage: axis-browser pages
List all open pages/tabs in the browser.

examples:
  axis-browser pages`,

  newpage: `usage: axis-browser newpage <url> [--background] [--full]
Open a new tab and navigate to a URL.

args:
  <url>  URL to open (required)

flags:
  --background  Open in background without bringing to front
  --full        Show complete snapshot without truncation

examples:
  axis-browser newpage https://example.com
  axis-browser newpage https://example.com --background`,

  selectpage: `usage: axis-browser selectpage <id> [--full]
Switch to a tab by page ID.

args:
  <id>  Page ID from the pages command (required)

flags:
  --full  Show complete snapshot without truncation

examples:
  axis-browser selectpage 1`,

  closepage: `usage: axis-browser closepage <id>
Close a tab by page ID. The last open page cannot be closed.

args:
  <id>  Page ID from the pages command (required)

examples:
  axis-browser closepage 2`,

  resize: `usage: axis-browser resize <width> <height>
Resize the browser viewport.

args:
  <width>   Width in pixels (required)
  <height>  Height in pixels (required)

examples:
  axis-browser resize 1280 720
  axis-browser resize 390 844`,

  // Interaction
  hover: `usage: axis-browser hover @<uid> [--full]
Hover over an element to trigger hover states.

args:
  @<uid>  Element ref from snapshot (required). Refs are generation-tagged
          (e.g. @g3:12) - pass them back exactly as printed. A stale ref
          returns a STALE_REF error so you know to re-snapshot.

flags:
  --full  Show complete snapshot without truncation

examples:
  axis-browser hover @g1:5`,

  drag: `usage: axis-browser drag @<from> @<to> [--full]
Drag an element onto another element.

args:
  @<from>  Element to drag (required). Use refs from the latest snapshot.
  @<to>    Element to drop onto (required). Stale refs return STALE_REF.

flags:
  --full  Show complete snapshot without truncation

examples:
  axis-browser drag @g1:3 @g1:7`,

  fillform: `usage: axis-browser fillform @<uid>=<value>... [--full]
Fill multiple form fields at once.

args:
  @<uid>=<value>  One or more field entries from the latest snapshot (required).
                  Stale refs return STALE_REF.

flags:
  --full  Show complete snapshot without truncation

examples:
  axis-browser fillform @g1:1="hello" @g1:2="world"
  axis-browser fillform @g2:3="user@email.com" @g2:4="password123"`,

  dialog: `usage: axis-browser dialog <accept|dismiss> [text]
Handle a browser dialog (alert, confirm, prompt).

args:
  <action>  accept or dismiss (required)
  [text]    Optional text to enter into a prompt dialog

examples:
  axis-browser dialog accept
  axis-browser dialog dismiss
  axis-browser dialog accept "confirmed"`,

  upload: `usage: axis-browser upload @<uid> <path> [--full]
Upload a file through a file input element.

args:
  @<uid>  File input element ref from snapshot (required). Refs are
          generation-tagged; stale refs return STALE_REF.
  <path>  Local file path to upload (required)

flags:
  --full  Show complete snapshot without truncation

examples:
  axis-browser upload @g1:5 ./photo.jpg`,

  // Emulation
  emulate: `usage: axis-browser emulate [flags]
Emulate device features on the selected page.

flags:
  --viewport <spec>          Viewport like "390x844x3,mobile,touch"
  --color-scheme <value>     dark | light | auto
  --network <condition>      Offline | Slow 3G | Fast 3G | Slow 4G | Fast 4G
  --cpu <rate>               CPU throttling rate 1-20
  --geolocation <lat>x<lon>  Geolocation like "37.7749x-122.4194"
  --user-agent <string>      Custom user agent string

examples:
  axis-browser emulate --viewport "390x844x3,mobile" --color-scheme dark
  axis-browser emulate --network "Slow 3G" --cpu 4`,

  // DevTools debugging
  console: `usage: axis-browser console [--type <type>] [--limit <n>] [--page <n>]
List console messages for the current page.

flags:
  --type <type>  Filter by message type. Valid values:
                   log, debug, info, error, warn, dir, dirxml, table, trace,
                   clear, startGroup, startGroupCollapsed, endGroup, assert,
                   profile, profileEnd, count, timeEnd, verbose, issue, all
                 ("all" or omitted returns every message.)
  --limit <n>    Maximum messages to return
  --page <n>     Page number (0-based)

examples:
  axis-browser console
  axis-browser console --type error --limit 50
  axis-browser console --type all`,

  "console-get": `usage: axis-browser console-get <id>
Get a specific console message by ID.

args:
  <id>  Message ID from the console command (required)

examples:
  axis-browser console-get 3`,

  network: `usage: axis-browser network [--type <type>] [--limit <n>] [--page <n>]
List network requests for the current page.

flags:
  --type <type>  Filter by resource type. Valid values:
                   document, stylesheet, image, media, font, script, texttrack,
                   xhr, fetch, prefetch, eventsource, websocket, manifest,
                   signedexchange, ping, cspviolationreport, preflight, fedcm,
                   other, all
                 ("all" or omitted returns every request.)
  --limit <n>    Maximum requests to return
  --page <n>     Page number (0-based)

examples:
  axis-browser network
  axis-browser network --type fetch --limit 50
  axis-browser network --type all`,

  "network-get": `usage: axis-browser network-get [id] [--response-file <path>] [--request-file <path>]
Get a specific network request. If id is omitted, gets the selected request.

args:
  [id]  Request ID from the network command (optional)

flags:
  --response-file <path>  Save response body to file
  --request-file <path>   Save request body to file

Relative output paths resolve against the directory where you run the CLI.

examples:
  axis-browser network-get 42
  axis-browser network-get 42 --response-file ./response.json`,

  // Performance
  lighthouse: `usage: axis-browser lighthouse [--device <device>] [--mode <mode>] [--output-dir <path>]
Run a Lighthouse audit for accessibility, SEO, and best practices.

flags:
  --device <device>      desktop (default) or mobile
  --mode <mode>          navigation (default) or snapshot
  --output-dir <path>    Directory for reports

Relative output paths resolve against the directory where you run the CLI.

examples:
  axis-browser lighthouse
  axis-browser lighthouse --device mobile --output-dir ./reports`,

  "perf-start": `usage: axis-browser perf-start [--no-reload] [--no-auto-stop] [--file <path>]
Start a performance trace recording.

flags:
  --no-reload     Don't reload the page when starting
  --no-auto-stop  Don't automatically stop the trace
  --file <path>   Save raw trace data to file

Relative output paths resolve against the directory where you run the CLI.
Output reports the resolved absolute path.

examples:
  axis-browser perf-start
  axis-browser perf-start --no-reload --file trace.json.gz`,

  "perf-stop": `usage: axis-browser perf-stop [--file <path>]
Stop the active performance trace recording.

flags:
  --file <path>  Save raw trace data to file

Relative output paths resolve against the directory where you run the CLI.

examples:
  axis-browser perf-stop
  axis-browser perf-stop --file trace.json.gz`,

  "perf-insight": `usage: axis-browser perf-insight <set-id> <insight-name>
Analyze a specific performance insight from a trace.

args:
  <set-id>        Insight set ID from trace results (required)
  <insight-name>  Insight name, e.g. "DocumentLatency" (required)

examples:
  axis-browser perf-insight set1 DocumentLatency
  axis-browser perf-insight set1 LCPBreakdown`,

  heap: `usage: axis-browser heap <path>
Capture a heap snapshot for memory leak debugging.

args:
  <path>  File path to save the .heapsnapshot file (required)

Relative output paths resolve against the directory where you run the CLI.
Output reports the resolved absolute path.

examples:
  axis-browser heap ./snapshot.heapsnapshot`,

  setup: `usage: axis-browser setup [--install] [--project <path>] [--json] [--yes]
       axis-browser setup hooks

Report Axis Browser workflow readiness, detect the optional browser-bay
router, and optionally run permission-gated project setup.

Default setup is read-only. In non-interactive contexts, --install previews
commands unless --yes is passed. The command never writes secrets, .env files,
shell rc files, MCP credential files, or user credential stores.

flags:
  --install         Run or preview setup actions
  --project <path>  Target project directory (default: current directory)
  --json            Emit stable machine-readable status
  --yes, -y         Allow non-interactive project setup after review

actions:
  hooks             Install or repair Claude Code and Codex SessionStart hooks

examples:
  axis-browser setup
  axis-browser setup --json
  axis-browser setup --install --project .
  axis-browser setup hooks`,

  update: `usage: axis-browser update [--check]
Axis Browser is distributed from GitHub, not the upstream npm package.

This fork disables the SDK npm self-updater because the npm package it would
target (\`chrome-devtools-axi\`, the upstream base) is not this fork.

Update with:
  npm install -g github:Nirmantix/axis-browser

Or with Bun:
  bun add -g github:Nirmantix/axis-browser`,
};

export function getCommandHelp(command: string): string | null {
  const written = COMMAND_HELP[command];
  if (written) return written;
  if (!Object.hasOwn(COMMAND_HANDLERS, command)) return null;
  // `--help` must never execute a command. The SDK prints this function's result
  // when it is non-null and otherwise falls through to the handler, so a
  // registered command with no help entry ran for real on `--help` —
  // `axis-browser reap --help` terminated bridges instead of describing them.
  // Synthesize the synopsis from the same allow-list the flag validator uses, so
  // help and validation cannot disagree. `test/command-flags.test.ts` requires a
  // written entry for every command, which keeps this a net rather than a habit.
  const valueFlags = COMMAND_VALUE_FLAGS[command] ?? [];
  const synopsis = (COMMAND_FLAGS[command] ?? [])
    .map((flag) => ` [${flag}${valueFlags.includes(flag) ? " <value>" : ""}]`)
    .join("");
  return renderOutput([
    `usage: axis-browser ${command}${synopsis}`,
    `No detailed help is written for \`${command}\` yet; the flags above are the ones it accepts.`,
  ]);
}

/**
 * Every command name this CLI dispatches. A function rather than an exported
 * constant because `COMMAND_HANDLERS` is declared further down the module, and a
 * top-level `Object.keys` here would read it before initialization.
 */
export function listCommands(): string[] {
  return Object.keys(COMMAND_HANDLERS);
}

/**
 * Reject flags a command does not document. Exported so the help text and the
 * allow-list can be checked against each other without invoking a handler: a
 * documented flag the validator rejects is a command that cannot be used, and
 * that stays invisible until someone runs it.
 */
export function assertCommandFlagsAllowed(
  command: string,
  args: string[],
): void {
  validateCommandFlags(
    command,
    args,
    COMMAND_FLAGS[command] ?? [],
    COMMAND_VALUE_FLAGS[command] ?? [],
    COMMAND_DASH_POSITIONAL_SLOTS[command] ?? [],
    COMMAND_POSITIONAL_TEXT_START[command],
  );
}

/**
 * True when every argument to `command` is free text from position 0 — `type`,
 * `wait`, `eval` — so a leading `--…` is the text itself rather than a flag
 * (`type --literal`, `eval --counter`). Exported so the allow-list test proves
 * that exception from the same table the validator reads, instead of restating a
 * hardcoded command list that could drift from it.
 */
export function isAllPositionalText(command: string): boolean {
  return COMMAND_POSITIONAL_TEXT_START[command] === 0;
}

export interface ScreenshotArgs {
  filePath: string | null;
  uid: string | undefined;
  fullPage: boolean;
  format: string | undefined;
}

export function parseScreenshotArgs(args: string[]): ScreenshotArgs {
  let filePath: string | null = null;
  let uid: string | undefined;
  let fullPage = false;
  let format: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--uid" && i + 1 < args.length) {
      const raw = args[++i];
      uid = raw.startsWith("@") ? raw.slice(1) : raw;
    } else if (a === "--full-page") {
      fullPage = true;
    } else if (a === "--format" && i + 1 < args.length) {
      format = args[++i];
    } else if (!a.startsWith("--")) {
      filePath = a;
    }
  }

  return { filePath, uid, fullPage, format };
}

export function formatScreenshotOutput(filePath: string): string {
  return encode({ screenshot: filePath });
}

function parseScreenshotOutputPath(result: string): string {
  const match = result.match(/(?:^|\n)Saved screenshot to ([\s\S]+)\.\s*$/);
  if (!match) {
    throw new CdpError(
      "chrome-devtools-mcp did not report a saved screenshot path",
      "BROWSER_ERROR",
    );
  }
  return match[1];
}

/** Format raw MCP text result as AXI output: labeled block + truncation + suggestions. */
export function formatMcpResult(
  label: string,
  text: string,
  suggestions: string[],
): string {
  const blocks: string[] = [];
  const tr = truncateSnapshot(text, false, 2000);
  blocks.push(`${label}:\n${tr.text.trimEnd()}`);
  if (tr.truncated) {
    blocks[0] += `\n    ... (truncated, ${tr.totalLength} chars total)`;
  }
  if (suggestions.length > 0) {
    blocks.push(renderHelp(suggestions));
  }
  return renderOutput(blocks);
}

export function parseFillFormArgs(args: string[]): {
  entries: { uid: string; value: string }[];
} {
  const entries: { uid: string; value: string }[] = [];
  for (const arg of args) {
    if (arg === "--full") continue;
    const match = arg.match(/^@([^=]+)=(.+)$/);
    if (!match) continue;
    const uid = match[1];
    let value = match[2];
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    entries.push({ uid, value });
  }
  return { entries };
}

function parseOptionalInteger(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isNaN(parsed) ? undefined : parsed;
}

export interface EmulateArgs extends Record<string, unknown> {
  viewport?: string;
  colorScheme?: string;
  networkConditions?: string;
  cpuThrottlingRate?: number;
  geolocation?: string;
  userAgent?: string;
}

export function parseEmulateArgs(args: string[]): EmulateArgs {
  const result: EmulateArgs = {};
  let i = 0;
  while (i < args.length) {
    switch (args[i]) {
      case "--viewport":
        result.viewport = args[++i];
        break;
      case "--color-scheme":
        result.colorScheme = args[++i];
        break;
      case "--network":
        result.networkConditions = args[++i];
        break;
      case "--cpu": {
        const cpuThrottlingRate = parseOptionalInteger(args[++i]);
        if (cpuThrottlingRate !== undefined) {
          result.cpuThrottlingRate = cpuThrottlingRate;
        }
        break;
      }
      case "--geolocation":
        result.geolocation = args[++i];
        break;
      case "--user-agent":
        result.userAgent = args[++i];
        break;
    }
    i++;
  }
  return result;
}

export function parseConsoleArgs(args: string[]): {
  types?: string[];
  pageSize?: number;
  pageIdx?: number;
} {
  const result: { types?: string[]; pageSize?: number; pageIdx?: number } = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--type" && i + 1 < args.length) {
      const value = args[++i];
      if (value.toLowerCase() === "all") delete result.types;
      else result.types = [value];
    } else if (args[i] === "--limit" && i + 1 < args.length) {
      const pageSize = parseOptionalInteger(args[++i]);
      if (pageSize !== undefined) result.pageSize = pageSize;
    } else if (args[i] === "--page" && i + 1 < args.length) {
      const pageIdx = parseOptionalInteger(args[++i]);
      if (pageIdx !== undefined) result.pageIdx = pageIdx;
    }
  }
  return result;
}

export function parseNetworkArgs(args: string[]): {
  resourceTypes?: string[];
  pageSize?: number;
  pageIdx?: number;
} {
  const result: {
    resourceTypes?: string[];
    pageSize?: number;
    pageIdx?: number;
  } = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--type" && i + 1 < args.length) {
      const value = args[++i];
      if (value.toLowerCase() === "all") delete result.resourceTypes;
      else result.resourceTypes = [value];
    } else if (args[i] === "--limit" && i + 1 < args.length) {
      const pageSize = parseOptionalInteger(args[++i]);
      if (pageSize !== undefined) result.pageSize = pageSize;
    } else if (args[i] === "--page" && i + 1 < args.length) {
      const pageIdx = parseOptionalInteger(args[++i]);
      if (pageIdx !== undefined) result.pageIdx = pageIdx;
    }
  }
  return result;
}

export function parseNetworkGetArgs(args: string[]): {
  reqid?: number;
  responseFilePath?: string;
  requestFilePath?: string;
} {
  const result: {
    reqid?: number;
    responseFilePath?: string;
    requestFilePath?: string;
  } = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--response-file" && i + 1 < args.length) {
      result.responseFilePath = args[++i];
    } else if (args[i] === "--request-file" && i + 1 < args.length) {
      result.requestFilePath = args[++i];
    } else if (!args[i].startsWith("--")) {
      const reqid = parseOptionalInteger(args[i]);
      if (reqid !== undefined) result.reqid = reqid;
    }
  }
  return result;
}

export function parseLighthouseArgs(args: string[]): {
  device?: string;
  mode?: string;
  outputDirPath?: string;
} {
  const result: { device?: string; mode?: string; outputDirPath?: string } = {};
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--device":
        result.device = args[++i];
        break;
      case "--mode":
        result.mode = args[++i];
        break;
      case "--output-dir":
        result.outputDirPath = args[++i];
        break;
    }
  }
  return result;
}

export function parsePerfStartArgs(args: string[]): {
  reload?: boolean;
  autoStop?: boolean;
  filePath?: string;
} {
  const result: { reload?: boolean; autoStop?: boolean; filePath?: string } =
    {};
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--no-reload":
        result.reload = false;
        break;
      case "--no-auto-stop":
        result.autoStop = false;
        break;
      case "--file":
        result.filePath = args[++i];
        break;
    }
  }
  return result;
}

function renderHelp(lines: string[]): string {
  if (lines.length === 0) return "";
  const indented = lines.map((l) => `  ${l}`).join("\n");
  return `help[${lines.length}]:\n${indented}`;
}

function renderError(
  message: string,
  code: string,
  suggestions: string[] = [],
): string {
  const blocks = [encode({ error: message, code })];
  if (suggestions.length > 0) {
    blocks.push(renderHelp(suggestions));
  }
  return blocks.join("\n");
}

function renderOutput(blocks: string[]): string {
  return blocks.filter(Boolean).join("\n");
}

function splitFullFlag(args: string[]): { args: string[]; full: boolean } {
  return {
    args: args.filter((arg) => arg !== "--full"),
    full: args.includes("--full"),
  };
}

function trimSingleTrailingNewline(text: string): string {
  return text.endsWith("\n") ? text.slice(0, -1) : text;
}

function wrapsRawStdout(argv: string[] | undefined): boolean {
  return (argv ?? process.argv.slice(2))[0] === "run";
}

function wrapStdout(
  stdout: CliStdout | undefined,
  argv: string[] | undefined,
): CliStdout | undefined {
  const target = stdout ?? process.stdout;
  if (!wrapsRawStdout(argv)) {
    return stdout;
  }

  return {
    write(chunk: string) {
      if (!chunk.startsWith(RAW_STDOUT_MARKER)) {
        return target.write(chunk);
      }

      const raw = chunk.slice(RAW_STDOUT_MARKER.length);
      if (raw === "\n") {
        return true;
      }

      return target.write(raw);
    },
  };
}

function renderUnknownCommand(command: string): string {
  return (
    renderError(`Unknown command: ${command}`, "VALIDATION_ERROR", [
      "Run `axis-browser --help` to see available commands",
    ]) + "\n"
  );
}

function normalizeMainOptions(
  options: MainOptions | string[] | undefined,
): MainOptions {
  if (Array.isArray(options)) {
    return { argv: options };
  }

  return options ?? {};
}

function resolveArgv(argv: string[] | undefined): string[] {
  return argv ?? process.argv.slice(2);
}

function shouldRenderFullHome(argv: string[]): boolean {
  return argv.length === 1 && argv[0] === "--full";
}

/** Format page metadata (TOON) + raw snapshot + suggestions. */
function formatPageOutput(
  snapshot: string,
  command: string,
  url?: string,
  full = false,
): string {
  const title = extractTitle(snapshot);
  const refs = countRefs(snapshot);

  const blocks: string[] = [];

  // Page metadata as TOON
  const page: Record<string, unknown> = {};
  if (title) page.title = title;
  if (url) page.url = url;
  page.refs = refs;
  blocks.push(encode({ page }));

  // Truncate snapshot
  const tr = truncateSnapshot(snapshot, full);
  let snapshotBlock = `snapshot:\n${tr.text.trimEnd()}`;
  if (tr.truncated) {
    snapshotBlock += `\n    ... (truncated, ${tr.totalLength} chars total)`;
  }
  blocks.push(snapshotBlock);

  // Contextual suggestions
  const suggestions = getSuggestions({ command, url, snapshot });
  if (tr.truncated) {
    suggestions.push(
      `Run \`axis-browser ${command}${url ? " " + url : ""} --full\` to see complete snapshot`,
    );
  }
  if (suggestions.length > 0) {
    blocks.push(renderHelp(suggestions));
  }

  return renderOutput(blocks);
}

/** Tag a freshly captured snapshot with a bumped generation marker. */
async function stampFresh(): Promise<string> {
  return captureFreshSnapshot(callTool, async () =>
    stripSnapshotHeader(await callTool("take_snapshot")),
  );
}

/**
 * Call a tool with includeSnapshot:true and extract the snapshot.
 * Falls back to a separate take_snapshot() if parsing fails.
 */
async function callWithSnapshot(
  name: string,
  args: Record<string, unknown>,
): Promise<string> {
  await callTool(name, args);
  return stampFresh();
}

// evaluate_script invokes its payload, so each entry must be a callable.
const SCROLL_FUNCTIONS: Record<string, string> = {
  up: "() => window.scrollBy(0, -500)",
  down: "() => window.scrollBy(0, 500)",
  top: "() => window.scrollTo(0, 0)",
  bottom: "() => window.scrollTo(0, document.body.scrollHeight)",
};

async function handleOpen(args: string[], full: boolean): Promise<string> {
  const url = args[0];
  if (!url) {
    throw new CdpError("Missing URL", "VALIDATION_ERROR", [
      "Run `axis-browser open https://example.com` to navigate to a page",
    ]);
  }

  try {
    await callTool("navigate_page", { type: "url", url });
  } catch (error) {
    if (!isRecoverableOpenError(error)) {
      throw error;
    }
    await callTool("new_page", { url });
  }
  const snapshot = await stampFresh();
  return formatPageOutput(snapshot, "open", url, full);
}

async function handleSnapshot(full: boolean): Promise<string> {
  const snapshot = await stampFresh();
  return formatPageOutput(snapshot, "snapshot", undefined, full);
}

async function handleScreenshot(args: string[]): Promise<string> {
  const parsed = parseScreenshotArgs(args);
  if (!parsed.filePath) {
    throw new CdpError("Missing file path", "VALIDATION_ERROR", [
      "Run `axis-browser screenshot ./page.png` to save a screenshot",
    ]);
  }

  const filePath = resolveOutputPath(parsed.filePath);
  const toolArgs: Record<string, unknown> = { filePath };
  if (parsed.uid) toolArgs.uid = await parseUidFresh(parsed.uid);
  if (parsed.fullPage) toolArgs.fullPage = true;
  if (parsed.format) toolArgs.format = parsed.format;

  const result = await callTool("take_screenshot", toolArgs);
  return formatScreenshotOutput(parseScreenshotOutputPath(result));
}

async function handleClick(args: string[], full: boolean): Promise<string> {
  const uid = args[0];
  if (!uid) {
    throw new CdpError("Missing element ref", "VALIDATION_ERROR", [
      "Run `axis-browser click @<uid>` — get uid from snapshot",
    ]);
  }

  const snapshot = await callWithSnapshot("click", {
    uid: await parseUidFresh(uid),
  });
  return formatPageOutput(snapshot, "click", undefined, full);
}

async function handleFill(args: string[], full: boolean): Promise<string> {
  const uid = args[0];
  // Presence, not truthiness: an explicitly empty argument is a real request to
  // *clear* the field. Testing the joined string instead made `fill @g1:5 ""`
  // unreachable, so a prefilled input could never be emptied from the CLI.
  const hasValue = args.length > 1;
  const value = args.slice(1).join(" ");
  if (!uid) {
    throw new CdpError("Missing element ref", "VALIDATION_ERROR", [
      'Run `axis-browser fill @<uid> "text"` — get uid from snapshot',
    ]);
  }
  if (!hasValue) {
    throw new CdpError("Missing fill text", "VALIDATION_ERROR", [
      'Run `axis-browser fill @<uid> "text"` to fill the field',
      'Pass an explicit empty string to clear it: axis-browser fill @<uid> ""',
    ]);
  }

  const snapshot = await callWithSnapshot("fill", {
    uid: await parseUidFresh(uid),
    value,
  });
  return formatPageOutput(snapshot, "fill", undefined, full);
}

async function handlePress(args: string[], full: boolean): Promise<string> {
  const key = args[0];
  if (!key) {
    throw new CdpError("Missing key name", "VALIDATION_ERROR", [
      "Run `axis-browser press Enter` to press a key",
    ]);
  }

  const snapshot = await callWithSnapshot("press_key", { key });
  return formatPageOutput(snapshot, "press", undefined, full);
}

async function handleType(args: string[], full: boolean): Promise<string> {
  const text = args.join(" ");
  if (!text) {
    throw new CdpError("Missing text", "VALIDATION_ERROR", [
      'Run `axis-browser type "hello"` to type text',
    ]);
  }

  await callTool("type_text", { text });
  const snapshot = await stampFresh();
  return formatPageOutput(snapshot, "type", undefined, full);
}

async function handleScroll(args: string[], full: boolean): Promise<string> {
  const dir = (args[0] ?? "down").toLowerCase();
  const fn = SCROLL_FUNCTIONS[dir];
  if (!fn) {
    throw new CdpError(`Unknown scroll direction: ${dir}`, "VALIDATION_ERROR", [
      "Run `axis-browser scroll down` — directions: up, down, top, bottom",
    ]);
  }

  await callTool("evaluate_script", { function: fn });
  const snapshot = await stampFresh();
  return formatPageOutput(snapshot, "scroll", undefined, full);
}

async function handleBack(full: boolean): Promise<string> {
  await callTool("navigate_page", { type: "back" });
  const snapshot = await stampFresh();
  return formatPageOutput(snapshot, "back", undefined, full);
}

async function handleWait(args: string[]): Promise<string> {
  const target = args[0];
  if (!target) {
    throw new CdpError(
      "Missing wait target (milliseconds or text)",
      "VALIDATION_ERROR",
      [
        "Run `axis-browser wait 2000` to wait 2 seconds",
        'Run `axis-browser wait "Submit"` to wait for text to appear',
      ],
    );
  }

  const isNumeric = /^\d+$/.test(target);
  if (isNumeric) {
    await callTool("evaluate_script", {
      function: wrapJsExpression(`new Promise(r => setTimeout(r, ${target}))`),
    });
  } else {
    await callTool("wait_for", { text: [target] });
  }

  const blocks: string[] = [];
  blocks.push(encode({ waited: target }));
  const suggestions = getSuggestions({ command: "wait" });
  if (suggestions.length > 0) blocks.push(renderHelp(suggestions));
  return renderOutput(blocks);
}

/** Extract the actual value from MCP evaluate_script response. */
function parseEvalResult(output: string): string {
  // MCP wraps results in: "Script ran on page and returned:\n```json\n<value>\n```"
  const jsonBlock = output.match(/```json\n([\s\S]*?)\n```/);
  if (jsonBlock) return jsonBlock[1].trim();
  // Fallback: strip the preamble if present
  const preamble = "Script ran on page and returned:";
  if (output.includes(preamble))
    return output.slice(output.indexOf(preamble) + preamble.length).trim();
  return output.trim();
}

async function handleEval(args: string[], full: boolean): Promise<string> {
  const js = args.join(" ");
  if (!js) {
    throw new CdpError("Missing JavaScript expression", "VALIDATION_ERROR", [
      'Run `axis-browser eval "document.title"` to evaluate JavaScript',
    ]);
  }

  const output = await callTool("evaluate_script", {
    function: wrapJsExpression(js),
  });

  const blocks: string[] = [];
  const raw = parseEvalResult(output);
  const tr = full
    ? { text: raw, truncated: false, totalLength: raw.length }
    : truncateText(raw);
  blocks.push(encode({ result: tr.text }));
  const suggestions = getSuggestions({ command: "eval" });
  if (tr.truncated) {
    suggestions.push(
      "Result was truncated — re-run with --full flag, or use .slice() / filter in your JS expression",
    );
  }
  if (suggestions.length > 0) blocks.push(renderHelp(suggestions));
  return renderOutput(blocks);
}

async function handleStart(): Promise<string> {
  const port = await ensureBridge();
  return encode({ status: "ready", port });
}

async function handleDoctor(args: string[]): Promise<string> {
  const json = args.includes("--json");
  const report = await buildDoctorReport();
  return json ? JSON.stringify(report, null, 2) : renderDoctorReport(report);
}

async function handleReap(args: string[]): Promise<string> {
  const dryRun = args.includes("--dry-run");
  const hoursIndex = args.indexOf("--min-age-hours");
  const hours =
    hoursIndex >= 0
      ? Number(args[hoursIndex + 1])
      : DEFAULT_REAP_MIN_AGE_MS / 3_600_000;
  if (!Number.isFinite(hours) || hours < 0) {
    throw new Error("--min-age-hours expects a non-negative number");
  }

  const orphans = findOrphanBridges(hours * 3_600_000);
  const outcome = reapBridges(orphans, { dryRun });
  // Manual reap still acts on these, but the operator should know automatic reaping
  // is currently suppressed and why.
  const malformed = scanSessionPidFiles().malformed;
  return encode({
    ...(malformed.length > 0
      ? { malformedPidFiles: malformed, autoReapSuppressed: true }
      : {}),
    orphans: orphans.map((o) => ({
      pid: o.pid,
      ageMinutes: Math.round(o.ageMs / 60_000),
    })),
    reaped: outcome.reaped,
    failed: outcome.failed,
    ...(dryRun ? { dryRun: true, wouldReap: outcome.skipped } : {}),
  });
}

/** Wait for the operator to press Enter. Resolves immediately when stdin is not a TTY
 *  (defensive — handleLogin refuses non-TTY first), and also resolves if stdin closes
 *  before any data, so the bridge and profile lock are never left dangling on a closed
 *  pipe. (new Promise rather than Promise.withResolvers: the project tsconfig targets
 *  ES2022 and withResolvers needs ES2024 libs — bumping lib is a separate config pass.) */
function waitForEnter(): Promise<void> {
  return new Promise((resolve) => {
    if (!process.stdin.isTTY) {
      resolve();
      return;
    }
    const done = () => {
      process.stdin.off("data", onData);
      process.stdin.off("end", done);
      process.stdin.off("error", done);
      process.stdin.pause();
      resolve();
    };
    const onData = () => done();
    process.stdin.resume();
    process.stdin.once("data", onData);
    process.stdin.once("end", done);
    process.stdin.once("error", done);
  });
}

/**
 * `axis-browser login <url>` — the one sanctioned operator touchpoint.
 *
 * Opens the managed profile headed, hands the browser to the human, and waits. Every run
 * after this one is silent, because the cookies live in the profile on disk. The bridge is
 * stopped on the way out so the profile lock is released and Chrome flushes its state —
 * leaving it running would both leak a browser and block the next session.
 */
async function handleLogin(args: string[]): Promise<string> {
  const url = args.find((a) => !a.startsWith("-"));
  if (!url) {
    throw new Error(
      "usage: axis-browser login <url>  (opens the managed profile headed for a one-time interactive login)",
    );
  }
  if (!process.stdin.isTTY) {
    throw new Error(
      "axis-browser login is interactive and needs a terminal: it hands you a visible browser and waits for you to sign in. " +
        "Run it yourself in a terminal, then re-run the original command — every later run reuses the saved profile silently.",
    );
  }

  // Force the mode for this invocation: login is meaningless in a mode that owns no
  // persistent profile, and silently logging into a throwaway profile would be worse
  // than refusing.
  process.env.CHROME_DEVTOOLS_AXI_MODE = "managed";
  process.env.CHROME_DEVTOOLS_AXI_HEADED = "1";

  const profileDir = resolveUserDataDir(
    "managed",
    process.env,
    resolveSessionName(),
  );

  await ensureBridge();
  let cookieCount = 0;
  try {
    try {
      await callTool("navigate_page", { type: "url", url });
    } catch (error) {
      if (!isRecoverableOpenError(error)) throw error;
      await callTool("new_page", { url });
    }

    process.stderr.write(
      `\nA browser window is open on ${url} using the profile at:\n  ${profileDir}\n\n` +
        "Sign in there, then press Enter here to save and close.\n",
    );
    await waitForEnter();

    // Verify something actually landed rather than reporting a success we did not check.
    //
    // The count is tagged and the parse anchored to that tag. `callTool` returns MCP
    // prose wrapped in a response envelope, so matching the first digit run anywhere in
    // the serialized result could latch onto an unrelated number (a page id, a
    // timestamp) and report a confidently wrong cookie count. No tag match means the
    // probe told us nothing — which is "unverified", not "zero".
    try {
      const result = await callTool("evaluate_script", {
        function:
          "() => 'AXIS_COOKIE_COUNT=' + document.cookie.split(';').filter((c) => c.trim()).length",
      });
      const match = JSON.stringify(result).match(/AXIS_COOKIE_COUNT=(\d+)/);
      cookieCount = match ? Number(match[1]) : -1;
    } catch {
      // A failed probe is not a failed login; report it as unknown rather than zero.
      cookieCount = -1;
    }
  } finally {
    // stopBridge runs on every path (including throw) so a failed login never leaves a
    // browser holding the profile's SingletonLock — which would block the next session.
    await stopBridge();
  }

  return encode({
    status: "saved",
    profile: profileDir ?? "(none)",
    cookies: cookieCount < 0 ? "unverified" : cookieCount,
    note:
      cookieCount === 0
        ? "No cookies were visible on that page — if the site stores its session elsewhere this may still be fine, but re-run and check if the next command is not authenticated."
        : "Later runs reuse this profile silently.",
  });
}

export function formatStopOutput(wasStopped: boolean): string {
  return encode({ status: wasStopped ? "stopped" : "stopped (no-op)" });
}

async function handleStop(): Promise<string> {
  const wasStopped = await stopBridge();
  return formatStopOutput(wasStopped);
}

// --- Page management handlers ---

async function handlePages(): Promise<string> {
  const result = await callTool("list_pages");
  const pages = overlaySessionSelected(parsePagesList(result));
  if (pages.length === 0) {
    return "pages: 0 pages open";
  }
  const blocks: string[] = [];
  const header = `pages[${pages.length}]{id,url,selected}:`;
  const rows = pages.map((p) => `  ${p.id},${p.url},${p.selected}`);
  blocks.push(`${header}\n${rows.join("\n")}`);
  blocks.push(
    renderHelp([
      "Run `axis-browser selectpage <id>` to switch tabs",
      "Run `axis-browser newpage <url>` to open a new tab",
    ]),
  );
  return renderOutput(blocks);
}

async function handleNewPage(args: string[], full: boolean): Promise<string> {
  const url = args.filter((a) => !a.startsWith("--"))[0];
  if (!url) {
    throw new CdpError("Missing URL", "VALIDATION_ERROR", [
      "Run `axis-browser newpage https://example.com` to open a new tab",
    ]);
  }
  const background = args.includes("--background");
  const toolArgs: Record<string, unknown> = { url };
  if (background) toolArgs.background = true;
  await callTool("new_page", toolArgs);
  const snapshot = await stampFresh();
  return formatPageOutput(snapshot, "newpage", url, full);
}

async function handleSelectPage(
  args: string[],
  full: boolean,
): Promise<string> {
  const id = args[0];
  if (!id) {
    throw new CdpError("Missing page ID", "VALIDATION_ERROR", [
      "Run `axis-browser selectpage <id>` — get ID from `pages` command",
    ]);
  }
  const pageId = parseInt(id, 10);
  if (isNaN(pageId)) {
    throw new CdpError(`Invalid page ID: ${id}`, "VALIDATION_ERROR", [
      "Run `axis-browser pages` to list available page IDs",
    ]);
  }
  await callTool("select_page", { pageId });
  const snapshot = await stampFresh();
  return formatPageOutput(snapshot, "selectpage", undefined, full);
}

async function handleClosePage(args: string[]): Promise<string> {
  const id = args[0];
  if (!id) {
    throw new CdpError("Missing page ID", "VALIDATION_ERROR", [
      "Run `axis-browser closepage <id>` — get ID from `pages` command",
    ]);
  }
  const pageId = parseInt(id, 10);
  if (isNaN(pageId)) {
    throw new CdpError(`Invalid page ID: ${id}`, "VALIDATION_ERROR", [
      "Run `axis-browser pages` to list available page IDs",
    ]);
  }
  // Check page count before closing — last page can't be closed
  const beforeResult = await callTool("list_pages");
  const pagesBefore = parsePagesList(beforeResult);
  if (pagesBefore.length <= 1) {
    const blocks = [
      encode({ status: "cannot close the last open page (no-op)" }),
    ];
    blocks.push(
      renderHelp([
        "Run `axis-browser newpage <url>` to open another tab first",
        "Run `axis-browser stop` to shut down the browser entirely",
      ]),
    );
    return renderOutput(blocks);
  }
  await callTool("close_page", { pageId });
  return encode({ status: "closed", pageId });
}

async function handleResize(args: string[]): Promise<string> {
  const [widthStr, heightStr] = args;
  if (!widthStr || !heightStr) {
    throw new CdpError("Missing width and/or height", "VALIDATION_ERROR", [
      "Run `axis-browser resize 1280 720` to resize the viewport",
    ]);
  }
  const width = parseInt(widthStr, 10);
  const height = parseInt(heightStr, 10);
  if (isNaN(width) || isNaN(height)) {
    throw new CdpError("Width and height must be numbers", "VALIDATION_ERROR", [
      "Run `axis-browser resize 1280 720` to resize the viewport",
    ]);
  }
  await callTool("resize_page", { width, height });
  return encode({ resized: { width, height } });
}

// --- Interaction handlers ---

async function handleHover(args: string[], full: boolean): Promise<string> {
  const uid = args[0];
  if (!uid) {
    throw new CdpError("Missing element ref", "VALIDATION_ERROR", [
      "Run `axis-browser hover @<uid>` — get uid from snapshot",
    ]);
  }
  const snapshot = await callWithSnapshot("hover", {
    uid: await parseUidFresh(uid),
  });
  return formatPageOutput(snapshot, "hover", undefined, full);
}

async function handleDrag(args: string[], full: boolean): Promise<string> {
  const from = args[0];
  const to = args[1];
  if (!from || !to) {
    throw new CdpError("Missing element refs", "VALIDATION_ERROR", [
      "Run `axis-browser drag @<from> @<to>` — get uids from snapshot",
    ]);
  }
  const snapshot = await callWithSnapshot("drag", {
    from_uid: await parseUidFresh(from),
    to_uid: await parseUidFresh(to),
  });
  return formatPageOutput(snapshot, "drag", undefined, full);
}

async function handleFillForm(args: string[], full: boolean): Promise<string> {
  const { entries } = parseFillFormArgs(args);
  if (entries.length === 0) {
    throw new CdpError("No valid field entries", "VALIDATION_ERROR", [
      'Run `axis-browser fillform @g1:1="hello" @g1:2="world"` to fill multiple fields',
    ]);
  }
  const validated = await Promise.all(
    entries.map(async (e) => ({
      uid: await parseUidFresh(e.uid),
      value: e.value,
    })),
  );
  const snapshot = await callWithSnapshot("fill_form", { elements: validated });
  return formatPageOutput(snapshot, "fillform", undefined, full);
}

async function handleDialog(args: string[]): Promise<string> {
  const action = args[0];
  if (!action || (action !== "accept" && action !== "dismiss")) {
    throw new CdpError("Missing or invalid action", "VALIDATION_ERROR", [
      "Run `axis-browser dialog accept` or `axis-browser dialog dismiss`",
    ]);
  }
  const params: Record<string, unknown> = { action };
  const promptText = args.slice(1).join(" ");
  if (promptText) params.promptText = promptText;
  await callTool("handle_dialog", params);
  return encode({ dialog: action });
}

async function handleUpload(args: string[], full: boolean): Promise<string> {
  const uid = args[0];
  const filePath = args[1];
  if (!uid) {
    throw new CdpError("Missing element ref", "VALIDATION_ERROR", [
      "Run `axis-browser upload @<uid> <path>` — get uid from snapshot",
    ]);
  }
  if (!filePath) {
    throw new CdpError("Missing file path", "VALIDATION_ERROR", [
      "Run `axis-browser upload @<uid> /path/to/file` to upload a file",
    ]);
  }
  const snapshot = await callWithSnapshot("upload_file", {
    uid: await parseUidFresh(uid),
    // Resolved here, not in the bridge: the bridge is a detached process whose
    // cwd is wherever the *first* command of the session happened to run, so a
    // relative path sent verbatim would name a different file (or nothing).
    filePath: resolveOutputPath(filePath),
  });
  return formatPageOutput(snapshot, "upload", undefined, full);
}

// --- Emulation handler ---

async function handleEmulate(args: string[]): Promise<string> {
  const parsed = parseEmulateArgs(args);
  await callTool("emulate", parsed);
  return encode({ emulated: parsed });
}

// --- DevTools debugging handlers ---

async function handleConsole(args: string[]): Promise<string> {
  const parsed = parseConsoleArgs(args);
  const result = await callTool("list_console_messages", parsed);
  return formatMcpResult("console", result, [
    "Run `axis-browser console-get <id>` to see a specific message",
    "Run `axis-browser console --type error` to filter by type",
  ]);
}

async function handleConsoleGet(args: string[]): Promise<string> {
  const id = args[0];
  if (!id) {
    throw new CdpError("Missing console message id", "VALIDATION_ERROR", [
      "Run `axis-browser console-get <id>` — get id from `axis-browser console`",
    ]);
  }
  const msgid = parseOptionalInteger(id);
  if (msgid === undefined) {
    throw new CdpError(
      `Invalid console message id: ${id}`,
      "VALIDATION_ERROR",
      ["Run `axis-browser console` to list available message ids"],
    );
  }
  const result = await callTool("get_console_message", { msgid });
  return formatMcpResult("message", result, []);
}

async function handleNetwork(args: string[]): Promise<string> {
  const parsed = parseNetworkArgs(args);
  const result = await callTool("list_network_requests", parsed);
  return formatMcpResult("network", result, [
    "Run `axis-browser network-get <id>` to see request details",
    "Run `axis-browser network --type fetch` to filter by type",
  ]);
}

async function handleNetworkGet(args: string[]): Promise<string> {
  const parsed = parseNetworkGetArgs(args);
  const toolArgs = { ...parsed };
  if (toolArgs.responseFilePath) {
    toolArgs.responseFilePath = resolveOutputPath(toolArgs.responseFilePath);
  }
  if (toolArgs.requestFilePath) {
    toolArgs.requestFilePath = resolveOutputPath(toolArgs.requestFilePath);
  }
  const result = await callTool("get_network_request", toolArgs);
  return formatMcpResult("request", result, []);
}

// --- Performance handlers ---

async function handleLighthouse(args: string[]): Promise<string> {
  const opts = parseLighthouseArgs(args);
  if (opts.outputDirPath) {
    opts.outputDirPath = resolveOutputPath(opts.outputDirPath);
  }
  const result = await callTool("lighthouse_audit", opts);
  return formatMcpResult("lighthouse", result, []);
}

async function handlePerfStart(args: string[]): Promise<string> {
  const opts = parsePerfStartArgs(args);
  if (opts.filePath) opts.filePath = resolveOutputPath(opts.filePath);
  await callTool("performance_start_trace", opts);
  return encode({ trace: "started", ...opts });
}

async function handlePerfStop(args: string[]): Promise<string> {
  const toolArgs: Record<string, unknown> = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--file" && i + 1 < args.length) {
      toolArgs.filePath = resolveOutputPath(args[++i]);
    }
  }
  const result = await callTool("performance_stop_trace", toolArgs);
  return formatMcpResult("trace", result, [
    "Run `axis-browser perf-insight <set-id> <insight-name>` to analyze insights",
  ]);
}

async function handlePerfInsight(args: string[]): Promise<string> {
  const [setId, insightName] = args;
  if (!setId || !insightName) {
    throw new CdpError("Missing required arguments", "VALIDATION_ERROR", [
      "Run `axis-browser perf-insight <set-id> <insight-name>` to analyze an insight",
    ]);
  }
  const result = await callTool("performance_analyze_insight", {
    insightSetId: setId,
    insightName,
  });
  return formatMcpResult("insight", result, []);
}

async function handleHeap(args: string[]): Promise<string> {
  const rawPath = args[0];
  if (!rawPath) {
    throw new CdpError("Missing file path", "VALIDATION_ERROR", [
      "Run `axis-browser heap ./snapshot.heapsnapshot` to take a heap snapshot",
    ]);
  }
  const filePath = resolveOutputPath(rawPath);
  await callTool("take_memory_snapshot", { filePath });
  return encode({ heap: filePath });
}

async function handleRun(): Promise<string> {
  if (process.stdin.isTTY) {
    throw new CdpError("No script provided on stdin", "VALIDATION_ERROR", [
      "Pipe a script: axis-browser run <<'EOF'\\n...\\nEOF",
    ]);
  }
  const content = await readStdin();
  if (!content.trim()) {
    throw new CdpError("Empty script on stdin", "VALIDATION_ERROR", [
      "Pipe a script: axis-browser run <<'EOF'\\n...\\nEOF",
    ]);
  }
  const result = await runScript(content, callTool);
  return RAW_STDOUT_MARKER + trimSingleTrailingNewline(result.stdout);
}

async function handleSetup(args: string[]): Promise<string> {
  let parsed: ParsedSetupArgs;
  try {
    parsed = parseSetupArgs(args);
  } catch (error) {
    throw new CdpError(
      error instanceof Error ? error.message : "Unknown setup option",
      "VALIDATION_ERROR",
      [
        "Run `axis-browser setup` for a read-only report",
        "Run `axis-browser setup hooks` to install agent hooks",
      ],
    );
  }

  if (parsed.action === "hooks") {
    installHooksOrThrow();

    return renderOutput([
      "hooks:\n  status: installed\n  integrations: Claude Code, Codex",
      renderHelp([
        "Restart your agent session to receive axis-browser ambient context",
      ]),
    ]);
  }

  const report = runSetupWorkflow(parsed);
  if (parsed.json) {
    return JSON.stringify(report, null, 2);
  }
  return formatSetupReport(report);
}

async function handleUpdate(args: string[]): Promise<string> {
  const valid =
    args.length === 0 ||
    (args.length === 1 && (args[0] === "--check" || args[0] === "--help"));
  if (!valid) {
    throw new CdpError("Unknown update option", "VALIDATION_ERROR", [
      "Run `axis-browser update --help`",
    ]);
  }

  return renderOutput([
    encode({
      update: "disabled",
      reason: "Axis Browser is distributed from GitHub, not upstream npm",
    }),
    renderHelp([
      "Run `npm install -g github:Nirmantix/axis-browser` to update with npm",
      "Run `bun add -g github:Nirmantix/axis-browser` to update with Bun",
      "Installing `chrome-devtools-axi` from npm gets the upstream base tool, not this fork",
    ]),
  ]);
}

async function handleHome(_full: boolean): Promise<string> {
  const result = await getSessionSnapshotIfRunning();
  if (!result) {
    return renderOutput([
      encode({ browser: "no active session" }),
      renderHelp(["Run `axis-browser open <url>` to start browsing"]),
    ]);
  }
  const snapshot = stripSnapshotHeader(result);
  const title = extractTitle(snapshot);
  const refs = countRefs(snapshot);
  const page: Record<string, unknown> = {};
  if (title) page.title = title;
  page.refs = refs;
  const help: string[] = [
    "Run `axis-browser snapshot` to see page content",
    "Run `axis-browser open <url>` to navigate to a URL",
    "Run `axis-browser --help` to see full command list",
  ];
  return renderOutput([encode({ page }), renderHelp(help)]);
}

type CommandFn = (args: string[]) => Promise<string>;

function withFullFlag(
  handler: (args: string[], full: boolean) => Promise<string>,
): CommandFn {
  return (args) => {
    const parsed = splitFullFlag(args);
    return handler(parsed.args, parsed.full);
  };
}

function withoutFullFlag(
  handler: (args: string[]) => Promise<string>,
): CommandFn {
  return (args) => handler(splitFullFlag(args).args);
}

function validateCommandFlags(
  command: string,
  args: string[],
  allowedFlags: readonly string[],
  valueFlags: readonly string[],
  dashPositionalSlots: readonly number[],
  positionalArgsBeforeText = args.length,
): void {
  let positionalArgs = 0;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (positionalArgs === positionalArgsBeforeText) return;
    if (arg === "--help" || allowedFlags.includes(arg)) {
      if (valueFlags.includes(arg)) {
        // A value flag as the last argument would otherwise skip past the end
        // of args and be silently accepted — `screenshot ./a.png --format`
        // validated fine and then rendered a PNG with the format ignored.
        if (i + 1 >= args.length) {
          throw new CdpError(
            `Flag ${arg} for \`${command}\` needs a value`,
            "VALIDATION_ERROR",
            [
              `Run \`${PRIMARY_COMMAND_NAME} ${command} --help\` to see valid flags`,
            ],
          );
        }
        i += 1;
      }
      continue;
    }
    if (
      arg !== "-" &&
      arg.startsWith("-") &&
      (arg.startsWith("--") || !dashPositionalSlots.includes(positionalArgs))
    ) {
      throw new CdpError(
        `Unknown flag ${arg} for \`${command}\``,
        "VALIDATION_ERROR",
        [
          `Run \`${PRIMARY_COMMAND_NAME} ${command} --help\` to see valid flags`,
        ],
      );
    }
    positionalArgs += 1;
  }
}

const COMMAND_HANDLERS: Record<string, CommandFn> = {
  open: withFullFlag(handleOpen),
  snapshot: async (args) => handleSnapshot(splitFullFlag(args).full),
  screenshot: withoutFullFlag(handleScreenshot),
  click: withFullFlag(handleClick),
  fill: withFullFlag(handleFill),
  type: withFullFlag(handleType),
  press: withFullFlag(handlePress),
  scroll: withFullFlag(handleScroll),
  back: async (args) => handleBack(splitFullFlag(args).full),
  wait: withoutFullFlag(handleWait),
  eval: withFullFlag(handleEval),
  run: async () => handleRun(),
  hover: withFullFlag(handleHover),
  drag: withFullFlag(handleDrag),
  fillform: withFullFlag(handleFillForm),
  dialog: withoutFullFlag(handleDialog),
  upload: withFullFlag(handleUpload),
  pages: async () => handlePages(),
  newpage: withFullFlag(handleNewPage),
  selectpage: withFullFlag(handleSelectPage),
  closepage: withoutFullFlag(handleClosePage),
  resize: withoutFullFlag(handleResize),
  emulate: withoutFullFlag(handleEmulate),
  console: withoutFullFlag(handleConsole),
  "console-get": withoutFullFlag(handleConsoleGet),
  network: withoutFullFlag(handleNetwork),
  "network-get": withoutFullFlag(handleNetworkGet),
  lighthouse: withoutFullFlag(handleLighthouse),
  "perf-start": withoutFullFlag(handlePerfStart),
  "perf-stop": withoutFullFlag(handlePerfStop),
  "perf-insight": withoutFullFlag(handlePerfInsight),
  heap: withoutFullFlag(handleHeap),
  start: async () => handleStart(),
  doctor: withoutFullFlag(handleDoctor),
  reap: withoutFullFlag(handleReap),
  login: withoutFullFlag(handleLogin),
  stop: async () => handleStop(),
  setup: withoutFullFlag(handleSetup),
  update: withoutFullFlag(handleUpdate),
};

const COMMAND_FLAGS: Record<string, readonly string[]> = {
  open: ["--full"],
  screenshot: ["--uid", "--full-page", "--format"],
  snapshot: ["--full"],
  click: ["--full"],
  fill: ["--full"],
  type: ["--full"],
  press: ["--full"],
  scroll: ["--full"],
  back: ["--full"],
  wait: [],
  eval: ["--full"],
  run: [],
  hover: ["--full"],
  drag: ["--full"],
  fillform: ["--full"],
  dialog: [],
  upload: ["--full"],
  pages: [],
  newpage: ["--background", "--full"],
  selectpage: ["--full"],
  closepage: [],
  resize: [],
  emulate: [
    "--viewport",
    "--color-scheme",
    "--network",
    "--cpu",
    "--geolocation",
    "--user-agent",
  ],
  console: ["--type", "--limit", "--page"],
  "console-get": [],
  network: ["--type", "--limit", "--page"],
  "network-get": ["--response-file", "--request-file"],
  lighthouse: ["--device", "--mode", "--output-dir"],
  "perf-start": ["--no-reload", "--no-auto-stop", "--file"],
  "perf-stop": ["--file"],
  "perf-insight": [],
  heap: [],
  start: [],
  stop: [],
  // Fork-owned commands. Upstream's strict flag table (0.1.34) predates them and
  // a missing key means `?? []`, which silently rejected every flag these
  // commands document — `update --check`, `doctor --json`, `reap --dry-run`,
  // `setup --install`. Each list must stay in step with COMMAND_HELP and the
  // handler that parses it.
  doctor: ["--json"],
  reap: ["--dry-run", "--min-age-hours"],
  login: [],
  setup: ["--install", "--json", "--yes", "-y", "--project"],
  update: ["--check"],
};

const COMMAND_VALUE_FLAGS: Partial<Record<string, readonly string[]>> = {
  screenshot: ["--uid", "--format"],
  emulate: COMMAND_FLAGS.emulate,
  console: COMMAND_FLAGS.console,
  network: COMMAND_FLAGS.network,
  "network-get": COMMAND_FLAGS["network-get"],
  lighthouse: COMMAND_FLAGS.lighthouse,
  "perf-start": ["--file"],
  "perf-stop": COMMAND_FLAGS["perf-stop"],
  reap: ["--min-age-hours"],
  setup: ["--project"],
};

const COMMAND_POSITIONAL_TEXT_START: Partial<Record<string, number>> = {
  fill: 1,
  type: 0,
  wait: 0,
  eval: 0,
  dialog: 1,
};

const COMMAND_DASH_POSITIONAL_SLOTS: Partial<
  Record<string, readonly number[]>
> = {
  heap: [0],
  upload: [1],
  screenshot: [0],
};

const COMMANDS: Record<string, CommandFn> = Object.fromEntries(
  Object.entries(COMMAND_HANDLERS).map(([command, handler]) => [
    command,
    (args: string[]) => {
      assertCommandFlagsAllowed(command, args);
      return handler(args);
    },
  ]),
);

export async function main(
  options: MainOptions | string[] = {},
): Promise<void> {
  const normalized = normalizeMainOptions(options);
  const requestedArgv = resolveArgv(normalized.argv);
  const homeFull = shouldRenderFullHome(requestedArgv);
  const argv = homeFull ? [] : normalized.argv;
  const stdout = wrapStdout(normalized.stdout, argv);

  await runAxiCli({
    ...(argv ? { argv } : {}),
    ...(stdout ? { stdout } : {}),
    description: HOME_DESCRIPTION,
    version: VERSION,
    topLevelHelp: TOP_HELP,
    home: async (args) => handleHome(homeFull || splitFullFlag(args).full),
    commands: COMMANDS,
    getCommandHelp,
    renderUnknownCommand,
  });
}
