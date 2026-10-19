import { describe, it } from "node:test";
import assert from "node:assert/strict";
import worker, { evaluate, parseCSV, extractFunctions } from "../src/index.js";

// The deployed logic is the pure `evaluate()` core (shared by the Cloudflare
// Worker in src/index.js). These tests exercise it directly against the current
// API: `formulas` (array), `grid`, and `groupBy` modes.

// ─── Formulas mode ───────────────────────────────────────────────

describe("formulas mode", () => {
  it("evaluates SUM over a cell range", () => {
    const out = evaluate({ data: [["v"], [10], [20], [30]], formulas: ["=SUM(A2:A4)"] });
    assert.equal(out.success, true);
    assert.equal(out.mode, "formulas");
    assert.deepEqual(out.result, [60]);
  });

  it("evaluates multiple formulas in order", () => {
    const out = evaluate({ data: [[10, 20], [30, 40]], formulas: ["=SUM(A1:A2)", "=SUM(B1:B2)", "=AVERAGE(A1:B2)"] });
    assert.deepEqual(out.result, [40, 60, 25]);
  });

  it("references columns by name when headers:true", () => {
    const data = parseCSV("name,score\nAlice,85\nBob,92\nCarol,78");
    const out = evaluate({ data, headers: true, formulas: ["=SUM(score)", "=AVERAGE(score)"] });
    assert.equal(out.result[0], 255);
    assert.equal(out.result[1], 85);
    assert.ok(out.meta.columns.score);
  });

  it("sanitizes column names with spaces", () => {
    const out = evaluate({ data: [["Total Revenue", "Total Cost"], [1000, 800]], headers: true, formulas: ["=SUM(Total_Revenue)"] });
    assert.equal(out.result[0], 1000);
  });

  it("whole-column references do not see other formulas", () => {
    const out = evaluate({ data: [["a"], [1], [2]], headers: true, formulas: ["=SUM(a)", "=SUM(A:A)"] });
    assert.deepEqual(out.result, [3, 3]);
  });

  it("isolates a broken formula from the rest of the batch", () => {
    const out = evaluate({ data: [[1]], formulas: ["=A1*2", "=OFFSET()", "=1+", "=FOO(1)"] });
    assert.equal(out.result[0], 2);
    assert.equal(out.result[1].error, "#ERROR!");
    assert.equal(out.result[2].error, "#ERROR!");
    assert.equal(out.result[3].error, "#NAME?");
  });

  it("returns array results whole as 2D arrays", () => {
    const out = evaluate({ data: [["x"], ["y"], ["x"]], formulas: ["=UNIQUE(A1:A3)", "=SORT(A1:A3)", "=A1:A2"] });
    assert.deepEqual(out.result, [[["x"], ["y"]], [["x"], ["x"], ["y"]], [["x"], ["y"]]]);
  });

  it("supports bare TRUE/FALSE, array arithmetic and ISO dates", () => {
    const out = evaluate({
      data: [["k", "v", "d"], ["EU", 1, "2024-01-31"], ["US", 2, "2024-02-29"], ["EU", 3, "2024-03-31"]],
      headers: true,
      formulas: ['=VLOOKUP("US",A2:B4,2,FALSE)', '=SUMPRODUCT((k="EU")*v)', "=YEAR(C2)", "=C3-C2", "=IF(TRUE,1,2)"],
    });
    assert.deepEqual(out.result, [2, 4, 2024, 29, 1]);
  });

  it("returns a HyperFormula error object for a bad formula", () => {
    const out = evaluate({ data: [[1]], formulas: ["=1/0"] });
    assert.ok(out.result[0] && typeof out.result[0] === "object" && out.result[0].error);
  });

  it("includes meta with rows and cols", () => {
    const out = evaluate({ data: [["a"], [1]], formulas: ["=A2+1"] });
    assert.equal(out.meta.rows, 2);
    assert.equal(out.meta.cols, 1);
  });
});

// ─── Grid mode (embedded formulas) ───────────────────────────────

describe("grid mode", () => {
  it("resolves embedded formulas and returns the full grid", () => {
    const out = evaluate({ data: [["a", "b", "sum"], [1, 2, "=A2+B2"], [3, 4, "=A3+B3"]] });
    assert.equal(out.mode, "grid");
    assert.deepEqual(out.result, [["a", "b", "sum"], [1, 2, 3], [3, 4, 7]]);
  });

  it("handles cells referencing other formula cells", () => {
    const out = evaluate({ data: [["a", "b", "c"], [5, "=A2*2", "=B2+1"]] });
    assert.equal(out.result[1][1], 10);
    assert.equal(out.result[1][2], 11);
  });
});

