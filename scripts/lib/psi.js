'use strict';

// Turns raw PageSpeed Insights (PSI) API responses into one compact report per URL:
// averages the repeated runs per strategy, groups savings opportunities by root
// cause, and decides whether the URL should be flagged.
//
// Pure functions, no dependencies, so the same code can run in tests, from the
// CLI, or pasted into an n8n Code node.

const { SCORE_THRESHOLD, SAVINGS_THRESHOLD_MS } = require('./config');

const METRICS = {
  lcp_ms: 'largest-contentful-paint',
  fcp_ms: 'first-contentful-paint',
  tbt_ms: 'total-blocking-time',
  cls: 'cumulative-layout-shift',
  si_ms: 'speed-index',
};

// Metric audits report the metric itself, not something to fix.
const METRIC_AUDIT_IDS = new Set([...Object.values(METRICS), 'interactive', 'max-potential-fid']);

// A diagnostic is a failing audit with no time estimate (e.g. "LCP image not
// discoverable"). It's context for the analysis, never a reason to flag.
const DIAGNOSTIC_MAX_SCORE = 0.9;

// Time-based metrics only: CLS savings are unitless and can't be compared in ms.
const TIME_SAVINGS_KEYS = ['LCP', 'FCP', 'TBT', 'INP'];

// Lighthouse audit id -> root cause. Covers both the classic "opportunity" audits
// and the newer "insight" audits, because PSI has shipped both.
const ROOT_CAUSES = {
  images: {
    label: 'Images',
    audits: ['uses-optimized-images', 'modern-image-formats', 'uses-responsive-images', 'offscreen-images',
      'efficient-animated-content', 'unsized-images', 'image-delivery-insight'],
  },
  javascript: {
    label: 'JavaScript',
    audits: ['unused-javascript', 'unminified-javascript', 'legacy-javascript', 'legacy-javascript-insight',
      'duplicated-javascript', 'duplicated-javascript-insight', 'bootup-time', 'mainthread-work-breakdown'],
  },
  render_blocking: {
    label: 'Render-blocking CSS and requests',
    audits: ['render-blocking-resources', 'render-blocking-insight', 'unused-css-rules', 'unminified-css',
      'critical-request-chains', 'network-dependency-tree-insight'],
  },
  lcp: {
    label: 'Largest Contentful Paint element',
    audits: ['lcp-discovery-insight', 'prioritize-lcp-image', 'lcp-phases-insight', 'largest-contentful-paint-element'],
  },
  server: {
    label: 'Server, caching and network',
    audits: ['server-response-time', 'document-latency-insight', 'redirects', 'uses-text-compression',
      'uses-http2', 'uses-rel-preconnect', 'uses-long-cache-ttl', 'cache-insight'],
  },
  fonts: {
    label: 'Web fonts',
    audits: ['font-display', 'font-display-insight'],
  },
  third_party: {
    label: 'Third-party scripts',
    audits: ['third-party-summary', 'third-parties-insight', 'third-party-facades'],
  },
  layout: {
    label: 'Layout shifts',
    audits: ['layout-shifts', 'cls-culprits-insight'],
  },
};

const AUDIT_TO_CAUSE = Object.fromEntries(
  Object.entries(ROOT_CAUSES).flatMap(([cause, { audits }]) => audits.map((id) => [id, cause])),
);

const round = (n, places = 0) => {
  const f = 10 ** places;
  return Math.round(n * f) / f;
};
const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;

function savingsMs(audit) {
  const overall = audit.details && audit.details.overallSavingsMs;
  if (typeof overall === 'number') return overall;
  const ms = TIME_SAVINGS_KEYS
    .map((k) => audit.metricSavings && audit.metricSavings[k])
    .filter((v) => typeof v === 'number');
  return ms.length ? Math.max(...ms) : 0;
}

