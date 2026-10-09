# Runbook

*For the **operator**: the person who keeps the PageSpeed Monitor running. One section per symptom: how to check it, then how to fix it.*

> **If you're a VA reading alerts, you want the [training pack](https://github.com/dexterloor/pagespeed-monitor-training) instead.** Its [what-to-do table](https://github.com/dexterloor/pagespeed-monitor-training/blob/main/what-to-do.md) says when to send something here.

Terms (*digest*, *flagged*, *risk*, *could not be tested*, *analysis source*, *run*) are defined in the training pack's [glossary](https://github.com/dexterloor/pagespeed-monitor-training/blob/main/glossary.md). How it all works: [README](../README.md).

---

## First checks (do these for any problem)

All commands run from the repo root.

```bash
curl -s http://127.0.0.1:5678/healthz          # {"status":"ok"} means n8n is up
sqlite3 .n8n/database.sqlite \
  "select id, mode, status, startedAt from execution_entity order by id desc limit 10;"
```

The second command lists recent **runs**. `mode` is `trigger` for the daily schedule and `webhook` for the form and the webhook. Times are UTC. You can see the same list in the editor at http://localhost:5678 under **Executions**. Open a run to see which node failed and why. Executions are kept for 7 days.

Ask the VA for the **run number** (digest footer or `run_id` in the Sheet). It's the execution ID.

