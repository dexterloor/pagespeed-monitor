'use strict';

// Builds minimal PageSpeed Insights responses with the same shape as the real API,
// keeping only the fields the scripts read.

function makePsi({
  url = 'https://example.com/',
  strategy = 'mobile',
  performance = 0.95,
  bestPractices = 1,
  metrics = {},
  audits = {},
} = {}) {
  const m = {
    'largest-contentful-paint': 2000,
    'first-contentful-paint': 1000,
    'total-blocking-time': 100,
    'cumulative-layout-shift': 0.01,
    'speed-index': 1500,
    ...metrics,
  };
  const metricAudits = Object.fromEntries(
    Object.entries(m).map(([id, numericValue]) => [id, { id, title: id, score: 0.8, numericValue }]),
  );
  return {
    id: url,
    analysisUTCTimestamp: '2026-10-08T10:00:00.000Z',
    lighthouseResult: {
      requestedUrl: url,
      finalUrl: url,
      lighthouseVersion: '12.8.2',
      fetchTime: '2026-10-08T10:00:00.000Z',
      configSettings: { formFactor: strategy },
      categories: {
        performance: { id: 'performance', score: performance },
        'best-practices': { id: 'best-practices', score: bestPractices },
      },
      audits: { ...metricAudits, ...audits },
    },
  };
}

// Classic opportunity audit (details.overallSavingsMs).
const opportunity = (title, savingsMs, score = 0) => ({
  title, score, details: { type: 'opportunity', overallSavingsMs: savingsMs },
});

// Newer insight audit (metricSavings only).
const insight = (title, metricSavings, score = 0) => ({
  title, score, scoreDisplayMode: 'metricSavings', metricSavings,
});

module.exports = { makePsi, opportunity, insight };
