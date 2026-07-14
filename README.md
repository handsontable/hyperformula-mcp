# HyperFormula Edge Calc Service

Stateless spreadsheet calculations via HTTP. Formulas instead of code.

Send data and Excel-compatible formulas to a single API endpoint and get computed results back as JSON. Accepts raw CSV or JSON arrays. Supports named columns, declarative groupBy aggregation, and 400+ built-in functions. Up to 50,000 rows per request.

**Live API**: https://hyperformula-mcp.handsontable-sandbox.workers.dev
**API Schema**: https://hyperformula-mcp.handsontable-sandbox.workers.dev/api/calc (GET)
**Repo**: https://github.com/handsontable/hyperformula-mcp

> Hosted as a Cloudflare Worker on the Handsontable sandbox account. The API is
> public (no authentication) so AI agents and HTTP clients can call it directly;
> responses carry an `X-Robots-Tag: noindex` header to keep the endpoint out of
> search results.

Built on [HyperFormula](https://hyperformula.handsontable.com/), a headless spreadsheet calculation engine by [Handsontable](https://handsontable.com/).

---

## Capabilities

### Formulas Mode
Evaluate one or more formulas against a dataset. Returns an array of results.

```bash
curl -X POST https://hyperformula-mcp.handsontable-sandbox.workers.dev/api/calc \
  -H "Content-Type: application/json" \
  -d '{
    "csv": "product,price,qty\nWidget,10,5\nGadget,25,3",
    "headers": true,
    "formulas": ["=SUM(price)", "=SUMPRODUCT(price,qty)", "=MAX(qty)"]
  }'
```
```json
{"success": true, "mode": "formulas", "result": [35, 125, 5]}
```

### GroupBy Mode
Declarative aggregation — group rows by a column and compute SUM, AVERAGE, COUNT, MIN, MAX, or MEDIAN per group.

```bash
curl -X POST https://hyperformula-mcp.handsontable-sandbox.workers.dev/api/calc \
  -H "Content-Type: application/json" \
  -d '{
    "csv": "Region,Revenue,Units\nEurope,1000,50\nAsia,2000,80\nEurope,1500,30",
    "headers": true,
    "groupBy": {"by": "Region", "aggregates": {"Revenue": "SUM", "Units": "AVERAGE"}}
  }'
```
```json
{"success": true, "mode": "groupBy", "result": [
  {"group": "Europe", "Revenue": 2500, "Units": 40},
  {"group": "Asia", "Revenue": 2000, "Units": 80}
]}
```

### Embedded Grid Mode
Place formulas directly in data cells. Returns the full evaluated grid.

```bash
curl -X POST https://hyperformula-mcp.handsontable-sandbox.workers.dev/api/calc \
  -H "Content-Type: application/json" \
  -d '{
    "data": [["a","b","sum"], [1,2,"=A2+B2"], [3,4,"=A3+B3"]]
  }'
```
```json
{"success": true, "mode": "grid", "result": [["a","b","sum"], [1,2,3], [3,4,7]]}
```

### Named Columns
When `headers: true`, row 1 becomes column names usable directly in formulas. Column names with spaces are sanitized (spaces become underscores). Both the original name and sanitized name work.

```json
{"csv": "Total Revenue,Total Cost\n1000,800", "headers": true, "formulas": ["=SUM(Total_Revenue)"]}
```

### CSV Input
Pass raw CSV via the `csv` field instead of building JSON arrays. Numeric values are auto-detected. Supports quoted fields with commas and newlines.

---

## Usage

### Option 1: Managed API

The hosted API at `https://hyperformula-mcp.handsontable-sandbox.workers.dev/api/calc` is ready to use with no setup.

- **`GET /api/calc`** — Returns the full API schema with parameters, examples, supported formulas, and limits. Useful for AI agent discovery.
- **`POST /api/calc`** — Evaluate formulas. Send JSON with `csv` or `data`, plus `formulas` or `groupBy`.

Rate limited to 60 requests/minute per IP. Responses include `X-RateLimit-Limit`, `X-RateLimit-Remaining`, and `X-RateLimit-Reset` headers.

### Option 2: MCP Server (for AI agents)

The included MCP server gives AI agents like Claude native tool access. All requests flow through the hosted API, so rate limiting and analytics still apply.

**Tools available:**
| Tool | Description |
|------|-------------|
| `calc_formulas` | Evaluate formulas against CSV/JSON data with optional named columns |
| `calc_groupby` | Declarative group-by aggregation |
| `calc_grid` | Evaluate embedded formulas in a grid |

**Claude Desktop** — add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "hyperformula": {
      "type": "stdio",
      "command": "node",
      "args": ["/path/to/hyperformula-mcp/mcp-server.mjs"]
    }
  }
}
```

**Claude Code** — add to `.claude/settings.json`:

```json
{
  "mcpServers": {
    "hyperformula": {
      "type": "stdio",
      "command": "node",
      "args": ["/path/to/hyperformula-mcp/mcp-server.mjs"]
    }
  }
}
```

To point the MCP server at a different API (e.g. self-hosted), set the `HYPERFORMULA_API_URL` environment variable.

### Option 3: Self-Hosted

The service is a single Cloudflare Worker (`src/index.js`) that serves the static
files in `public/` via the ASSETS binding **and** runs the `/api/calc` logic
server-side. No database, no state, no configuration required. It runs on any
platform that supports Node-compatible serverless functions, but the repo is set
up for Cloudflare Workers out of the box.

```bash
git clone https://github.com/handsontable/hyperformula-mcp
cd hyperformula-mcp
npm install

# Local development (Wrangler dev server)
npm run dev

