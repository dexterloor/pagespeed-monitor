'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildReport } = require('../scripts/lib/psi');
const {
  riskFromReport, validateAnalysis, fallbackAnalysis, parseClaudeEnvelope,
} = require('../scripts/lib/analysis');
const { makePsi, opportunity } = require('./helpers/psi-factory');

const report = buildReport([
  makePsi({
    strategy: 'mobile',
    performance: 0.62,
    audits: {
      'unused-javascript': opportunity('Reduce unused JavaScript', 450),
      'image-delivery-insight': opportunity('Improve image delivery', 1200),
    },
  }),
  makePsi({
    strategy: 'desktop',
    performance: 0.88,
    audits: { 'unused-javascript': opportunity('Reduce unused JavaScript', 150) },
  }),
]);

const goodAnalysis = () => ({
  summary: 'The page is slow on mobile, mostly because of large images.',
  risk: 'high',
  root_causes: [{
    cause: 'Oversized images',
    affects: 'mobile',
    audit_ids: ['image-delivery-insight'],
    est_savings_ms: 1200,
    fix: 'Serve WebP images at display size.',
    effort: 'small',
  }],
  quick_win: 'Compress the hero image.',
});

test('riskFromReport follows the rubric', () => {
  assert.equal(riskFromReport(report), 'high'); // 1200ms saving
  const medium = buildReport([makePsi({ performance: 0.85 })]);
  assert.equal(riskFromReport(medium), 'medium');
  const low = buildReport([makePsi({ performance: 0.95, audits: { 'unused-javascript': opportunity('JS', 150) } })]);
  assert.equal(riskFromReport(low), 'low');
  const veryLow = buildReport([makePsi({ performance: 0.3 })]);
  assert.equal(riskFromReport(veryLow), 'high');
});

test('validateAnalysis accepts a well-formed analysis', () => {
  assert.equal(validateAnalysis(goodAnalysis(), report).ok, true);
});

test('validateAnalysis rejects audit ids that are not in the report', () => {
  const a = goodAnalysis();
  a.root_causes[0].audit_ids = ['made-up-audit'];
  const res = validateAnalysis(a, report);
  assert.equal(res.ok, false);
  assert.match(res.errors.join(), /not in report: made-up-audit/);
});

test('validateAnalysis reports every problem at once', () => {
  const res = validateAnalysis({ summary: '', risk: 'severe', root_causes: [], extra: 1 }, report);
  assert.equal(res.ok, false);
  const msg = res.errors.join(' | ');
  for (const part of ['unexpected field "extra"', 'summary', 'risk', 'quick_win', 'root_causes']) {
    assert.ok(msg.includes(part), `expected error about ${part}: ${msg}`);
  }
});

test('validateAnalysis checks root cause fields', () => {
  const a = goodAnalysis();
  Object.assign(a.root_causes[0], { affects: 'tablet', effort: 'huge', est_savings_ms: -5, fix: '' });
  const msg = validateAnalysis(a, report).errors.join(' | ');
  for (const part of ['affects', 'effort', 'est_savings_ms', 'fix']) assert.ok(msg.includes(part), part);
});

test('validateAnalysis rejects non-objects', () => {
  assert.equal(validateAnalysis(null, report).ok, false);
  assert.equal(validateAnalysis([], report).ok, false);
});

test('fallbackAnalysis is valid against the same contract and merges strategies', () => {
  const fb = fallbackAnalysis(report);
  assert.equal(validateAnalysis(fb, report).ok, true);
  assert.equal(fb.risk, 'high');
  assert.match(fb.summary, /62 on mobile and 88 on desktop/);
  assert.match(fb.summary, /AI analysis was unavailable/);
  const js = fb.root_causes.find((rc) => rc.cause === 'JavaScript');
  assert.equal(js.affects, 'both');
  assert.equal(js.est_savings_ms, 450);
  assert.equal(fb.root_causes[0].cause, 'Images');
});

test('fallbackAnalysis handles a low score with no opportunities', () => {
  const fb = fallbackAnalysis(buildReport([makePsi({ performance: 0.7 })]));
  assert.equal(fb.root_causes.length, 1);
  assert.equal(fb.risk, 'medium');
});

test('parseClaudeEnvelope reads structured_output first', () => {
  const out = JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'ignored', structured_output: { a: 1 } });
  assert.deepEqual(parseClaudeEnvelope(out), { ok: true, value: { a: 1 } });
});

test('parseClaudeEnvelope falls back to result text, including fenced JSON', () => {
  const out = JSON.stringify({ subtype: 'success', is_error: false, result: '```json\n{"a":1}\n```' });
  assert.deepEqual(parseClaudeEnvelope(out), { ok: true, value: { a: 1 } });
});

test('parseClaudeEnvelope reports errors', () => {
  assert.equal(parseClaudeEnvelope('not json').ok, false);
  assert.match(parseClaudeEnvelope(JSON.stringify({ is_error: true, subtype: 'error_max_turns' })).error, /error_max_turns/);
  assert.match(parseClaudeEnvelope(JSON.stringify({ subtype: 'success', result: 'Sure! Here it is' })).error, /not valid JSON/);
  assert.match(parseClaudeEnvelope(JSON.stringify({ subtype: 'success' })).error, /no result/);
});

test('validateAnalysis accepts causes backed by diagnostics', () => {
  const withDiag = buildReport([makePsi({
    performance: 0.6,
    audits: { 'lcp-discovery-insight': { title: 'LCP request discovery', score: 0, metricSavings: { LCP: 0 } } },
  })]);
  const a = goodAnalysis();
  a.root_causes[0] = { ...a.root_causes[0], audit_ids: ['lcp-discovery-insight'], est_savings_ms: 0 };
  assert.equal(validateAnalysis(a, withDiag).ok, true);
});
