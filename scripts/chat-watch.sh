#!/usr/bin/env bash
# chat-watch.sh — event trigger for a Claude session from the agent_chat board.
#
# Blocks (cheap shell polling, NO Claude turns) until a NEW message from `ivan`
# appears, then prints it and exits. Run it as a BACKGROUND task so the harness
# re-invokes the session the moment Ivan posts — near-instant, with zero wasted
# Claude turns while idle. Re-launch it after handling a message to keep watching.
# Dies when the session ends (that's expected — no live session, nothing to wake).
#
# Usage:  scripts/chat-watch.sh            # wake on any ivan message posted after launch
#         scripts/chat-watch.sh <ISO_TS>   # wake on ivan messages after a given timestamp
set -uo pipefail
PAT="$(cat "$HOME/.supabase_pat")"
REF="ujvfwzcjgxupvtiwllhw"
POLL="${POLL:-20}"   # seconds between cheap shell checks

q() { curl -s -X POST "https://api.supabase.com/v1/projects/$REF/database/query" \
  -H "Authorization: Bearer $PAT" -H "Content-Type: application/json" \
  --data "{\"query\": $(python3 -c 'import json,sys;print(json.dumps(sys.argv[1]))' "$1")}"; }

# Watermark: latest message time at launch, so we only fire on messages posted AFTER now.
SINCE="${1:-}"
if [ -z "$SINCE" ]; then
  SINCE="$(q "select coalesce(max(created_at)::text,'epoch') as w from agent_chat;" \
           | python3 -c 'import json,sys;print(json.load(sys.stdin)[0]["w"])')"
fi
echo "chat-watch: waiting for new ivan messages since $SINCE (poll ${POLL}s)…" >&2

while true; do
  ROWS="$(q "select to_char(created_at,'HH24:MI') t, body from agent_chat where author='ivan' and created_at > '$SINCE' order by created_at;")"
  N="$(printf '%s' "$ROWS" | python3 -c 'import json,sys;print(len(json.load(sys.stdin)))' 2>/dev/null || echo 0)"
  if [ "${N:-0}" -gt 0 ]; then
    echo "🔔 NEW message(s) from ivan on the session chat:"
    printf '%s' "$ROWS" | python3 -c 'import json,sys
for r in json.load(sys.stdin): print("  [%s] %s" % (r["t"], r["body"]))'
    echo "→ Address these, reply in agent_chat, then re-launch scripts/chat-watch.sh to keep watching."
    exit 0
  fi
  sleep "$POLL"
done
