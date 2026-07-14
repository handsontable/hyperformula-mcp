import { describe, it } from "node:test";
import assert from "node:assert/strict";
import worker, { evaluate, parseCSV } from "../src/index.js";

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

  it("returns a HyperFormula error object for a bad formula", () => {
    const out = evaluate({ data: [[1]], formulas: ["=1/0"] });
    assert.ok(out.result[0] && typeof out.result[0] === "object" && out.result[0].error);
  });

  it("includes meta with rows, cols, durationMs", () => {
    const out = evaluate({ data: [["a"], [1]], formulas: ["=A2+1"] });
    assert.equal(out.meta.rows, 2);
    assert.equal(out.meta.cols, 1);
    assert.equal(typeof out.meta.durationMs, "number");
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

  it("evaluates a POST with results and noindex header", async () => {
    const res = await worker.fetch(
      req("/api/calc", { body: JSON.stringify({ data: [[1, 2], [3, 4]], formulas: ["=SUM(A1:B2)"] }) }),
      {},
      CTX
    );
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("x-robots-tag"), "noindex");
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
