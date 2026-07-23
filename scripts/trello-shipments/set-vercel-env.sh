#!/usr/bin/env bash
# Push Trello creds from the local creds file into Vercel (production) + redeploy.
# Values are read from ~/.config/ictc-trello/credentials.env and piped straight to
# Vercel — never printed, never in shell history. Run from the repo root:
#     bash scripts/trello-shipments/set-vercel-env.sh
set -euo pipefail

CRED="$HOME/.config/ictc-trello/credentials.env"
[ -f "$CRED" ] || { echo "✗ missing $CRED — paste your keys there first"; exit 1; }
# shellcheck disable=SC1090
source "$CRED"
: "${TRELLO_API_KEY:?TRELLO_API_KEY not set in creds file}"
: "${TRELLO_TOKEN:?TRELLO_TOKEN not set in creds file}"
BOARD="${TRELLO_BOARD_ID:-68157fe83b212306ba0ee381}"

set_var() { # name value
  # --force overwrites if it already exists; drop it on older CLI (then `vercel env rm <name> production` first).
  printf %s "$2" | vercel env add "$1" production --force
}

echo "→ setting TRELLO_API_KEY, TRELLO_TOKEN, TRELLO_BOARD_ID on Vercel (production)…"
set_var TRELLO_API_KEY  "$TRELLO_API_KEY"
set_var TRELLO_TOKEN    "$TRELLO_TOKEN"
set_var TRELLO_BOARD_ID "$BOARD"

echo "✓ env vars set. Redeploying production so the build picks them up…"
vercel --prod

echo "✓ done — log in → /shipments should now pull from Trello."
