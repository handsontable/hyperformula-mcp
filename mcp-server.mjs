import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import * as fs from "fs";
import { readFileSync } from "fs";
import XLSX from "xlsx";
import * as cpexcel from "xlsx/dist/cpexcel.full.mjs";

// The SheetJS ESM build does not auto-load Node modules: fs must be wired in
// for readFile/writeFile, and the codepage table for legacy .xls files.
XLSX.set_fs(fs);
XLSX.set_cptable(cpexcel);

const API_URL = process.env.HYPERFORMULA_API_URL || "https://hyperformula-mcp.handsontable-sandbox.workers.dev/api/calc";

// --- xlsx helpers ---

function readFileAsData(filePath, sheetName) {
  const ext = filePath.split(".").pop().toLowerCase();
  if (ext === "csv") {
    return { csv: readFileSync(filePath, "utf8") };
  }
  const workbook = XLSX.readFile(filePath);
  const name = sheetName || workbook.SheetNames[0];
  const sheet = workbook.Sheets[name];
  const data = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: null });
  return { data };
}

function writeGridToXlsx(grid, filePath) {
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet(grid);
  XLSX.utils.book_append_sheet(wb, ws, "Results");
  XLSX.writeFile(wb, filePath);
}

// --- Tool definitions ---

const FILE_PARAMS = {
  file: { type: "string", description: "Path to a local .xlsx, .xls, or .csv file. Mutually exclusive with 'csv'/'data'." },
  sheet: { type: "string", description: "Sheet name to read from an xlsx file. Defaults to the first sheet." },
  output_file: { type: "string", description: "Path to write the result as an .xlsx file. Returns the file path on success." },
};

// The local server reads and (with output_file) writes files, and forwards
// computation to the hosted API.
const ANNOTATIONS = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true };

const TOOLS = [
  {
    name: "calc_formulas",
    annotations: { title: "Evaluate formulas", ...ANNOTATIONS },
    description:
      "Evaluate Excel-compatible spreadsheet formulas against the user's data and return each formula next to its result, so the user can check the calculation in their own spreadsheet. Send the complete dataset: prefer the file parameter for a local .xlsx/.csv; otherwise pass the data exactly as the user provided it (CSV string or JSON 2D array, header row included, with headers:true); do not filter, sort, or retype rows yourself. Put every filter, condition, and lookup inside the formula, for example =SUMIFS(Revenue,Region,\"EMEA\",Date,\">=\"&DATE(2026,4,1)), =MEDIAN(FILTER(Revenue,Region=\"APAC\")), or =XLOOKUP(1,(Rep=\"Ana\")*(Date=DATE(2026,5,2)),Revenue). Never pass hand-picked values such as =SUM(120.5,98.2): the formula is the user's record of how the answer was found. If the dataset is too large to send in full, tell the user rather than sending part of it. Omit data for formulas that need none, e.g. =PMT(0.05/12,60,10000). 400+ functions (SUMIFS, COUNTIFS, AVERAGEIFS, XLOOKUP, FILTER, SUMPRODUCT, IRR, PMT, FV, ...). Up to 50,000 rows and 50 columns.",
    inputSchema: {
      type: "object",
      properties: {
        csv: { type: "string", description: "Raw CSV string. Numeric values auto-detected. Use this OR data OR file, not multiple." },
        data: { type: "array", items: { type: "array" }, description: "2D JSON array. Use this OR csv OR file, not multiple." },
        headers: { type: "boolean", description: "When true, row 1 = column names usable in formulas (e.g. =SUM(Revenue))." },
        formulas: { type: "array", items: { type: "string" }, description: "Array of formulas to evaluate (each starting with '='). Returns results in same order." },
        ...FILE_PARAMS,
      },
      required: ["formulas"],
    },
  },
  {
    name: "calc_groupby",
    annotations: { title: "Group and aggregate", ...ANNOTATIONS },
    description:
      "Aggregate data by groups: computes SUM, AVERAGE, COUNT, MIN, MAX, or MEDIAN of a column for each value of another column. Returns one row per group. Send the complete dataset (prefer the file parameter for a local .xlsx/.csv, otherwise a CSV string with its header row); do not filter or retype rows yourself. To aggregate only some rows, use calc_formulas with SUMIFS, AVERAGEIFS, or FILTER instead.",
    inputSchema: {
      type: "object",
      properties: {
        csv: { type: "string", description: "Raw CSV string with header row. Use this OR file, not both." },
        by: { type: "string", description: "Column name to group by." },
        aggregates: {
          type: "object",
          additionalProperties: { type: "string", enum: ["SUM", "AVERAGE", "COUNT", "MIN", "MAX", "MEDIAN"] },
          description: "Map of column name to aggregate function.",
        },
        ...FILE_PARAMS,
      },
      required: ["by", "aggregates"],
    },
  },
  {
    name: "calc_grid",
    annotations: { title: "Evaluate grid", ...ANNOTATIONS },
    description:
      "Evaluate a grid with embedded formulas. Formulas in cells (strings starting with '=') are computed and the full grid is returned with values resolved. Accepts a 2D array or a local file path (.xlsx/.csv). Useful for building spreadsheet-like calculations.",
    inputSchema: {
      type: "object",
      properties: {
        data: { type: "array", items: { type: "array" }, description: "2D array with formulas in cells (e.g. [['a','b','sum'],[1,2,'=A2+B2']]). Use this OR file, not both." },
        ...FILE_PARAMS,
      },
    },
  },
];

