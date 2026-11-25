# Eval: no tools vs. code sandbox vs. HyperFormula MCP

Measures how accurate, expensive, and fast an agent is on spreadsheet-style questions in three setups:

| Arm | Tools | Data |
|---|---|---|
| A | none | CSV in the prompt |
| B | `run_python` in a Docker container (pandas, numpy, numpy_financial; no network, read-only, 512 MB, 30 s) | CSV in the prompt and at `/data/input.csv` |
| C | the three MCP tools from this repo (`calc_formulas`, `calc_groupby`, `calc_grid`) | CSV in the prompt; the model passes it in the call |

Every model is called through a LiteLLM gateway (OpenAI-compatible chat completions with function calling), so one
loop serves all vendors. The user prompt is identical across arms; the system prompt differs only in one sentence
describing the tools. Max 8 turns and 32,000 output tokens per request.

## Tasks

`tasks.mjs` builds 12 tasks from seeded synthetic sales data at 20, 200, and 2,000 rows: a two-condition filtered sum,
median per region, and a two-key lookup at each size, plus IRR, mortgage payment and total interest, and remaining
balance after 60 payments. Each ground truth is computed twice, in plain JavaScript and in HyperFormula, and the
script refuses to write the task file unless both agree.

Answers are scored numerically from the final `ANSWER:` line (0.01 tolerance; 1.5e-6 for IRR; $2 for lifetime
interest). There's no LLM judge.

## Run

```bash
docker build -t hf-eval-sandbox:1 eval/sandbox
npx wrangler dev --port 8787 --ip 127.0.0.1   # arm C runs against this local Worker
node eval/tasks.mjs
LITELLM_BASE_URL=… LITELLM_API_KEY=… node eval/run.mjs --stage 1 --runs 0
node eval/report.mjs eval/results/stage-1.jsonl
```

`run.mjs` appends one JSON line per trial and skips trials already in the output file, so an interrupted stage
resumes where it stopped. Options: `--models`, `--arms`, `--tasks`, `--runs 1,2`, `--concurrency`.

## Stages

| Stage | Runs | Trials |
|---|---|---|
| 1 | run 0 | 6 models × 3 arms × 12 tasks = 216 |
| 2 | runs 1–2 | 432 |
| 3 | runs 3–4 | 432 |

Prompts and tasks are frozen after stage 1. Cost per trial comes from the gateway's `x-litellm-response-cost` header.
