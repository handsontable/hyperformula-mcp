import { HyperFormula } from "hyperformula";
import { createHash } from "node:crypto";

// --- Analytics (fetch-based PostHog capture, non-blocking) ---
// On Workers we POST directly to the capture endpoint via ctx.waitUntil so it
// never blocks the response. No-op when the key is unset.
//
// What is captured is deliberately limited to usage shape, never content:
//   - a daily-rotating hash of the caller's IP (daily active callers, no
//     persistent identity)
//   - transport (http / mcp), the User-Agent product token, MCP client name
//   - mode, input type, size buckets, and which spreadsheet FUNCTIONS appear
//     in formulas (names only — no formula text, literals, column names, or
//     cell values)
const POSTHOG_HOST = "https://us.i.posthog.com";

function anonymousId(ip) {
  const day = new Date().toISOString().slice(0, 10);
  return createHash("sha256").update(`${ip || "unknown"}|${day}`).digest("hex").slice(0, 16);
}

// Bucket a count so dashboards can group by size without exact row counts.
function sizeBucket(n) {
  if (n == null) return undefined;
  if (n <= 10) return "1-10";
  if (n <= 100) return "11-100";
  if (n <= 1000) return "101-1k";
  if (n <= 10000) return "1k-10k";
  return "10k+";
}

// Unique spreadsheet function names used across a set of formulas, e.g.
// ["SUM", "COUNTIF"]. String literals are stripped first so that quoted text
// such as "Europe" or a customer name never leaks into analytics.
export function extractFunctions(formulas) {
  const names = new Set();
  for (const f of formulas || []) {
    const noStrings = String(f).replace(/"(?:[^"]|"")*"/g, '""');
    for (const m of noStrings.matchAll(/([A-Za-z_][A-Za-z0-9_.]*)\s*\(/g)) names.add(m[1].toUpperCase());
  }
  return [...names].sort();
}

function clientToken(userAgent) {
  // First product token only ("curl/8.7.1", "node", "python-requests/2.32")
  return (userAgent || "").split(" ")[0].slice(0, 40) || undefined;
}

function capture(env, ctx, distinctId, event, properties) {
  const key = env.POSTHOG_API_KEY;
  if (!key) return;
  ctx.waitUntil(
    fetch(`${POSTHOG_HOST}/capture/`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ api_key: key, event, distinct_id: distinctId, properties }),
    }).catch(() => {})
  );
}

function trackEval(env, ctx, clientIp, body, result, { transport = "http", userAgent } = {}) {
  const props = {
    transport,
    client: clientToken(userAgent),
    mode: result.mode,
    input_type: body.csv !== undefined ? "csv" : "data",
    headers: !!body.headers,
    rows_bucket: sizeBucket(result.meta?.rows),
    cols: result.meta?.cols,
  };

  if (result.mode === "formulas") {
    props.formula_count = body.formulas?.length;
    props.functions = extractFunctions(body.formulas);
  } else if (result.mode === "grid") {
    const embedded = [];
    for (const row of body.data || []) for (const v of row || []) if (typeof v === "string" && v.startsWith("=")) embedded.push(v);
    props.formula_count = embedded.length;
    props.functions = extractFunctions(embedded);
  } else if (result.mode === "groupBy") {
    props.aggregates = body.groupBy?.aggregates ? [...new Set(Object.values(body.groupBy.aggregates).map((a) => String(a).toUpperCase()))].sort() : [];
    props.groups_bucket = sizeBucket(result.meta?.groups);
  }

  capture(env, ctx, anonymousId(clientIp), "calc_evaluated", props);
}

function trackError(env, ctx, clientIp, errorType, { transport = "http", userAgent } = {}) {
  capture(env, ctx, anonymousId(clientIp), "calc_error", { transport, client: clientToken(userAgent), error_type: errorType });
}

// Which MCP clients connect is the most useful adoption signal for the remote
// endpoint; clientInfo is the client's self-declared product name/version.
function trackMcpInitialize(env, ctx, clientIp, clientInfo, userAgent) {
  capture(env, ctx, anonymousId(clientIp), "mcp_initialize", {
    client_name: String(clientInfo?.name || "unknown").slice(0, 60),
    client_version: String(clientInfo?.version || "").slice(0, 30),
    client: clientToken(userAgent),
  });
}

// --- Limits ---
const MAX_ROWS = 50_000;
const MAX_COLS = 50;
const MAX_BODY_BYTES = 50_000_000; // 50 MB
const MAX_FORMULA_LENGTH = 2_000;
const MAX_FORMULAS = 100;
const MAX_CELL_CHARS = 10_000;
const MAX_GROUPS = 10_000;
const RATE_LIMIT = 60; // requests per window
const RATE_WINDOW_MS = 60_000; // 1 minute

