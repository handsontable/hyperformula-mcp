# hyperformula-mcp

| Field | Value |
|-------|-------|
| **Owner** | GreenFlux |
| **Team** | DevRel |
| **Platform** | netlify |
| **Live URL** | https://69d7ef8b4b51b737a6805d19--hyperformula-mcp.netlify.app |
| **Repo** | https://github.com/handsontable/hyperformula-mcp |
| **ClickUp** | https://app.clickup.com/t/9015210959/HF-62 |
| **Tags** | testing, LLMs |

## Description

Stateless spreadsheet calculations via HTTP. Formulas instead of code.

## Quick Start

```bash
git clone https://github.com/handsontable/hyperformula-mcp
cd hyperformula-mcp
npm install
```

## Performance

Benchmarked with a 50,000-row sales dataset (14 columns, 6MB CSV) on Apple M4 Max / Node 22.

| Mode | Details | Avg Time |
|------|---------|----------|
| Formulas + named columns | 7 formulas (SUM, AVERAGE, MAX, COUNTA) | ~1,016ms |
| Formulas + cell references | 3 formulas, no headers | ~560ms |
| GroupBy (7 groups) | by Region, 3 aggregates (SUM) | ~1,707ms |
| GroupBy (12 groups) | by Item Type, 4 aggregates (SUM, AVERAGE) | ~2,838ms |
| GroupBy (2 groups) | by Sales Channel, 3 aggregates (SUM) | ~1,127ms |
| Small dataset baseline | 3 rows, 3 formulas | ~7ms |

Times are server-side `durationMs` (excludes network and CSV parsing overhead).

---

*Published with [handsoncode-publisher](https://github.com/handsontable/handsoncode-cli)*
