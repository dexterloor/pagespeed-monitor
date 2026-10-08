# Samples

| File | What it is |
|---|---|
| `report-flagged.illustrative.json` | Output of `scripts/lib/psi.js#buildReport` for a flagged page (3 mobile + 3 desktop runs) |
| `analysis-claude.illustrative.json` | Output of `scripts/analyze.js` for that report, from a real `claude -p` run |
| `analysis-fallback.illustrative.json` | The same report with `ANALYZE_FORCE_FALLBACK=1`: what the sheet and Slack get if the AI step fails |

The illustrative report is built from synthetic PSI responses (same shape as the real
API) so the samples are stable.

`samples/real/` holds a real run against https://www.theverge.com/ (Lighthouse 13.5,
2026-10-08): the report built from one mobile and one desktop PSI response
(`tests/fixtures/`), and Claude's analysis of it. A full workflow run averages 3 runs
per strategy.

Regenerate:

```bash
node scripts/analyze.js --file samples/report-flagged.illustrative.json
ANALYZE_FORCE_FALLBACK=1 node scripts/analyze.js --file samples/report-flagged.illustrative.json
```
