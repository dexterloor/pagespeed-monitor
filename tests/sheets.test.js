'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildReport } = require('../scripts/lib/psi');
const { fallbackAnalysis } = require('../scripts/lib/analysis');
const {
  HISTORY_COLUMNS, FINDINGS_COLUMNS, historyRows, findingsRow,
} = require('../scripts/lib/sheets');
const { makePsi, opportunity } = require('./helpers/psi-factory');

const report = buildReport([
  makePsi({ strategy: 'mobile', performance: 0.6, audits: { 'unused-javascript': opportunity('JS', 500) } }),
  makePsi({ strategy: 'desktop', performance: 0.95 }),
]);

test('historyRows writes one row per strategy with every column', () => {
  const rows = historyRows(report, { runId: 'r1', trigger: 'schedule' });
  assert.equal(rows.length, 2);
  for (const row of rows) assert.deepEqual(Object.keys(row), HISTORY_COLUMNS);
  const mobile = rows.find((r) => r.strategy === 'mobile');
  assert.equal(mobile.flagged, true);
  assert.match(mobile.flag_reasons, /performance 0.6 < 0.9/);
});

test('findingsRow flattens root causes and records the analysis source', () => {
  const row = findingsRow(report, { source: 'fallback', fallback_reason: 'timeout', analysis: fallbackAnalysis(report) }, { runId: 'r1' });
  assert.deepEqual(Object.keys(row), FINDINGS_COLUMNS);
  assert.equal(row.mobile_score, 0.6);
  assert.equal(row.desktop_score, 0.95);
  assert.match(row.root_causes, /^1\. JavaScript \[mobile, ~500ms, medium\]: /);
  assert.equal(row.analysis_source, 'fallback');
  assert.equal(row.fallback_reason, 'timeout');
});
