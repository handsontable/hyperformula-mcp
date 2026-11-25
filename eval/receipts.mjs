// For the MCP arm: does the formula the model sent contain the question (criteria over the full dataset),
// or did the model pick the values itself? Compares one or more result files side by side.
//   node eval/receipts.mjs eval/results/stage-1.jsonl eval/results/stage-1-toolfix.jsonl
import fs from 'node:fs';
import path from 'node:path';

export function receiptKind(r) {
  if (r.size === '-') return 'finance';
  const calls = r.toolCalls;
  if (!calls.length) return 'no tool call';
  const txt = calls.map((t) => JSON.stringify(t.formulas || '') + (t.by ? ` groupby:${t.by}` : '')).join(' ');
  const fullData = calls.some((t) => t.dataExact === true);
  const criteria = r.category === 'filtered_sum' ? /SUMIFS|SUMPRODUCT|FILTER/i.test(txt) && /EMEA/.test(txt)
    : r.category === 'median_by_group' ? /groupby:Region/.test(txt) || /MEDIAN\((IF|FILTER)/i.test(txt)
    : /XLOOKUP|INDEX|MATCH|FILTER|VLOOKUP|SUMIFS/i.test(txt);
  if (criteria && fullData) return 'question in formula';
  if (criteria) return 'criteria, partial data';
  return 'model picked values';
}

const declined = (r) => /too (large|big|long)|send (it|the data) in full|can't send|cannot send/i.test(r.final || '');
const files = process.argv.slice(2);
const sets = files.map((f) => ({ name: path.basename(f, '.jsonl'),
  rows: fs.readFileSync(f, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((r) => r.arm === 'C') }));
const pad = (s, n) => String(s).padEnd(n);
const col = (fn) => sets.map((s) => pad(fn(s.rows), 22)).join('');

console.log(pad('', 34) + sets.map((s) => pad(s.name, 22)).join(''));
for (const size of ['S', 'M', 'L', '-']) {
  const lbl = { S: '20 rows', M: '200 rows', L: '2,000 rows', '-': 'finance' }[size];
  console.log(pad(`accuracy ${lbl}`, 34) + col((R) => { const a = R.filter((r) => r.size === size); return `${a.filter((r) => r.ok).length}/${a.length}`; }));
}
for (const size of ['S+M', 'L']) {
  const inSize = (r) => (size === 'S+M' ? r.size === 'S' || r.size === 'M' : r.size === 'L');
  for (const k of ['question in formula', 'criteria, partial data', 'model picked values', 'no tool call']) {
    console.log(pad(`${size}: ${k}`, 34) + col((R) => { const a = R.filter(inSize); const b = a.filter((r) => receiptKind(r) === k); return `${b.length}/${a.length} (ok ${b.filter((r) => r.ok).length})`; }));
  }
}
console.log(pad('L: tool calls with full CSV', 34) + col((R) => { const c = R.filter((r) => r.size === 'L').flatMap((r) => r.toolCalls); return `${c.filter((t) => t.dataExact === true).length}/${c.length}`; }));
console.log(pad('L: told user data too large', 34) + col((R) => `${R.filter((r) => r.size === 'L' && declined(r)).length}/${R.filter((r) => r.size === 'L').length}`));
console.log(pad('L: hit output limit', 34) + col((R) => `${R.filter((r) => r.size === 'L' && r.finish.includes('length')).length}/${R.filter((r) => r.size === 'L').length}`));
const avg = (R, k, f = () => true) => { const a = R.filter(f); return Math.round(a.reduce((s, r) => s + r[k], 0) / a.length); };
console.log(pad('input tokens / trial (S+M)', 34) + col((R) => avg(R, 'inTok', (r) => r.size === 'S' || r.size === 'M')));
console.log(pad('output tokens / trial (S+M)', 34) + col((R) => avg(R, 'outTok', (r) => r.size === 'S' || r.size === 'M')));
console.log(pad('cost total', 34) + col((R) => `$${R.reduce((s, r) => s + r.cost, 0).toFixed(2)}`));