// --- Rate limiter (in-memory sliding window) ---
// Per-isolate and ephemeral. Good enough for basic abuse protection; not a
// global limit.
const ipHits = new Map();
const RATE_MAP_SWEEP_SIZE = 10_000;

function rateLimit(ip) {
  const now = Date.now();
  // Evict idle IPs so the map can't grow unbounded over an isolate's lifetime
  if (ipHits.size > RATE_MAP_SWEEP_SIZE) {
    for (const [key, rec] of ipHits) {
      if (rec.timestamps.length === 0 || rec.timestamps[rec.timestamps.length - 1] <= now - RATE_WINDOW_MS) {
        ipHits.delete(key);
      }
    }
  }
  let record = ipHits.get(ip);
  if (!record) {
    record = { timestamps: [] };
    ipHits.set(ip, record);
  }
  // Prune timestamps older than the window
  record.timestamps = record.timestamps.filter(t => t > now - RATE_WINDOW_MS);
  const remaining = Math.max(0, RATE_LIMIT - record.timestamps.length);
  const resetAt = record.timestamps.length > 0
    ? Math.ceil((record.timestamps[0] + RATE_WINDOW_MS) / 1000)
    : Math.ceil((now + RATE_WINDOW_MS) / 1000);

  if (record.timestamps.length >= RATE_LIMIT) {
    return { allowed: false, remaining: 0, resetAt };
  }
  record.timestamps.push(now);
  ipHits.set(ip, record);
  return { allowed: true, remaining: remaining - 1, resetAt };
}

function rateLimitHeaders(rl) {
  return {
    "X-RateLimit-Limit": String(RATE_LIMIT),
    "X-RateLimit-Remaining": String(rl.remaining),
    "X-RateLimit-Reset": String(rl.resetAt),
  };
}

// --- Helpers ---

function validateData(data) {
  if (!Array.isArray(data) || data.length === 0) {
    return "data must be a non-empty 2D array";
  }
  for (let i = 0; i < data.length; i++) {
    if (!Array.isArray(data[i])) {
      return `data[${i}] is not an array`;
    }
  }
  if (data.length > MAX_ROWS + 1) {
    return `data exceeds maximum of ${MAX_ROWS} data rows (plus optional header)`;
  }
  const maxWidth = Math.max(...data.map((r) => r.length));
  if (maxWidth > MAX_COLS) {
    return `data exceeds maximum of ${MAX_COLS} columns`;
  }
  return null;
}

function normalizeCell(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === "string" && v.startsWith("=")) return v; // formula
  return v;
}

function normalizeData(data) {
  // Pad all rows to the same width and normalize cell values
  const width = Math.max(...data.map((r) => r.length));
  return data.map((row) => {
    const out = new Array(width).fill(null);
    for (let c = 0; c < row.length; c++) {
      out[c] = normalizeCell(row[c]);
    }
    return out;
  });
}

// --- CSV parsing ---

export function parseCSV(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        cell += ch;
      }
      if (cell.length > MAX_CELL_CHARS) throw { type: "INVALID_CSV", message: `Cell exceeds maximum of ${MAX_CELL_CHARS} characters` };
    } else {
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === ",") {
        row.push(autoType(cell));
        cell = "";
      } else if (ch === "\n" || ch === "\r") {
        row.push(autoType(cell));
        cell = "";
        // Skip fully blank lines instead of emitting [null] rows
        if (row.length > 1 || row[0] !== null) rows.push(row);
        row = [];
        if (ch === "\r" && text[i + 1] === "\n") i++; // skip \n in \r\n
      } else {
        cell += ch;
      }
    }
  }
  // Last cell/row
  if (cell !== "" || row.length > 0) {
    row.push(autoType(cell));
    rows.push(row);
  }
  return rows;
}

function autoType(val) {
  const trimmed = val.trim();
  if (trimmed === "") return null;
  if (trimmed.startsWith("=")) return trimmed; // formula
  const num = Number(trimmed);
  if (!isNaN(num) && trimmed !== "") return num;
  return trimmed;
}

function colToLetter(index) {
  let s = "";
  let n = index;
  while (n >= 0) {
    s = String.fromCharCode((n % 26) + 65) + s;
    n = Math.floor(n / 26) - 1;
  }
  return s;
}

// --- Core evaluation ---