// One PSI API response -> the few fields we keep.
function extractRun(psi) {
  const lr = psi && psi.lighthouseResult;
  if (!lr || !lr.categories || !lr.audits) {
    throw new Error('Not a PageSpeed Insights response: missing lighthouseResult');
  }
  const perf = lr.categories.performance;
  if (!perf || typeof perf.score !== 'number') {
    throw new Error('PageSpeed Insights response has no performance score');
  }
  const bp = lr.categories['best-practices'];

  const metrics = {};
  for (const [key, id] of Object.entries(METRICS)) {
    const v = lr.audits[id] && lr.audits[id].numericValue;
    metrics[key] = typeof v === 'number' ? v : null;
  }

  const opportunities = [];
  const diagnostics = [];
  for (const [id, a] of Object.entries(lr.audits)) {
    if (METRIC_AUDIT_IDS.has(id) || a.score === 1) continue;
    const ms = savingsMs(a);
    if (ms > 0) {
      opportunities.push({ id, title: a.title || id, savings_ms: ms });
    } else if (typeof a.score === 'number' && a.score < DIAGNOSTIC_MAX_SCORE) {
      diagnostics.push({ id, title: a.title || id, score: a.score });
    }
  }

  return {
    // Group on the URL we asked for: the final URL can differ between runs
    // (geo or device redirects) and is kept separately.
    url: lr.requestedUrl || lr.finalUrl || psi.id,
    final_url: lr.finalUrl || null,
    strategy: (lr.configSettings && lr.configSettings.formFactor) || null,
    fetched_at: lr.fetchTime || psi.analysisUTCTimestamp || null,
    lighthouse_version: lr.lighthouseVersion || null,
    performance: perf.score,
    best_practices: bp && typeof bp.score === 'number' ? bp.score : null,
    metrics,
    opportunities,
    diagnostics,
  };
}

// Several extracted runs of the same URL + strategy -> one averaged result.
// Opportunities must appear in a majority of runs, which filters out one-off noise.
function averageRuns(runs) {
  if (!runs.length) throw new Error('averageRuns needs at least one run');

  const metrics = {};
  for (const key of Object.keys(METRICS)) {
    const vals = runs.map((r) => r.metrics[key]).filter((v) => typeof v === 'number');
    metrics[key] = vals.length ? round(mean(vals), key === 'cls' ? 3 : 0) : null;
  }

  const byId = new Map();
  for (const run of runs) {
    for (const o of run.opportunities) {
      const entry = byId.get(o.id) || { id: o.id, title: o.title, total: 0, seen_in_runs: 0 };
      entry.total += o.savings_ms;
      entry.seen_in_runs += 1;
      byId.set(o.id, entry);
    }
  }
  const opportunities = [...byId.values()]
    .filter((e) => e.seen_in_runs * 2 > runs.length)
    // Divide by all runs, not just the ones it showed up in, so a flaky audit isn't overstated.
    .map(({ id, title, total, seen_in_runs }) => ({ id, title, savings_ms: round(total / runs.length), seen_in_runs }))
    .sort((a, b) => b.savings_ms - a.savings_ms);

  // Same majority rule for diagnostics. An audit that had savings in most runs is
  // already an opportunity, so it isn't listed twice.
  const opportunityIds = new Set(opportunities.map((o) => o.id));
  const diagById = new Map();
  for (const run of runs) {
    for (const d of run.diagnostics || []) {
      const entry = diagById.get(d.id) || { id: d.id, title: d.title, scores: [] };
      entry.scores.push(d.score);
      diagById.set(d.id, entry);
    }
  }
  const diagnostics = [...diagById.values()]
    .filter((e) => e.scores.length * 2 > runs.length && !opportunityIds.has(e.id))
    .map(({ id, title, scores }) => ({ id, title, score: round(mean(scores), 2) }))
    .sort((a, b) => a.score - b.score || a.id.localeCompare(b.id));

  const perfScores = runs.map((r) => r.performance);
  const bpScores = runs.map((r) => r.best_practices).filter((v) => typeof v === 'number');

  return {
    runs: runs.length,
    performance: round(mean(perfScores), 2),
    performance_range: [Math.min(...perfScores), Math.max(...perfScores)],
    best_practices: bpScores.length ? round(mean(bpScores), 2) : null,
    metrics,
    opportunities,
    diagnostics,
  };
}

