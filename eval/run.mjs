// Eval runner: three arms (A no tools, B Python sandbox, C HyperFormula MCP) over the tasks in
// eval/.cache/tasks.json, every model called through a LiteLLM gateway (OpenAI-compatible chat
// completions with function calling). Appends one JSON line per trial; re-running resumes.
//
//   node eval/run.mjs --stage 1 --runs 0 [--models a,b] [--arms A,B,C] [--tasks id,id] [--concurrency 6]
//
// Env: LITELLM_API_KEY and LITELLM_BASE_URL (both required; any LiteLLM proxy with these models),
//      HF_MCP_URL (default http://127.0.0.1:8787/mcp, a local `wrangler dev` of this repo).
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { parseArgs } from 'node:util';

const here = path.dirname(new URL(import.meta.url).pathname);
const { values: opt } = parseArgs({ options: {
  stage: { type: 'string', default: '1' },
  runs: { type: 'string', default: '0' }, // comma list of run indexes, e.g. "1,2"
  models: { type: 'string' },
  arms: { type: 'string', default: 'A,B,C' },
  tasks: { type: 'string' },
  concurrency: { type: 'string', default: '6' },
  out: { type: 'string' },
} });

export const MODELS = [
  'anthropic/claude-sonnet-5-5', 'anthropic/claude-haiku-5-5',
  'openai/gpt-6.2-sol', 'openai/gpt-5.4-mini',
  'gemini/gemini-3.1-pro-preview', 'gemini/gemini-3.8-flash',
];
const KEY = process.env.LITELLM_API_KEY;
const BASE = process.env.LITELLM_BASE_URL;
const MCP_URL = process.env.HF_MCP_URL || 'http://127.0.0.1:8787/mcp';
const MAX_TURNS = 8;
const MAX_TOKENS = 32000;
const SANDBOX_IMAGE = 'hf-eval-sandbox:1';
const SANDBOX_TIMEOUT_MS = 30000;
if (!KEY || !BASE) { console.error('LITELLM_API_KEY and LITELLM_BASE_URL must be set'); process.exit(1); }

const TASKS = JSON.parse(fs.readFileSync(path.join(here, '.cache/tasks.json'), 'utf8'))
  .filter((t) => !opt.tasks || opt.tasks.split(',').includes(t.id));
const models = opt.models ? opt.models.split(',') : MODELS;
const arms = opt.arms.split(',');
const runs = opt.runs.split(',').map(Number);
const outFile = opt.out || path.join(here, 'results', `stage-${opt.stage}.jsonl`);

// --- Prompts (identical user prompt across arms; system prompt differs only in the tool sentence)
const BASE_SYS = 'You are a data assistant for spreadsheet users. Answer the question about the data the user provides.';
const SYS = {
  A: BASE_SYS,
  B: `${BASE_SYS} You have a Python sandbox (pandas, numpy, numpy_financial); use it for any calculation instead of computing in your head. When the user provides data, it is also available in the sandbox at /data/input.csv.`,
  C: `${BASE_SYS} You have spreadsheet calculation tools; use them for any calculation instead of computing in your head.`,
};
const userPrompt = (t) => (t.csv ? `Here is my data (CSV):\n\n${t.csv}\n\n` : '')
  + `${t.q}\n\nEnd your reply with a final line in the form "ANSWER: <value>", where <value> is ${t.fmt}.`;

// --- Tools
async function mcp(method, params) {
  for (let a = 0; a < 5; a++) {
    const r = await fetch(MCP_URL, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
    if (r.status === 429) { await sleep(5000); continue; }
    const text = await r.text();
    const json = text.startsWith('{') ? JSON.parse(text) : JSON.parse(text.split('\n').find((l) => l.startsWith('data:')).slice(5));
    return json.result ?? { content: [{ type: 'text', text: `Error: ${json.error?.message}` }] };
  }
  return { content: [{ type: 'text', text: 'Error: rate limited' }] };
}
const MCP_TOOLS = (await mcp('tools/list', {})).tools
  .map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.inputSchema } }));
