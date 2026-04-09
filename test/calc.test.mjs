import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { handler } from "../netlify/functions/calc.mjs";

// Helper: build a Netlify-style event object
function makeEvent(body, method = "POST") {
  const raw = typeof body === "string" ? body : JSON.stringify(body);
  return { httpMethod: method, body: raw };
}

async function call(body) {
  const res = await handler(makeEvent(body));
  return { ...res, json: JSON.parse(res.body) };
}

// ─── Single formula mode ─────────────────────────────────────────

describe("single formula mode", () => {
  it("evaluates SUM", async () => {
    const { json } = await call({
      data: [["v"], [10], [20], [30]],
      formula: "=SUM(A2:A4)",
    });
    assert.equal(json.success, true);
    assert.equal(json.mode, "single");
    assert.equal(json.result, 60);
  });

  it("evaluates AVERAGE", async () => {
    const { json } = await call({
      data: [["v"], [10], [20], [30]],
      formula: "=AVERAGE(A2:A4)",
    });
    assert.equal(json.result, 20);
  });

  it("evaluates CONCATENATE", async () => {
    const { json } = await call({
      data: [["first", "last"], ["Jane", "Doe"]],
      formula: '=CONCATENATE(A2," ",B2)',
    });
    assert.equal(json.result, "Jane Doe");
  });

  it("evaluates COUNT", async () => {
    const { json } = await call({
      data: [["v"], [1], [null], [3], ["text"]],
      formula: "=COUNT(A2:A5)",
    });
    assert.equal(json.result, 2); // COUNT counts numbers only
  });

  it("returns grid when returnMode=grid", async () => {
    const { json } = await call({
      data: [["v"], [10], [20]],
      formula: "=SUM(A2:A3)",
      returnMode: "grid",
    });
    assert.equal(json.mode, "single");
    assert.ok(Array.isArray(json.result));
    assert.equal(json.result.length, 3); // 3 data rows (formula row excluded)
  });

  it("includes meta with rows, cols, durationMs", async () => {
    const { json } = await call({
      data: [["a"], [1]],
      formula: "=A2+1",
    });
    assert.equal(json.meta.rows, 2);
    assert.equal(json.meta.cols, 1);
    assert.equal(typeof json.meta.durationMs, "number");
  });
});

// ─── Embedded formula mode ───────────────────────────────────────

describe("embedded formula mode", () => {
  it("evaluates formulas in cells", async () => {
    const { json } = await call({
      data: [
        ["a", "b", "sum"],
        [1, 2, "=A2+B2"],
        [3, 4, "=A3+B3"],
      ],
    });
    assert.equal(json.success, true);
    assert.equal(json.mode, "grid");
    assert.deepEqual(json.result[1], [1, 2, 3]);
    assert.deepEqual(json.result[2], [3, 4, 7]);
  });

  it("evaluates IF formulas", async () => {
    const { json } = await call({
      data: [
        ["status", "price", "qty", "discount", "result"],
        ["active", 100, 2, 0.1, '=IF(A2="active",B2*C2*(1-D2),0)'],
        ["inactive", 50, 1, 0, '=IF(A3="active",B3*C3*(1-D3),0)'],
      ],
    });
    assert.equal(json.result[1][4], 180);
    assert.equal(json.result[2][4], 0);
  });

  it("returns only formula results with returnMode=results", async () => {
    const { json } = await call({
      data: [
        ["a", "b", "sum"],
        [1, 2, "=A2+B2"],
        [3, 4, "=A3+B3"],
      ],
      returnMode: "results",
    });
    assert.equal(json.result.length, 2);
    assert.deepEqual(json.result[0], { row: 1, col: 2, value: 3 });
    assert.deepEqual(json.result[1], { row: 2, col: 2, value: 7 });
  });

  it("handles cells referencing other formula cells", async () => {
    const { json } = await call({
      data: [
        ["a", "b", "c"],
        [5, "=A2*2", "=B2+1"],
      ],
    });
    assert.equal(json.result[1][1], 10);
    assert.equal(json.result[1][2], 11);
  });
});