| Symptom | Section |
|---|---|
| No digest after the daily run time | [The daily run didn't happen](#the-daily-run-didnt-happen) |
| The "Check a page" form won't open | [The form isn't loading](#the-form-isnt-loading) |
| ❌ *could not be tested* in the digest | [A page could not be tested](#a-page-could-not-be-tested) |
| *(fallback summary)* or *(error summary)* in the digest | [Claude unavailable (fallback)](#claude-unavailable-fallback) |
| Digest arrived but the Sheet has no new rows | [Google sign-in expired](#google-sign-in-expired) |
| 🚨 *"PageSpeed Monitor failed at …"* in Slack | [Error alert in Slack](#error-alert-in-slack) |
| Nothing responds on port 5678 | [n8n isn't running](#n8n-isnt-running) |
| A change made in the editor disappeared | [Editor changes were overwritten](#editor-changes-were-overwritten) |
| Old behaviour right after a deploy | [Deployed, but n8n runs the old version](#deployed-but-n8n-runs-the-old-version) |

---

## The daily run didn't happen

**The VA sees:** no digest after the daily run time. Every run posts one, even when all pages pass (a one-line ✅ message), so silence means the run didn't happen or broke before the end. (→ [training pack: no digest](https://github.com/dexterloor/pagespeed-monitor-training/blob/main/what-to-do.md#no-digest))

**Check, in order:**
1. **Is the schedule on?** `grep SCHEDULE_ENABLED scripts/lib/config.js`. It's `false` until the demo video is recorded. In the editor, a disabled *Daily schedule* node is greyed out.
2. **Was n8n running at 07:00** (this machine's time zone)? Run the [first checks](#first-checks-do-these-for-any-problem). No `trigger` run today means n8n wasn't running or the machine was asleep. n8n doesn't make up missed schedule runs.
3. **Did it run but fail?** A `trigger` run with status `error` → open it, and see [Error alert in Slack](#error-alert-in-slack).
4. **Still running?** A slow run (several heavy pages, retries, Claude timeouts) can take 15 minutes or more. Status `running` → wait.

**Fix:**
- Start n8n if it isn't running ([n8n isn't running](#n8n-isnt-running)).
- Run today's check by hand. The VA can paste the daily list into the form, or you can send it to the webhook:
  ```bash
  jq -c '{urls: .urls}' config/urls.json | curl -s -X POST http://localhost:5678/webhook/pagespeed \
    -H "X-Webhook-Token: $WEBHOOK_TOKEN" -H 'Content-Type: application/json' -d @-
  ```
  These rows show `trigger` = `webhook` (or `form`), not `schedule`.
- To stop it happening again on a Mac, wake it before the run: `sudo pmset repeat wakeorpoweron MTWRFSU 06:55:00`. n8n must also be running. Long term, host n8n on a server (README, "How this would scale").

## The form isn't loading

**The VA sees:** http://localhost:5678/form/check-a-page doesn't open, or shows "not found". (→ [training pack: the form said "Nothing was checked"](https://github.com/dexterloor/pagespeed-monitor-training/blob/main/what-to-do.md#the-form-said-nothing-was-checked))

**Check:**
1. `curl -s http://127.0.0.1:5678/healthz`. No answer → [n8n isn't running](#n8n-isnt-running).
2. n8n only just started? For a few seconds after "Editor is now accessible", the form returns 404 while it registers. Wait 10 seconds and reload.
3. Still 404: is the form registered?
   ```bash
   sqlite3 .n8n/database.sqlite "select webhookPath, method from webhook_entity;"
   ```
   You should see `check-a-page` for both `GET` and `POST`. If it's missing, the published workflow is an old version: run `scripts/n8n.sh deploy`, then start n8n.
4. The VA is on another computer? n8n listens on `127.0.0.1` only, so the form works only on this machine. That's deliberate: the form has no login. To share it, host n8n and put basic auth or n8n's user login in front of the form first (README, "Data and secrets").

**"Nothing was checked"** on the form isn't a fault. It means none of the input was a valid `http(s)` URL (validation is in `scripts/lib/request.js`).

## A page could not be tested

**The VA sees:** `❌ <url>: no PageSpeed data (6 failed runs)` in the digest. (→ [training pack: a page could not be tested](https://github.com/dexterloor/pagespeed-monitor-training/blob/main/what-to-do.md#a-page-could-not-be-tested))

Every PageSpeed request that fails is retried once after 30 seconds. A page is *could not be tested* when all 6 requests (3 runs × 2 strategies) still fail. If only some fail, it's ⚠️ *partial* and the report uses the rest.

**Check:** the `errors` tab rows for that `run_id`. The `error_message` column holds Google's message and `http_status` holds the code:

| `error_message` / `http_status` | Cause | Fix |
|---|---|---|
| `Lighthouse returned error: FAILED_DOCUMENT_REQUEST`, `400` | Google couldn't load the page: it's down, the domain is wrong, or the site blocks Google's tester | Open the URL yourself. If it's down, it's the site owner's problem, not the monitor's. If it loads, re-run with the form. If it always fails, the site may block Lighthouse; tell the site owner |
| `429` | PageSpeed API quota or rate limit | Wait and re-run. Check quota in Google Cloud console → APIs → PageSpeed Insights API → Quotas. For long URL lists, see README "How this would scale" |
| `5xx`, or a timeout | Google's side | Re-run later. If it lasts hours, check the [Google Cloud status page](https://status.cloud.google.com/) |
| `403` / `API key not valid` | The PSI key is wrong, restricted or deleted | Fix the key in Google Cloud, update `PSI_API_KEY` in `.env`, stop n8n, run `scripts/import-credentials.sh`, start n8n |
| `… no performance score` (`http_status` 200) | PageSpeed answered without a performance score | Rare. If it happens on every page, see [the incident](incidents/2026-10-08-n8n-query-parameter-collapse.md) |

**Known waste:** the retry also retries `4xx` errors, which never succeed, so an unreachable page costs about 50 seconds more than it needs to. It's harmless, and on the list to change.

**Whole daily list could not be tested** → it's this machine's network, or the PSI key. Check `http_status` on any row.

## Claude unavailable (fallback)

**The VA sees:** *(fallback summary)* after the scores, and in the Sheet `analysis_source` = `fallback`. (→ [training pack: fallback summary](https://github.com/dexterloor/pagespeed-monitor-training/blob/main/what-to-do.md#fallback-summary))

`scripts/analyze.js` calls the Claude Code CLI. If Claude errors, times out or fails validation twice, the script writes a deterministic summary from the report and marks it `fallback`. The run never stops here. The scores and the risk level are unaffected: risk always comes from `riskFromReport()` (`scripts/lib/risk.js`), whoever writes the summary.

**Check:** the `fallback_reason` column in `findings`:

| `fallback_reason` | Fix |
|---|---|
| `ANALYZE_FORCE_FALLBACK=1` | Test mode was left on. Set `ANALYZE_FORCE_FALLBACK=0` in `.env` (or don't pass it), then restart n8n |
| `claude timed out after 180000ms` | Claude was slow (a timeout isn't retried). One-off: ignore. Often: raise `CLAUDE_TIMEOUT_MS` in `.env` and restart |
| `could not start claude: spawn claude ENOENT` | The CLI isn't on n8n's PATH. `which claude` in your shell, then restart with `scripts/n8n.sh start`, which adds that folder to n8n's PATH |
| `claude exited 1: …` | Read the rest of the message. Usually sign-in or a usage limit: run `claude` in a terminal to sign in again, or wait for the limit to reset |
| `invalid analysis: …` (e.g. an unknown audit id) | Claude's answer failed the grounding check. One-off: fine, that's the check working. Every time: compare the prompt in `prompts/analyze-report.md` with the report shape |

**Test the AI step on its own:**
```bash
node scripts/analyze.js --file samples/report-flagged.illustrative.json | jq '{source, fallback_reason}'
```
`"source": "claude"` means it's working.

**`analysis_source` = `error`** / *(error summary)*: `analyze.js` didn't run at all, so the *AI analysis (Claude)* node itself failed. Open the run in Executions and read that node's error (usually `node` not found, or Execute Command disabled; `scripts/n8n.sh` sets both).

## Google sign-in expired

**The VA sees:** a digest whose run number has no rows in the Sheet.

The Google Cloud OAuth app is in **Testing** mode, so Google's sign-in tokens expire after **7 days**. Sheets writes then fail. By design the run carries on and still posts the digest (README, "Error handling"), so this is easy to miss.

**Check:** open the run in Executions. *Append history* / *Append findings* / *Append errors* show an auth error, or Credentials → *Google Sheets (PageSpeed Monitor)* shows a reconnect warning.

**Fix:** n8n → **Credentials → Google Sheets (PageSpeed Monitor) → Sign in with Google**. Then re-run any missed checks with the form. To stop the weekly expiry, publish the OAuth app (Google Cloud console → OAuth consent screen → Publish app).

## Error alert in Slack

**The VA sees:** 🚨 *"PageSpeed Monitor failed at \<node\>"* with an error message and an execution number. (→ [training pack: the monitor itself failed](https://github.com/dexterloor/pagespeed-monitor-training/blob/main/what-to-do.md#the-monitor-itself-failed))

The separate error workflow (*PageSpeed Monitor: errors*) sends this when the main workflow **stops**. It doesn't fire for a failed PageSpeed request (that's retried and logged) or a failed Sheets write (that's skipped). So this alert means something actually broke. It also writes an `errors` row with an empty `url`.

**Check:** open the execution number from the alert in Executions and look at the failed node.

| Failed node | Likely cause | Fix |
|---|---|---|
| *Build reports* | Unexpected PageSpeed response shape, or a bug in `scripts/lib/psi.js` | Save the input items, add them as a test fixture, fix, `npm test`, deploy |
| *Post to Slack* | Slack webhook URL revoked, or Slack down | Check `SLACK_WEBHOOK_URL` in `.env`; restart n8n. **Don't screenshot this node's error panel: it can show the webhook URL** |
| *URLs to check* / *Make PSI requests* | Bad entry in `config/urls.json` or a bad deploy | Fix and `scripts/n8n.sh deploy` |

After the fix, re-run the affected check with the form.

## n8n isn't running

**Check:** `curl -s http://127.0.0.1:5678/healthz` gives no answer. Common after a reboot, since nothing starts n8n automatically.

**Fix:**
```bash
scripts/n8n.sh start > .n8n/server.log 2>&1 &
tail -f .n8n/server.log      # ready when it says "Editor is now accessible"
```
Always start it with `scripts/n8n.sh`, never with `npx n8n`. The script sets the allowlisted environment, the Slack URL, the Sheet ID and the Execute Command setting. Without them, Slack and the AI step fail.

`scripts/n8n.sh stop` finds n8n by its port, because n8n renames its own process.

## Editor changes were overwritten

Changes made in the n8n editor are replaced on the next `scripts/n8n.sh deploy`, because deploy rebuilds `workflows/*.json` from `scripts/build-workflows.js` and `scripts/lib/`. That's deliberate: the code the tests cover is the code that runs.

**Fix:** make the change in `scripts/`, run `npm test`, then `scripts/n8n.sh deploy`. Don't edit `workflows/*.json` by hand; a test fails if it doesn't match the generator.

## Deployed, but n8n runs the old version

With n8n 2.42, the first start after a CLI import/publish still serves the previously published version. `scripts/n8n.sh deploy` already does a throwaway start/stop to get past this.

**If you still see old behaviour** (a new node is missing, or the form returns 404 after the wait): `scripts/n8n.sh stop`, then start again.

## Rotating the webhook token

Do this if the token may have leaked. The form doesn't use it, so VAs aren't affected.

```bash
openssl rand -hex 24              # new value -> WEBHOOK_TOKEN in .env
scripts/n8n.sh stop
scripts/import-credentials.sh     # updates the token; keeps the Google sign-in
scripts/n8n.sh start
```
Then give the new token to whatever calls the webhook. The old one now gets `403`.

---

Something not covered here? Once it's fixed, add a section. If it was a real bug, write it up in [`incidents/`](incidents/).
