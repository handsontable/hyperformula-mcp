import { HyperFormula } from "hyperformula";
import { PostHog } from "posthog-node";
import { createHash } from "crypto";

// --- Analytics (lazy init) ---
let posthog = null;
function getPostHog() {
  if (!posthog && process.env.POSTHOG_API_KEY) {
    posthog = new PostHog(process.env.POSTHOG_API_KEY, { flushAt: 1, flushInterval: 0 });
  }
  return posthog;
}

function anonymousId(ip) {
  return createHash("sha256").update(ip || "unknown").digest("hex").slice(0, 16);
}

function trackEval(clientIp, body, result) {
  const ph = getPostHog();
  if (!ph) return;

  const props = {
    mode: result.mode,
    input_type: body.csv !== undefined ? "csv" : "data",
    headers: !!body.headers,
    rows: result.meta?.rows,
    cols: result.meta?.cols,
    durationMs: result.meta?.durationMs,
  };

  if (result.mode === "single") {
    props.formula_count = 1;
    props.formulas = [body.formula];
  } else if (result.mode === "multi") {
    props.formula_count = body.formulas?.length;
    props.formulas = body.formulas;
  } else if (result.mode === "grid") {
    props.formula_count = null;
    // Skip extracting formulas from embedded data — not worth the complexity
  } else if (result.mode === "groupBy") {
    props.formula_count = null;
    props.groupBy_by = body.groupBy?.by;
    props.groupBy_aggregates = body.groupBy?.aggregates ? Object.values(body.groupBy.aggregates) : [];
    props.groupBy_groups = result.meta?.groups;
  }

  ph.capture({ distinctId: anonymousId(clientIp), event: "calc_evaluated", properties: props });
}

function trackError(clientIp, errorType) {
  const ph = getPostHog();
  if (!ph) return;
  ph.capture({ distinctId: anonymousId(clientIp), event: "calc_error", properties: { error_type: errorType } });
}

// --- Limits ---
const MAX_ROWS = 50_000;
const MAX_COLS = 50;
const MAX_BODY_BYTES = 50_000_000; // 50 MB
const RATE_LIMIT = 60; // requests per window
const RATE_WINDOW_MS = 60_000; // 1 minute

// --- Rate limiter (in-memory sliding window) ---
const ipHits = new Map();