function sanitizeName(name) {
  let s = name.replace(/[^a-zA-Z0-9_]/g, "_");
  if (/^[0-9]/.test(s)) s = "_" + s;
  return s;
}

// Map header names (original and sanitized) to column letters and indexes.
function buildColumnMap(headerRow) {
  const columnMap = {};
  for (let c = 0; c < headerRow.length; c++) {
    const raw = headerRow[c];
    if (raw == null) continue;
    const colName = String(raw);
    const safeName = sanitizeName(colName);
    const entry = { letter: colToLetter(c), index: c, namedExpression: safeName };
    columnMap[colName] = entry;
    if (safeName !== colName) columnMap[safeName] = entry;
  }
  return columnMap;
}

export function evaluate({ data, formulas, headers, groupBy }) {
  const name = "Sheet1";
  const normalized = normalizeData(data);
  const columnMap = headers && normalized.length > 0 ? buildColumnMap(normalized[0]) : null;

  let mode, result;

  if (groupBy) {
    // GroupBy mode — a single pass over the data; no engine instance needed
    result = evaluateGroupBy(normalized, columnMap, groupBy);
    mode = "groupBy";
  } else {
    const hf = HyperFormula.buildFromSheets(
      { [name]: normalized },
      { licenseKey: "gpl-v3", maxRows: MAX_ROWS + 1001, maxColumns: MAX_COLS + 100 }
    );
    const sheetId = hf.getSheetId(hf.getSheetName(0));

    // Named expressions from headers: each column name refers to its data range
    if (columnMap) {
      const dataRows = normalized.length;
      for (const entry of new Set(Object.values(columnMap))) {
        const col = entry.letter;
        try {
          hf.addNamedExpression(entry.namedExpression, `=${name}!$${col}$2:$${col}$${dataRows}`);
        } catch (_) { /* skip if name conflicts with built-in */ }
      }
    }

    if (Array.isArray(formulas) && formulas.length > 0) {
      // Formulas mode — all formulas set in one operation, results in the same order
      const formulaRow = normalized.length;
      hf.setCellContents({ sheet: sheetId, row: formulaRow, col: 0 }, [formulas]);
      result = formulas.map((_, i) => unwrapValue(hf.getCellValue({ sheet: sheetId, row: formulaRow, col: i })));
      mode = "formulas";
    } else {
      // Embedded formula mode — return the full evaluated grid
      mode = "grid";
      result = extractGrid(hf, sheetId, normalized.length, normalized[0]?.length || 0);
    }
    hf.destroy();
  }

  const meta = { rows: normalized.length, cols: normalized[0]?.length || 0 };
  if (columnMap) meta.columns = columnMap;
  if (mode === "groupBy") meta.groups = result.length;

  return { success: true, mode, result, meta };
}

const SUPPORTED_AGGS = ["SUM", "AVERAGE", "COUNT", "MIN", "MAX", "MEDIAN"];