// --- API caller ---

async function callApi(body) {
  const res = await fetch(API_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  if (!json.success) {
    throw new Error(json.error?.message || `API error (${res.status})`);
  }
  return json;
}

// --- Tool handlers ---

function displayValue(v) {
  if (v === null || v === undefined) return "";
  if (Array.isArray(v)) return JSON.stringify(v);
  if (typeof v === "object" && v.error) return `ERROR: ${v.error}`;
  return String(v);
}

// Cell value for xlsx output: scalars as-is, errors and arrays as text.
function cellValue(v) {
  return v !== null && typeof v === "object" ? displayValue(v) : v;
}

async function handleCalcFormulas(args) {
  const body = { formulas: args.formulas };

  if (args.file) {
    Object.assign(body, readFileAsData(args.file, args.sheet));
    if (args.headers) body.headers = true;
  } else if (args.csv) {
    body.csv = args.csv;
    if (args.headers) body.headers = true;
  } else if (args.data) {
    body.data = args.data;
    if (args.headers) body.headers = true;
  }
  // No source: formulas that reference no cells (=PMT(...)) run on an empty sheet

  const json = await callApi(body);

  const lines = [`Results (${json.meta.rows} rows):`];
  for (let i = 0; i < args.formulas.length; i++) {
    lines.push(`  ${args.formulas[i]} = ${displayValue(json.result[i])}`);
  }
  if (json.meta.columns) {
    // columnMap lists each column under its original name first, then (if
    // different) its sanitized name — keep the first key per column index.
    const seen = new Set();
    const names = [];
    for (const [key, info] of Object.entries(json.meta.columns)) {
      if (seen.has(info.index)) continue;
      seen.add(info.index);
      names.push(key);
    }
    lines.push("", "Available columns: " + names.join(", "));
  }

  if (args.output_file) {
    const grid = [["Formula", "Result"], ...args.formulas.map((f, i) => [f, cellValue(json.result[i])])];
    writeGridToXlsx(grid, args.output_file);
    lines.push(`\nWritten to: ${args.output_file}`);
  }

  return lines.join("\n");
}

async function handleCalcGroupby(args) {
  let body;

  if (args.file) {
    const fileData = readFileAsData(args.file, args.sheet);
    body = { ...fileData, headers: true, groupBy: { by: args.by, aggregates: args.aggregates } };
  } else if (args.csv) {
    body = { csv: args.csv, headers: true, groupBy: { by: args.by, aggregates: args.aggregates } };
  } else {
    throw new Error("Provide 'file' or 'csv'");
  }

  const json = await callApi(body);

  const aggCols = Object.keys(args.aggregates);
  const header = ["group", ...aggCols];
  const rows = json.result.map((r) => [r.group, ...aggCols.map((c) => r[c])]);

  const lines = [`GroupBy '${args.by}' (${json.meta.groups} groups):`, ""];
  lines.push(header.join("\t"));
  lines.push(header.map(() => "---").join("\t"));
  for (const row of rows) {
    lines.push(row.join("\t"));
  }

  if (args.output_file) {
    writeGridToXlsx([header, ...rows], args.output_file);
    lines.push(`\nWritten to: ${args.output_file}`);
  }

  return lines.join("\n");
}

async function handleCalcGrid(args) {
  let body;

  if (args.file) {
    body = readFileAsData(args.file, args.sheet);
  } else if (args.data) {
    body = { data: args.data };
  } else {
    throw new Error("Provide 'file' or 'data'");
  }

  const json = await callApi(body);

  const lines = [`Evaluated grid (${json.meta.rows}x${json.meta.cols}):`, ""];
  for (const row of json.result) {
    lines.push(row.map(displayValue).join("\t"));
  }

  if (args.output_file) {
    writeGridToXlsx(json.result.map((row) => row.map(cellValue)), args.output_file);
    lines.push(`\nWritten to: ${args.output_file}`);
  }

  return lines.join("\n");
}

// --- MCP server ---

const server = new Server(
  { name: "hyperformula-calc", version: "0.6.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  try {
    let text;
    switch (name) {
      case "calc_formulas": text = await handleCalcFormulas(args); break;
      case "calc_groupby": text = await handleCalcGroupby(args); break;
      case "calc_grid": text = await handleCalcGrid(args); break;
      default: throw new Error(`Unknown tool: ${name}`);
    }
    return { content: [{ type: "text", text }] };
  } catch (error) {
    return { content: [{ type: "text", text: `Error: ${error.message}` }], isError: true };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("HyperFormula MCP server running on stdio");
