# Google Sheets setup

1. Create a blank Google Sheet named **PageSpeed Monitor**.
2. Rename the first tab to `history` and add two more tabs: `findings` and `errors`.
3. For each tab, paste its header line below into cell A1. Then select A1 and choose **Data → Split text to columns** (separator: comma).
4. Copy the Sheet ID from the URL (`/d/<ID>/edit`) into `.env` as `GOOGLE_SHEET_ID`. The workflow reads it from there.

The column order matches `scripts/lib/sheets.js`, which builds the rows.

## `history`: one row per URL per strategy, every run

```
timestamp,run_id,trigger,url,strategy,performance,best_practices,lcp_ms,fcp_ms,tbt_ms,cls,si_ms,runs,flagged,flag_reasons
```

| Column | Meaning |
|---|---|
| `timestamp` | When the report was built (UTC, ISO 8601) |
| `run_id` | n8n execution ID, which links rows from the same run |
| `trigger` | `schedule`, `form` (the "Check a page" form) or `webhook` |
| `strategy` | `mobile` or `desktop` |
| `performance`, `best_practices` | Lighthouse category scores, 0–1, averaged over 3 runs |
| `lcp_ms` … `si_ms`, `cls` | Averaged Core Web Vitals and lab metrics |
| `runs` | How many PSI runs were averaged (normally 3) |
| `flagged`, `flag_reasons` | Whether this strategy crossed a threshold, and why |

## `findings`: one row per flagged URL

```
timestamp,run_id,url,risk,mobile_score,desktop_score,summary,root_causes,quick_win,analysis_source,fallback_reason
```

| Column | Meaning |
|---|---|
| `risk` | `low` / `medium` / `high`, from `scripts/lib/risk.js` (the same rubric as `prompts/analyze-report.md`) |
| `summary` | Plain-English summary for non-developers |
| `root_causes` | Numbered list: cause, affected strategy, estimated savings, effort, fix |
| `analysis_source` | `claude`, or `fallback` if the AI step failed validation or timed out |
| `fallback_reason` | Why the fallback was used (empty when `claude`) |

## `errors`: one row per failed PageSpeed run, or per workflow error

```
timestamp,run_id,workflow,node,url,error_message,http_status,attempts
```

Tip: freeze row 1 and add a conditional format on `history.performance` (red below 0.5, amber below 0.9) for a quick visual trend.

## `escalations` (optional): filled in by people, not the workflow

The training pack asks VAs to log every message they send about a page, so nobody sends the same alert twice and "is this new?" has an answer. Add this tab if your team uses that process. The workflow never reads or writes it.

```
first_sent,last_sent,url,risk,mobile_score,sent_to,run_id,status,notes
```

One row per page, edited in place. `risk` is the highest risk the client has been told about (`high`, `medium`, or `down` if the page wasn't loading). `status` is `open`, `updated`, `accepted` (the client won't fix it) or `fixed`. The rules for filling it in are in the training pack's [what-to-do.md](https://github.com/dexterloor/pagespeed-monitor-training/blob/main/what-to-do.md#the-escalation-log).