// GroupBy is computed in a single pass over the rows rather than as one
// SUMIF-style formula per group x aggregate: that layout scanned every row
// once per formula and hit the engine's sheet-size cap past ~150 cells, so
// grouping by a high-cardinality column failed. Group keys match exactly
// (case-sensitive, no wildcard interpretation). Results follow spreadsheet
// semantics: non-numeric values are ignored by SUM/AVERAGE/MIN/MAX/MEDIAN,
// COUNT counts the rows in the group, AVERAGE of no numbers is #DIV/0!,
// MIN/MAX of no numbers is 0.
function evaluateGroupBy(normalized, columnMap, groupBy) {
  const { by, aggregates } = groupBy;
  const byInfo = columnMap[by];
  if (!byInfo) throw { type: "INVALID_GROUPBY", message: `Column '${by}' not found in headers` };

  const aggEntries = Object.entries(aggregates).map(([col, fn]) => {
    if (!columnMap[col]) throw { type: "INVALID_GROUPBY", message: `Aggregate column '${col}' not found in headers` };
    const upperFn = String(fn).toUpperCase();
    if (!SUPPORTED_AGGS.includes(upperFn)) throw { type: "INVALID_GROUPBY", message: `Unsupported aggregate '${fn}'. Use: ${SUPPORTED_AGGS.join(", ")}` };
    return { key: col, index: columnMap[col].index, fn: upperFn };
  });

  // One accumulator per group, in first-seen order (header row 0 is skipped;
  // rows with a blank group value are skipped)
  const groups = new Map();
  for (let r = 1; r < normalized.length; r++) {
    const val = normalized[r][byInfo.index];
    if (val == null) continue;
    const key = String(val);
    let acc = groups.get(key);
    if (!acc) {
      if (groups.size >= MAX_GROUPS) {
        throw { type: "INVALID_GROUPBY", message: `groupBy produced more than ${MAX_GROUPS} distinct '${by}' values` };
      }
      acc = { raw: val, count: 0, cols: aggEntries.map(() => ({ sum: 0, n: 0, min: Infinity, max: -Infinity, values: null })) };
      groups.set(key, acc);
    }
    acc.count++;
    for (let i = 0; i < aggEntries.length; i++) {
      const v = normalized[r][aggEntries[i].index];
      if (typeof v !== "number") continue;
      const c = acc.cols[i];
      c.sum += v;
      c.n++;
      if (v < c.min) c.min = v;
      if (v > c.max) c.max = v;
      if (aggEntries[i].fn === "MEDIAN") (c.values ??= []).push(v);
    }
  }

  const results = [];
  for (const acc of groups.values()) {
    const row = { group: acc.raw };
    for (let i = 0; i < aggEntries.length; i++) {
      const { key, fn } = aggEntries[i];
      const c = acc.cols[i];
      switch (fn) {
        case "SUM": row[key] = c.sum; break;
        case "AVERAGE": row[key] = c.n === 0 ? { error: "#DIV/0!" } : c.sum / c.n; break;
        case "COUNT": row[key] = acc.count; break;
        case "MIN": row[key] = c.n === 0 ? 0 : c.min; break;
        case "MAX": row[key] = c.n === 0 ? 0 : c.max; break;
        case "MEDIAN": {
          if (c.n === 0) { row[key] = null; break; }
          const vals = c.values.sort((a, b) => a - b);
          const mid = Math.floor(vals.length / 2);
          row[key] = vals.length % 2 === 0 ? (vals[mid - 1] + vals[mid]) / 2 : vals[mid];
          break;
        }
      }
    }
    results.push(row);
  }
  return results;
}

function extractGrid(hf, sheetId, rows, cols) {
  const grid = [];
  for (let r = 0; r < rows; r++) {
    const row = [];
    for (let c = 0; c < cols; c++) {
      const v = hf.getCellValue({ sheet: sheetId, row: r, col: c });
      row.push(unwrapValue(v));
    }
    grid.push(row);
  }
  return grid;
}


function unwrapValue(v) {
  if (v !== null && typeof v === "object" && v.type !== undefined) {
    // HyperFormula error object
    return { error: String(v.value ?? v) };
  }
  return v;
}

// --- API schema (returned on GET) ---

