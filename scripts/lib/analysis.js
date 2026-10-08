'use strict';

// The contract for the AI step: the JSON shape Claude must return, a validator
// for it, and a deterministic fallback built from the report when Claude's
// output is missing or invalid. The workflow never stops because of the AI step.

const { auditIds } = require('./psi');

const RISK = ['low', 'medium', 'high'];
const AFFECTS = ['mobile', 'desktop', 'both'];
const EFFORT = ['small', 'medium', 'large'];

// Passed to `claude -p --json-schema`, and enforced again by validateAnalysis().
const ANALYSIS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'risk', 'root_causes', 'quick_win'],
  properties: {
    summary: { type: 'string', minLength: 1, maxLength: 600 },
    risk: { type: 'string', enum: RISK },
    root_causes: {
      type: 'array',
      minItems: 1,
      maxItems: 5,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['cause', 'affects', 'audit_ids', 'est_savings_ms', 'fix', 'effort'],
        properties: {
          cause: { type: 'string', minLength: 1, maxLength: 120 },
          affects: { type: 'string', enum: AFFECTS },
          audit_ids: { type: 'array', minItems: 1, items: { type: 'string' } },
          est_savings_ms: { type: 'number', minimum: 0 },
          fix: { type: 'string', minLength: 1, maxLength: 400 },
          effort: { type: 'string', enum: EFFORT },
        },
      },
    },
    quick_win: { type: 'string', minLength: 1, maxLength: 300 },
  },
};

// Same rubric the prompt gives Claude, so fallback output reads consistently.
function riskFromReport(report) {
  const summaries = Object.values(report.strategies);
  const worstScore = Math.min(...summaries.map((s) => s.performance));
  const biggestSaving = Math.max(0, ...summaries.flatMap((s) => s.opportunities.map((o) => o.savings_ms)));
  if (worstScore < 0.5 || biggestSaving >= 1000) return 'high';
  if (worstScore < 0.9 || biggestSaving >= 300) return 'medium';
  return 'low';
}

const isStr = (v, max) => typeof v === 'string' && v.trim().length > 0 && v.length <= max;

// Returns { ok: true, value } or { ok: false, errors: [...] }.
// Root causes that cite audit ids missing from the report count as errors:
// they mean the model invented a finding.
function validateAnalysis(value, report) {
  const errors = [];
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, errors: ['analysis is not an object'] };
  }
  const allowed = Object.keys(ANALYSIS_SCHEMA.properties);
  for (const k of Object.keys(value)) {
    if (!allowed.includes(k)) errors.push(`unexpected field "${k}"`);
  }
  if (!isStr(value.summary, 600)) errors.push('summary must be a non-empty string up to 600 chars');
  if (!RISK.includes(value.risk)) errors.push(`risk must be one of ${RISK.join('/')}`);
  if (!isStr(value.quick_win, 300)) errors.push('quick_win must be a non-empty string up to 300 chars');

  const known = report ? auditIds(report) : null;
  if (!Array.isArray(value.root_causes) || value.root_causes.length < 1 || value.root_causes.length > 5) {
    errors.push('root_causes must be an array of 1-5 items');
  } else {
    value.root_causes.forEach((rc, i) => {
      const p = `root_causes[${i}]`;
      if (!rc || typeof rc !== 'object') return errors.push(`${p} is not an object`);
      if (!isStr(rc.cause, 120)) errors.push(`${p}.cause must be a non-empty string up to 120 chars`);
      if (!AFFECTS.includes(rc.affects)) errors.push(`${p}.affects must be one of ${AFFECTS.join('/')}`);
      if (!EFFORT.includes(rc.effort)) errors.push(`${p}.effort must be one of ${EFFORT.join('/')}`);
      if (!isStr(rc.fix, 400)) errors.push(`${p}.fix must be a non-empty string up to 400 chars`);
      if (typeof rc.est_savings_ms !== 'number' || !(rc.est_savings_ms >= 0)) {
        errors.push(`${p}.est_savings_ms must be a number >= 0`);
      }
      if (!Array.isArray(rc.audit_ids) || rc.audit_ids.length < 1) {
        errors.push(`${p}.audit_ids must be a non-empty array`);
      } else if (known) {
        const unknown = rc.audit_ids.filter((id) => !known.has(id));
        if (unknown.length) errors.push(`${p}.audit_ids not in report: ${unknown.join(', ')}`);
      }
    });
  }
  return errors.length ? { ok: false, errors } : { ok: true, value };
}

