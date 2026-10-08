'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  savingsMs, extractRun, averageRuns, groupFindings, flagReasons, buildReport, auditIds,
} = require('../scripts/lib/psi');
const { makePsi, opportunity, insight } = require('./helpers/psi-factory');

test('savingsMs prefers overallSavingsMs', () => {
  assert.equal(savingsMs(opportunity('x', 450)), 450);
});

test('savingsMs falls back to the largest time-based metricSavings and ignores CLS', () => {
  assert.equal(savingsMs(insight('x', { LCP: 300, FCP: 120, CLS: 0.4 })), 300);
  assert.equal(savingsMs(insight('x', { CLS: 0.4 })), 0);
  assert.equal(savingsMs({ score: 0 }), 0);
});

test('extractRun keeps scores, metrics and failing audits with savings only', () => {
  const run = extractRun(makePsi({
    strategy: 'mobile',
    performance: 0.62,
    bestPractices: 0.96,
    metrics: { 'largest-contentful-paint': 4200 },
    audits: {
      'unused-javascript': opportunity('Reduce unused JavaScript', 900),
      'render-blocking-insight': insight('Render blocking requests', { FCP: 350, LCP: 350 }),
      'uses-text-compression': opportunity('Enable text compression', 200, 1), // passing
      'font-display': opportunity('Font display', 0), // no savings
    },
  }));
  assert.equal(run.strategy, 'mobile');
  assert.equal(run.performance, 0.62);
  assert.equal(run.best_practices, 0.96);
  assert.equal(run.metrics.lcp_ms, 4200);
  assert.deepEqual(run.opportunities.map((o) => o.id).sort(), ['render-blocking-insight', 'unused-javascript']);
});

test('extractRun does not treat metric audits as opportunities', () => {
  const psi = makePsi();
  psi.lighthouseResult.audits['largest-contentful-paint'].metricSavings = { LCP: 500 };
  assert.equal(extractRun(psi).opportunities.length, 0);
});

test('extractRun rejects responses without a lighthouse result or score', () => {
  assert.throws(() => extractRun({ error: { code: 429 } }), /missing lighthouseResult/);
  const psi = makePsi();
  psi.lighthouseResult.categories.performance.score = null;
  assert.throws(() => extractRun(psi), /no performance score/);
});

test('averageRuns averages scores and metrics across runs', () => {
  const runs = [0.5, 0.6, 0.7].map((p, i) => extractRun(makePsi({
    performance: p,
    metrics: { 'largest-contentful-paint': 3000 + i * 300, 'cumulative-layout-shift': 0.1 + i * 0.002 },
  })));
  const avg = averageRuns(runs);
  assert.equal(avg.runs, 3);
  assert.equal(avg.performance, 0.6);
  assert.deepEqual(avg.performance_range, [0.5, 0.7]);
  assert.equal(avg.metrics.lcp_ms, 3300);
  assert.equal(avg.metrics.cls, 0.102);
});

test('averageRuns drops opportunities seen in a minority of runs and divides by all runs', () => {
  const runs = [
    { 'unused-javascript': opportunity('JS', 600), 'offscreen-images': opportunity('Img', 900) },
    { 'unused-javascript': opportunity('JS', 300) },
    { },
  ].map((audits) => extractRun(makePsi({ audits })));
  const avg = averageRuns(runs);
  // JS appears in 2 of 3 runs: (600 + 300 + 0) / 3. Images appear in 1 of 3, so it's noise.
  assert.deepEqual(avg.opportunities, [{ id: 'unused-javascript', title: 'JS', savings_ms: 300, seen_in_runs: 2 }]);
});

test('groupFindings groups by root cause, biggest saving first, unknown ids under other', () => {
  const groups = groupFindings([
    { id: 'unused-javascript', title: 'JS', savings_ms: 400 },
    { id: 'legacy-javascript-insight', title: 'Legacy JS', savings_ms: 150 },
    { id: 'image-delivery-insight', title: 'Images', savings_ms: 1200 },
    { id: 'some-future-audit', title: 'New', savings_ms: 50 },
  ]);
  assert.deepEqual(groups.map((g) => g.cause), ['images', 'javascript', 'other']);
  const js = groups.find((g) => g.cause === 'javascript');
  assert.equal(js.max_savings_ms, 400); // max, not sum: savings overlap
  assert.equal(js.audits.length, 2);
});

test('flagReasons uses the 0.9 score and 100ms savings thresholds', () => {
  const ok = { performance: 0.9, opportunities: [{ id: 'a', savings_ms: 99 }] };
  assert.deepEqual(flagReasons(ok), []);

  const lowScore = { performance: 0.89, opportunities: [] };
  assert.deepEqual(flagReasons(lowScore), ['performance 0.89 < 0.9']);

  const bigSaving = { performance: 0.95, opportunities: [{ id: 'unused-javascript', savings_ms: 100 }] };
  assert.match(flagReasons(bigSaving)[0], /1 opportunity saving >= 100ms \(top: unused-javascript 100ms\)/);
});

test('flagReasons accepts custom thresholds', () => {
  assert.deepEqual(flagReasons({ performance: 0.8, opportunities: [] }, { score: 0.5 }), []);
});

