// Summarizes eval results: accuracy, failure kinds, tokens, and cost, plus a projection for further runs.
//   node eval/report.mjs eval/results/stage-1.jsonl [--project-runs 4]
import fs from 'node:fs';
import { parseArgs } from 'node:util';

const { values: opt, positionals } = parseArgs({ allowPositionals: true, options: { 'project-runs': { type: 'string', default: '4' } } });
const R = positionals.flatMap((f) => fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)));
const by = (f) => R.reduce((m, r) => ((m[f(r)] ??= []).push(r), m), {});
const sum = (a, k) => a.reduce((s, r) => s + (r[k] || 0), 0);
const pct = (a) => `${a.filter((r) => r.ok).length}/${a.length}`;
const money = (x) => `$${x.toFixed(2)}`;
const M = (x) => `${(x / 1e6).toFixed(2)}M`;
const ARMS = ['A', 'B', 'C'];
const armRows = (a) => ARMS.map((x) => pct(a.filter((r) => r.arm === x)).padEnd(7)).join(' ');

function failureKind(r) {
  if (r.ok) return null;
  if (r.error) return 'gateway/error';
  if (r.finish.includes('length')) return 'output limit';
  if (r.parsed == null) return 'no answer';
  if (r.arm === 'A') return 'wrong (no tools)';
  if (!r.toolCalls.length) return 'skipped tool';
  if (r.arm === 'C' && r.toolCalls.some((t) => t.dataExact === false || (t.dataChars > 0 && t.dataExact === null))) return 'data not passed whole';
  if (r.arm === 'B' && r.size !== '-' && !r.toolCalls.some((t) => t.readsFile)) return 'data not read from file';
  return 'wrong method/formula';
}

console.log(`# ${R.length} trials, ${new Set(R.map((r) => r.model)).size} models\n`);
console.log('## Accuracy by task            A(no tools) B(sandbox) C(MCP)');
for (const [k, a] of Object.entries(by((r) => r.task))) console.log(`${k.padEnd(30)} ${armRows(a)}`);
console.log(`${'ALL'.padEnd(30)} ${armRows(R)}`);
console.log(`${'ALL except L (2,000 rows)'.padEnd(30)} ${armRows(R.filter((r) => r.size !== 'L'))}`);
console.log('\n## Accuracy by model           A       B       C');
for (const [k, a] of Object.entries(by((r) => r.model))) console.log(`${k.padEnd(30)} ${armRows(a)}`);

console.log('\n## Failure kinds');
const kinds = by((r) => (r.ok ? 'ok' : `${r.arm} ${failureKind(r)}`));
for (const [k, a] of Object.entries(kinds).sort()) if (k !== 'ok') console.log(`${k.padEnd(30)} ${a.length}  [${[...new Set(a.map((r) => `${r.model.split('/')[1]}:${r.task}`))].slice(0, 6).join(', ')}]`);

console.log('\n## Tokens and cost by model');
console.log(`${'model'.padEnd(30)} ${'requests'.padStart(8)} ${'input'.padStart(8)} ${'cached'.padStart(8)} ${'output'.padStart(8)} ${'reason'.padStart(8)} ${'cost'.padStart(9)}`);
for (const [k, a] of Object.entries(by((r) => r.model))) console.log(`${k.padEnd(30)} ${String(sum(a, 'requests')).padStart(8)} ${M(sum(a, 'inTok')).padStart(8)} ${M(sum(a, 'cachedTok')).padStart(8)} ${M(sum(a, 'outTok')).padStart(8)} ${M(sum(a, 'reasoningTok')).padStart(8)} ${money(sum(a, 'cost')).padStart(9)}`);
console.log(`${'TOTAL'.padEnd(30)} ${String(sum(R, 'requests')).padStart(8)} ${M(sum(R, 'inTok')).padStart(8)} ${M(sum(R, 'cachedTok')).padStart(8)} ${M(sum(R, 'outTok')).padStart(8)} ${M(sum(R, 'reasoningTok')).padStart(8)} ${money(sum(R, 'cost')).padStart(9)}`);

console.log('\n## Cost by arm × size (per trial avg)');
for (const [k, a] of Object.entries(by((r) => `${r.arm} ${r.size}`)).sort()) console.log(`${k.padEnd(8)} trials ${String(a.length).padStart(3)}  in ${String(Math.round(sum(a, 'inTok') / a.length)).padStart(7)}  out ${String(Math.round(sum(a, 'outTok') / a.length)).padStart(6)}  req ${(sum(a, 'requests') / a.length).toFixed(1)}  ${(sum(a, 'ms') / a.length / 1000).toFixed(0).padStart(4)} s  ${money(sum(a, 'cost') / a.length)}  total ${money(sum(a, 'cost'))}`);

const runsPerStage = new Set(R.map((r) => r.run)).size;
const perRun = sum(R, 'cost') / runsPerStage;
const n = Number(opt['project-runs']);
console.log(`\n## Projection\nMeasured: ${money(sum(R, 'cost'))} for ${runsPerStage} run(s) → ${money(perRun)} per full run of the matrix.`);
console.log(`${n} more run(s) at the same rate: ~${money(perRun * n)}; total for ${runsPerStage + n} runs: ~${money(perRun * (runsPerStage + n))}.`);
console.log(`Wall time: ${(Math.max(...R.map((r) => r.ms)) / 1000).toFixed(0)} s slowest trial; ${(sum(R, 'ms') / 3600000).toFixed(1)} trial-hours.`);
