# BrowserAct: CLI vs project MCP

You can use **both**. They are complementary, not duplicates.

| | **CLI** (`browser-act`) | **Remote MCP** (HTTP) |
|--|-------------------------|------------------------|
| **What** | Local shell automation | Hosted tools = **published BrowserAct workflows** |
| **Auth** | `browser-act auth login` / `auth set` (machine) | Dashboard MCP Server URL + API key (per client config) |
| **Best for** | Screenshots, navigate/click, scrape, sessions in coding agents via skill | “Run my saved workflow X” from Claude Code / Cursor |
| **Install** | Global tool OK (`uv tool install browser-act-cli`) | Prefer **project** or **user** MCP config — not required globally |

BrowserBay routes ad-hoc browser work to CLI/Harness/Playwright/Axis. Use MCP when the deliverable is a **named published workflow**.

Official docs: [MCP integration](https://docs.browseract.com/workflow/learn/integrations/mcp) · [MCP Servers](https://www.browseract.com/reception/mcp-servers)

---

## Per-project MCP (recommended for this repo)

Do **not** put URL/key in git. This repo gitignores `.mcp.json`.

### Option A — Claude Code project scope (simplest)

From the **project root** (e.g. this `axis-browser` checkout):

```bash
cd /path/to/your-project

# Values from BrowserAct → MCP Servers → Management → Connection Details
export BROWSERACT_MCP_SERVER_URL='https://mcp.browseract.com/<SERVER_ID>/mcp/'
export BROWSERACT_API_KEY='…'   # paste only in your terminal

claude mcp add --transport http browseract "$BROWSERACT_MCP_SERVER_URL" \
  --header "Authorization: Bearer $BROWSERACT_API_KEY" \
  --scope project
```

Verify (from same project):

```bash
claude mcp list
# expect: browseract … (HTTP) — Connected
```

Remove later:

```bash
claude mcp remove browseract --scope project
```

Scopes:

| Scope | Where it applies |
|-------|------------------|
| `project` | This repo only (what you want for “install in this project”) |
| `local` | Even narrower (often cwd/session-local; default) |
| `user` | All projects on this Mac (global — skip if you want project-only) |

### Option B — Hand-written `.mcp.json` (any MCP-aware host)

```bash
cd /path/to/your-project
cp .mcp.browseract.example.json .mcp.json   # if the example exists in the repo
# or create .mcp.json from the template in skills/browser-bay credentials docs
```

Edit `.mcp.json`: replace `<YOUR_SERVER_ID>` and `<YOUR_BROWSERACT_API_KEY>`.

Then open the project in Claude Code / Cursor and confirm MCP connects.

**Never commit** `.mcp.json`.

### Repeat for another project

Same steps in that project’s directory (new `claude mcp add … --scope project` or new `.mcp.json`).  
CLI auth is already machine-wide; you only re-add **MCP** per project (or use `--scope user` once if you prefer global MCP).

---

## Dashboard prerequisites (MCP tools empty otherwise)

1. Workflows: **MCP-Ready** + **Publish**
2. MCP server: tools **exposed**, server **online**
3. Connection Details: URL + API key pair match

---

## How agents should choose

1. **BrowserBay skill** → task routing  
2. Ad-hoc browser work → CLI / Harness / Playwright / Axis  
3. Published BrowserAct workflow → MCP tool `browseract` (if project MCP connected)  
4. If MCP missing → fall back to CLI or other tools; do not fail the whole skill  