test('buildReport splits strategies and flags the URL if any strategy is flagged', () => {
  const responses = [
    ...[0.55, 0.6, 0.65].map((p) => makePsi({
      strategy: 'mobile', performance: p, audits: { 'unused-javascript': opportunity('JS', 800) },
    })),
    ...[0.97, 0.98, 0.99].map((p) => makePsi({ strategy: 'desktop', performance: p })),
  ];
  const report = buildReport(responses, { now: new Date('2026-10-08T12:00:00Z') });
  assert.equal(report.url, 'https://example.com/');
  assert.equal(report.generated_at, '2026-10-08T12:00:00.000Z');
  assert.equal(report.flagged, true);
  assert.equal(report.strategies.mobile.flagged, true);
  assert.equal(report.strategies.desktop.flagged, false);
  assert.equal(report.strategies.desktop.performance, 0.98);
  assert.equal(report.strategies.mobile.root_causes[0].cause, 'javascript');
  assert.ok(report.flag_reasons.every((r) => r.startsWith('mobile: ')));
});

test('buildReport rejects responses for different URLs', () => {
  assert.throws(
    () => buildReport([makePsi({ url: 'https://a.example/' }), makePsi({ url: 'https://b.example/' })]),
    /expects one URL/,
  );
});

// Trimmed real responses (Lighthouse 13.5, captured 2026-10-08) guard against API shape changes.
test('real PSI responses: extract, flag and group as expected', () => {
  const mobile = require('./fixtures/psi-real-theverge-mobile.json');
  const desktop = require('./fixtures/psi-real-theverge-desktop.json');

  const m = extractRun(mobile);
  assert.equal(m.strategy, 'mobile');
  assert.equal(m.lighthouse_version, '13.5.0');
  assert.equal(m.performance, 0.27);
  assert.ok(Object.values(m.metrics).every((v) => typeof v === 'number'));
  const ids = m.opportunities.map((o) => o.id);
  assert.ok(ids.includes('unused-javascript'));
  assert.ok(ids.includes('render-blocking-insight'));
  assert.ok(!ids.includes('largest-contentful-paint'), 'metric audits are not opportunities');
  assert.ok(!ids.includes('image-delivery-insight'), 'zero-savings audits are dropped');

  const report = buildReport([mobile, desktop]);
  assert.equal(report.flagged, true);
  assert.deepEqual(Object.keys(report.strategies).sort(), ['desktop', 'mobile']);
  assert.equal(report.strategies.mobile.root_causes[0].cause, 'javascript');
  assert.ok(report.strategies.mobile.root_causes.every((g) => g.cause !== 'other'), 'every real audit id maps to a known cause');
});

test('extractRun keeps failing zero-savings audits as diagnostics, not opportunities', () => {
  const run = extractRun(makePsi({
    audits: {
      'lcp-discovery-insight': insight('LCP request discovery', { LCP: 0 }),
      'errors-in-console': { title: 'Console errors', score: 0, scoreDisplayMode: 'binary' },
      'image-delivery-insight': insight('Images', { LCP: 0 }, 0.95), // passing enough: ignored
      'non-composited-animations': { title: 'Animations', score: null, metricSavings: { CLS: 0 } }, // informative
      'unused-javascript': opportunity('JS', 300),
    },
  }));
  assert.deepEqual(run.opportunities.map((o) => o.id), ['unused-javascript']);
  assert.deepEqual(run.diagnostics.map((d) => d.id).sort(), ['errors-in-console', 'lcp-discovery-insight']);
});

test('averageRuns applies the majority rule to diagnostics and drops ones that are opportunities', () => {
  const runs = [
    { 'lcp-discovery-insight': insight('LCP', { LCP: 0 }, 0), 'unused-javascript': opportunity('JS', 300) },
    { 'lcp-discovery-insight': insight('LCP', { LCP: 0 }, 0.5), 'unused-javascript': opportunity('JS', 0, 0.5) },
    { 'unused-javascript': opportunity('JS', 300), 'forced-reflow-insight': { title: 'Reflow', score: 0 } },
  ].map((audits) => extractRun(makePsi({ audits })));
  const avg = averageRuns(runs);
  assert.deepEqual(avg.diagnostics, [{ id: 'lcp-discovery-insight', title: 'LCP', score: 0.25 }]);
  assert.deepEqual(avg.opportunities.map((o) => o.id), ['unused-javascript']);
});

test('real PSI responses: diagnostics include LCP discovery and are citable', () => {
  const report = buildReport([
    require('./fixtures/psi-real-theverge-mobile.json'),
    require('./fixtures/psi-real-theverge-desktop.json'),
  ]);
  const ids = report.strategies.mobile.diagnostics.map((d) => d.id);
  assert.ok(ids.includes('lcp-discovery-insight'));
  assert.ok(!ids.includes('unused-javascript'), 'opportunities are not repeated as diagnostics');
  assert.ok(auditIds(report).has('lcp-discovery-insight'));
});

test('buildReport groups on the requested URL even when redirects differ between runs', () => {
  const a = makePsi({ strategy: 'mobile' });
  const b = makePsi({ strategy: 'desktop' });
  b.lighthouseResult.finalUrl = 'https://www.example.co.uk/';
  const report = buildReport([a, b]);
  assert.equal(report.url, 'https://example.com/');
  assert.equal(report.final_url, 'https://example.com/');
});
