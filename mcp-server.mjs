import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { readFileSync } from "fs";
import XLSX from "xlsx";

const API_URL = process.env.HYPERFORMULA_API_URL || "https://hyperformula-mcp.netlify.app/api/calc";

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

const TOOLS = [
  {
    name: "calc_formulas",
    description:
      "Evaluate spreadsheet formulas against a dataset. Send data as CSV string, JSON 2D array, or a local file path (.xlsx/.csv). With headers:true, formulas can reference column names (e.g. =SUM(Revenue)). Supports 400+ Excel-compatible functions: SUM, AVERAGE, COUNTIF, VLOOKUP, IF, SUMPRODUCT, etc. Up to 50,000 rows.",
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
    description:
      "Aggregate data by groups. Groups rows by a column and computes SUM, AVERAGE, COUNT, MIN, MAX, or MEDIAN per group. Requires a CSV string or local file (.xlsx/.csv) with headers. Returns array of {group, ...aggregates} objects.",
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
  } else {
    throw new Error("Provide 'file', 'csv', or 'data'");
  }

  const json = await callApi(body);

  const lines = [`Results (${json.meta.durationMs}ms, ${json.meta.rows} rows):`];
  for (let i = 0; i < args.formulas.length; i++) {
    const val = json.result[i];
    const display = val && typeof val === "object" && val.error ? `ERROR: ${val.error}` : val;
    lines.push(`  ${args.formulas[i]} = ${display}`);
  }
  if (json.meta.columns) {
    lines.push("", "Available columns: " + Object.keys(json.meta.columns).filter(k => !k.includes("_") || !json.meta.columns[k].namedExpression || json.meta.columns[k].namedExpression === k).join(", "));
  }

  if (args.output_file) {
    const grid = [["Formula", "Result"], ...args.formulas.map((f, i) => {
      const v = json.result[i];
      return [f, v && typeof v === "object" && v.error ? `ERROR: ${v.error}` : v];
    })];
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

  const lines = [`GroupBy '${args.by}' (${json.meta.groups} groups, ${json.meta.durationMs}ms):`, ""];
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

  const lines = [`Evaluated grid (${json.meta.rows}x${json.meta.cols}, ${json.meta.durationMs}ms):`, ""];
  for (const row of json.result) {
    lines.push(row.map((v) => (v === null ? "" : String(v))).join("\t"));
  }

  if (args.output_file) {
    writeGridToXlsx(json.result, args.output_file);
    lines.push(`\nWritten to: ${args.output_file}`);
  }

  return lines.join("\n");
}

// --- MCP server ---

const server = new Server(
  { name: "hyperformula-calc", version: "0.4.0" },
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
