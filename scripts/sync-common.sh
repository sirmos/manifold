#!/usr/bin/env bash
# common/ is the source of truth for shared code (env, Firestore, Pub/Sub,
# Gemini helpers). Each agent needs its own copy inside its own folder,
# because Cloud Run only sees one agent's folder at deploy time, not the
# whole repo. Run this after every edit to a file in common/, and before
# running an agent locally or deploying it.
set -euo pipefail
cd "$(dirname "$0")/.."

for agent in collector monitor investigator reporter; do
  mkdir -p "agents/$agent/lib"
  cp common/*.js "agents/$agent/lib/"
  echo "Synced common/ into agents/$agent/lib/"
done
