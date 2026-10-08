'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { build } = require('../scripts/build-workflows');
const { buildReport } = require('../scripts/lib/psi');
const { fallbackAnalysis } = require('../scripts/lib/analysis');

const mobile = require('./fixtures/psi-real-theverge-mobile.json');
const desktop = require('./fixtures/psi-real-theverge-desktop.json');
const { main, error } = build();
const byName = (wf, name) => wf.nodes.find((n) => n.name === name);

// Runs a Code node's source the way n8n does ("Run Once for All Items"), with the
// n8n globals it uses stubbed.
function runCodeNode(jsCode, { items, matching = {}, executionId = '42' }) {
  const sandbox = {
    Buffer,
    $input: { all: () => items, first: () => items[0] },
    $: (name) => ({ itemMatching: (i) => ({ json: matching[name][i] }) }),
    $execution: { id: executionId },
    $workflow: { name: 'PageSpeed Monitor' },
    $env: {},
  };
  return vm.runInNewContext(`(async () => {\n${jsCode}\n})()`, sandbox);
}

test('committed workflows/ match the generator (run npm run build:workflows)', () => {
  for (const [name, wf] of Object.entries({ main, error })) {
    const file = path.join(__dirname, '..', 'workflows', `${name}.json`);
    assert.equal(fs.readFileSync(file, 'utf8'), `${JSON.stringify(wf, null, 2)}\n`, `${name}.json is stale`);
  }
});

test('workflows contain no secrets or machine-specific paths', () => {
  const text = JSON.stringify({ main, error });
  assert.ok(!/\/Users\/|hooks\.slack\.com|AIza|GOCSPX-/.test(text));
});

test('every connection points at a node that exists', () => {
  for (const wf of [main, error]) {
    const names = new Set(wf.nodes.map((n) => n.name));
    for (const [from, { main: outs }] of Object.entries(wf.connections)) {
      assert.ok(names.has(from), from);
      for (const out of outs) for (const c of out) assert.ok(names.has(c.node), `${from} -> ${c.node}`);
    }
  }
});

test('Build reports node produces the same report as scripts/lib/psi.js', async () => {
  const reqs = [
    { url: 'https://www.theverge.com/', trigger: 'webhook', strategy: 'mobile', run: 1 },
    { url: 'https://www.theverge.com/', trigger: 'webhook', strategy: 'desktop', run: 1 },
    { url: 'https://www.theverge.com/', trigger: 'webhook', strategy: 'mobile', run: 2 },
    { url: 'https://down.example/', trigger: 'webhook', strategy: 'mobile', run: 1 },
    { url: 'https://www.theverge.com/', trigger: 'webhook', strategy: 'desktop', run: 2 },
  ];
  const items = [
    { json: mobile },
    { json: desktop },
    { json: { error: { message: 'Request failed with status code 500', httpCode: '500' } } },
    { json: { error: 'timeout of 120000ms exceeded' } },
    // PSI answered but without a performance score (e.g. category param dropped)
    { json: { lighthouseResult: { categories: { 'best-practices': { score: 1 } }, audits: {} } } },
  ];
  const out = await runCodeNode(byName(main, 'Build reports').parameters.jsCode, {
    items, matching: { 'Make PSI requests': reqs },
  });

  assert.equal(out.length, 2);
  const verge = out[0].json;
  assert.equal(verge.status, 'partial');
  assert.equal(verge.flagged, true);
  assert.equal(verge.run_id, '42');

  const expected = buildReport([mobile, desktop]);
  const { generated_at: a, ...got } = verge.report;
  const { generated_at: b, ...want } = expected;
  assert.deepEqual(JSON.parse(JSON.stringify(got)), want);
  assert.equal(JSON.parse(Buffer.from(verge.report_b64, 'base64')).url, 'https://www.theverge.com/');
  assert.equal(verge.history_rows.length, 2);
  assert.equal(verge.error_rows.length, 2);
  assert.match(verge.error_rows[1].error_message, /^desktop run 2: .*no performance score/);
  assert.match(verge.error_rows[0].error_message, /^mobile run 2: Request failed with status code 500/);
  assert.equal(verge.error_rows[0].http_status, '500');

  const down = out[1].json;
  assert.equal(down.status, 'failed');
  assert.equal(down.report, null);
  assert.equal(down.flagged, false);
  assert.match(down.error_rows[0].error_message, /timeout/);
});