// ─── GroupBy mode ────────────────────────────────────────────────

describe("groupBy mode", () => {
  it("aggregates SUM and AVERAGE per group", () => {
    const data = parseCSV("Region,Revenue,Units\nEurope,1000,50\nAsia,2000,80\nEurope,1500,30");
    const out = evaluate({ data, headers: true, groupBy: { by: "Region", aggregates: { Revenue: "SUM", Units: "AVERAGE" } } });
    assert.equal(out.mode, "groupBy");
    const europe = out.result.find(r => r.group === "Europe");
    const asia = out.result.find(r => r.group === "Asia");
    assert.equal(europe.Revenue, 2500);
    assert.equal(europe.Units, 40);
    assert.equal(asia.Revenue, 2000);
    assert.equal(asia.Units, 80);
  });

  it("computes MEDIAN manually per group", () => {
    const data = parseCSV("g,v\nx,1\nx,3\nx,5\ny,10\ny,20");
    const out = evaluate({ data, headers: true, groupBy: { by: "g", aggregates: { v: "MEDIAN" } } });
    const x = out.result.find(r => r.group === "x");
    const y = out.result.find(r => r.group === "y");
    assert.equal(x.v, 3);
    assert.equal(y.v, 15);
  });

  it("matches group values exactly (wildcards literal, case-sensitive)", () => {
    const data = parseCSV("g,v\nA*,1\nAB,2\nA*,3\na?,4\nab,5");
    const out = evaluate({ data, headers: true, groupBy: { by: "g", aggregates: { v: "SUM" } } });
    assert.deepEqual(out.result, [{ group: "A*", v: 4 }, { group: "AB", v: 2 }, { group: "a?", v: 4 }, { group: "ab", v: 5 }]);
  });

  it("computes COUNT, MIN, MAX and ignores non-numeric cells", () => {
    const data = parseCSV("g,v\nx,5\nx,n/a\nx,2\ny,");
    const out = evaluate({ data, headers: true, groupBy: { by: "g", aggregates: { v: "COUNT" } } });
    assert.deepEqual(out.result, [{ group: "x", v: 3 }, { group: "y", v: 1 }]);
    const out2 = evaluate({ data, headers: true, groupBy: { by: "g", aggregates: { v: "MIN" } } });
    assert.equal(out2.result[0].v, 2);
    const out3 = evaluate({ data, headers: true, groupBy: { by: "g", aggregates: { v: "AVERAGE" } } });
    assert.equal(out3.result[0].v, 3.5);
    assert.deepEqual(out3.result[1].v, { error: "#DIV/0!" });
  });

  it("handles thousands of distinct groups", () => {
    const data = [["g", "v"]];
    for (let i = 0; i < 5000; i++) data.push(["G" + i, i]);
    const out = evaluate({ data, headers: true, groupBy: { by: "g", aggregates: { v: "SUM" } } });
    assert.equal(out.meta.groups, 5000);
    assert.equal(out.result[4999].v, 4999);
  });

  it("rejects more than the maximum number of groups with a clear error", () => {
    const data = [["g", "v"]];
    for (let i = 0; i < 10001; i++) data.push(["G" + i, i]);
    assert.throws(() => evaluate({ data, headers: true, groupBy: { by: "g", aggregates: { v: "SUM" } } }), (e) => e.type === "INVALID_GROUPBY" && /10000/.test(e.message));
  });

  it("throws for an unknown groupBy column", () => {
    assert.throws(() => evaluate({ data: [["a"], [1]], headers: true, groupBy: { by: "missing", aggregates: { a: "SUM" } } }));
  });
});

// ─── CSV parsing ─────────────────────────────────────────────────

describe("parseCSV", () => {
  it("auto-types numbers and keeps strings", () => {
    assert.deepEqual(parseCSV("a,b\n1,x\n2,y"), [["a", "b"], [1, "x"], [2, "y"]]);
  });

  it("handles quoted fields containing commas", () => {
    assert.deepEqual(parseCSV('name,note\n"Doe, John",hi'), [["name", "note"], ["Doe, John", "hi"]]);
  });

  it("skips blank lines instead of emitting null rows", () => {
    assert.deepEqual(parseCSV("a\n1\n\n2\n"), [["a"], [1], [2]]);
  });

  it("handles CR and CRLF line endings", () => {
    assert.deepEqual(parseCSV("a,b\r1,2\r\n3,4"), [["a", "b"], [1, 2], [3, 4]]);
  });
});

