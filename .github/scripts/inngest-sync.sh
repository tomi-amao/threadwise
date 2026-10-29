#!/usr/bin/env bash
# Re-sync the AI agent's functions with Inngest Cloud once Render is serving a commit.
#
# Inngest only re-reads an app's function list when the app is synced, and it syncs on deploy by
# itself only for Vercel and Netlify. Syncing before the new code is live would register the old
# functions, so this waits until the agent's /health reports a commit whose apps/ai_agent is the
# same as TARGET_SHA's. (Render rebuilds only for backend changes, so after a frontend-only push
# the deployed commit is an older one with the same backend: that counts as live.)
#
# Usage: inngest-sync.sh <target-sha>
# Env:   AI_AGENT_URL     the agent's public URL, e.g. https://threadwise-ai-agent.onrender.com
#        INNGEST_API_KEY  an Inngest API key (Inngest dashboard -> Settings -> API keys)
#        INNGEST_APP_ID   the app id (default threadwise-ai-agent, as in core/config.py)
#        INNGEST_ENV      the Inngest environment to sync into (default production); the API
#                         requires it, as the X-Inngest-Env header
#        WAIT_MINUTES     how long to wait for the deploy (default 30)
#        INNGEST_API_BASE_URL  default https://api.inngest.com (the SDK's own variable name)
# Needs the full git history (the deployed commit has to be resolvable).

set -euo pipefail

TARGET_SHA="${1:?usage: inngest-sync.sh <target-sha>}"
: "${AI_AGENT_URL:?AI_AGENT_URL is not set}"
: "${INNGEST_API_KEY:?INNGEST_API_KEY is not set}"
APP_ID="${INNGEST_APP_ID:-threadwise-ai-agent}"
INNGEST_ENV="${INNGEST_ENV:-production}"
WAIT_MINUTES="${WAIT_MINUTES:-30}"
AI_AGENT_URL="${AI_AGENT_URL%/}"
API_BASE="${INNGEST_API_BASE_URL:-https://api.inngest.com}"

deadline=$(($(date +%s) + WAIT_MINUTES * 60))
while :; do
  deployed="$(curl -fsS --max-time 20 "$AI_AGENT_URL/health" | jq -r '.commit // empty' || true)"
  # Only a commit id reaches git (anything else, e.g. a leading "--", would be read as an option).
  [[ "$deployed" =~ ^[0-9a-f]{7,40}$ ]] || deployed=""
  if [[ -n "$deployed" ]] && git cat-file -e "$deployed^{commit}" 2> /dev/null &&
    git diff --quiet "$deployed" "$TARGET_SHA" -- apps/ai_agent; then
    echo "Render is serving $deployed, which has the same backend as $TARGET_SHA."
    break
  fi
  if (($(date +%s) > deadline)); then
    echo "::error::Render did not serve $TARGET_SHA's backend within $WAIT_MINUTES minutes (last seen: ${deployed:-nothing})."
    exit 1
  fi
  echo "Waiting for the deploy (serving: ${deployed:-unreachable})..."
  sleep 20
done

# https://www.inngest.com/docs/apps/cloud: POST /v2/apps/{app id}/syncs with the serve URL.
status="$(curl -sS -o /tmp/inngest-sync.json -w '%{http_code}' -X POST \
  "$API_BASE/v2/apps/$APP_ID/syncs" \
  -H "Authorization: Bearer $INNGEST_API_KEY" \
  -H "X-Inngest-Env: $INNGEST_ENV" \
  -H 'Content-Type: application/json' \
  -d "{\"url\": \"$AI_AGENT_URL/api/inngest\"}")"
cat /tmp/inngest-sync.json
echo
if [[ "$status" != 2* ]]; then
  echo "::error::Inngest sync failed with HTTP $status."
  exit 1
fi
echo "Synced $APP_ID with Inngest Cloud ($INNGEST_ENV)."
