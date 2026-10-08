#!/usr/bin/env node
'use strict';

// Generates the n8n workflows in workflows/ from this file plus the tested code in
// scripts/lib/. The library code is copied into the Code nodes that need it, so
// what runs in n8n is exactly what the unit tests cover. Edit scripts/lib/ or this
// file, then run `npm run build:workflows`. Don't edit the generated JSON by hand.
//
//   node scripts/build-workflows.js                 -> workflows/main.json, workflows/error.json
//   node scripts/build-workflows.js --no-sheets --out <dir>
//                                                   -> same, with the Google Sheets nodes disabled
//                                                      (for testing before Google sign-in)

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const config = require('./lib/config');

const ROOT = path.join(__dirname, '..');
const LIB = path.join(__dirname, 'lib');

const IDS = {
  main: 'pagespeedMain001',
  error: 'pagespeedErr0001',
  credPsi: 'pagespeedPsiHdr1',
  credSheets: 'pagespeedSheets1',
  credHook: 'pagespeedHook001',
};
const WEBHOOK_ID = '6f3c2a5e-8d41-4b7a-9c0e-2d5f7a1b3c90';
const PSI_ENDPOINT = 'https://www.googleapis.com/pagespeedonline/v5/runPagespeed';
const MAX_URLS_PER_REQUEST = 10;

// ---------------------------------------------------------------------------
// Library code for Code nodes