// ─── Analytics helpers ───────────────────────────────────────────

describe("extractFunctions", () => {
  it("returns unique uppercase function names and drops string literals", () => {
    const fns = extractFunctions(['=SUM(Revenue)', '=countif(Region,"SUM(x)")', '=IF(A1>0,ROUND(A1,2),"n/a")', '=SUM(A1:A3)']);
    assert.deepEqual(fns, ["COUNTIF", "IF", "ROUND", "SUM"]);
  });

  it("does not treat a quoted customer name as a function", () => {
    assert.deepEqual(extractFunctions(['=COUNTIF(Name,"Acme (EU)")']), ["COUNTIF"]);
  });
});

describe("analytics payload", () => {
  it("sends usage shape only, never formula text, cell values, or raw IP", async () => {
    const sent = [];
    const origFetch = globalThis.fetch;
    globalThis.fetch = async (url, init) => { sent.push(JSON.parse(init.body)); return new Response("ok"); };
    try {
      const body = JSON.stringify({ csv: "Customer,Revenue\nAcme Corp,100\nGlobex,200", headers: true, formulas: ['=SUMIF(Customer,"Acme Corp",Revenue)'] });
      const res = await worker.fetch(
        req("/api/calc", { body, headers: { "cf-connecting-ip": "203.0.113.9", "user-agent": "curl/8.7.1 (x86_64)" } }),
        { POSTHOG_API_KEY: "test-key" },
        { waitUntil: (p) => p }
      );
      assert.equal(res.status, 200);
      await new Promise((r) => setTimeout(r, 0));
      assert.equal(sent.length, 1);
      const ev = sent[0];
      assert.equal(ev.event, "calc_evaluated");
      assert.deepEqual(ev.properties.functions, ["SUMIF"]);
      assert.equal(ev.properties.client, "curl/8.7.1");
      assert.equal(ev.properties.rows_bucket, "1-10");
      const text = JSON.stringify(ev);
      for (const leak of ["Acme", "Globex", "Customer", "Revenue", "203.0.113.9", "SUMIF("]) {
        assert.ok(!text.includes(leak), `analytics payload leaked: ${leak}`);
      }
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});

// ─── Worker fetch handler (HTTP shell) ───────────────────────────

const CTX = { waitUntil() {} };

function req(path, { method = "POST", headers = {}, body = "" } = {}) {
  return {
    url: `https://hyperformula-mcp.example${path}`,
    method,
    headers: new Headers(headers),
    text: async () => body,
  };
}

describe("worker fetch handler", () => {
  it("rejects an oversized body up front via Content-Length (413)", async () => {
    // 60 MB declared — must be refused before the body is read into memory.
    const res = await worker.fetch(
      req("/api/calc", { headers: { "content-length": String(60_000_000), "content-type": "application/json" } }),
      {},
      CTX
    );
    assert.equal(res.status, 413);
    const json = await res.json();
    assert.equal(json.error.type, "PAYLOAD_TOO_LARGE");
  });

  it("400s a null JSON body instead of crashing", async () => {
    const res = await worker.fetch(req("/api/calc", { body: "null" }), {}, CTX);
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error.type, "INVALID_JSON");
  });

  it("enforces the cell size cap on JSON data and unquoted CSV fields", async () => {
    const big = "x".repeat(10_001);
    const r1 = await worker.fetch(req("/api/calc", { body: JSON.stringify({ data: [[big]], formulas: ["=LEN(A1)"] }) }), {}, CTX);
    assert.equal(r1.status, 400);
    assert.equal((await r1.json()).error.type, "INVALID_DATA");
    const r2 = await worker.fetch(req("/api/calc", { body: JSON.stringify({ csv: `a\n${big}`, formulas: ["=LEN(A2)"] }) }), {}, CTX);
    assert.equal(r2.status, 400);
    assert.equal((await r2.json()).error.type, "INVALID_CSV");
  });

  it("evaluates a POST with results", async () => {
    const res = await worker.fetch(
      req("/api/calc", { body: JSON.stringify({ data: [[1, 2], [3, 4]], formulas: ["=SUM(A1:B2)"] }) }),
      {},
      CTX
    );
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.deepEqual(json.result, [10]);
  });

  it("returns the schema on GET", async () => {
    const res = await worker.fetch(req("/api/calc", { method: "GET" }), {}, CTX);
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.endpoint, "/api/calc");
  });

  it("204s a CORS preflight", async () => {
    const res = await worker.fetch(req("/api/calc", { method: "OPTIONS" }), {}, CTX);
    assert.equal(res.status, 204);
    assert.equal(res.headers.get("access-control-allow-origin"), "*");
  });
});

// ─── Remote MCP endpoint (/mcp) ──────────────────────────────────

function mcpReq(message) {
  return req("/mcp", { body: JSON.stringify(message) });
}

describe("remote MCP endpoint", () => {
  it("negotiates protocol version on initialize", async () => {
    const res = await worker.fetch(mcpReq({
      jsonrpc: "2.0", id: 1, method: "initialize",
      params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "0" } },
    }), {}, CTX);
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.result.protocolVersion, "2025-03-26");
    assert.equal(json.result.serverInfo.name, "hyperformula-calc");
    assert.ok(json.result.capabilities.tools);
  });

  it("falls back to the latest supported protocol version", async () => {
    const res = await worker.fetch(mcpReq({
      jsonrpc: "2.0", id: 1, method: "initialize",
      params: { protocolVersion: "1999-01-01" },
    }), {}, CTX);
    const json = await res.json();
    assert.equal(json.result.protocolVersion, "2025-06-18");
  });

  it("202s the initialized notification", async () => {
    const res = await worker.fetch(mcpReq({ jsonrpc: "2.0", method: "notifications/initialized" }), {}, CTX);
    assert.equal(res.status, 202);
  });

  it("lists the three calc tools", async () => {
    const res = await worker.fetch(mcpReq({ jsonrpc: "2.0", id: 2, method: "tools/list" }), {}, CTX);
    const json = await res.json();
    assert.deepEqual(json.result.tools.map((t) => t.name), ["calc_formulas", "calc_groupby", "calc_grid"]);
  });

  it("executes calc_formulas via tools/call", async () => {
    const res = await worker.fetch(mcpReq({
      jsonrpc: "2.0", id: 3, method: "tools/call",
      params: { name: "calc_formulas", arguments: { csv: "v\n10\n20\n30", headers: true, formulas: ["=SUM(v)"] } },
    }), {}, CTX);
    const json = await res.json();
    assert.equal(json.error, undefined);
    assert.match(json.result.content[0].text, /=SUM\(v\) = 60/);
  });

  it("executes calc_groupby via tools/call", async () => {
    const res = await worker.fetch(mcpReq({
      jsonrpc: "2.0", id: 4, method: "tools/call",
      params: { name: "calc_groupby", arguments: { csv: "g,v\nx,1\nx,3\ny,10", by: "g", aggregates: { v: "SUM" } } },
    }), {}, CTX);
    const json = await res.json();
    assert.match(json.result.content[0].text, /x\t4/);
    assert.match(json.result.content[0].text, /y\t10/);
  });

  it("returns isError content for invalid tool input", async () => {
    const res = await worker.fetch(mcpReq({
      jsonrpc: "2.0", id: 5, method: "tools/call",
      params: { name: "calc_formulas", arguments: { csv: "v\n1", formulas: ["SUM(v)"] } },
    }), {}, CTX);
    const json = await res.json();
    assert.equal(json.result.isError, true);
    assert.match(json.result.content[0].text, /INVALID_FORMULAS/);
  });

  it("returns isError when calc_formulas is called without a formulas array", async () => {
    const res = await worker.fetch(mcpReq({
      jsonrpc: "2.0", id: 7, method: "tools/call",
      params: { name: "calc_formulas", arguments: { csv: "v\n1" } },
    }), {}, CTX);
    const json = await res.json();
    assert.equal(json.result.isError, true);
  });

  it("answers a null JSON-RPC body with -32600 instead of crashing", async () => {
    const res = await worker.fetch(req("/mcp", { body: "null" }), {}, CTX);
    assert.equal(res.status, 200);
    assert.equal((await res.json()).error.code, -32600);
  });

  it("advertises tool annotations", async () => {
    const res = await worker.fetch(mcpReq({ jsonrpc: "2.0", id: 2, method: "tools/list" }), {}, CTX);
    const json = await res.json();
    assert.ok(json.result.tools.every((t) => t.annotations.readOnlyHint === true));
  });

  it("rejects unknown methods with -32601", async () => {
    const res = await worker.fetch(mcpReq({ jsonrpc: "2.0", id: 6, method: "resources/list" }), {}, CTX);
    const json = await res.json();
    assert.equal(json.error.code, -32601);
  });

  it("405s GET (no SSE stream, stateless)", async () => {
    const res = await worker.fetch(req("/mcp", { method: "GET" }), {}, CTX);
    assert.equal(res.status, 405);
  });
});