const API_SCHEMA = {
  name: "HyperFormula Edge Calc Service",
  version: "0.6.0",
  description: "Stateless spreadsheet calculation API. Send data (JSON or CSV) and formulas, get computed results. Supports 400+ Excel-compatible functions, named columns, and declarative groupBy aggregation.",
  endpoint: "/api/calc",
  method: "POST",
  contentType: "application/json",
  rateLimit: { requests: RATE_LIMIT, windowSeconds: RATE_WINDOW_MS / 1000 },
  limits: { maxRows: MAX_ROWS, maxCols: MAX_COLS, maxBodyBytes: MAX_BODY_BYTES, maxFormulaLength: MAX_FORMULA_LENGTH, maxFormulas: MAX_FORMULAS, maxCellChars: MAX_CELL_CHARS, maxGroups: MAX_GROUPS },
  parameters: {
    data: {
      type: "array of arrays",
      required: "one of data or csv is required",
      description: "2D array of cell values. Strings starting with '=' are evaluated as formulas. Row 0 is row 1 in formulas (A1, B1, ...). Mutually exclusive with 'csv'.",
    },
    csv: {
      type: "string",
      required: "one of data or csv is required",
      description: "Raw CSV string. Parsed server-side into a 2D grid. Numeric values auto-detected. Supports quoted fields. Mutually exclusive with 'data'. Easiest way for AI agents to send data.",
      example: "Region,Revenue,Cost\nEurope,1000,800\nAsia,2000,1500",
    },
    headers: {
      type: "boolean",
      required: false,
      description: "When true, row 1 is treated as column names. Formulas can reference columns by name (e.g. =SUM(Revenue)). Column names with spaces are sanitized (spaces→underscores). Response meta.columns shows the mapping. Required for groupBy.",
    },
    formulas: {
      type: "array of strings",
      required: false,
      description: "Array of formulas (each starting with '='). All evaluated in one pass. Returns array of results in same order. Mutually exclusive with 'groupBy'. With headers:true, use column names directly.",
      example: ["=SUM(Revenue)", "=AVERAGE(Cost)", "=COUNTIF(Region,\"Europe\")"],
    },
    groupBy: {
      type: "object",
      required: false,
      description: "Declarative aggregation. Groups data by a column and computes aggregates per group. Requires headers:true. Mutually exclusive with formulas. Returns array of {group, ...aggregates} objects. Rows with a blank value in the 'by' column are skipped. Group values match exactly (case-sensitive). Up to 10,000 distinct groups.",
      properties: {
        by: { type: "string", description: "Column name to group by" },
        aggregates: { type: "object", description: "Map of column name → aggregate function. Supported: SUM, AVERAGE, COUNT, MIN, MAX, MEDIAN" },
      },
      example: { by: "Region", aggregates: { Revenue: "SUM", Units: "SUM" } },
    },
  },
  modes: {
    formulas: { description: "Evaluate formulas, get array of results", params: "data/csv + formulas" },
    grid: { description: "Embedded formulas in data cells, returns full evaluated grid", params: "data/csv (with '=' formulas in cells)" },
    groupBy: { description: "Declarative aggregation by groups", params: "csv/data + headers:true + groupBy" },
  },
  examples: {
    formulas: { data: [[10, 20], [30, 40]], formulas: ["=SUM(A1:A2)", "=SUM(B1:B2)", "=AVERAGE(A1:B2)"] },
    csv_with_named_columns: { csv: "name,score\nAlice,85\nBob,92\nCarol,78", headers: true, formulas: ["=SUM(score)", "=AVERAGE(score)"] },
    groupBy: { csv: "Region,Revenue,Units\nEurope,1000,5\nAsia,2000,3\nEurope,1500,8", headers: true, groupBy: { by: "Region", aggregates: { Revenue: "SUM", Units: "SUM" } } },
    embedded: { data: [["a", "b", "sum"], [1, 2, "=A2+B2"], [3, 4, "=A3+B3"]] },
  },
  commonFormulas: [
    "SUM", "AVERAGE", "COUNT", "COUNTA", "COUNTIF", "COUNTIFS",
    "SUMIF", "SUMIFS", "MIN", "MAX", "MEDIAN",
    "IF", "IFS", "IFERROR", "AND", "OR", "NOT",
    "VLOOKUP", "HLOOKUP", "XLOOKUP", "INDEX", "MATCH",
    "UNIQUE", "SORT", "FILTER",
    "LEFT", "RIGHT", "MID", "LEN", "TRIM", "CONCATENATE", "SUBSTITUTE",
    "ROUND", "ROUNDUP", "ROUNDDOWN", "ABS", "MOD", "POWER",
    "DATE", "YEAR", "MONTH", "DAY", "TODAY", "NOW",
    "TEXT", "VALUE", "LARGE", "SMALL", "RANK",
  ],
  columnReference: "Columns are letters: A=0, B=1, C=2, ... Z=25, AA=26. Rows are 1-indexed. With headers:true, use column names directly in formulas instead of cell references.",
  links: {
    openapi: "/openapi.json",
    mcp: "/mcp",
    formulaDocs: "https://hyperformula.handsontable.com/guide/built-in-functions.html",
  },
};

// --- Shared request-body processing (used by the HTTP API and the MCP endpoint) ---