const SANDBOX_TOOL = [{ type: 'function', function: { name: 'run_python',
  description: 'Run a Python 3.12 script in an isolated sandbox with pandas, numpy and numpy_financial installed, and return its stdout and stderr. No network. If the user provided data, it is at /data/input.csv. Print what you need to see.',
  parameters: { type: 'object', properties: { code: { type: 'string', description: 'Python source to run.' } }, required: ['code'] } } }];

function runPython(code, task) {
  return new Promise((resolve) => {
    const args = ['run', '--rm', '-i', '--network', 'none', '--memory', '512m', '--cpus', '1', '--read-only', '--tmpfs', '/tmp'];
    if (task.csv) args.push('-v', `${path.join(here, '.cache/data', `${task.id}.csv`)}:/data/input.csv:ro`);
    args.push(SANDBOX_IMAGE, 'python', '-');
    const p = spawn('docker', args);
    let out = '';
    const timer = setTimeout(() => { p.kill('SIGKILL'); out += '\n[timed out after 30 s]'; }, SANDBOX_TIMEOUT_MS);
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { out += d; });
    p.on('close', (codeExit) => { clearTimeout(timer); resolve((out || `(no output, exit ${codeExit})`).slice(0, 4000)); });
    p.stdin.end(code);
  });
}

