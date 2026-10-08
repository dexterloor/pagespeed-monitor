#!/usr/bin/env bash
# Runs the local n8n for this project with the settings the workflows need.
#
#   scripts/n8n.sh start                                          # editor at http://localhost:5678
#   scripts/n8n.sh stop                                           # stop the n8n started above
#   scripts/n8n.sh deploy                                         # stop, rebuild and load workflows/
#   scripts/n8n.sh import:workflow --input=workflows/main.json    # any n8n CLI command
#
# n8n 2.x needs Node >= 24. Set N8N_RUNTIME to a folder containing node24/ and
# node_modules/.bin/n8n (default ~/.local/share/n8n-runtime, see README).
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [[ "${1:-}" == "deploy" ]]; then
  # Loads workflows/*.json into n8n and publishes them. n8n must be stopped for
  # CLI imports, and a published version takes effect on the next start.
  "$0" stop
  node "$REPO/scripts/build-workflows.js"
  for w in error main; do "$0" import:workflow --input="$REPO/workflows/$w.json"; done
  for id in pagespeedErr0001 pagespeedMain001; do "$0" publish:workflow --id="$id"; done
  # Observed with n8n 2.42: the first start after a CLI import still serves the
  # previously published version; the start after that serves the new one. A
  # throwaway start/stop here means the next real start is correct.
  log="$(mktemp -t n8n-warmup)"
  "$0" start > "$log" 2>&1 &
  warmup=$!
  ready=0
  for _ in $(seq 1 90); do grep -q "Editor is now accessible" "$log" && { ready=1; break; }; sleep 2; done
  if [[ $ready == 1 ]]; then sleep 3; "$0" stop >/dev/null; fi
  kill "$warmup" 2>/dev/null || true
  if [[ $ready != 1 ]]; then
    echo "Warm-up start failed; n8n log:" >&2; tail -20 "$log" >&2; rm -f "$log"; exit 1
  fi
  rm -f "$log"
  echo "Deployed. Start n8n with: scripts/n8n.sh start"
  exit 0
fi

if [[ "${1:-}" == "stop" ]]; then
  # n8n renames its process to "n8n start", so find it by its port instead.
  pids="$(lsof -t -nP -iTCP:5678 -sTCP:LISTEN 2>/dev/null || true)"
  [[ -n "$pids" ]] || { echo "n8n is not running"; exit 0; }
  # shellcheck disable=SC2086
  kill $pids
  for _ in $(seq 1 30); do
    # shellcheck disable=SC2086
    kill -0 $pids 2>/dev/null || { echo "n8n stopped"; exit 0; }
    sleep 1
  done
  echo "n8n did not stop within 30 s (pid $pids)" >&2; exit 1
fi
RUNTIME="${N8N_RUNTIME:-$HOME/.local/share/n8n-runtime}"
N8N="$RUNTIME/node_modules/.bin/n8n"
NODE_DIR="$RUNTIME/node24/bin"
CLAUDE="$(command -v claude || true)"

[[ -x "$N8N" ]] || { echo "n8n not found at $N8N (see README: Run it locally)" >&2; exit 1; }
[[ -x "$NODE_DIR/node" ]] || { echo "Node 24 not found at $NODE_DIR (see README)" >&2; exit 1; }
[[ -n "$CLAUDE" ]] || echo "warning: claude CLI not on PATH; the AI step will use its fallback" >&2

# Read one key from .env without sourcing the whole file.
env_value() {
  [[ -f "$REPO/.env" ]] || return 0
  grep -E "^$1=" "$REPO/.env" | tail -1 | cut -d= -f2- | sed -e 's/^["'\'']//' -e 's/["'\'']$//'
}

# n8n gets an allowlisted environment only. The PSI key and Google OAuth secret
# live in n8n's encrypted credential store, never in its environment.
cd "$REPO"
exec env -i \
  HOME="$HOME" USER="$USER" LOGNAME="${LOGNAME:-$USER}" SHELL=/bin/sh TMPDIR="${TMPDIR:-/tmp}" \
  LANG="${LANG:-en_US.UTF-8}" TERM="${TERM:-xterm}" \
  PATH="$NODE_DIR:$(dirname "${CLAUDE:-/usr/bin/true}"):/usr/bin:/bin:/usr/sbin:/sbin" \
  N8N_USER_FOLDER="$REPO" \
  N8N_LISTEN_ADDRESS=127.0.0.1 \
  NODES_EXCLUDE='["n8n-nodes-base.localFileTrigger"]' \
  N8N_BLOCK_ENV_ACCESS_IN_NODE=false \
  EXECUTIONS_DATA_PRUNE=true \
  EXECUTIONS_DATA_MAX_AGE=168 \
  GENERIC_TIMEZONE="${GENERIC_TIMEZONE:-$(readlink /etc/localtime | sed 's#.*/zoneinfo/##')}" \
  N8N_DIAGNOSTICS_ENABLED=false \
  N8N_PERSONALIZATION_ENABLED=false \
  SLACK_WEBHOOK_URL="${SLACK_WEBHOOK_URL:-$(env_value SLACK_WEBHOOK_URL)}" \
  GOOGLE_SHEET_ID="$(env_value GOOGLE_SHEET_ID)" \
  SLACK_PREFIX="${SLACK_PREFIX:-}" \
  CLAUDE_BIN="${CLAUDE:-claude}" \
  CLAUDE_MODEL="$(env_value CLAUDE_MODEL)" \
  CLAUDE_TIMEOUT_MS="$(env_value CLAUDE_TIMEOUT_MS)" \
  ANALYZE_FORCE_FALLBACK="${ANALYZE_FORCE_FALLBACK:-$(env_value ANALYZE_FORCE_FALLBACK)}" \
  "$N8N" "$@"