function processCalcBody(body) {
  const { data: rawData, csv, formulas, headers, groupBy } = body;

  function invalid(status, type, message) {
    return { ok: false, status, type, message };
  }

  // Resolve data from 'data' or 'csv'
  if (rawData !== undefined && csv !== undefined) {
    return invalid(400, "INVALID_PARAMS", "Provide either 'data' or 'csv', not both");
  }

  let data;
  if (csv !== undefined) {
    if (typeof csv !== "string" || csv.trim() === "") {
      return invalid(400, "INVALID_CSV", "csv must be a non-empty string");
    }
    try {
      data = parseCSV(csv);
    } catch (e) {
      return invalid(400, e.type || "INVALID_CSV", e.message || "Could not parse csv");
    }
    if (data.length === 0) return invalid(400, "INVALID_CSV", "csv produced no rows");
  } else {
    data = rawData;
  }

  // Validate data
  const dataErr = validateData(data);
  if (dataErr) return invalid(400, "INVALID_DATA", dataErr);

  // Validate mutual exclusivity
  if (formulas !== undefined && groupBy !== undefined) {
    return invalid(400, "INVALID_PARAMS", "Provide either 'formulas' or 'groupBy', not both");
  }

  // Validate groupBy
  if (groupBy !== undefined) {
    if (!headers) return invalid(400, "INVALID_GROUPBY", "groupBy requires headers: true");
    if (!groupBy.by || typeof groupBy.by !== "string") return invalid(400, "INVALID_GROUPBY", "groupBy.by must be a column name string");
    if (!groupBy.aggregates || typeof groupBy.aggregates !== "object" || Object.keys(groupBy.aggregates).length === 0) {
      return invalid(400, "INVALID_GROUPBY", "groupBy.aggregates must be a non-empty object mapping column names to aggregate functions");
    }
  }

  // Validate formulas array if provided
  if (formulas !== undefined) {
    if (!Array.isArray(formulas) || formulas.length === 0) {
      return invalid(400, "INVALID_FORMULAS", "formulas must be a non-empty array");
    }
    if (formulas.length > MAX_FORMULAS) {
      return invalid(400, "INVALID_FORMULAS", `formulas exceeds maximum of ${MAX_FORMULAS}`);
    }
    for (let i = 0; i < formulas.length; i++) {
      if (typeof formulas[i] !== "string" || !formulas[i].startsWith("=")) {
        return invalid(400, "INVALID_FORMULAS", `formulas[${i}] must be a string starting with '='`);
      }
      if (formulas[i].length > MAX_FORMULA_LENGTH) {
        return invalid(400, "INVALID_FORMULAS", `formulas[${i}] exceeds maximum of ${MAX_FORMULA_LENGTH} characters`);
      }
    }
  }

  try {
    return { ok: true, result: evaluate({ data, formulas, headers, groupBy }) };
  } catch (err) {
    const safeType = err.type || "EVALUATION_ERROR";
    const safeMessage = err.type ? (err.message || "Evaluation failed") : "Evaluation failed";
    return invalid(422, safeType, safeMessage);
  }
}

// --- API handler (POST/GET /api/calc) ---

async function handleCalc(request, env, ctx) {
  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };

  // CORS preflight
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  // GET — return API schema for discoverability
  if (request.method === "GET") {
    return new Response(JSON.stringify(API_SCHEMA, null, 2), {
      status: 200,
      headers: { "Content-Type": "application/json", ...corsHeaders },
    });
  }

  if (request.method !== "POST") {
    return new Response(
      JSON.stringify({ success: false, error: { type: "METHOD_NOT_ALLOWED", message: "Use GET for API docs or POST to evaluate" } }),
      { status: 405, headers: { "Content-Type": "application/json", ...corsHeaders } }
    );
  }

  // Rate limiting
  const clientIp = (request.headers.get("cf-connecting-ip") || request.headers.get("x-forwarded-for") || "unknown").split(",")[0].trim();
  const rl = rateLimit(clientIp);
  if (!rl.allowed) {
    return new Response(
      JSON.stringify({ success: false, error: { type: "RATE_LIMITED", message: `Rate limit exceeded. Max ${RATE_LIMIT} requests per minute.` } }),
      {
        status: 429,
        headers: {
          "Content-Type": "application/json",
          "Retry-After": String(Math.ceil(RATE_WINDOW_MS / 1000)),
          ...rateLimitHeaders(rl),
          ...corsHeaders,
        },
      }
    );
  }

  const h = {
    "Content-Type": "application/json",
    ...rateLimitHeaders(rl),
    ...corsHeaders,
  };

  function fail(status, type, message) {
    return new Response(JSON.stringify({ success: false, error: { type, message } }), { status, headers: h });
  }

  // Body size check — reject up front on Content-Length, before reading the
  // body into memory (a Worker has no platform body cap, so an oversized
  // payload would otherwise exhaust the isolate before the 413).
  const contentLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
    return fail(413, "PAYLOAD_TOO_LARGE", `Body exceeds ${MAX_BODY_BYTES} bytes`);
  }

  const rawBody = await request.text();

  // Fallback for requests without a Content-Length (e.g. chunked transfer).
  if (rawBody && rawBody.length > MAX_BODY_BYTES) {
    return fail(413, "PAYLOAD_TOO_LARGE", `Body exceeds ${MAX_BODY_BYTES} bytes`);
  }

  let body;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return fail(400, "INVALID_JSON", "Could not parse request body as JSON");
  }

  const telemetry = { transport: "http", userAgent: request.headers.get("user-agent") };
  const outcome = processCalcBody(body);
  if (!outcome.ok) {
    if (outcome.status === 422) trackError(env, ctx, clientIp, outcome.type, telemetry);
    return fail(outcome.status, outcome.type, outcome.message);
  }
  trackEval(env, ctx, clientIp, body, outcome.result, telemetry);
  return new Response(JSON.stringify(outcome.result), { status: 200, headers: h });
}