test('Findings row node maps AI output, and survives a failed AI step', async () => {
  const report = buildReport([mobile, desktop]);
  const src = { report, run_id: '42' };
  const good = { source: 'fallback', fallback_reason: 'x', analysis: fallbackAnalysis(report) };
  const out = await runCodeNode(byName(main, 'Findings row').parameters.jsCode, {
    items: [{ json: { stdout: JSON.stringify(good) } }, { json: { stdout: '', stderr: 'node: not found' } }],
    matching: { 'Flagged?': [src, src] },
  });
  assert.equal(out[0].json.analysis_source, 'fallback');
  assert.equal(out[0].json.risk, 'high');
  assert.equal(out[1].json.analysis_source, 'error');
  assert.match(out[1].json.fallback_reason, /not found/);
});

test('Slack digest: one message, nothing when all pages pass', async () => {
  const jsCode = byName(main, 'Slack digest').parameters.jsCode;
  const none = await runCodeNode(jsCode, { items: [{ json: { status: 'ok', url: 'a', error_rows: [] } }] });
  assert.equal(none.length, 0);

  const out = await runCodeNode(jsCode, {
    items: [
      { json: { risk: 'medium', url: 'https://b/', mobile_score: 0.8, desktop_score: 0.95, summary: 'S', quick_win: 'Q', analysis_source: 'claude' } },
      { json: { risk: 'high', url: 'https://a/', mobile_score: 0.3, desktop_score: 0.6, summary: 'S', quick_win: 'Q', analysis_source: 'fallback' } },
      { json: { status: 'ok', url: 'https://a/', error_rows: [] } },
      { json: { status: 'ok', url: 'https://b/', error_rows: [] } },
      { json: { status: 'failed', url: 'https://c/', error_rows: [{}, {}] } },
    ],
  });
  assert.equal(out.length, 1);
  const { text, blocks } = out[0].json;
  assert.equal(text, '%PREFIX%PageSpeed Monitor: 2 of 3 pages need attention');
  assert.match(blocks[1].text.text, /^:red_circle: \*<https:\/\/a\/\|https:\/\/a\/>\*: high risk · mobile 30 · desktop 60 _\(fallback summary\)_/);
  assert.match(blocks[3].text.text, /:x: https:\/\/c\/: no PageSpeed data \(2 failed runs\)/);
});

test('Make PSI requests builds the full PSI query (n8n would merge repeated params)', async () => {
  const out = await runCodeNode(byName(main, 'Make PSI requests').parameters.jsCode, {
    items: [{ json: { url: 'https://example.com/a?b=1', trigger: 'webhook' } }],
  });
  assert.equal(out.length, 6);
  const u = new URL(out[0].json.psi_url);
  assert.equal(u.searchParams.get('url'), 'https://example.com/a?b=1');
  assert.equal(u.searchParams.get('strategy'), 'mobile');
  assert.deepEqual(u.searchParams.getAll('category'), ['performance', 'best-practices']);
  assert.match(u.searchParams.get('fields'), /^id,analysisUTCTimestamp,lighthouseResult\(/);
  assert.ok(!u.searchParams.has('key'), 'the key comes from the credential header');
  for (const name of ['PSI run', 'PSI retry']) {
    assert.equal(byName(main, name).parameters.genericAuthType, 'httpHeaderAuth');
  }
});

test('Check request validates the webhook body', async () => {
  const jsCode = byName(main, 'Check request').parameters.jsCode;
  const check = async (body) => (await runCodeNode(jsCode, { items: [{ json: { body } }] }))[0].json;

  const one = await check({ url: 'https://a.example/' });
  assert.equal(one.valid, true);
  assert.equal(JSON.stringify(one.urls), '["https://a.example/"]');

  const mixed = await check({ urls: ['https://a.example/', 'ftp://x', 'https://a.example/'] });
  assert.equal(JSON.stringify(mixed.urls), '["https://a.example/"]', 'drops invalid and duplicate URLs');

  assert.match((await check({ url: 'nope' })).error, /No valid/);
  assert.match((await check({})).error, /Send \{"url"/);
  const tooMany = Array.from({ length: 11 }, (_, i) => `https://x${i}.example/`);
  assert.match((await check({ urls: tooMany })).error, /At most 10/);
});

test('URLs to check uses the webhook list, or the daily list on schedule', async () => {
  const jsCode = byName(main, 'URLs to check').parameters.jsCode;
  const daily = await runCodeNode(jsCode, { items: [{ json: {} }] });
  assert.equal(daily.length, require('../config/urls.json').urls.length);
  assert.equal(daily[0].json.trigger, 'schedule');
  const hook = await runCodeNode(jsCode, { items: [{ json: { urls: ['https://a.example/'] } }] });
  assert.equal(hook[0].json.trigger, 'webhook');
});