function libSource(file) {
  let src = fs.readFileSync(path.join(LIB, file), 'utf8');
  src = src.replace(/^'use strict';\n/m, '');
  if (file === 'config.js') {
    src = src.replace('module.exports = {', 'const CONFIG = {');
  } else {
    src = src.replace(
      "const { SCORE_THRESHOLD, SAVINGS_THRESHOLD_MS } = require('./config');",
      'const { SCORE_THRESHOLD, SAVINGS_THRESHOLD_MS } = CONFIG;',
    );
    src = src.replace(/\nmodule\.exports = \{[\s\S]*?\};\s*$/, '\n');
  }
  if (/\brequire\(/.test(src) || /module\.exports/.test(src)) {
    throw new Error(`${file}: could not strip require/module.exports for inlining`);
  }
  return src.trim();
}

function generatedCode(files, glue) {
  return [
    `// GENERATED from ${files.map((f) => `scripts/lib/${f}`).join(' + ')} by scripts/build-workflows.js.`,
    '// Edit those files and run `npm run build:workflows`. Changes made here are overwritten.',
    '',
    ...files.map((f) => `// ===== scripts/lib/${f} =====\n${libSource(f)}\n`),
    '// ===== n8n glue =====',
    glue.trim(),
    '',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Hand-written Code node bodies (short on purpose: they're what people read in the editor)

const defaultUrls = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'urls.json'), 'utf8')).urls;

const CODE_CHECK_REQUEST = `
// Accepts {"url": "..."} or {"urls": ["...", "..."]}: up to ${MAX_URLS_PER_REQUEST} public http(s) URLs.
const body = $input.first().json.body || {};
const requested = [].concat(body.urls || [], body.url || []).map((u) => String(u).trim());
const urls = [...new Set(requested)].filter((u) => /^https?:\\/\\/[^\\s/$.?#].[^\\s]*$/i.test(u));

let error = null;
if (!requested.length) error = 'Send {"url": "https://..."} or {"urls": ["https://...", ...]}';
else if (!urls.length) error = 'No valid http(s) URLs in the request';
else if (urls.length > ${MAX_URLS_PER_REQUEST}) error = 'At most ${MAX_URLS_PER_REQUEST} URLs per request';

return [{ json: { valid: !error, error, urls } }];
`;

const CODE_URLS = `
// Pages checked by the daily schedule. Edit this list to monitor different pages.
const DAILY_URLS = ${JSON.stringify(defaultUrls, null, 2)};

// Webhook runs arrive with a checked list of URLs; scheduled runs use DAILY_URLS.
const first = $input.first().json;
const fromWebhook = Array.isArray(first.urls);
const urls = fromWebhook ? first.urls : DAILY_URLS;

return urls.map((url) => ({ json: { url, trigger: fromWebhook ? 'webhook' : 'schedule' } }));
`;

const CODE_REQUESTS = `
// ${config.RUNS_PER_STRATEGY} runs per strategy, because single Lighthouse runs are noisy.
const STRATEGIES = ${JSON.stringify(config.STRATEGIES)};
const RUNS = ${config.RUNS_PER_STRATEGY};
const CATEGORIES = ${JSON.stringify(config.CATEGORIES)};
// Only the fields the report needs (drops screenshots and other bulk).
const FIELDS = ${JSON.stringify(config.PSI_FIELDS)};

// The query string is built here because n8n's query-parameter list merges
// repeated names, and PSI needs category=... twice.
const psiUrl = (url, strategy) => '${PSI_ENDPOINT}?' + [
  \`url=\${encodeURIComponent(url)}\`,
  \`strategy=\${strategy}\`,
  ...CATEGORIES.map((c) => \`category=\${c}\`),
  \`fields=\${encodeURIComponent(FIELDS)}\`,
].join('&');

return $input.all().flatMap(({ json }) =>
  STRATEGIES.flatMap((strategy) =>
    Array.from({ length: RUNS }, (_, i) => ({
      json: { url: json.url, trigger: json.trigger, strategy, run: i + 1, psi_url: psiUrl(json.url, strategy) },
    }))));
`;

const GLUE_BUILD_REPORTS = `
// Every PSI request arrives here exactly once: as a response, or as an error after
// one retry. Group by URL and build one report per URL.
const runId = $execution.id;
const now = new Date().toISOString();

const errorText = (e) => (typeof e === 'string' ? e : (e && (e.message || e.description)) || JSON.stringify(e));
const errorStatus = (e) => (e && (e.httpCode || e.status || e.statusCode)) || '';

const groups = new Map();
$input.all().forEach((item, i) => {
  const req = $('Make PSI requests').itemMatching(i).json;
  const g = groups.get(req.url) || { url: req.url, trigger: req.trigger, responses: [], errors: [] };
  if (item.json.error || !item.json.lighthouseResult) {
    const e = item.json.error || item.json;
    // Request errors reach this node only after the retry.
    g.errors.push({ strategy: req.strategy, run: req.run, message: psiErrorMessage(errorText(e)), http_status: errorStatus(e), attempts: 2 });
  } else {
    try {
      extractRun(item.json); // reject responses missing the fields the report needs
      g.responses.push(item.json);
    } catch (err) {
      g.errors.push({ strategy: req.strategy, run: req.run, message: err.message, http_status: 200, attempts: 1 });
    }
  }
  groups.set(req.url, g);
});

return [...groups.values()].map((g) => {
  const errorRows = g.errors.map((e) => ({
    timestamp: now,
    run_id: runId,
    workflow: $workflow.name,
    node: 'PSI run',
    url: g.url,
    error_message: \`\${e.strategy} run \${e.run}: \${e.message}\`.slice(0, 500),
    http_status: e.http_status,
    attempts: e.attempts,
  }));

  let report = null;
  if (g.responses.length) {
    try {
      report = buildReport(g.responses);
      report.url = g.url;
    } catch (err) {
      errorRows.push({ timestamp: now, run_id: runId, workflow: $workflow.name, node: 'Build reports',
        url: g.url, error_message: err.message, http_status: '', attempts: 1 });
    }
  }

  const status = !report ? 'failed' : g.errors.length ? 'partial' : 'ok';
  return {
    json: {
      url: g.url,
      trigger: g.trigger,
      run_id: runId,
      status,
      flagged: Boolean(report && report.flagged),
      report,
      report_b64: report ? Buffer.from(JSON.stringify(report)).toString('base64') : null,
      history_rows: report ? historyRows(report, { runId, trigger: g.trigger }) : [],
      error_rows: errorRows,
    },
  };
});
`;

const GLUE_FINDINGS = `
// One findings row per flagged URL, from the AI step's JSON on stdout.
return $input.all().map((item, i) => {
  const src = $('Flagged?').itemMatching(i).json;
  let result = null;
  try {
    result = JSON.parse(item.json.stdout);
  } catch (err) {
    // analyze.js always prints JSON for a valid report, so this means it didn't run.
  }
  if (!result || !result.analysis) {
    const reason = (item.json.stderr || item.json.error || 'no output').toString().slice(0, 300);
    result = {
      source: 'error',
      fallback_reason: reason,
      analysis: {
        summary: 'The AI analysis step did not run. See the history tab for scores.',
        risk: src.report.strategies.mobile && src.report.strategies.mobile.performance < 0.5 ? 'high' : 'medium',
        root_causes: [],
        quick_win: '',
      },
    };
  }
  return { json: findingsRow(src.report, result, { runId: src.run_id }) };
});
`;

const CODE_DIGEST = `
// One Slack message per run: flagged pages first, then pages that couldn't be tested.
const items = $input.all().map((i) => i.json);
const findings = items.filter((j) => j.risk !== undefined);
const reports = items.filter((j) => j.status !== undefined);
const failed = reports.filter((r) => r.status === 'failed');
const partial = reports.filter((r) => r.status === 'partial');

if (!findings.length && !failed.length) return [];

// %PREFIX% is filled in by "Post to Slack" from SLACK_PREFIX (e.g. "[TEST] ").
// Code nodes can't read environment variables; expressions can.
const icon = { high: ':red_circle:', medium: ':large_orange_circle:', low: ':large_yellow_circle:' };
const pct = (s) => (typeof s === 'number' ? Math.round(s * 100) : '–');
const order = { high: 0, medium: 1, low: 2 };
findings.sort((a, b) => (order[a.risk] ?? 3) - (order[b.risk] ?? 3));

const pages = (n) => \`\${n} \${n === 1 ? 'page' : 'pages'}\`;
const tested = reports.length - failed.length;
const headline = [
  tested ? \`\${findings.length} of \${pages(tested)} \${tested === 1 ? 'needs' : 'need'} attention\` : '',
  failed.length ? \`\${pages(failed.length)} couldn't be tested\` : '',
].filter(Boolean).join(' · ');
const blocks = [{
  type: 'header',
  text: { type: 'plain_text', text: \`%PREFIX%PageSpeed Monitor: \${headline}\` },
}];
for (const f of findings) {
  const ai = f.analysis_source === 'claude' ? '' : \` _(\${f.analysis_source} summary)_\`;
  blocks.push({
    type: 'section',
    text: {
      type: 'mrkdwn',
      text: [
        \`\${icon[f.risk] || ':white_circle:'} *<\${f.url}|\${f.url}>*: \${f.risk} risk · mobile \${pct(f.mobile_score)} · desktop \${pct(f.desktop_score)}\${ai}\`,
        f.summary,
        f.quick_win ? \`*Quick win:* \${f.quick_win}\` : '',
      ].filter(Boolean).join('\\n').slice(0, 2900),
    },
  });
}
if (failed.length || partial.length) {
  const lines = [
    ...failed.map((r) => \`:x: \${r.url}: no PageSpeed data (\${r.error_rows.length} failed runs)\`),
    ...partial.map((r) => \`:warning: \${r.url}: \${r.error_rows.length} of the runs failed, results use the rest\`),
  ];
  blocks.push({ type: 'section', text: { type: 'mrkdwn', text: lines.join('\\n').slice(0, 2900) } });
}
const tabNames = [
  findings.length ? 'findings' : '',
  tested ? 'history' : '',
  failed.length || partial.length ? 'errors' : '',
].filter(Boolean);
const tabs = tabNames.length === 1
  ? \`\${tabNames[0]} tab\`
  : \`\${tabNames.slice(0, -1).join(', ')} and \${tabNames.at(-1)} tabs\`;
blocks.push({
  type: 'context',
  elements: [{ type: 'mrkdwn', text: \`Run \${$execution.id} · details in the PageSpeed Monitor sheet (\${tabs})\` }],
});

return [{ json: { text: blocks[0].text.text, blocks } }];
`;

const CODE_FORMAT_ERROR = `
// Turns an n8n error event into a Slack message and an errors-tab row.
const { execution = {}, workflow = {} } = $input.first().json;
const err = execution.error || {};
const node = (err.node && err.node.name) || execution.lastNodeExecuted || 'unknown';
const message = String(err.message || err.description || 'Unknown error').slice(0, 500);

return [{
  json: {
    slack: {
      text: \`%PREFIX%PageSpeed Monitor failed at "\${node}"\`,
      blocks: [{
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: \`:rotating_light: %PREFIX%*\${workflow.name || 'Workflow'}* failed at *\${node}*\\n\${message}\\nExecution \${execution.id || '?'} (\${execution.mode || 'unknown'} run)\`,
        },
      }],
    },
    row: {
      timestamp: new Date().toISOString(),
      run_id: execution.id || '',
      workflow: workflow.name || '',
      node,
      url: '',
      error_message: message,
      http_status: (err.httpCode || err.status || '') + '',
      attempts: 1,
    },
  },
}];
`;

// ---------------------------------------------------------------------------
// Node builders

const uuid = (seed) => {
  const h = crypto.createHash('sha1').update(seed).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
};

const node = (name, type, typeVersion, position, parameters, extra = {}) => ({
  id: uuid(`node:${name}`), name, type, typeVersion, position, parameters, ...extra,
});

const code = (name, position, jsCode, extra = {}) =>
  node(name, 'n8n-nodes-base.code', 2, position, { jsCode: jsCode.trim() + '\n' }, extra);

const sticky = (name, position, width, height, content, color = 7) =>
  node(name, 'n8n-nodes-base.stickyNote', 1, position, { content, width, height, color });

// The API key is sent as the X-Goog-Api-Key header from an n8n credential.
const psiRequest = (name, position, urlExpr, extra = {}) => node(
  name, 'n8n-nodes-base.httpRequest', 4.2, position, {
    url: urlExpr,
    authentication: 'genericCredentialType',
    genericAuthType: 'httpHeaderAuth',
    options: {
      timeout: 120000,
      batching: { batch: { batchSize: 3, batchInterval: 2000 } },
    },
  },
  {
    credentials: { httpHeaderAuth: { id: IDS.credPsi, name: 'PageSpeed Insights API key' } },
    onError: 'continueErrorOutput',
    ...extra,
  },
);

// In the main workflow a failed Sheets write must not stop the run (the Slack
// digest still matters); the error workflow keeps the default and fails loudly.
const sheetsAppend = (name, position, tab, noSheets, extra = {}) => node(
  name, 'n8n-nodes-base.googleSheets', 4.5, position, {
    operation: 'append',
    documentId: { __rl: true, mode: 'id', value: '={{ $env.GOOGLE_SHEET_ID }}' },
    sheetName: { __rl: true, mode: 'name', value: tab },
    columns: { mappingMode: 'autoMapInputData', value: {}, matchingColumns: [], schema: [] },
    options: {},
  },
  {
    credentials: { googleSheetsOAuth2Api: { id: IDS.credSheets, name: 'Google Sheets (PageSpeed Monitor)' } },
    ...extra,
    ...(noSheets ? { disabled: true } : {}),
  },
);

const slackPost = (name, position, bodyExpr) => node(
  name, 'n8n-nodes-base.httpRequest', 4.2, position, {
    method: 'POST',
    url: '={{ $env.SLACK_WEBHOOK_URL }}',
    sendBody: true,
    specifyBody: 'json',
    jsonBody: bodyExpr,
    options: { timeout: 20000 },
  },
  { retryOnFail: true, maxTries: 3, waitBetweenTries: 5000 },
);

const splitOut = (name, position, field) =>
  node(name, 'n8n-nodes-base.splitOut', 1, position, { fieldToSplitOut: field, options: {} });

const link = (connections, from, to, { output = 0, input = 0 } = {}) => {
  const c = (connections[from] = connections[from] || { main: [] });
  while (c.main.length <= output) c.main.push([]);
  c.main[output].push({ node: to, type: 'main', index: input });
};

// ---------------------------------------------------------------------------
// Workflows

function mainWorkflow({ noSheets }) {
  const nodes = [
    sticky('Note: overview', [-220, -380], 760, 300, [
      '## PageSpeed Monitor',
      'Checks public pages with Google PageSpeed Insights (3 runs × mobile + desktop), averages the runs, and flags pages that score below **0.9** or have a fix worth **≥ 100 ms**.',
      '',
      'Flagged pages get a plain-English analysis from Claude, a row in the **findings** tab, and one Slack digest per run. Every page gets **history** rows. Failed requests are retried once after 30 s, then logged to **errors**.',
      '',
      'Code in *Build reports* and *Findings row* is generated from the tested `scripts/lib/` in the repo.',
    ].join('\n'), 5),
    sticky('Note: secrets', [2360, -380], 420, 200, [
      '### Secrets',
      'PSI key, Google sign-in and webhook token are n8n credentials (encrypted).',
      'Slack webhook URL and Sheet ID come from environment variables set by `scripts/n8n.sh`, so this JSON contains no secrets.',
    ].join('\n')),
    sticky('Note: AI step', [2380, 680], 420, 230, [
      '### AI step',
      '`scripts/analyze.js` runs Claude Code headless with a fixed JSON schema, no tools, and validates the result (every cause must cite real audit ids). If Claude fails or times out, it returns a rule-based fallback, so the run never stops here.',
      '',
      '*Production: swap this node for the Anthropic API node with a team API key.*',
    ].join('\n')),

    node('Daily schedule', 'n8n-nodes-base.scheduleTrigger', 1.2, [0, 0],
      { rule: { interval: [{ field: 'days', triggerAtHour: 7 }] } },
      config.SCHEDULE_ENABLED
        ? { notes: 'Runs every day at 07:00.', notesInFlow: true }
        : { disabled: true, notes: 'Off. Set SCHEDULE_ENABLED in scripts/lib/config.js and redeploy.', notesInFlow: true }),
    node('On-demand webhook', 'n8n-nodes-base.webhook', 2, [0, 200], {
      httpMethod: 'POST',
      path: 'pagespeed',
      authentication: 'headerAuth',
      responseMode: 'responseNode',
      options: {},
    }, {
      webhookId: WEBHOOK_ID,
      credentials: { httpHeaderAuth: { id: IDS.credHook, name: 'PageSpeed webhook token' } },
    }),
    code('Check request', [200, 200], CODE_CHECK_REQUEST),
    node('Valid request?', 'n8n-nodes-base.if', 2.2, [400, 200], {
      conditions: {
        options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
        conditions: [{
          id: uuid('cond:valid'),
          leftValue: '={{ $json.valid }}',
          rightValue: true,
          operator: { type: 'boolean', operation: 'true', singleValue: true },
        }],
        combinator: 'and',
      },
      options: {},
    }),
    node('Accepted (202)', 'n8n-nodes-base.respondToWebhook', 1.1, [620, 180], {
      respondWith: 'json',
      responseBody: '={{ { "status": "accepted", "execution_id": $execution.id, "urls": $json.urls, "message": "Results go to Google Sheets and Slack when the run finishes." } }}',
      options: { responseCode: 202 },
    }),
    node('Bad request (400)', 'n8n-nodes-base.respondToWebhook', 1.1, [620, 380], {
      respondWith: 'json',
      responseBody: '={{ { "status": "rejected", "error": $json.error } }}',
      options: { responseCode: 400 },
    }),
    code('URLs to check', [840, 100], CODE_URLS),
    code('Make PSI requests', [1060, 100], CODE_REQUESTS),
    psiRequest('PSI run', [1280, 100], '={{ $json.psi_url }}'),
    node('Wait 30 s', 'n8n-nodes-base.wait', 1.1, [1500, 260], { amount: 30, unit: 'seconds' }),
    psiRequest('PSI retry', [1720, 260], "={{ $('Make PSI requests').item.json.psi_url }}"),
    node('All runs', 'n8n-nodes-base.merge', 3.2, [1940, 100], { numberInputs: 3 }),
    code('Build reports', [2160, 100], generatedCode(['config.js', 'psi.js', 'sheets.js'], GLUE_BUILD_REPORTS)),

    splitOut('History rows', [2380, -100], 'history_rows'),
    sheetsAppend('Append history', [2600, -100], 'history', noSheets, { onError: 'continueRegularOutput' }),
    splitOut('Error rows', [2380, 500], 'error_rows'),
    sheetsAppend('Append errors', [2600, 500], 'errors', noSheets, { onError: 'continueRegularOutput' }),

    node('Flagged?', 'n8n-nodes-base.if', 2.2, [2380, 100], {
      conditions: {
        options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
        conditions: [{
          id: uuid('cond:flagged'),
          leftValue: '={{ $json.flagged }}',
          rightValue: true,
          operator: { type: 'boolean', operation: 'true', singleValue: true },
        }],
        combinator: 'and',
      },
      options: {},
    }),
    node('AI analysis (Claude)', 'n8n-nodes-base.executeCommand', 1, [2600, 80], {
      command: '=node scripts/analyze.js --b64 {{ $json.report_b64 }}',
    }, { onError: 'continueRegularOutput' }),
    code('Findings row', [2820, 80], generatedCode(['sheets.js'], GLUE_FINDINGS)),
    sheetsAppend('Append findings', [3040, 80], 'findings', noSheets, { onError: 'continueRegularOutput' }),

    node('Collect for digest', 'n8n-nodes-base.merge', 3.2, [3040, 300], {}),
    code('Slack digest', [3260, 300], CODE_DIGEST),
    slackPost('Post to Slack', [3480, 300],
      "={{ JSON.stringify({ text: $json.text, blocks: $json.blocks }).replaceAll('%PREFIX%', $env.SLACK_PREFIX || '') }}"),
  ];

  const connections = {};
  link(connections, 'Daily schedule', 'URLs to check');
  link(connections, 'On-demand webhook', 'Check request');
  link(connections, 'Check request', 'Valid request?');
  link(connections, 'Valid request?', 'Accepted (202)', { output: 0 });
  link(connections, 'Valid request?', 'Bad request (400)', { output: 1 });
  link(connections, 'Accepted (202)', 'URLs to check');
  link(connections, 'URLs to check', 'Make PSI requests');
  link(connections, 'Make PSI requests', 'PSI run');
  link(connections, 'PSI run', 'All runs', { output: 0, input: 0 });
  link(connections, 'PSI run', 'Wait 30 s', { output: 1 });
  link(connections, 'Wait 30 s', 'PSI retry');
  link(connections, 'PSI retry', 'All runs', { output: 0, input: 1 });
  link(connections, 'PSI retry', 'All runs', { output: 1, input: 2 });
  link(connections, 'All runs', 'Build reports');
  link(connections, 'Build reports', 'History rows');
  link(connections, 'History rows', 'Append history');
  link(connections, 'Build reports', 'Error rows');
  link(connections, 'Error rows', 'Append errors');
  link(connections, 'Build reports', 'Flagged?');
  link(connections, 'Flagged?', 'AI analysis (Claude)', { output: 0 });
  link(connections, 'AI analysis (Claude)', 'Findings row');
  link(connections, 'Findings row', 'Append findings');
  link(connections, 'Findings row', 'Collect for digest', { input: 0 });
  link(connections, 'Build reports', 'Collect for digest', { input: 1 });
  link(connections, 'Collect for digest', 'Slack digest');
  link(connections, 'Slack digest', 'Post to Slack');

  return {
    id: IDS.main,
    name: 'PageSpeed Monitor',
    nodes,
    connections,
    settings: { executionOrder: 'v1', errorWorkflow: IDS.error, saveManualExecutions: true },
    pinData: {},
    active: false,
    tags: [],
  };
}

function errorWorkflow({ noSheets }) {
  const nodes = [
    sticky('Note: errors', [-220, -260], 520, 180, [
      '## PageSpeed Monitor: error handler',
      'Runs when the main workflow fails outright (not for a single failed PageSpeed request, which the main workflow retries and logs itself). Posts to Slack and writes an **errors** row.',
    ].join('\n'), 3),
    node('On workflow error', 'n8n-nodes-base.errorTrigger', 1, [0, 0], {}),
    code('Format error', [220, 0], CODE_FORMAT_ERROR),
    slackPost('Post to Slack', [440, -100],
      "={{ JSON.stringify($json.slack).replaceAll('%PREFIX%', $env.SLACK_PREFIX || '') }}"),
    node('Error row', 'n8n-nodes-base.set', 3.4, [440, 100], {
      mode: 'raw', jsonOutput: '={{ JSON.stringify($json.row) }}', options: {},
    }),
    sheetsAppend('Append errors', [660, 100], 'errors', noSheets),
  ];
  const connections = {};
  link(connections, 'On workflow error', 'Format error');
  link(connections, 'Format error', 'Post to Slack');
  link(connections, 'Format error', 'Error row');
  link(connections, 'Error row', 'Append errors');
  return {
    id: IDS.error,
    name: 'PageSpeed Monitor: errors',
    nodes,
    connections,
    settings: { executionOrder: 'v1' },
    pinData: {},
    active: false,
    tags: [],
  };
}

function build({ noSheets = false } = {}) {
  return { main: mainWorkflow({ noSheets }), error: errorWorkflow({ noSheets }) };
}

function main(argv) {
  const noSheets = argv.includes('--no-sheets');
  const o = argv.indexOf('--out');
  const outDir = o !== -1 ? path.resolve(argv[o + 1]) : path.join(ROOT, 'workflows');
  fs.mkdirSync(outDir, { recursive: true });
  const wf = build({ noSheets });
  for (const [name, w] of Object.entries(wf)) {
    const file = path.join(outDir, `${name}.json`);
    fs.writeFileSync(file, `${JSON.stringify(w, null, 2)}\n`);
    process.stdout.write(`wrote ${path.relative(process.cwd(), file)}${noSheets ? ' (Sheets nodes disabled)' : ''}\n`);
  }
}

if (require.main === module) main(process.argv.slice(2));

module.exports = { build, libSource, generatedCode, GLUE_BUILD_REPORTS, GLUE_FINDINGS, CODE_DIGEST };
