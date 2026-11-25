// Builds the 12 eval tasks with seeded synthetic data and two independent ground truths:
// a plain-JS implementation and HyperFormula (the engine under test). A task is accepted only
// when both agree within its tolerance. Run: node eval/tasks.mjs  (writes eval/.cache/tasks.json)
import fs from 'node:fs';
import path from 'node:path';
import { HyperFormula } from 'hyperformula';

const here = path.dirname(new URL(import.meta.url).pathname);
const cacheDir = path.join(here, '.cache');

const REGIONS = ['EMEA', 'APAC', 'AMER', 'LATAM'];
const REPS = ['Ana', 'Ben', 'Cy', 'Dee', 'Eli', 'Fay', 'Gus', 'Hal', 'Ivy', 'Jo', 'Kai', 'Lu', 'Mo', 'Ned', 'Oli', 'Pia', 'Quin', 'Rae', 'Sol', 'Tia'];
const PRODUCTS = ['Starter', 'Pro', 'Team', 'Enterprise'];
const HEADER = ['Date', 'Region', 'Rep', 'Product', 'Units', 'Revenue'];

function rng(seed) {
  let s = seed;
  return () => (s = (s * 1103515245 + 12345) % 2147483648) / 2147483648;
}

function genRows(n, seed) {
  const rnd = rng(seed);
  return Array.from({ length: n }, () => {
    const d = new Date(Date.UTC(2026, 0, 1) + Math.floor(rnd() * 365) * 86400000);
    return {
      Date: d.toISOString().slice(0, 10),
      Region: REGIONS[Math.floor(rnd() * 4)],
      Rep: REPS[Math.floor(rnd() * 20)],
      Product: PRODUCTS[Math.floor(rnd() * 4)],
      Units: 1 + Math.floor(rnd() * 40),
      Revenue: Math.round((200 + rnd() * 19800) * 100) / 100,
    };
  });
}

const toCsv = (rows) => [HEADER.join(','), ...rows.map((r) => [r.Date, r.Region, r.Rep, r.Product, r.Units, r.Revenue.toFixed(2)].join(','))].join('\n');
const r2 = (x) => Math.round(x * 100) / 100;
const median = (a) => { const b = [...a].sort((x, y) => x - y); const m = b.length >> 1; return b.length % 2 ? b[m] : (b[m - 1] + b[m]) / 2; };
const inQ2Emea = (r) => r.Region === 'EMEA' && r.Date >= '2026-04-01' && r.Date <= '2026-06-30';

// Pick a seed per size so every task has a well-posed answer at that size.
function datasetFor(n, startSeed) {
  for (let seed = startSeed; ; seed++) {
    const rows = genRows(n, seed);
    const q2 = rows.filter(inQ2Emea).length;
    const perRegion = REGIONS.map((g) => rows.filter((r) => r.Region === g).length);
    const lookup = pickLookupRow(rows);
    if (q2 >= 3 && Math.min(...perRegion) >= 3 && lookup) return { rows, seed, lookup };
  }
}

// A row whose (Rep, Date) pair is unique, whose Rep appears at least 3 times (so a single-key lookup
// is not enough), and which sits in the second half of the file.
function pickLookupRow(rows) {
  for (let i = rows.length - 1; i >= Math.floor(rows.length / 2); i--) {
    const r = rows[i];
    const sameKey = rows.filter((x) => x.Rep === r.Rep && x.Date === r.Date).length;
    const sameRep = rows.filter((x) => x.Rep === r.Rep).length;
    if (sameKey === 1 && sameRep >= 3) return r;
  }
  return null;
}

// --- HyperFormula cross-check -------------------------------------------------
function hfEval(rows, formulas) {
  const data = [HEADER, ...rows.map((r) => [r.Date, r.Region, r.Rep, r.Product, r.Units, r.Revenue])];
  const hf = HyperFormula.buildFromArray(data, { licenseKey: 'gpl-v3', dateFormats: ['YYYY-MM-DD'], useArrayArithmetic: true });
  const n = rows.length + 1;
  const col = { Date: `A2:A${n}`, Region: `B2:B${n}`, Rep: `C2:C${n}`, Revenue: `F2:F${n}` };
  const sheet = hf.addSheet('calc');
  const id = hf.getSheetId(sheet);
  return formulas.map((f, i) => {
    const src = f.replace(/\{(\w+)\}/g, (_, k) => `Sheet1!${col[k]}`);
    hf.setCellContents({ sheet: id, col: 0, row: i }, [[src]]);
    return hf.getCellValue({ sheet: id, col: 0, row: i });
  });
}
const hfScalar = (f) => {
  const hf = HyperFormula.buildFromArray([[f]], { licenseKey: 'gpl-v3' });
  return hf.getCellValue({ sheet: 0, col: 0, row: 0 });
};

// --- Tasks ------------------------------------------------------------------------
const SIZES = { S: 20, M: 200, L: 2000 };
const datasets = Object.fromEntries(Object.entries(SIZES).map(([k, n], i) => [k, datasetFor(n, 1000 * (i + 1))]));

const SUM_Q = 'What was the total Revenue for the EMEA region in Q2 2026 (April 1 to June 30, 2026, inclusive)?';
const MEDIAN_Q = 'What is the median Revenue per Region?';
const lookupQ = (r) => `What was the Revenue on the deal that ${r.Rep} closed on ${r.Date}?`;

