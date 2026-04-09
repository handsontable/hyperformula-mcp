import { HyperFormula } from "hyperformula";

// --- Limits ---
const MAX_ROWS = 1000;
const MAX_COLS = 50;
const MAX_BODY_BYTES = 1_000_000; // 1 MB

// --- Helpers ---

function jsonError(status, type, message, details) {
  return new Response(
    JSON.stringify({ success: false, error: { type, message, details } }),
    { status, headers: { "Content-Type": "application/json" } }
  );
}

function jsonOk(body) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function validateData(data) {
  if (!Array.isArray(data) || data.length === 0) {
    return "data must be a non-empty 2D array";
  }
  for (let i = 0; i < data.length; i++) {
    if (!Array.isArray(data[i])) {
      return `data[${i}] is not an array`;
    }
  }
  if (data.length > MAX_ROWS) {
    return `data exceeds maximum of ${MAX_ROWS} rows`;
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

// --- Core evaluation ---

function evaluate({ data, formula, returnMode, sheetName }) {
  const name = sheetName || "Sheet1";
  const normalized = normalizeData(data);
  const startMs = Date.now();

  const hf = HyperFormula.buildFromSheets(
    { [name]: normalized },
    { licenseKey: "gpl-v3" }
  );

  const sheetId = hf.getSheetId(hf.getSheetName(0));

  // Determine mode
  const isSingleFormula = typeof formula === "string" && formula.startsWith("=");

  let mode, result;

  if (isSingleFormula) {
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

  return {
    success: true,
    mode,
    result,
    meta: {
      rows: normalized.length,
      cols: normalized[0]?.length || 0,
      durationMs,
    },
  };
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

// --- Handler ---

export async function handler(event) {
  // CORS preflight
  if (event.httpMethod === "OPTIONS") {
    return {
      statusCode: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      },
    };
  }

  if (event.httpMethod !== "POST") {
    return {
      statusCode: 405,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ success: false, error: { type: "METHOD_NOT_ALLOWED", message: "Use POST" } }),
    };
  }

  // Body size check
  if (event.body && event.body.length > MAX_BODY_BYTES) {
    return {
      statusCode: 413,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ success: false, error: { type: "PAYLOAD_TOO_LARGE", message: `Body exceeds ${MAX_BODY_BYTES} bytes` } }),
    };
  }

  let body;
  try {
    body = JSON.parse(event.body);
  } catch {
    return {
      statusCode: 400,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ success: false, error: { type: "INVALID_JSON", message: "Could not parse request body as JSON" } }),
    };
  }

  const { data, formula, returnMode, sheetName } = body;

  // Validate data
  const dataErr = validateData(data);
  if (dataErr) {
    return {
      statusCode: 400,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ success: false, error: { type: "INVALID_DATA", message: dataErr } }),
    };
  }

  // Validate formula if provided
  if (formula !== undefined && (typeof formula !== "string" || !formula.startsWith("="))) {
    return {
      statusCode: 400,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ success: false, error: { type: "INVALID_FORMULA", message: "formula must be a string starting with '='" } }),
    };
  }

  // Validate returnMode
  const validModes = ["grid", "value", "results"];
  if (returnMode !== undefined && !validModes.includes(returnMode)) {
    return {
      statusCode: 400,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ success: false, error: { type: "INVALID_RETURN_MODE", message: `returnMode must be one of: ${validModes.join(", ")}` } }),
    };
  }

  try {
    const result = evaluate({ data, formula, returnMode, sheetName });
    return {
      statusCode: 200,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
      body: JSON.stringify(result),
    };
  } catch (err) {
    const type = err.type || "EVALUATION_ERROR";
    const message = err.message || "Evaluation failed";
    const details = err.details || undefined;
    return {
      statusCode: 422,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ success: false, error: { type, message, details } }),
    };
  }
}