# Deploy to Cloudflare Workers
npm run deploy     # runs `wrangler deploy`
```

Deploying requires a Cloudflare account (`npx wrangler login` on the CLI). The
target Worker name and account are set in `wrangler.jsonc`.

For analytics, set a `POSTHOG_API_KEY` Worker secret with your PostHog project
API key (`npx wrangler secret put POSTHOG_API_KEY`). When it's unset, analytics
is a no-op.

---

## API Reference

### Parameters

| Param | Type | Description |
|-------|------|-------------|
| `csv` | string | Raw CSV string. Auto-detects numbers. Mutually exclusive with `data`. |
| `data` | array[] | 2D JSON array. Mutually exclusive with `csv`. |
| `headers` | boolean | When `true`, row 1 = column names usable in formulas. Required for `groupBy`. |
| `formulas` | string[] | Array of formulas (each starting with `=`). Returns array of results. |
| `groupBy` | object | `{by: "column", aggregates: {col: "SUM"}}`. Requires `headers: true`. |

### Limits

| Limit | Value |
|-------|-------|
| Max rows | 50,000 (+ header) |
| Max columns | 50 |
| Max body size | 50 MB |
| Max formula length | 2,000 characters |
| Max formulas per request | 100 |
| Max cell size (CSV) | 10,000 characters |
| Evaluation timeout | 5 seconds |
| Rate limit | 60 requests/minute per IP |

### Supported Formulas

400+ Excel-compatible functions via [HyperFormula](https://hyperformula.handsontable.com/guide/built-in-functions.html). Common ones:

**Math**: SUM, AVERAGE, MIN, MAX, MEDIAN, COUNT, COUNTA, ROUND, ABS, MOD, POWER
**Conditional**: IF, IFS, IFERROR, AND, OR, NOT, COUNTIF, COUNTIFS, SUMIF, SUMIFS, AVERAGEIF
**Lookup**: VLOOKUP, HLOOKUP, INDEX, MATCH
**Text**: LEFT, RIGHT, MID, LEN, TRIM, CONCATENATE, SUBSTITUTE, TEXT
**Date**: DATE, YEAR, MONTH, DAY, TODAY, NOW
**Statistical**: LARGE, SMALL, RANK, SUMPRODUCT

### Response Format

```json
{
  "success": true,
  "mode": "formulas | grid | groupBy",
  "result": "array of values | 2D grid | array of group objects",
  "meta": {
    "rows": 50001,
    "cols": 14,
    "durationMs": 1016,
    "groups": 7,
    "columns": {"Revenue": {"letter": "B", "index": 1, "namedExpression": "Revenue"}}
  }
}
```

### AI Agent Discovery

The API is designed to be easily discovered and used by AI agents:

- **`GET /api/calc`** — Full API schema as JSON with parameters, examples, supported formulas, and limits
- **`/openapi.json`** — OpenAPI 3.1 specification
- **`/.well-known/ai-plugin.json`** — AI plugin manifest for ChatGPT-style plugin discovery

---

## Architecture

```
┌─────────────────┐     ┌──────────────────────────────┐
│  MCP Client     │     │  Any HTTP Client              │
│  (Claude, etc.) │     │  (curl, fetch, Python, etc.)  │
└────────┬────────┘     └──────────────┬───────────────┘
         │ stdio                       │ HTTPS
         ▼                             ▼
┌─────────────────┐     ┌──────────────────────────────┐
│  mcp-server.mjs │────▶│  POST /api/calc              │
│  (thin wrapper) │     │  Cloudflare Worker            │
└─────────────────┘     └──────────────┬───────────────┘
                                       │
                        ┌──────────────▼───────────────┐
                        │  HyperFormula Engine          │
                        │  (stateless, per-request)     │
                        └──────────────┬───────────────┘
                                       │
                        ┌──────────────▼───────────────┐
                        │  PostHog Analytics            │
                        │  (anonymous, formulas only)   │
                        └──────────────────────────────┘
```

- **Stateless**: No database, no sessions. Each request is independent.
- **Edge-deployable**: Runs as a Cloudflare Worker (static assets + API in one Worker). Deploy anywhere that supports Node-compatible serverless.
- **Rate limited**: 60 req/min per IP with sliding window. Headers expose remaining quota.
- **Hardened**: 5s evaluation timeout, formula length/count limits, CSV cell size caps, sanitized error messages.
- **Observable**: PostHog analytics track formula types, modes, row counts, and durations. Data is never stored or logged.

---

## Performance

Benchmarked with a 50,000-row sales dataset (14 columns, 6MB CSV) on Apple M4 Max / Node 22.

| Mode | Details | Avg Time |
|------|---------|----------|
| Formulas + named columns | 7 formulas (SUM, AVERAGE, MAX, COUNTA) | ~1,016ms |
| Formulas + cell references | 3 formulas, no headers | ~560ms |
| GroupBy (7 groups) | by Region, 3 aggregates (SUM) | ~1,707ms |
| GroupBy (12 groups) | by Item Type, 4 aggregates (SUM, AVERAGE) | ~2,838ms |
| GroupBy (2 groups) | by Sales Channel, 3 aggregates (SUM) | ~1,127ms |
| Small dataset baseline | 3 rows, 3 formulas | ~7ms |

Times are server-side `durationMs` (excludes network and CSV parsing overhead).

---

## Privacy

This service runs as a serverless edge function. Your data is processed in-memory and never stored. We collect anonymous usage analytics on formula types, execution modes, row counts, and durations. The actual dataset content is never logged or transmitted to analytics.

---

## License

Powered by [HyperFormula](https://hyperformula.handsontable.com/) (GPLv3). Built by [Handsontable](https://handsontable.com/).