// --- Remote MCP endpoint (Streamable HTTP, stateless) ---
//
// A minimal MCP server implemented directly on the Worker: POST /mcp accepts
// JSON-RPC messages and always answers with application/json (no SSE stream,
// no sessions — every tool call is a single stateless request, which is
// exactly what this service is). Clients connect with just the URL.

const MCP_PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const MCP_SERVER_INFO = { name: "hyperformula-calc", version: "0.6.0" };

const MCP_DATA_PARAMS = {
  csv: { type: "string", description: "Raw CSV string. Numeric values auto-detected. Use this OR data, not both." },
  data: { type: "array", items: { type: "array" }, description: "2D JSON array. Use this OR csv, not both." },
};

const MCP_TOOLS = [
  {
    name: "calc_formulas",
    description:
      "Evaluate spreadsheet formulas against a dataset. Send data as a CSV string or JSON 2D array. With headers:true, formulas can reference column names (e.g. =SUM(Revenue)). Supports 400+ Excel-compatible functions: SUM, AVERAGE, COUNTIF, VLOOKUP, XLOOKUP, IF, SUMPRODUCT, etc. Up to 50,000 rows.",
    inputSchema: {
      type: "object",
      properties: {
        ...MCP_DATA_PARAMS,
        headers: { type: "boolean", description: "When true, row 1 = column names usable in formulas (e.g. =SUM(Revenue))." },
        formulas: { type: "array", items: { type: "string" }, description: "Array of formulas to evaluate (each starting with '='). Returns results in same order." },
      },
      required: ["formulas"],
    },
  },
  {
    name: "calc_groupby",
    description:
      "Aggregate data by groups. Groups rows by a column and computes SUM, AVERAGE, COUNT, MIN, MAX, or MEDIAN per group. Data must include a header row. Returns one row per group.",
    inputSchema: {
      type: "object",
      properties: {
        ...MCP_DATA_PARAMS,
        by: { type: "string", description: "Column name to group by." },
        aggregates: {
          type: "object",
          additionalProperties: { type: "string", enum: ["SUM", "AVERAGE", "COUNT", "MIN", "MAX", "MEDIAN"] },
          description: "Map of column name to aggregate function.",
        },
      },
      required: ["by", "aggregates"],
    },
  },
  {
    name: "calc_grid",
    description:
      "Evaluate a grid with embedded formulas. Formulas in cells (strings starting with '=') are computed and the full grid is returned with values resolved. Useful for building spreadsheet-like calculations.",
    inputSchema: {
      type: "object",
      properties: MCP_DATA_PARAMS,
    },
  },
];

function displayValue(v) {
  if (v === null || v === undefined) return "";
  if (typeof v === "object" && v.error) return `ERROR: ${v.error}`;
  return String(v);
}

function mcpToolBody(name, args) {
  const source = {};
  if (args.csv !== undefined) source.csv = args.csv;
  if (args.data !== undefined) source.data = args.data;

  if (name === "calc_formulas") {
    return { ...source, headers: !!args.headers || undefined, formulas: args.formulas };
  }
  if (name === "calc_groupby") {
    return { ...source, headers: true, groupBy: { by: args.by, aggregates: args.aggregates } };
  }
  return source; // calc_grid
}

function formatMcpResult(name, args, json) {
  if (name === "calc_formulas") {
    const lines = [`Results (${json.meta.rows} rows):`];
    for (let i = 0; i < args.formulas.length; i++) {
      lines.push(`  ${args.formulas[i]} = ${displayValue(json.result[i])}`);
    }
    return lines.join("\n");
  }
  if (name === "calc_groupby") {
    const aggCols = Object.keys(args.aggregates);
    const lines = [`GroupBy '${args.by}' (${json.meta.groups} groups):`, ""];
    lines.push(["group", ...aggCols].join("\t"));
    for (const r of json.result) {
      lines.push([displayValue(r.group), ...aggCols.map((c) => displayValue(r[c]))].join("\t"));
    }
    return lines.join("\n");
  }
  const lines = [`Evaluated grid (${json.meta.rows}x${json.meta.cols}):`, ""];
  for (const row of json.result) {
    lines.push(row.map(displayValue).join("\t"));
  }
  return lines.join("\n");
}

