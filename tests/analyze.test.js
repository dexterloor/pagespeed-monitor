'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { buildReport } = require('../scripts/lib/psi');
const { analyze, buildPrompt } = require('../scripts/analyze');
const { makePsi, opportunity } = require('./helpers/psi-factory');

const report = buildReport([makePsi({
  performance: 0.6,
  audits: { 'unused-javascript': opportunity('Reduce unused JavaScript', 700) },
})]);

const valid = {
  summary: 'Slow on mobile because of unused JavaScript.',
  risk: 'medium',
  root_causes: [{
    cause: 'Unused JavaScript', affects: 'mobile', audit_ids: ['unused-javascript'],
    est_savings_ms: 700, fix: 'Split the bundle.', effort: 'medium',
  }],
  quick_win: 'Defer the analytics bundle.',
};
const envelope = (structured) => JSON.stringify({ type: 'result', subtype: 'success', is_error: false, structured_output: structured });

// Fake Claude: returns the queued responses in order and records each call.
function fakeClaude(...responses) {
  const calls = [];
  const run = async (prompt, settings) => {
    calls.push({ prompt, settings });
    return responses[calls.length - 1];
  };
  return { run, calls };
}

test('buildPrompt embeds the report as data', () => {
  const prompt = buildPrompt(report);
  assert.ok(prompt.includes('<report>'));
  assert.ok(prompt.includes('"unused-javascript"'));
  assert.ok(!prompt.includes('{{REPORT_JSON}}'));
});

test('returns Claude analysis when it is valid', async () => {
  const fake = fakeClaude({ ok: true, stdout: envelope(valid) });
  const res = await analyze(report, { runClaude: fake.run, env: { CLAUDE_MODEL: 'haiku' } });
  assert.equal(res.source, 'claude');
  assert.equal(res.model, 'haiku');
  assert.equal(res.attempts, 1);
  assert.deepEqual(res.analysis, valid);
  assert.equal(fake.calls[0].settings.timeoutMs, 180000);
});

test('retries once on invalid output, then succeeds', async () => {
  const fake = fakeClaude(
    { ok: true, stdout: envelope({ ...valid, risk: 'catastrophic' }) },
    { ok: true, stdout: envelope(valid) },
  );
  const res = await analyze(report, { runClaude: fake.run, env: {} });
  assert.equal(res.source, 'claude');
  assert.equal(res.attempts, 2);
});

test('falls back after two invalid outputs and says why', async () => {
  const bad = { ok: true, stdout: envelope({ ...valid, root_causes: [{ ...valid.root_causes[0], audit_ids: ['invented'] }] }) };
  const fake = fakeClaude(bad, bad);
  const res = await analyze(report, { runClaude: fake.run, env: {} });
  assert.equal(res.source, 'fallback');
  assert.equal(res.model, null);
  assert.equal(res.attempts, 2);
  assert.match(res.fallback_reason, /not in report: invented/);
  assert.match(res.analysis.summary, /AI analysis was unavailable/);
});

test('does not retry after a timeout', async () => {
  const fake = fakeClaude({ ok: false, error: 'claude timed out after 10ms', retryable: false });
  const res = await analyze(report, { runClaude: fake.run, env: {} });
  assert.equal(res.source, 'fallback');
  assert.equal(fake.calls.length, 1);
  assert.match(res.fallback_reason, /timed out/);
});

test('ANALYZE_FORCE_FALLBACK skips Claude entirely', async () => {
  const fake = fakeClaude();
  const res = await analyze(report, { runClaude: fake.run, env: { ANALYZE_FORCE_FALLBACK: '1' } });
  assert.equal(res.source, 'fallback');
  assert.equal(fake.calls.length, 0);
});

test('CLI: --b64 input, missing claude binary -> fallback JSON on stdout, exit 0', () => {
  const b64 = Buffer.from(JSON.stringify(report)).toString('base64');
  const out = execFileSync('node', [path.join(__dirname, '..', 'scripts', 'analyze.js'), '--b64', b64], {
    env: { ...process.env, CLAUDE_BIN: 'definitely-not-a-real-binary' },
  });
  const res = JSON.parse(out);
  assert.equal(res.source, 'fallback');
  assert.match(res.fallback_reason, /could not start/);
});

test('CLI: invalid input exits 2', () => {
  const b64 = Buffer.from('{"nope":true}').toString('base64');
  assert.throws(
    () => execFileSync('node', [path.join(__dirname, '..', 'scripts', 'analyze.js'), '--b64', b64], { stdio: 'pipe' }),
    (err) => err.status === 2,
  );
});
