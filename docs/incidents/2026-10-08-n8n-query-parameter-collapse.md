# Incident: n8n merged a repeated query parameter, so PageSpeed returned one category

| | |
|---|---|
| **Date** | 2026-10-08, during the build, before the first commit |
| **Found by** | The first end-to-end test run through n8n |
| **Would have caused** | Every page reported as *could not be tested*, on every run |
| **Status** | Fixed, with a test that fails if it comes back |

## Summary

The monitor asks PageSpeed Insights (PSI) for two Lighthouse categories by repeating a query parameter: `category=performance&category=best-practices`. n8n's HTTP Request node merged the two into one, so PSI only ever saw `category=best-practices` and returned no performance score. It took three attempts to fix. What worked was building the whole query string in a Code node and sending the API key in a header instead of the URL.

## How it was found

The first full test run through n8n (two URLs sent to the webhook) finished with status *success*. Reading the execution data showed that the *Build reports* step had rejected every PageSpeed response with `PageSpeed Insights response has no performance score`. The responses contained `{"best-practices": {"score": 1}}` and nothing else.

So the run "worked", and the check that a response actually contains a performance score (`extractRun()` in `scripts/lib/psi.js`) is what caught it. Without that check, the result would have been reports with no scores, not an error.

## What we tried

| Attempt | Result |
|---|---|
| 1. Set the HTTP node's *Array format in query parameters* option to *No brackets* (`repeat`) | Still one category. n8n merges duplicate names before that option is applied |
| 2. Put `?category=performance&category=best-practices` straight into the node's URL | Still one category. At this point the API key was still a query parameter added by the node's credential. The likely explanation is that adding it made n8n re-parse the URL's query string and merge the duplicates again. I didn't dig into n8n's source to confirm, because attempt 3 removed the need |
| 3. Checked with `curl`: same URL, API key sent as an `X-Goog-Api-Key` header | Both categories came back. With no query parameter left for n8n to add, the URL goes out exactly as built |

## Root cause

n8n's HTTP Request node treats query parameters as name/value pairs keyed by name. When it builds or rebuilds the query string, a second parameter with the same name replaces the first. PSI is one of the APIs that expect a repeated name for a list. Nothing errored: PSI answered `200`, just with less than we asked for.

## Fix

1. **The Code node builds the full URL.** *Make PSI requests* writes the complete PSI URL, with one `category=` for each entry in `CATEGORIES` (`scripts/lib/config.js`). The HTTP node requests `{{ $json.psi_url }}` as it is. See `CODE_REQUESTS` in [`scripts/build-workflows.js`](../../scripts/build-workflows.js).
2. **The API key moved to a header.** The key is now an n8n Header Auth credential (`X-Goog-Api-Key`) instead of a query parameter, so n8n never rewrites the URL. A side benefit: the key no longer appears in URLs, in the workflow JSON or in saved execution data.

## What stops it coming back

- `tests/workflows.test.js`, *"Make PSI requests builds the full PSI query"*, runs the generated Code node and checks that the URL has both `category` values and **no** `key` parameter. It also checks that both PSI nodes use a header credential.
- `extractRun()` still rejects any response without a performance score. A test feeds *Build reports* a response with only Best Practices and checks it's logged as an error rather than averaged in.
- A test scans the generated workflow JSON for API keys and webhook URLs.

## What I'd do differently

- **Read the output of the first run, not just its status.** n8n said *success*. The problem only showed up in the data. I now treat "the first real run" as something to inspect node by node.
- **Expect low-code tools to normalise requests.** If an API depends on something unusual (repeated parameters, ordering, encoding), build that part in code where it can be unit-tested, and test the exact request that goes out.
- **Validate what comes back.** The score check turned a silent data problem into a loud one. Every API response the workflow depends on should be checked for the fields it needs.

Related: [runbook: a page could not be tested](../runbook.md#a-page-could-not-be-tested).