// ─── Edge cases ──────────────────────────────────────────────────

describe("edge cases", () => {
  it("handles null and empty cells", async () => {
    const { json } = await call({
      data: [["a", "b"], [null, ""], [1, 2]],
      formula: "=SUM(A2:B3)",
    });
    assert.equal(json.result, 3);
  });

  it("handles single-cell data", async () => {
    const { json } = await call({
      data: [[42]],
      formula: "=A1*2",
    });
    assert.equal(json.result, 84);
  });

  it("handles ragged rows (different lengths)", async () => {
    const { json } = await call({
      data: [["a", "b"], [1], [2, 3]],
      formula: "=SUM(A2:B3)",
    });
    assert.equal(json.result, 6); // 1+0+2+3
  });

  it("preserves header row strings", async () => {
    const { json } = await call({
      data: [["Name", "Score"], ["Alice", 95]],
    });
    assert.deepEqual(json.result[0], ["Name", "Score"]);
    assert.deepEqual(json.result[1], ["Alice", 95]);
  });

  it("handles boolean values", async () => {
    const { json } = await call({
      data: [[true], [false]],
      formula: "=AND(A1,A2)",
    });
    assert.equal(json.result, false);
  });
});

// ─── Validation & errors ─────────────────────────────────────────

describe("validation", () => {
  it("rejects missing data", async () => {
    const { statusCode, json } = await call({});
    assert.equal(statusCode, 400);
    assert.equal(json.error.type, "INVALID_DATA");
  });

  it("rejects non-array data", async () => {
    const { statusCode, json } = await call({ data: "nope" });
    assert.equal(statusCode, 400);
    assert.equal(json.error.type, "INVALID_DATA");
  });

  it("rejects non-array row", async () => {
    const { statusCode, json } = await call({ data: [[1], "bad"] });
    assert.equal(statusCode, 400);
    assert.match(json.error.message, /data\[1\] is not an array/);
  });

  it("rejects invalid formula (no = prefix)", async () => {
    const { statusCode, json } = await call({
      data: [[1]],
      formula: "SUM(A1)",
    });
    assert.equal(statusCode, 400);
    assert.equal(json.error.type, "INVALID_FORMULA");
  });

  it("rejects invalid returnMode", async () => {
    const { statusCode, json } = await call({
      data: [[1]],
      returnMode: "bogus",
    });
    assert.equal(statusCode, 400);
    assert.equal(json.error.type, "INVALID_RETURN_MODE");
  });

  it("rejects non-POST methods", async () => {
    const res = await handler(makeEvent("{}", "GET"));
    const json = JSON.parse(res.body);
    assert.equal(res.statusCode, 405);
    assert.equal(json.error.type, "METHOD_NOT_ALLOWED");
  });

  it("handles CORS preflight", async () => {
    const res = await handler({ httpMethod: "OPTIONS" });
    assert.equal(res.statusCode, 204);
    assert.equal(res.headers["Access-Control-Allow-Origin"], "*");
  });

  it("rejects invalid JSON body", async () => {
    const res = await handler({ httpMethod: "POST", body: "{bad json" });
    const json = JSON.parse(res.body);
    assert.equal(res.statusCode, 400);
    assert.equal(json.error.type, "INVALID_JSON");
  });

  it("returns 422 for formula evaluation errors", async () => {
    const { statusCode, json } = await call({
      data: [[1]],
      formula: "=INVALID(((",
    });
    assert.equal(statusCode, 422);
    assert.equal(json.error.type, "FORMULA_ERROR");
  });
});

// ─── Custom sheet name ───────────────────────────────────────────

describe("sheetName option", () => {
  it("accepts a custom sheet name", async () => {
    const { json } = await call({
      data: [["v"], [5]],
      formula: "=A2+10",
      sheetName: "Data",
    });
    assert.equal(json.result, 15);
  });
});
