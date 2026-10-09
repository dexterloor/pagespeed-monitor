'use strict';

// The risk rubric from prompts/analyze-report.md, in code. Every findings row gets
// its risk from here (Claude, fallback and error rows alike), so the same scores
// always give the same risk.
function riskFromReport(report) {
  const summaries = Object.values(report.strategies);
  const worstScore = Math.min(...summaries.map((s) => s.performance));
  const biggestSaving = Math.max(0, ...summaries.flatMap((s) => s.opportunities.map((o) => o.savings_ms)));
  if (worstScore < 0.5 || biggestSaving >= 1000) return 'high';
  if (worstScore < 0.9 || biggestSaving >= 300) return 'medium';
  return 'low';
}

module.exports = { riskFromReport };