// --- Model calls
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function chat(model, messages, tools) {
  const body = { model, messages, max_tokens: MAX_TOKENS };
  if (tools) body.tools = tools;
  for (let a = 0; a < 5; a++) {
    let r;
    try {
      r = await fetch(`${BASE}/v1/chat/completions`, { method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` }, body: JSON.stringify(body),
        signal: AbortSignal.timeout(600000) });
    } catch (e) { await sleep(10000 * (a + 1)); continue; }
    const j = await r.json().catch(() => ({ error: { message: `non-JSON ${r.status}` } }));
    if (r.ok) return { j, cost: Number(r.headers.get('x-litellm-response-cost')) || 0 };
    if (r.status === 429 || r.status >= 500) { await sleep(10000 * (a + 1)); continue; }
    throw new Error(`${r.status} ${JSON.stringify(j.error || j).slice(0, 300)}`);
  }
  throw new Error('gateway retries exhausted');
}

// --- Scoring
export function score(t, text) {
  const m = [...(text || '').matchAll(/ANSWER:\s*(.+)/gi)].pop();
  if (!m) return { ok: false, parsed: null };
  const v = m[1].replace(/[*`]/g, '');
  const num = (s) => parseFloat(s.replace(/[$,\s]/g, ''));
  if (typeof t.truth === 'number') {
    let x = num(v);
    if (t.id === 'irr' && /%/.test(v)) x /= 100;
    return { ok: Math.abs(x - t.truth) <= t.tol, parsed: Number.isFinite(x) ? x : null };
  }
  const got = {};
  for (const k of Object.keys(t.truth)) {
    const mm = v.match(new RegExp(`${k}\\s*[=:]\\s*\\$?([-\\d.,]+)`, 'i'));
    got[k] = mm ? num(mm[1]) : null;
  }
  return { ok: Object.keys(t.truth).every((k) => got[k] != null && Math.abs(got[k] - t.truth[k]) <= t.tol), parsed: got };
}

// --- One trial
async function trial(model, arm, t, run) {
  const t0 = Date.now();
  const messages = [{ role: 'system', content: SYS[arm] }, { role: 'user', content: userPrompt(t) }];
  const tools = arm === 'B' ? SANDBOX_TOOL : arm === 'C' ? MCP_TOOLS : null;
  const rec = { stage: opt.stage, model, arm, task: t.id, category: t.category, size: t.size, run,
    requests: 0, inTok: 0, outTok: 0, cachedTok: 0, reasoningTok: 0, cost: 0, toolCalls: [], finish: [], error: null, final: '' };
  try {
    for (let turn = 0; turn < MAX_TURNS; turn++) {
      const { j, cost } = await chat(model, messages, tools);
      rec.requests++; rec.cost += cost;
      rec.inTok += j.usage?.prompt_tokens || 0; rec.outTok += j.usage?.completion_tokens || 0;
      rec.cachedTok += j.usage?.prompt_tokens_details?.cached_tokens || 0;
      rec.reasoningTok += j.usage?.completion_tokens_details?.reasoning_tokens || 0;
      const choice = j.choices?.[0]; const msg = choice?.message || { role: 'assistant', content: '' };
      rec.finish.push(choice?.finish_reason);
      messages.push(msg);
      if (!msg.tool_calls?.length) { rec.final = msg.content || ''; break; }
      for (const tc of msg.tool_calls) {
        let args = null;
        try { args = JSON.parse(tc.function.arguments || '{}'); } catch { /* broken JSON, usually a truncated call */ }
        let result;
        const call = { name: tc.function.name, argChars: (tc.function.arguments || '').length };
        if (!args) result = 'Error: tool arguments were not valid JSON.';
        else if (arm === 'B') {
          result = await runPython(String(args.code ?? ''), t);
          call.code = String(args.code ?? '').slice(0, 1500);
          call.readsFile = /\/data\/input\.csv/.test(args.code ?? '');
        } else {
          const r = await mcp('tools/call', { name: tc.function.name, arguments: args });
          result = r?.content?.map((c) => c.text).join('\n') ?? JSON.stringify(r);
          call.formulas = args.formulas; call.by = args.by; call.aggregates = args.aggregates;
          const sent = args.csv ?? (args.data ? JSON.stringify(args.data) : null);
          call.dataChars = sent?.length ?? 0;
          call.dataExact = t.csv && typeof args.csv === 'string' ? args.csv.trim() === t.csv.trim() : null;
        }
        call.result = result.slice(0, 800);
        rec.toolCalls.push(call);
        messages.push({ role: 'tool', tool_call_id: tc.id, content: result });
      }
    }
  } catch (e) { rec.error = String(e.message || e); }
  Object.assign(rec, score(t, rec.final), { truth: t.truth, ms: Date.now() - t0 });
  rec.final = rec.final.slice(-1500);
  return rec;
}

// --- Schedule (resumable)
fs.mkdirSync(path.dirname(outFile), { recursive: true });
const done = new Set(fs.existsSync(outFile)
  ? fs.readFileSync(outFile, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
    .filter((r) => !r.error).map((r) => `${r.model}|${r.arm}|${r.task}|${r.run}`)
  : []);
const jobs = [];
for (const run of runs) for (const t of TASKS) for (const arm of arms) for (const model of models)
  if (!done.has(`${model}|${arm}|${t.id}|${run}`)) jobs.push([model, arm, t, run]);
console.log(`stage ${opt.stage}: ${jobs.length} trials to run (${done.size} already done) → ${path.relative(process.cwd(), outFile)}`);

let next = 0, finished = 0, spend = 0;
await Promise.all(Array.from({ length: Number(opt.concurrency) }, async () => {
  while (next < jobs.length) {
    const r = await trial(...jobs[next++]);
    fs.appendFileSync(outFile, `${JSON.stringify(r)}\n`);
    finished++; spend += r.cost;
    console.log(`${finished}/${jobs.length} ${r.model} ${r.arm} ${r.task} ok=${r.ok} req=${r.requests} in=${r.inTok} out=${r.outTok} $${r.cost.toFixed(4)} ${Math.round(r.ms / 1000)}s total=$${spend.toFixed(2)}${r.error ? ` ERR ${r.error.slice(0, 120)}` : ''}`);
  }
}));