function handleMcpMessage(msg, env, ctx, clientIp, userAgent) {
  // Notifications (no id) get no response
  if (msg.id === undefined || msg.id === null) return null;

  const rpcError = (code, message) => ({ jsonrpc: "2.0", id: msg.id, error: { code, message } });
  const rpcResult = (result) => ({ jsonrpc: "2.0", id: msg.id, result });

  switch (msg.method) {
    case "initialize": {
      const requested = msg.params?.protocolVersion;
      const protocolVersion = MCP_PROTOCOL_VERSIONS.includes(requested) ? requested : MCP_PROTOCOL_VERSIONS[0];
      trackMcpInitialize(env, ctx, clientIp, msg.params?.clientInfo, userAgent);
      return rpcResult({ protocolVersion, capabilities: { tools: {} }, serverInfo: MCP_SERVER_INFO });
    }
    case "ping":
      return rpcResult({});
    case "tools/list":
      return rpcResult({ tools: MCP_TOOLS });
    case "tools/call": {
      const name = msg.params?.name;
      const args = msg.params?.arguments ?? {};
      if (!MCP_TOOLS.some((t) => t.name === name)) {
        return rpcError(-32602, `Unknown tool: ${name}`);
      }
      const toolError = (text) => rpcResult({ content: [{ type: "text", text }], isError: true });
      if (args.csv === undefined && args.data === undefined) {
        return toolError("Error: provide 'csv' or 'data'");
      }
      if (name === "calc_formulas" && !Array.isArray(args.formulas)) {
        return toolError("Error: 'formulas' must be an array of formula strings");
      }
      try {
        const body = mcpToolBody(name, args);
        const outcome = processCalcBody(body);
        const telemetry = { transport: "mcp", userAgent };
        if (!outcome.ok) {
          if (outcome.status === 422) trackError(env, ctx, clientIp, outcome.type, telemetry);
          return toolError(`Error (${outcome.type}): ${outcome.message}`);
        }
        trackEval(env, ctx, clientIp, body, outcome.result, telemetry);
        return rpcResult({ content: [{ type: "text", text: formatMcpResult(name, args, outcome.result) }] });
      } catch {
        return toolError("Error: tool execution failed");
      }
    }
    default:
      return rpcError(-32601, `Method not found: ${msg.method}`);
  }
}

async function handleMcp(request, env, ctx) {
  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Accept, Authorization, Mcp-Session-Id, MCP-Protocol-Version",
  };

  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  if (request.method !== "POST") {
    // Stateless server: no SSE stream to GET, no session to DELETE
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32000, message: "Method not allowed. POST JSON-RPC messages to this endpoint." } }), {
      status: 405,
      headers: { "Content-Type": "application/json", Allow: "POST, OPTIONS", ...corsHeaders },
    });
  }

  const clientIp = (request.headers.get("cf-connecting-ip") || request.headers.get("x-forwarded-for") || "unknown").split(",")[0].trim();
  const rl = rateLimit(clientIp);
  const h = { "Content-Type": "application/json", ...rateLimitHeaders(rl), ...corsHeaders };
  if (!rl.allowed) {
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32000, message: `Rate limit exceeded. Max ${RATE_LIMIT} requests per minute.` } }), {
      status: 429,
      headers: { "Retry-After": String(Math.ceil(RATE_WINDOW_MS / 1000)), ...h },
    });
  }

  const contentLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32000, message: `Body exceeds ${MAX_BODY_BYTES} bytes` } }), { status: 413, headers: h });
  }

  const rawBody = await request.text();
  if (rawBody.length > MAX_BODY_BYTES) {
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32000, message: `Body exceeds ${MAX_BODY_BYTES} bytes` } }), { status: 413, headers: h });
  }

  let parsed;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }), { status: 400, headers: h });
  }

  // Batches were removed in protocol 2025-06-18 but older clients may send them
  const messages = Array.isArray(parsed) ? parsed : [parsed];
  const userAgent = request.headers.get("user-agent");
  const responses = messages.map((m) => handleMcpMessage(m, env, ctx, clientIp, userAgent)).filter((r) => r !== null);

  if (responses.length === 0) {
    return new Response(null, { status: 202, headers: h });
  }
  const payload = Array.isArray(parsed) ? responses : responses[0];
  return new Response(JSON.stringify(payload), { status: 200, headers: h });
}

// --- Worker entry ---

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/api/calc") {
      return handleCalc(request, env, ctx);
    }

    if (url.pathname === "/mcp") {
      return handleMcp(request, env, ctx);
    }

    // Everything else is a static asset from ./public.
    return env.ASSETS.fetch(request);
  },
};
