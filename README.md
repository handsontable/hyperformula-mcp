# HyperFormula Edge Calc Service

A lightweight, stateless calculation service that lets AI agents evaluate spreadsheet logic using **formulas instead of code**.

Wraps [HyperFormula](https://hyperformula.handsontable.com/) in a single HTTP endpoint, enabling deterministic data transformations without generating or executing custom JavaScript/Python.

## Why

LLMs are inconsistent at math but very good at writing formulas. This service lets agents send structured data, express logic as spreadsheet formulas, and get deterministic, Excel-compatible results.

Instead of generating code like:

```js
rows.map(r => r.status !== "active" ? 0 : r.price * r.qty * (1 - r.discount));
```

Agents send:

```
=IF(A2="active", B2*C2*(1-D2), 0)
```

## Quick Start

```bash
npm install
npm run dev        # starts Netlify dev server on :8888
```

```bash
curl -X POST http://localhost:8888/api/calc \
  -H "Content-Type: application/json" \
  -d '{
    "data": [["value"], [10], [20], [30]],
    "formula": "=SUM(A2:A4)"
  }'
```

```json
{
  "success": true,
  "mode": "single",
  "result": 60,
  "meta": { "rows": 4, "cols": 1, "durationMs": 2 }
}
```

## API

### `POST /api/calc`

#### Request Body

| Field | Type | Required | Description |
|---|---|---|---|
| `data` | `any[][]` | Yes | 2D array representing the sheet. Strings starting with `=` are treated as formulas. |
| `formula` | `string` | No | A single formula applied to the dataset (must start with `=`). |
| `returnMode` | `string` | No | `"grid"`, `"value"`, or `"results"`. Defaults depend on mode. |
| `sheetName` | `string` | No | Sheet name. Defaults to `"Sheet1"`. |

#### Execution Modes

**Embedded formulas** — formulas live inside `data` cells:

```json
{
  "data": [
    ["a", "b", "sum"],
    [1, 2, "=A2+B2"],
    [3, 4, "=A3+B3"]
  ]
}
```

Default return: full evaluated grid.

**Single formula** — one formula applied to the dataset:

```json
{
  "data": [["value"], [10], [20]],
  "formula": "=SUM(A2:A3)"
}
```

Default return: computed value only.

#### Return Modes

| Mode | Description |
|---|---|
| `"grid"` | Full dataset with all formulas evaluated |
| `"value"` | Single computed value (default for single formula mode) |
| `"results"` | Only cells that contained formulas, with their computed values |

#### Response

```json
{
  "success": true,
  "mode": "single",
  "result": 60,
  "meta": {
    "rows": 4,
    "cols": 1,
    "durationMs": 2
  }
}
```

#### Errors

```json
{
  "success": false,
  "error": {
    "type": "INVALID_FORMULA",
    "message": "formula must be a string starting with '='",
    "details": null
  }
}
```

Error types: `INVALID_JSON`, `INVALID_DATA`, `INVALID_FORMULA`, `INVALID_RETURN_MODE`, `FORMULA_ERROR`, `EVALUATION_ERROR`, `METHOD_NOT_ALLOWED`, `PAYLOAD_TOO_LARGE`.

## Testing

```bash
npm test
```

Uses Node.js built-in test runner (`node:test`). Tests cover both execution modes, all return modes, edge cases, and validation.

## Constraints (MVP)

- Stateless — no persistence between requests
- Single sheet per request
- Max ~1,000 rows, ~50 columns
- Max 1 MB request body
- No file upload (CSV/XLSX)
- No auth (add before production exposure)

## Deployment

Designed for Netlify Functions. Also works on Vercel, Cloudflare Workers, or any Node.js runtime.

```bash
netlify deploy --prod
```

## Project Structure

```
├── netlify/functions/calc.mjs   # The calc endpoint
├── public/index.html            # Demo UI
├── test/calc.test.mjs           # Test suite
├── netlify.toml                 # Routing config
└── package.json
```

## License

MIT
