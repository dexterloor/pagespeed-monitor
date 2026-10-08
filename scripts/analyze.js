#!/usr/bin/env node
'use strict';

// AI step: report JSON in, validated analysis JSON out.
//
//   node scripts/analyze.js --b64 <base64 report>   (what n8n's Execute Command node uses)
//   node scripts/analyze.js --file samples/report-flagged.json
//   cat report.json | node scripts/analyze.js
//
// Always prints one JSON object and exits 0 when the input report is valid. If
// Claude fails, times out or returns invalid JSON (after one retry), the output is a
// deterministic fallback with source "fallback", so the workflow keeps going.
//
// Env: CLAUDE_BIN (default "claude"), CLAUDE_MODEL (default "sonnet"),
//      CLAUDE_TIMEOUT_MS (default 180000), ANALYZE_FORCE_FALLBACK=1 (skip Claude, for demos and tests).

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const {
  ANALYSIS_SCHEMA, validateAnalysis, fallbackAnalysis, parseClaudeEnvelope,
} = require('./lib/analysis');

const PROMPT_PATH = path.join(__dirname, '..', 'prompts', 'analyze-report.md');
const MAX_ATTEMPTS = 2;

function buildPrompt(report) {
  return fs.readFileSync(PROMPT_PATH, 'utf8').replace('{{REPORT_JSON}}', JSON.stringify(report, null, 2));
}

// Runs Claude Code headless with no tools and none of the user's settings, hooks or
// plugins, from an empty temp dir so no CLAUDE.md is picked up. The prompt goes in on stdin.
function runClaude(prompt, { bin, model, timeoutMs }) {
  return new Promise((resolve) => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'psi-analyze-'));
    const args = [
      '-p',
      '--output-format', 'json',
      '--model', model,
      '--tools', '',
      '--setting-sources', '',
      '--no-session-persistence',
      '--json-schema', JSON.stringify(ANALYSIS_SCHEMA),
    ];
    const child = spawn(bin, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, timeoutMs);

    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ ok: false, error: `could not start ${bin}: ${err.message}` });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      fs.rmSync(cwd, { recursive: true, force: true });
      if (timedOut) return resolve({ ok: false, error: `claude timed out after ${timeoutMs}ms`, retryable: false });
      if (code !== 0) return resolve({ ok: false, error: `claude exited ${code}: ${stderr.trim().slice(0, 300)}` });
      resolve({ ok: true, stdout });
    });
    child.stdin.end(prompt);
  });
}

async function analyze(report, opts = {}) {
  const env = opts.env || process.env;
  const settings = {
    bin: env.CLAUDE_BIN || 'claude',
    model: env.CLAUDE_MODEL || 'sonnet',
    timeoutMs: Number(env.CLAUDE_TIMEOUT_MS) || 180000,
  };
  const run = opts.runClaude || runClaude;
  const started = Date.now();
  const result = (source, analysis, extra = {}) => ({
    url: report.url,
    source,
    model: source === 'claude' ? settings.model : null,
    duration_ms: Date.now() - started,
    ...extra,
    analysis,
  });

  if (env.ANALYZE_FORCE_FALLBACK === '1') {
    return result('fallback', fallbackAnalysis(report), { fallback_reason: 'ANALYZE_FORCE_FALLBACK=1', attempts: 0 });
  }

  const prompt = buildPrompt(report);
  let lastError = 'no attempts made';
  let attempts = 0;
  while (attempts < MAX_ATTEMPTS) {
    attempts += 1;
    const out = await run(prompt, settings);
    if (!out.ok) {
      lastError = out.error;
      if (out.retryable === false) break;
      continue;
    }
    const parsed = parseClaudeEnvelope(out.stdout);
    if (!parsed.ok) {
      lastError = parsed.error;
      continue;
    }
    const checked = validateAnalysis(parsed.value, report);
    if (checked.ok) return result('claude', checked.value, { attempts });
    lastError = `invalid analysis: ${checked.errors.join('; ')}`;
  }
  return result('fallback', fallbackAnalysis(report), { fallback_reason: lastError, attempts });
}

function readInput(argv) {
  const i = argv.indexOf('--b64');
  if (i !== -1) return Buffer.from(argv[i + 1] || '', 'base64').toString('utf8');
  const f = argv.indexOf('--file');
  if (f !== -1) return fs.readFileSync(argv[f + 1], 'utf8');
  return fs.readFileSync(0, 'utf8');
}

async function main() {
  let report;
  try {
    report = JSON.parse(readInput(process.argv.slice(2)));
    if (!report || !report.url || !report.strategies) throw new Error('missing url or strategies');
  } catch (err) {
    process.stderr.write(`analyze: invalid report input: ${err.message}\n`);
    process.exit(2);
  }
  process.stdout.write(`${JSON.stringify(await analyze(report))}\n`);
}

if (require.main === module) main();

module.exports = { analyze, buildPrompt };
