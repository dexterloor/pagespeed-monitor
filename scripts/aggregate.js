#!/usr/bin/env node
'use strict';

// Raw PSI responses for one URL -> report JSON. Handy for rebuilding samples/ and
// for checking the averaging outside n8n.
//
//   node scripts/aggregate.js run1.json run2.json ...     (each file: one PSI response)
//   node scripts/aggregate.js --file runs.json            (one file: an array of PSI responses)

const fs = require('node:fs');
const { buildReport } = require('./lib/psi');

function main(argv) {
  const f = argv.indexOf('--file');
  const responses = f !== -1
    ? JSON.parse(fs.readFileSync(argv[f + 1], 'utf8'))
    : argv.map((p) => JSON.parse(fs.readFileSync(p, 'utf8')));
  if (!Array.isArray(responses) || !responses.length) {
    process.stderr.write('aggregate: no PSI responses given\n');
    process.exit(2);
  }
  process.stdout.write(`${JSON.stringify(buildReport(responses), null, 2)}\n`);
}

if (require.main === module) main(process.argv.slice(2));