const tasks = [];
for (const [size, ds] of Object.entries(datasets)) {
  const { rows, lookup } = ds;
  const csv = toCsv(rows);
  const sumJs = r2(rows.filter(inQ2Emea).reduce((a, r) => a + r.Revenue, 0));
  const [sumHf] = hfEval(rows, ['=SUMIFS({Revenue},{Region},"EMEA",{Date},">="&DATE(2026,4,1),{Date},"<="&DATE(2026,6,30))']);
  tasks.push({ id: `sum_${size}`, category: 'filtered_sum', size, rows: rows.length, csv, q: SUM_Q,
    fmt: 'a single number rounded to 2 decimals', truth: sumJs, check: r2(sumHf), tol: 0.011 });

  const medJs = Object.fromEntries(REGIONS.map((g) => [g, median(rows.filter((r) => r.Region === g).map((r) => r.Revenue))]));
  const medHf = Object.fromEntries(REGIONS.map((g, i) => [g, hfEval(rows, REGIONS.map((x) => `=MEDIAN(IF({Region}="${x}",{Revenue}))`))[i]]));
  tasks.push({ id: `median_${size}`, category: 'median_by_group', size, rows: rows.length, csv, q: MEDIAN_Q,
    fmt: 'one value per region rounded to 2 decimals, in the form "ANSWER: EMEA=<v>; APAC=<v>; AMER=<v>; LATAM=<v>"',
    truth: medJs, check: medHf, tol: 0.011 });

  const [lkHf] = hfEval(rows, [`=XLOOKUP(1,({Rep}="${lookup.Rep}")*({Date}=DATE(${lookup.Date.slice(0, 4)},${+lookup.Date.slice(5, 7)},${+lookup.Date.slice(8, 10)})),{Revenue})`]);
  tasks.push({ id: `lookup_${size}`, category: 'lookup', size, rows: rows.length, csv, q: lookupQ(lookup),
    fmt: 'a single number rounded to 2 decimals', truth: lookup.Revenue, check: lkHf, tol: 0.011 });
}

const FLOWS = [-250000, 18000, 22000, 25000, 27500, 30000, 31000, 33000, 34000, 36000, 38000, 60000];
const npv = (r) => FLOWS.reduce((a, f, i) => a + f / Math.pow(1 + r, i), 0);
let lo = -0.99, hi = 1;
for (let i = 0; i < 200; i++) { const mid = (lo + hi) / 2; if (npv(mid) > 0) lo = mid; else hi = mid; }
tasks.push({ id: 'irr', category: 'finance', size: '-', rows: 0, csv: null,
  q: `A project has these annual cash flows, starting with the initial investment in year 0: ${FLOWS.join(', ')}. What is its internal rate of return (IRR)?`,
  fmt: 'the IRR as a decimal rounded to 6 places (e.g. 0.123456)', truth: Math.round(lo * 1e6) / 1e6,
  check: Math.round(hfScalar(`=IRR({${FLOWS.join(',')}})`) * 1e6) / 1e6, tol: 1.5e-6 });

const P = 425000, rate = 0.06375 / 12, n = 360;
const pmt = (P * rate) / (1 - Math.pow(1 + rate, -n));
tasks.push({ id: 'loan_payment', category: 'finance', size: '-', rows: 0, csv: null,
  q: 'A $425,000 30-year fixed mortgage has a 6.375% annual interest rate, compounded and paid monthly. What is the monthly payment, and how much interest is paid in total over the life of the loan?',
  fmt: 'two values rounded to 2 decimals, in the form "ANSWER: PAYMENT=<v>; INTEREST=<v>"',
  truth: { PAYMENT: r2(pmt), INTEREST: r2(pmt * n - P) },
  check: { PAYMENT: r2(-hfScalar('=PMT(0.06375/12,360,425000)')), INTEREST: r2(-hfScalar('=PMT(0.06375/12,360,425000)') * 360 - 425000) },
  tol: 2 }); // interest = payment × 360 − principal; rounding the payment to cents first moves it by up to $1.80
let bal = P;
for (let k = 0; k < 60; k++) bal = bal * (1 + rate) - pmt;
tasks.push({ id: 'loan_balance', category: 'finance', size: '-', rows: 0, csv: null,
  q: 'A $425,000 30-year fixed mortgage has a 6.375% annual interest rate, compounded and paid monthly. What is the remaining principal balance immediately after the 60th monthly payment?',
  fmt: 'a single number rounded to 2 decimals', truth: r2(bal),
  check: r2(-hfScalar('=FV(0.06375/12,60,PMT(0.06375/12,360,425000),425000)')), tol: 0.011 });

// --- Agreement gate -------------------------------------------------------------------
const close = (a, b, tol) => typeof a === 'number' ? Math.abs(a - b) <= tol : Object.keys(a).every((k) => Math.abs(a[k] - b[k]) <= tol);
let bad = 0;
for (const t of tasks) {
  const ok = close(t.truth, t.check, t.tol);
  if (!ok) bad++;
  console.log(`${ok ? 'ok ' : 'BAD'} ${t.id.padEnd(13)} rows=${String(t.rows).padStart(4)} truth=${JSON.stringify(t.truth)} hf=${JSON.stringify(t.check)}`);
}
if (bad) { console.error(`${bad} task(s) disagree between implementations`); process.exit(1); }

fs.mkdirSync(path.join(cacheDir, 'data'), { recursive: true });
for (const t of tasks) if (t.csv) fs.writeFileSync(path.join(cacheDir, 'data', `${t.id}.csv`), t.csv);
fs.writeFileSync(path.join(cacheDir, 'tasks.json'), JSON.stringify(tasks, null, 1));
console.log(`wrote ${tasks.length} tasks; seeds ${Object.entries(datasets).map(([k, d]) => `${k}=${d.seed}`).join(' ')}`);
