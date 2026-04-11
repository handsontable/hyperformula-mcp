import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const API_URL = process.env.HYPERFORMULA_API_URL || "https://hyperformula-mcp.netlify.app/api/calc";

// --- Tool definitions ---

const TOOLS = [
  {
    name: "calc_formulas",
    description:
      "Evaluate spreadsheet formulas against a dataset. Send data as CSV string or JSON 2D array, plus an array of formulas. With headers:true, formulas can reference column names (e.g. =SUM(Revenue)). Supports 400+ Excel-compatible functions: SUM, AVERAGE, COUNTIF, VLOOKUP, IF, SUMPRODUCT, etc. Up to 50,000 rows.",
    inputSchema: {
      type: "object",
      properties: {
        csv: { type: "string", description: "Raw CSV string. Numeric values auto-detected. Use this OR data, not both." },
        data: { type: "array", items: { type: "array" }, description: "2D JSON array. Use this OR csv, not both." },
        headers: { type: "boolean", description: "When true, row 1 = column names usable in formulas (e.g. =SUM(Revenue))." },
        formulas: { type: "array", items: { type: "string" }, description: "Array of formulas to evaluate (each starting with '='). Returns results in same order." },
      },
      required: ["formulas"],
    },
  },
  {
    name: "calc_groupby",
    description:
      "Aggregate data by groups. Groups rows by a column and computes SUM, AVERAGE, COUNT, MIN, MAX, or MEDIAN per group. Requires CSV input with headers. Returns array of {group, ...aggregates} objects.",
    inputSchema: {
      type: "object",
      properties: {
        csv: { type: "string", description: "Raw CSV string with header row." },
        by: { type: "string", description: "Column name to group by." },
        aggregates: {
          type: "object",
          additionalProperties: { type: "string", enum: ["SUM", "AVERAGE", "COUNT", "MIN", "MAX", "MEDIAN"] },
          description: "Map of column name to aggregate function.",
        },
      },
      required: ["csv", "by", "aggregates"],
    },
  },
  {
    name: "calc_grid",
    description:
      "Evaluate a grid with embedded formulas. Formulas in cells (strings starting with '=') are computed and the full grid is returned with values resolved. Useful for building spreadsheet-like calculations.",
    inputSchema: {
      type: "object",
      properties: {
        data: { type: "array", items: { type: "array" }, description: "2D array with formulas in cells (e.g. [['a','b','sum'],[1,2,'=A2+B2']])" },
      },
      required: ["data"],
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
  if (args.csv) body.csv = args.csv;
  else if (args.data) body.data = args.data;
  else throw new Error("Provide either 'csv' or 'data'");
  if (args.headers) body.headers = true;

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
  return lines.join("\n");
}

async function handleCalcGroupby(args) {
  const body = {
    csv: args.csv,
    headers: true,
    groupBy: { by: args.by, aggregates: args.aggregates },
  };

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
  return lines.join("\n");
}

async function handleCalcGrid(args) {
  const json = await callApi({ data: args.data });

  const lines = [`Evaluated grid (${json.meta.rows}x${json.meta.cols}, ${json.meta.durationMs}ms):`, ""];
  for (const row of json.result) {
    lines.push(row.map((v) => (v === null ? "" : String(v))).join("\t"));
  }
  return lines.join("\n");
}

// --- MCP server ---

const server = new Server(
  { name: "hyperformula-calc", version: "0.3.0" },
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
