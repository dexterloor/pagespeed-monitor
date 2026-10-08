# Demo script (2–4 min screen recording)

## Before recording

- [ ] `scripts/n8n.sh start`, sign in to the editor, and check the Google Sheets credential is connected. In Google's Testing mode, sign-in tokens expire after 7 days, so reconnect it if it's older than that.
- [ ] Clear old test rows from the sheet (keep the headers), and clear `#pagespeed-alerts`, or start from a known state.
- [ ] Check an error-workflow execution is still in **Executions** (they're kept 7 days; the build tests left some on 2026-10-08). If not, skip that scene or say it in words.
- [ ] Pre-run the happy path once so the results are ready to show. A run takes 1–2 minutes, so you can cut from the trigger to the result.
- [ ] Have these open in tabs: the n8n canvas, the "Check a page" form, Slack, the Sheet, and a terminal with `WEBHOOK_TOKEN` exported.
- [ ] Never open a failed **Post to Slack** node's error panel on camera: it can show the webhook URL.

## Script

| Time | Show | Say (roughly) |
|---|---|---|
| 0:00 | README diagram | "A single PageSpeed run is noisy and the report is long, and the people who need to act on it usually aren't developers. This automates the review: test, average, explain, record, alert." |
| 0:20 | n8n canvas, left to right | "Three triggers: a daily schedule, a 'Check a page' form for non-technical staff, and a token-protected webhook for other tools. The form and the webhook share one validation step. Each URL gets 3 runs on mobile and 3 on desktop. A failed request waits 30 seconds and retries once." |
| 0:50 | *Build reports* node code header | "This node averages the runs and groups findings by root cause. Its code is generated from a tested library in the repo, so what runs here is what the tests cover." |
| 1:05 | *AI analysis (Claude)* node + sticky note | "Flagged pages go to Claude with a fixed JSON schema and no tools. The script checks every cause cites a real Lighthouse audit, and falls back to a rule-based summary if Claude fails. In production this node becomes the Anthropic API node with a team key." |
| 1:30 | Browser: `localhost:5678/form/check-a-page`, paste Wikipedia and The Verge, **Check now** | "This is how a VA runs a check: paste the pages, and the form says where the results will land and how long it takes." |
| 1:40 | Slack digest | "One message per run, worst first. Here's the highest-risk page, with the plain-English summary and the quick win." |
| 2:00 | Sheet: `history`, then `findings` | "Every run is logged for trends. Flagged pages get a findings row with root causes, effort and whether the summary came from Claude or the fallback." |
| 2:25 | Terminal: `curl … {"url": "https://this-domain-does-not-exist.invalid/"}` | "Now a page that can't be tested." (Cut ahead about 70 s.) |
| 2:40 | Slack `:x:` line + `errors` tab | "Each failed run was retried once, logged with Google's error message, and the digest says the page couldn't be tested. The rest of the run carries on." |
| 2:55 | Terminal: `curl … {"url": "nope"}` → 400 | "Bad input is rejected before anything runs." |
| 3:05 | Executions list → an error-workflow execution | "If the workflow itself breaks, a separate error workflow alerts Slack and logs it." |
| 3:15 | Terminal: `npm test` (all passing) | "Everything outside n8n is tested, including real Lighthouse responses. Secrets live in n8n's encrypted credentials; the workflow JSON in the repo has none." |
| 3:30 | README "How this would scale" | "To scale: host n8n on a server, swap the CLI for the API node, and move history to a database once Sheets gets big." |

## Commands

```bash
export WEBHOOK_TOKEN=...   # from .env
hook() { curl -s -X POST http://localhost:5678/webhook/pagespeed \
  -H "X-Webhook-Token: $WEBHOOK_TOKEN" -H 'Content-Type: application/json' -d "$1"; echo; }

hook '{"urls": ["https://www.wikipedia.org/", "https://www.theverge.com/"]}'
hook '{"url": "https://this-domain-does-not-exist.invalid/"}'
hook '{"url": "nope"}'
```

The form for the 1:30 scene: http://localhost:5678/form/check-a-page

Results vary between runs. A fast page like Wikipedia can still be flagged for a single 100 ms+ saving (risk `low`), which is the configured threshold working, not a bug.