// Opportunities -> root-cause groups, biggest first. Savings overlap between audits
// (e.g. unused JS and render-blocking both delay LCP), so a group reports its
// largest single saving rather than a sum.
function groupFindings(opportunities) {
  const groups = new Map();
  for (const o of opportunities) {
    const cause = AUDIT_TO_CAUSE[o.id] || 'other';
    const g = groups.get(cause) || {
      cause,
      label: cause === 'other' ? 'Other' : ROOT_CAUSES[cause].label,
      max_savings_ms: 0,
      audits: [],
    };
    g.audits.push({ id: o.id, title: o.title, savings_ms: o.savings_ms });
    g.max_savings_ms = Math.max(g.max_savings_ms, o.savings_ms);
    groups.set(cause, g);
  }
  return [...groups.values()].sort((a, b) => b.max_savings_ms - a.max_savings_ms);
}

function flagReasons(summary, thresholds = {}) {
  const scoreThreshold = thresholds.score ?? SCORE_THRESHOLD;
  const savingsThreshold = thresholds.savings_ms ?? SAVINGS_THRESHOLD_MS;
  const reasons = [];
  if (summary.performance < scoreThreshold) {
    reasons.push(`performance ${summary.performance} < ${scoreThreshold}`);
  }
  const big = summary.opportunities.filter((o) => o.savings_ms >= savingsThreshold);
  if (big.length) {
    reasons.push(`${big.length} opportunit${big.length === 1 ? 'y' : 'ies'} saving >= ${savingsThreshold}ms (top: ${big[0].id} ${big[0].savings_ms}ms)`);
  }
  return reasons;
}

// Raw PSI responses for one URL (any mix of strategies) -> the full report.
function buildReport(psiResponses, { thresholds = {}, now = new Date() } = {}) {
  const runs = psiResponses.map(extractRun);
  const urls = new Set(runs.map((r) => r.url));
  if (urls.size > 1) throw new Error(`buildReport expects one URL, got: ${[...urls].join(', ')}`);

  const byStrategy = {};
  for (const run of runs) {
    if (!run.strategy) throw new Error('PageSpeed Insights response has no formFactor (mobile/desktop)');
    (byStrategy[run.strategy] = byStrategy[run.strategy] || []).push(run);
  }

  const strategies = {};
  const reasons = [];
  for (const [strategy, list] of Object.entries(byStrategy)) {
    const summary = averageRuns(list);
    summary.root_causes = groupFindings(summary.opportunities);
    summary.flag_reasons = flagReasons(summary, thresholds);
    summary.flagged = summary.flag_reasons.length > 0;
    strategies[strategy] = summary;
    reasons.push(...summary.flag_reasons.map((r) => `${strategy}: ${r}`));
  }

  return {
    url: runs[0].url,
    final_url: runs[0].final_url,
    generated_at: now.toISOString(),
    lighthouse_version: runs[0].lighthouse_version,
    thresholds: {
      score: thresholds.score ?? SCORE_THRESHOLD,
      savings_ms: thresholds.savings_ms ?? SAVINGS_THRESHOLD_MS,
    },
    flagged: reasons.length > 0,
    flag_reasons: reasons,
    strategies,
  };
}

// Every audit id in a report, used to catch the AI citing audits that don't exist.
function auditIds(report) {
  const ids = new Set();
  for (const s of Object.values(report.strategies)) {
    for (const o of s.opportunities) ids.add(o.id);
    for (const d of s.diagnostics || []) ids.add(d.id);
  }
  return ids;
}

// n8n's HTTP Request node reports a failed PSI call as `<status> - <body>`, with
// Google's JSON error body (often JSON-encoded a second time) as the body. Keep
// only Google's message; anything else is returned unchanged.
function psiErrorMessage(text) {
  const raw = String(text);
  const m = raw.match(/^\d{3} - ([\s\S]+)$/);
  if (!m) return raw;
  try {
    let body = JSON.parse(m[1]);
    if (typeof body === 'string') body = JSON.parse(body);
    return (body && body.error && body.error.message) || raw;
  } catch {
    return raw;
  }
}

module.exports = {
  ROOT_CAUSES,
  savingsMs,
  extractRun,
  averageRuns,
  groupFindings,
  flagReasons,
  buildReport,
  auditIds,
  psiErrorMessage,
};
