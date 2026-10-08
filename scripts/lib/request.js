'use strict';

// Checks the URLs sent to an on-demand run. The webhook and the "Check a page"
// form both use this, so they accept and reject exactly the same input.

const MAX_URLS_PER_REQUEST = 10;
const URL_PATTERN = /^https?:\/\/[^\s/$.?#].[^\s]*$/i;

// requested: the raw strings as sent. Returns the unique valid URLs, the ones
// that were dropped, and an error code when nothing can be checked.
function checkUrls(requested) {
  const trimmed = requested.map((u) => String(u).trim()).filter(Boolean);
  const unique = [...new Set(trimmed)];
  const urls = unique.filter((u) => URL_PATTERN.test(u));
  const rejected = unique.filter((u) => !URL_PATTERN.test(u));

  let error = null;
  if (!trimmed.length) error = 'empty';
  else if (!urls.length) error = 'no_valid_urls';
  else if (urls.length > MAX_URLS_PER_REQUEST) error = 'too_many';

  return { valid: !error, error, urls, rejected };
}

// The form has one free-text box: one address per line, or separated by spaces or commas.
function splitUrlText(text) {
  return String(text || '').split(/[\s,]+/).filter(Boolean);
}

module.exports = { MAX_URLS_PER_REQUEST, checkUrls, splitUrlText };
