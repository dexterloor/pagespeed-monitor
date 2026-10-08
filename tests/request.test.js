'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { checkUrls, splitUrlText } = require('../scripts/lib/request');

test('checkUrls keeps unique valid URLs and lists the rest', () => {
  const r = checkUrls([' https://a.example/ ', 'ftp://x', 'https://a.example/', 'nope', '']);
  assert.equal(r.valid, true);
  assert.deepEqual(r.urls, ['https://a.example/']);
  assert.deepEqual(r.rejected, ['ftp://x', 'nope']);
});

test('checkUrls error codes', () => {
  assert.equal(checkUrls([]).error, 'empty');
  assert.equal(checkUrls(['  ']).error, 'empty');
  assert.equal(checkUrls(['nope']).error, 'no_valid_urls');
  assert.equal(checkUrls(Array.from({ length: 11 }, (_, i) => `https://x${i}.example/`)).error, 'too_many');
  assert.equal(checkUrls(Array.from({ length: 10 }, (_, i) => `https://x${i}.example/`)).valid, true);
});

test('splitUrlText accepts one per line, spaces or commas', () => {
  assert.deepEqual(splitUrlText('https://a/\r\nhttps://b/, https://c/  https://d/\n'), ['https://a/', 'https://b/', 'https://c/', 'https://d/']);
  assert.deepEqual(splitUrlText(undefined), []);
});
