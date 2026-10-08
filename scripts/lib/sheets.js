'use strict';

// Maps reports and analyses to rows for the three Google Sheets tabs.
// Column order here is the source of truth for docs/sheets-setup.md.

const HISTORY_COLUMNS = [
  'timestamp', 'run_id', 'trigger', 'url', 'strategy', 'performance', 'best_practices',
  'lcp_ms', 'fcp_ms', 'tbt_ms', 'cls', 'si_ms', 'runs', 'flagged', 'flag_reasons',
];

const FINDINGS_COLUMNS = [
  'timestamp', 'run_id', 'url', 'risk', 'mobile_score', 'desktop_score', 'summary',
  'root_causes', 'quick_win', 'analysis_source', 'fallback_reason',
];

const ERRORS_COLUMNS = [
  'timestamp', 'run_id', 'workflow', 'node', 'url', 'error_message', 'http_status', 'attempts',
];

// One row per strategy, written on every run.
function historyRows(report, { runId, trigger }) {
  return Object.entries(report.strategies).map(([strategy, s]) => ({
    timestamp: report.generated_at,
    run_id: runId,
    trigger,
    url: report.url,
    strategy,
    performance: s.performance,
    best_practices: s.best_practices,
    lcp_ms: s.metrics.lcp_ms,
    fcp_ms: s.metrics.fcp_ms,
    tbt_ms: s.metrics.tbt_ms,
    cls: s.metrics.cls,
    si_ms: s.metrics.si_ms,
    runs: s.runs,
    flagged: s.flagged,
    flag_reasons: s.flag_reasons.join('; '),
  }));
}

// One row per flagged URL. Root causes are flattened to readable lines so the
// sheet works for people who never open the JSON.
function findingsRow(report, analysisResult, { runId }) {
  const a = analysisResult.analysis;
  const score = (s) => (report.strategies[s] ? report.strategies[s].performance : null);
  return {
    timestamp: report.generated_at,
    run_id: runId,
    url: report.url,
    risk: a.risk,
    mobile_score: score('mobile'),
    desktop_score: score('desktop'),
    summary: a.summary,
    root_causes: a.root_causes
      .map((rc, i) => `${i + 1}. ${rc.cause} [${rc.affects}, ~${rc.est_savings_ms}ms, ${rc.effort}]: ${rc.fix}`)
      .join('\n'),
    quick_win: a.quick_win,
    analysis_source: analysisResult.source,
    fallback_reason: analysisResult.fallback_reason || '',
  };
}

module.exports = {
  HISTORY_COLUMNS, FINDINGS_COLUMNS, ERRORS_COLUMNS, historyRows, findingsRow,
};
