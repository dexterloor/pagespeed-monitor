'use strict';

// Thresholds match the manual PageSpeed review process this project automates.
module.exports = {
  SCORE_THRESHOLD: 0.9,
  SAVINGS_THRESHOLD_MS: 100,
  RUNS_PER_STRATEGY: 3,
  STRATEGIES: ['mobile', 'desktop'],
  CATEGORIES: ['performance', 'best-practices'],
  // Daily 07:00 run in n8n. Off by default so nothing runs until you choose to;
  // change here and run `scripts/n8n.sh deploy` (UI edits are overwritten on deploy).
  SCHEDULE_ENABLED: false,
  // PSI `fields` mask: drops screenshots and other bulk. The API can't select
  // fields inside `audits` (it's a map), so audits come back whole.
  // Measured: 2.2 MB -> 1.6 MB on a heavy page, 2.5 MB -> 250 KB on a light one.
  PSI_FIELDS: 'id,analysisUTCTimestamp,lighthouseResult(requestedUrl,finalUrl,lighthouseVersion,fetchTime,configSettings/formFactor,categories/*/score,audits)',
};