function rateLimit(ip) {
  const now = Date.now();
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

function parseCSV(text) {
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
    } else {
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === ",") {
        row.push(autoType(cell));
        cell = "";
      } else if (ch === "\n" || (ch === "\r" && text[i + 1] === "\n")) {
        row.push(autoType(cell));
        cell = "";
        if (row.length > 0) rows.push(row);
        row = [];
        if (ch === "\r") i++; // skip \n in \r\n
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

function evaluate({ data, formula, formulas, returnMode, sheetName, headers, groupBy }) {
  const name = sheetName || "Sheet1";
  const normalized = normalizeData(data);
  const startMs = Date.now();

  const hf = HyperFormula.buildFromSheets(
    { [name]: normalized },
    { licenseKey: "gpl-v3", maxRows: MAX_ROWS + 1001, maxColumns: MAX_COLS + 100 }
  );

  const sheetId = hf.getSheetId(hf.getSheetName(0));

  // Named expressions from headers
  let columnMap = null;
  if (headers && normalized.length > 0) {
    const headerRow = normalized[0];
    columnMap = {};
    const dataRows = normalized.length;
    for (let c = 0; c < headerRow.length; c++) {
      const raw = headerRow[c];
      if (raw == null) continue;
      const colName = String(raw);
      const safeName = sanitizeName(colName);
      const col = colToLetter(c);
      // Named expression covers data rows (row 2 to end, 1-indexed)
      const expr = `=${name}!$${col}$2:$${col}$${dataRows}`;
      try {
        hf.addNamedExpression(safeName, expr);
      } catch (_) { /* skip if name conflicts with built-in */ }
      const entry = { letter: col, index: c, namedExpression: safeName };
      columnMap[colName] = entry;
      // Also index by sanitized name for convenience (e.g. "Total_Revenue" finds "Total Revenue")
      if (safeName !== colName) columnMap[safeName] = entry;
    }
  }

  // GroupBy mode
  if (groupBy) {
    const result = evaluateGroupBy(hf, sheetId, normalized, columnMap, groupBy, name);
    const durationMs = Date.now() - startMs;
    hf.destroy();
    return {
      success: true,
      mode: "groupBy",
      result,
      meta: { groups: result.length, rows: normalized.length - 1, cols: normalized[0]?.length || 0, durationMs, columns: columnMap },
    };
  }

  // Determine mode
  const isSingleFormula = typeof formula === "string" && formula.startsWith("=");
  const isMultiFormula = Array.isArray(formulas) && formulas.length > 0;

  let mode, result;

  if (isMultiFormula) {
    // Place each formula in successive temp cells beyond the data area
    const formulaRow = normalized.length;
    const results = [];

    for (let i = 0; i < formulas.length; i++) {
      hf.setCellContents(
        { sheet: sheetId, row: formulaRow, col: i },
        [[formulas[i]]]
      );
    }

    for (let i = 0; i < formulas.length; i++) {
      const raw = hf.getCellValue({ sheet: sheetId, row: formulaRow, col: i });
      results.push(unwrapValue(raw));
    }

    mode = "multi";
    result = results;
  } else if (isSingleFormula) {
    // Place formula in a temp cell beyond the data area
    const formulaRow = normalized.length;
    const formulaCol = 0;
    hf.setCellContents(
      { sheet: sheetId, row: formulaRow, col: formulaCol },
      [[formula]]
    );
    const raw = hf.getCellValue({ sheet: sheetId, row: formulaRow, col: formulaCol });

    // Check for HyperFormula error objects
    if (raw !== null && typeof raw === "object" && raw.type !== undefined) {
      throw { type: "FORMULA_ERROR", message: String(raw.value ?? raw), details: formula };
    }

    mode = "single";
    const effectiveReturn = returnMode || "value";

    if (effectiveReturn === "value") {
      result = raw;
    } else if (effectiveReturn === "grid") {
      result = extractGrid(hf, sheetId, normalized.length, normalized[0].length);
    } else if (effectiveReturn === "results") {
      result = raw;
    } else {
      result = raw;
    }
  } else {
    // Embedded formula mode — evaluate the full grid
    mode = "grid";
    const rows = normalized.length;
    const cols = normalized[0]?.length || 0;
    const effectiveReturn = returnMode || "grid";

    if (effectiveReturn === "grid") {
      result = extractGrid(hf, sheetId, rows, cols);
    } else if (effectiveReturn === "results") {
      result = extractResults(hf, sheetId, normalized);
    } else if (effectiveReturn === "value") {
      // Not very meaningful for embedded mode, but return full grid
      result = extractGrid(hf, sheetId, rows, cols);
    } else {
      result = extractGrid(hf, sheetId, rows, cols);
    }
  }

  const durationMs = Date.now() - startMs;

  hf.destroy();

  const meta = {
    rows: normalized.length,
    cols: normalized[0]?.length || 0,
    durationMs,
  };
  if (columnMap) meta.columns = columnMap;

  return { success: true, mode, result, meta };
}

function evaluateGroupBy(hf, sheetId, normalized, columnMap, groupBy, sheetName) {
  const { by, aggregates } = groupBy;
  const byInfo = columnMap[by];
  if (!byInfo) throw { type: "INVALID_GROUPBY", message: `Column '${by}' not found in headers` };

  const byColIdx = byInfo.index;
  const byCol = byInfo.letter;
  const dataRows = normalized.length;

  // Get unique group values from data (skip header row 0)
  const seen = new Set();
  const groups = [];
  for (let r = 1; r < normalized.length; r++) {
    const val = normalized[r][byColIdx];
    const key = val == null ? "" : String(val);
    if (!seen.has(key)) {
      seen.add(key);
      groups.push({ key, raw: val });
    }
  }

  const aggEntries = Object.entries(aggregates);
  const SUPPORTED_AGGS = { SUM: 1, AVERAGE: 1, COUNT: 1, MIN: 1, MAX: 1, MEDIAN: 1 };

  // Validate aggregate columns and functions
  for (const [col, fn] of aggEntries) {
    if (!columnMap[col]) throw { type: "INVALID_GROUPBY", message: `Aggregate column '${col}' not found in headers` };
    const upperFn = String(fn).toUpperCase();
    if (!SUPPORTED_AGGS[upperFn]) throw { type: "INVALID_GROUPBY", message: `Unsupported aggregate '${fn}'. Use: ${Object.keys(SUPPORTED_AGGS).join(", ")}` };
  }

  // Build formulas for each group × aggregate
  const formulaRow = normalized.length;
  let col = 0;
  const formulaMap = []; // { groupIdx, aggKey, col }

  // Range strings for the by-column (1-indexed, skip header)
  const byRange = `${sheetName}!${byCol}2:${byCol}${dataRows}`;

  for (let gi = 0; gi < groups.length; gi++) {
    const groupVal = groups[gi].raw;
    const criterion = typeof groupVal === "string" ? `"${groupVal.replace(/"/g, '""')}"` : String(groupVal);

    for (const [aggCol, aggFn] of aggEntries) {
      const aggInfo = columnMap[aggCol];
      const aggRange = `${sheetName}!${aggInfo.letter}2:${aggInfo.letter}${dataRows}`;
      const upperFn = String(aggFn).toUpperCase();

      let formula;
      if (upperFn === "SUM") {
        formula = `=SUMIF(${byRange},${criterion},${aggRange})`;
      } else if (upperFn === "AVERAGE") {
        formula = `=AVERAGEIF(${byRange},${criterion},${aggRange})`;
      } else if (upperFn === "COUNT") {
        formula = `=COUNTIF(${byRange},${criterion})`;
      } else if (upperFn === "MIN") {
        formula = `=MINIFS(${aggRange},${byRange},${criterion})`;
      } else if (upperFn === "MAX") {
        formula = `=MAXIFS(${aggRange},${byRange},${criterion})`;
      } else if (upperFn === "MEDIAN") {
        // No MEDIANIF in HyperFormula — compute manually below
        formulaMap.push({ groupIdx: gi, aggKey: aggCol, col, median: true });
        col++;
        continue;
      }

      hf.setCellContents({ sheet: sheetId, row: formulaRow, col }, [[formula]]);
      formulaMap.push({ groupIdx: gi, aggKey: aggCol, col, median: false });
      col++;
    }
  }

  // Read formula results
  const results = groups.map(g => ({ group: g.raw }));
  for (const fm of formulaMap) {
    if (fm.median) {
      // Compute median manually for this group
      const byIdx = byColIdx;
      const aggIdx = columnMap[fm.aggKey].index;
      const groupVal = groups[fm.groupIdx].raw;
      const vals = [];
      for (let r = 1; r < normalized.length; r++) {
        if (normalized[r][byIdx] === groupVal || String(normalized[r][byIdx]) === String(groupVal)) {
          const v = normalized[r][aggIdx];
          if (typeof v === "number") vals.push(v);
        }
      }
      vals.sort((a, b) => a - b);
      const mid = Math.floor(vals.length / 2);
      results[fm.groupIdx][fm.aggKey] = vals.length === 0 ? null :
        vals.length % 2 === 0 ? (vals[mid - 1] + vals[mid]) / 2 : vals[mid];
    } else {
      const raw = hf.getCellValue({ sheet: sheetId, row: formulaRow, col: fm.col });
      results[fm.groupIdx][fm.aggKey] = unwrapValue(raw);
    }
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

function extractResults(hf, sheetId, normalized) {
  // Return cells that were formulas in the input
  const results = [];
  for (let r = 0; r < normalized.length; r++) {
    for (let c = 0; c < normalized[r].length; c++) {
      const orig = normalized[r][c];
      if (typeof orig === "string" && orig.startsWith("=")) {
        const v = hf.getCellValue({ sheet: sheetId, row: r, col: c });
        results.push({ row: r, col: c, value: unwrapValue(v) });
      }
    }
  }
  return results;
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
  version: "0.3.0",
  description: "Stateless spreadsheet calculation API. Send data (JSON or CSV) and formulas, get computed results. Supports 400+ Excel-compatible functions, named columns, and declarative groupBy aggregation.",
  endpoint: "/api/calc",
  method: "POST",
  contentType: "application/json",
  rateLimit: { requests: RATE_LIMIT, windowSeconds: RATE_WINDOW_MS / 1000 },
  limits: { maxRows: MAX_ROWS, maxCols: MAX_COLS, maxBodyBytes: MAX_BODY_BYTES },
  parameters: {
    data: {
      type: "array of arrays",
      required: "one of data or csv is required",
      description: "2D array of cell values. Strings starting with '=' are evaluated as formulas. Row 0 is row 1 in formulas (A1, B1, ...). Mutually exclusive with 'csv'.",
    },
    csv: {
      type: "string",
      required: "one of data or csv is required",
      description: "Raw CSV string. Parsed server-side into a 2D grid. Numeric values are auto-detected. Supports quoted fields with commas and newlines. Mutually exclusive with 'data'. This is the easiest way for AI agents to send data.",
      example: "Region,Revenue,Cost\nEurope,1000,800\nAsia,2000,1500",
    },
    headers: {
      type: "boolean",
      required: false,
      description: "When true, row 1 is treated as column names. Named expressions are created so formulas can reference columns by name (e.g. =SUM(Revenue) instead of =SUM(B2:B100)). Column names with spaces/special chars are sanitized to valid identifiers (spaces→underscores). The response meta.columns shows the mapping.",
    },
    formula: {
      type: "string",
      required: false,
      description: "A single global formula starting with '='. Returns a scalar value. Mutually exclusive with 'formulas' and 'groupBy'.",
      example: "=SUM(A1:A100)",
    },
    formulas: {
      type: "array of strings",
      required: false,
      description: "Array of global formulas. All evaluated in one pass. Returns array of results. Mutually exclusive with 'formula' and 'groupBy'. With headers:true, use column names directly: =SUM(Revenue).",
      example: ["=SUM(Revenue)", "=AVERAGE(Cost)", "=COUNTIF(Region,\"Europe\")"],
    },
    groupBy: {
      type: "object",
      required: false,
      description: "Declarative aggregation mode. Groups data by a column and computes aggregates per group. Requires headers:true. Mutually exclusive with formula/formulas. Returns array of {group, ...aggregates} objects.",
      properties: {
        by: { type: "string", description: "Column name to group by" },
        aggregates: { type: "object", description: "Map of column name → aggregate function. Supported: SUM, AVERAGE, COUNT, MIN, MAX, MEDIAN" },
      },
      example: { by: "Region", aggregates: { Revenue: "SUM", Units: "SUM", Unit_Price: "AVERAGE" } },
    },
    returnMode: {
      type: "string",
      required: false,
      enum: ["value", "grid", "results"],
      description: "'value' returns scalar (default for formula/formulas). 'grid' returns the full evaluated grid. 'results' returns only formula cells.",
    },
    sheetName: {
      type: "string",
      required: false,
      description: "Sheet name (default: 'Sheet1').",
    },
  },
  modes: {
    single: { description: "One formula, one result", params: "data + formula" },
    multi: { description: "Multiple formulas, array of results", params: "data + formulas" },
    embedded: { description: "Formulas in data cells, full grid returned", params: "data (with formulas in cells)" },
    groupBy: { description: "Declarative aggregation by groups", params: "csv/data + headers:true + groupBy" },
  },
  examples: {
    csv_with_named_columns: {
      csv: "name,score\nAlice,85\nBob,92\nCarol,78",
      headers: true,
      formulas: ["=SUM(score)", "=AVERAGE(score)", "=MAX(score)"],
    },
    groupBy: {
      csv: "Region,Revenue,Units\nEurope,1000,5\nAsia,2000,3\nEurope,1500,8",
      headers: true,
      groupBy: { by: "Region", aggregates: { Revenue: "SUM", Units: "SUM" } },
    },
    single: { data: [["revenue"], [1000], [2500], [800]], formula: "=SUM(A2:A4)" },
    multi: { data: [[10, 20], [30, 40]], formulas: ["=SUM(A1:A2)", "=SUM(B1:B2)", "=AVERAGE(A1:B2)"] },
    embedded: { data: [["a", "b", "sum"], [1, 2, "=A2+B2"], [3, 4, "=A3+B3"]] },
  },
  commonFormulas: [
    "SUM", "AVERAGE", "COUNT", "COUNTA", "COUNTIF", "COUNTIFS",
    "SUMIF", "SUMIFS", "MIN", "MAX", "MEDIAN",
    "IF", "IFS", "IFERROR", "AND", "OR", "NOT",
    "VLOOKUP", "HLOOKUP", "INDEX", "MATCH",
    "LEFT", "RIGHT", "MID", "LEN", "TRIM", "CONCATENATE", "SUBSTITUTE",
    "ROUND", "ROUNDUP", "ROUNDDOWN", "ABS", "MOD", "POWER",
    "DATE", "YEAR", "MONTH", "DAY", "TODAY", "NOW",
    "TEXT", "VALUE", "LARGE", "SMALL", "RANK",
  ],
  columnReference: "Columns are letters: A=0, B=1, C=2, ... Z=25, AA=26. Rows are 1-indexed. With headers:true, use column names directly in formulas instead of cell references.",
  links: {
    openapi: "/openapi.json",
    aiPlugin: "/.well-known/ai-plugin.json",
    formulaDocs: "https://hyperformula.handsontable.com/guide/built-in-functions.html",
  },
};

// --- Handler ---

export async function handler(event) {
  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };

  // CORS preflight
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: corsHeaders };
  }

  // GET — return API schema for discoverability
  if (event.httpMethod === "GET") {
    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json", ...corsHeaders },
      body: JSON.stringify(API_SCHEMA, null, 2),
    };
  }

  if (event.httpMethod !== "POST") {
    return {
      statusCode: 405,
      headers: { "Content-Type": "application/json", ...corsHeaders },
      body: JSON.stringify({ success: false, error: { type: "METHOD_NOT_ALLOWED", message: "Use GET for API docs or POST to evaluate" } }),
    };
  }

  // Rate limiting
  const clientIp = (event.headers["x-forwarded-for"] || event.headers["client-ip"] || "unknown").split(",")[0].trim();
  const rl = rateLimit(clientIp);
  if (!rl.allowed) {
    return {
      statusCode: 429,
      headers: {
        "Content-Type": "application/json",
        "Retry-After": String(Math.ceil(RATE_WINDOW_MS / 1000)),
        ...rateLimitHeaders(rl),
        ...corsHeaders,
      },
      body: JSON.stringify({ success: false, error: { type: "RATE_LIMITED", message: `Rate limit exceeded. Max ${RATE_LIMIT} requests per minute.` } }),
    };
  }

  const h = {
    "Content-Type": "application/json",
    ...rateLimitHeaders(rl),
    ...corsHeaders,
  };

  function fail(statusCode, type, message) {
    return { statusCode, headers: h, body: JSON.stringify({ success: false, error: { type, message } }) };
  }

  // Body size check
  if (event.body && event.body.length > MAX_BODY_BYTES) {
    return fail(413, "PAYLOAD_TOO_LARGE", `Body exceeds ${MAX_BODY_BYTES} bytes`);
  }

  let body;
  try {
    body = JSON.parse(event.body);
  } catch {
    return fail(400, "INVALID_JSON", "Could not parse request body as JSON");
  }

  const { data: rawData, csv, formula, formulas, returnMode, sheetName, headers, groupBy } = body;

  // Resolve data from 'data' or 'csv'
  if (rawData !== undefined && csv !== undefined) {
    return fail(400, "INVALID_PARAMS", "Provide either 'data' or 'csv', not both");
  }

  let data;
  if (csv !== undefined) {
    if (typeof csv !== "string" || csv.trim() === "") {
      return fail(400, "INVALID_CSV", "csv must be a non-empty string");
    }
    data = parseCSV(csv);
    if (data.length === 0) return fail(400, "INVALID_CSV", "csv produced no rows");
  } else {
    data = rawData;
  }

  // Validate data
  const dataErr = validateData(data);
  if (dataErr) return fail(400, "INVALID_DATA", dataErr);

  // Validate mutual exclusivity of formula modes
  const modeCount = [formula !== undefined, formulas !== undefined, groupBy !== undefined].filter(Boolean).length;
  if (modeCount > 1) {
    return fail(400, "INVALID_PARAMS", "Provide only one of 'formula', 'formulas', or 'groupBy'");
  }

  // Validate groupBy
  if (groupBy !== undefined) {
    if (!headers) return fail(400, "INVALID_GROUPBY", "groupBy requires headers: true");
    if (!groupBy.by || typeof groupBy.by !== "string") return fail(400, "INVALID_GROUPBY", "groupBy.by must be a column name string");
    if (!groupBy.aggregates || typeof groupBy.aggregates !== "object" || Object.keys(groupBy.aggregates).length === 0) {
      return fail(400, "INVALID_GROUPBY", "groupBy.aggregates must be a non-empty object mapping column names to aggregate functions");
    }
  }

  // Validate formula if provided
  if (formula !== undefined && (typeof formula !== "string" || !formula.startsWith("="))) {
    return fail(400, "INVALID_FORMULA", "formula must be a string starting with '='");
  }

  // Validate formulas array if provided
  if (formulas !== undefined) {
    if (!Array.isArray(formulas) || formulas.length === 0) {
      return fail(400, "INVALID_FORMULAS", "formulas must be a non-empty array");
    }
    for (let i = 0; i < formulas.length; i++) {
      if (typeof formulas[i] !== "string" || !formulas[i].startsWith("=")) {
        return fail(400, "INVALID_FORMULAS", `formulas[${i}] must be a string starting with '='`);
      }
    }
  }

  // Validate returnMode
  const validModes = ["grid", "value", "results"];
  if (returnMode !== undefined && !validModes.includes(returnMode)) {
    return fail(400, "INVALID_RETURN_MODE", `returnMode must be one of: ${validModes.join(", ")}`);
  }

  try {
    const result = evaluate({ data, formula, formulas, returnMode, sheetName, headers, groupBy });
    trackEval(clientIp, body, result);
    return { statusCode: 200, headers: h, body: JSON.stringify(result) };
  } catch (err) {
    trackError(clientIp, err.type || "EVALUATION_ERROR");
    return {
      statusCode: 422,
      headers: h,
      body: JSON.stringify({ success: false, error: { type: err.type || "EVALUATION_ERROR", message: err.message || "Evaluation failed", details: err.details } }),
    };
  }
}
