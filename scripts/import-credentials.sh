#!/usr/bin/env bash
# Creates (or updates) the n8n credentials the workflows use, from .env:
#   PageSpeed API key     (Header Auth: X-Goog-Api-Key=PSI_API_KEY)
#   Google Sheets OAuth2  (client ID + secret; you still click "Sign in with Google" in n8n)
#   Webhook token         (Header Auth: X-Webhook-Token=WEBHOOK_TOKEN)
#
# The values are written to a temp file readable only by you, imported into n8n's
# encrypted credential store, and the temp file is deleted on exit.
# Run with n8n stopped. IDs are fixed so re-running updates instead of duplicating.
#
# Re-importing the Google credential would drop its sign-in token, so it is
# skipped once it exists. Pass --reset-google to replace it (you then sign in again).
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
[[ -f "$REPO/.env" ]] || { echo "No .env found (copy .env.example)" >&2; exit 1; }

umask 077
TMP="$(mktemp -t n8n-creds)"
trap 'rm -f "$TMP"' EXIT

SKIP_GOOGLE=0
DB="$REPO/.n8n/database.sqlite"
if [[ "${1:-}" != "--reset-google" && -f "$DB" ]] && \
   [[ -n "$(sqlite3 "$DB" "select id from credentials_entity where id='pagespeedSheets1';" 2>/dev/null)" ]]; then
  SKIP_GOOGLE=1
  echo "Keeping the existing Google Sheets credential (use --reset-google to replace it)."
fi

SKIP_GOOGLE=$SKIP_GOOGLE node - "$REPO/.env" "$TMP" <<'EOF'
const fs = require('node:fs');
const [envPath, out] = process.argv.slice(2);
const env = {};
for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/);
  if (m) env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
}
const skipGoogle = process.env.SKIP_GOOGLE === '1';
const need = ['PSI_API_KEY', 'WEBHOOK_TOKEN', ...(skipGoogle ? [] : ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'])];
const missing = need.filter((k) => !env[k]);
if (missing.length) {
  console.error(`Missing in .env: ${missing.join(', ')}`);
  process.exit(1);
}
fs.writeFileSync(out, JSON.stringify([
  {
    id: 'pagespeedPsiHdr1', name: 'PageSpeed Insights API key', type: 'httpHeaderAuth',
    data: { name: 'X-Goog-Api-Key', value: env.PSI_API_KEY },
  },
  ...(skipGoogle ? [] : [{
    id: 'pagespeedSheets1', name: 'Google Sheets (PageSpeed Monitor)', type: 'googleSheetsOAuth2Api',
    data: { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET },
  }]),
  {
    id: 'pagespeedHook001', name: 'PageSpeed webhook token', type: 'httpHeaderAuth',
    data: { name: 'X-Webhook-Token', value: env.WEBHOOK_TOKEN },
  },
]));
EOF

"$REPO/scripts/n8n.sh" import:credentials --input="$TMP"
