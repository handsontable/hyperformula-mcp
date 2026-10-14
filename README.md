# HyperFormula Edge Calc Service

Stateless spreadsheet calculations via HTTP. Formulas instead of code.

Send data and Excel-compatible formulas to a single API endpoint and get computed results back as JSON. Accepts raw CSV or JSON arrays. Supports named columns, declarative groupBy aggregation, and 400+ built-in functions. Up to 50,000 rows per request.

- **Live API**: https://hyperformula-mcp.handsontable-sandbox.workers.dev
- **API Schema**: https://hyperformula-mcp.handsontable-sandbox.workers.dev/api/calc (GET)
- **Remote MCP**: https://hyperformula-mcp.handsontable-sandbox.workers.dev/mcp

> Hosted as a Cloudflare Worker on the Handsontable sandbox account. The API is
> public (no authentication) so AI agents and HTTP clients can call it directly.

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

### Option 2: Remote MCP Server (zero install)

The Worker exposes a hosted MCP endpoint (Streamable HTTP, stateless) — connect any MCP client with just the URL, no clone or install:

```
https://hyperformula-mcp.handsontable-sandbox.workers.dev/mcp
```

**Tools available:**
| Tool | Description |
|------|-------------|
| `calc_formulas` | Evaluate formulas against CSV/JSON data with optional named columns |
| `calc_groupby` | Declarative group-by aggregation |
| `calc_grid` | Evaluate embedded formulas in a grid |

**Claude Code:**

```bash
claude mcp add --transport http hyperformula https://hyperformula-mcp.handsontable-sandbox.workers.dev/mcp
```

**claude.ai / Claude Desktop** — add the URL above as a custom connector (Settings → Connectors → Add custom connector). No authentication required.

Rate limiting and analytics apply the same as the HTTP API.

### Option 3: Local MCP Server (for .xlsx files)

The included stdio MCP server adds local-file superpowers the remote endpoint can't have: pass a `.xlsx`/`.xls`/`.csv` path via the `file` parameter, and write results back with `output_file`. Data flows through the hosted API for computation.

**Claude Code** — the repo ships a project-scoped [`.mcp.json`](.mcp.json), so after `git clone` + `npm install` the server is available automatically when you run `claude` inside the repo. To register it from another project:

```bash
claude mcp add hyperformula-local -- node /path/to/hyperformula-mcp/mcp-server.mjs
```

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

To point the local MCP server at a different API (e.g. self-hosted), set the `HYPERFORMULA_API_URL` environment variable.

### Option 4: Self-Hosted

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
Worker name is set in `wrangler.jsonc`; the deploy goes to the account you are
logged into (or set `CLOUDFLARE_ACCOUNT_ID` / `account_id` to pick one).

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
| `groupBy` | object | `{by: "column", aggregates: {col: "SUM"}}`. Requires `headers: true`. Rows with a blank `by` value are skipped. Group values match exactly (case-sensitive). |

### Limits

| Limit | Value |
|-------|-------|
| Max rows | 50,000 (+ header) |
| Max columns | 50 |
| Max body size | 50 MB |
| Max formula length | 2,000 characters |
| Max formulas per request | 100 |
| Max cell size (CSV) | 10,000 characters |
| Max distinct groups (groupBy) | 10,000 |
| Rate limit | 60 requests/minute per IP |

### Supported Formulas

400+ Excel-compatible functions via [HyperFormula](https://hyperformula.handsontable.com/guide/built-in-functions.html). Common ones:

**Math**: SUM, AVERAGE, MIN, MAX, MEDIAN, COUNT, COUNTA, ROUND, ABS, MOD, POWER
**Conditional**: IF, IFS, IFERROR, AND, OR, NOT, COUNTIF, COUNTIFS, SUMIF, SUMIFS, AVERAGEIF
**Lookup**: VLOOKUP, HLOOKUP, XLOOKUP, INDEX, MATCH
**Array**: UNIQUE, SORT, FILTER, VSTACK, HSTACK
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
    "groups": 7,
    "columns": {"Revenue": {"letter": "B", "index": 1, "namedExpression": "Revenue"}}
  }
}
```

### AI Agent Discovery

The API is designed to be easily discovered and used by AI agents:

- **`GET /api/calc`** — Full API schema as JSON with parameters, examples, supported formulas, and limits
- **`/openapi.json`** — OpenAPI 3.1 specification

---

## Architecture

```
┌──────────────────┐  ┌─────────────────┐  ┌───────────────────────┐
│  MCP Client      │  │  MCP Client     │  │  Any HTTP Client      │
│  (remote, URL)   │  │  (local files)  │  │  (curl, fetch, ...)   │
└────────┬─────────┘  └────────┬────────┘  └──────────┬────────────┘
         │ HTTPS               │ stdio                │ HTTPS
         │            ┌────────▼────────┐             │
         │            │  mcp-server.mjs │             │
         │            │  (.xlsx/.csv IO)│             │
         │            └────────┬────────┘             │
         ▼                     ▼ HTTPS                ▼