// Generic, safe advice per root cause, used only when the AI step fails.
const FIX_HINTS = {
  images: 'Serve images in WebP/AVIF at the size they are displayed, lazy-load images below the fold, and set width/height.',
  javascript: 'Remove or defer unused JavaScript, split large bundles, and stop shipping legacy polyfills to modern browsers.',
  render_blocking: 'Inline critical CSS, defer the rest, and load non-critical scripts with defer or async.',
  lcp: 'Make the LCP image discoverable in the HTML, preload it, and give it fetchpriority="high". Never lazy-load it.',
  server: 'Reduce server response time, enable compression, and set long cache lifetimes on static assets.',
  fonts: 'Use font-display: swap and preload the one or two fonts that are needed above the fold.',
  third_party: 'Audit third-party tags, delay non-essential ones until after load, and use facades for embeds.',
  layout: 'Reserve space for images, ads and embeds so content does not move after it renders.',
  other: 'Review the listed Lighthouse audits for this page.',
};

function fallbackAnalysis(report) {
  const entries = Object.entries(report.strategies);
  const scores = entries.map(([s, v]) => `${Math.round(v.performance * 100)} on ${s}`).join(' and ');

  // Merge root causes across strategies, keeping the larger saving.
  const merged = new Map();
  for (const [strategy, s] of entries) {
    for (const g of s.root_causes) {
      const prev = merged.get(g.cause);
      if (!prev) {
        merged.set(g.cause, { ...g, strategies: [strategy], audit_ids: g.audits.map((a) => a.id) });
      } else {
        prev.strategies.push(strategy);
        prev.max_savings_ms = Math.max(prev.max_savings_ms, g.max_savings_ms);
        for (const a of g.audits) if (!prev.audit_ids.includes(a.id)) prev.audit_ids.push(a.id);
      }
    }
  }
  const top = [...merged.values()].sort((a, b) => b.max_savings_ms - a.max_savings_ms).slice(0, 3);

  const rootCauses = top.map((g) => ({
    cause: g.label,
    affects: g.strategies.length > 1 ? 'both' : g.strategies[0],
    audit_ids: g.audit_ids,
    est_savings_ms: g.max_savings_ms,
    fix: FIX_HINTS[g.cause] || FIX_HINTS.other,
    effort: 'medium',
  }));
  if (!rootCauses.length) {
    rootCauses.push({
      cause: 'Overall performance score',
      affects: 'both',
      audit_ids: [],
      est_savings_ms: 0,
      fix: 'No single large opportunity was found. Review the Lighthouse diagnostics for this page.',
      effort: 'medium',
    });
  }

  const lead = top[0]
    ? ` The biggest issue is ${top[0].label.toLowerCase()} (up to about ${top[0].max_savings_ms} ms).`
    : '';
  return {
    summary: `This page scored ${scores} out of 100 (target: ${Math.round(report.thresholds.score * 100)}).${lead} This summary was generated automatically because the AI analysis was unavailable.`,
    risk: riskFromReport(report),
    root_causes: rootCauses,
    quick_win: rootCauses[0].fix,
  };
}

// `claude -p --output-format json` prints one envelope object. The answer is in
// `structured_output` when --json-schema is used, otherwise in `result` as text.
function parseClaudeEnvelope(stdout) {
  let env;
  try {
    env = JSON.parse(stdout);
  } catch {
    return { ok: false, error: 'claude output is not JSON' };
  }
  if (env.is_error || (env.subtype && env.subtype !== 'success')) {
    return { ok: false, error: `claude reported an error: ${env.subtype || 'is_error'} ${env.api_error_status || ''}`.trim() };
  }
  if (env.structured_output && typeof env.structured_output === 'object') {
    return { ok: true, value: env.structured_output };
  }
  if (typeof env.result === 'string') {
    // Tolerate a model that wraps its JSON in a ```json fence.
    const text = env.result.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    try {
      return { ok: true, value: JSON.parse(text) };
    } catch {
      return { ok: false, error: 'claude result is not valid JSON' };
    }
  }
  return { ok: false, error: 'claude output has no result' };
}

module.exports = {
  ANALYSIS_SCHEMA,
  riskFromReport,
  validateAnalysis,
  fallbackAnalysis,
  parseClaudeEnvelope,
};