┌─────────────────────────────────────────────────────────────────┐
│  Cloudflare Worker                                              │
│  POST /mcp (Streamable HTTP)          POST /api/calc            │
└──────────────────────────────┬──────────────────────────────────┘
                               │
                ┌──────────────▼───────────────┐
                │  HyperFormula Engine          │
                │  (stateless, per-request)     │
                └──────────────┬───────────────┘
                               │
                ┌──────────────▼───────────────┐
                │  Usage Analytics              │
                │  (anonymous, usage only)      │
                └──────────────────────────────┘
```

- **Stateless**: No database, no sessions. Each request is independent.
- **Edge-deployable**: Runs as a Cloudflare Worker (static assets + API in one Worker). Deploy anywhere that supports Node-compatible serverless.
- **Rate limited**: 60 req/min per IP with sliding window. Headers expose remaining quota.
- **Hardened**: row/column/body/formula limits, CSV cell size caps, sanitized error messages. Requests that exceed the Workers CPU limit fail at the platform level.
- **Observable**: anonymous usage analytics capture how the service is used (transport, client, mode, size buckets, which spreadsheet functions appear in formulas), never what it is used on. See [Privacy](#privacy).

---

## Performance

Measured against the hosted Worker with a 50,000-row sales dataset (14 columns, 4 MB CSV). Each figure is the median of three requests, measured end to end from the client, so it includes uploading the CSV and parsing it server-side.

| Mode | Details | Round trip |
|------|---------|------------|
| Formulas + named columns | 7 formulas (SUM, AVERAGE, MAX, COUNTA) | ~12.5 s |
| Formulas + cell references | 3 formulas, no headers | ~4.5 s |
| GroupBy (2 groups) | by Channel, 3 aggregates (SUM) | ~0.9 s |
| GroupBy (7 groups) | by Region, 3 aggregates (SUM) | ~1.3 s |
| GroupBy (12 groups) | by Item Type, 4 aggregates (SUM, AVERAGE) | ~1.2 s |
| GroupBy (180 groups) | by Country, 3 aggregates (SUM, AVERAGE, MEDIAN) | ~1.0 s |
| Small dataset baseline | 3 rows, 3 formulas | ~0.3 s |

Formulas and grid modes build a full HyperFormula engine instance per request, so their cost grows with the data size and the formulas used. GroupBy runs as a single pass over the rows and is largely independent of the number of groups. The Worker cannot measure its own CPU time (the platform freezes the clock during a request), so the response carries no timing field.

---

## Privacy

This service runs as a serverless edge function. Your data is processed in memory and never stored.

We collect anonymous usage analytics so we can see how the service is used, not what it is used on. Each request records:

- a hash of the caller's IP that rotates daily (so we can count daily callers without a persistent identifier)
- the transport (HTTP or MCP), the first token of the User-Agent, and for MCP the client's self-declared name and version
- the mode, input type, row-count bucket (e.g. "1k-10k"), column count, formula count, and the **names of the spreadsheet functions** used (e.g. `SUM`, `COUNTIF`)
- for groupBy, the aggregate functions used and a group-count bucket
- error types for failed evaluations

Formula text, string literals, column names, cell values, and raw IP addresses are never sent. Analytics are a no-op when the `POSTHOG_API_KEY` secret is not configured.

---

## License

This repository is released under the [MIT License](LICENSE). Built by [Handsontable](https://handsontable.com/).

It depends on [HyperFormula](https://hyperformula.handsontable.com/), which is dual-licensed under GPLv3 and a commercial license. The hosted service and this repo use the `gpl-v3` license key; if you self-host, make sure your use complies with the GPLv3 terms or [obtain a commercial HyperFormula license](https://hyperformula.handsontable.com/guide/license-key.html).
