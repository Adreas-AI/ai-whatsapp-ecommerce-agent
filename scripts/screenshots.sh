#!/usr/bin/env bash
# Regenerates docs/screenshots/*.png from the running compose stack (DEMO_MODE).
# Prerequisite: docker compose up (gateway reachable as http://gateway:3000 on the compose network).
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$(pwd -W 2>/dev/null || pwd)"
NETWORK="${COMPOSE_NETWORK:-synvoca-whatsapp-agent_default}"
export MSYS_NO_PATHCONV=1
docker run --rm --network "$NETWORK" \
  -v "$ROOT/scripts:/scripts:ro" -v "$ROOT/docs/screenshots:/out" \
  mcr.microsoft.com/playwright:v1.50.0-noble \
  sh -c "cd /tmp && npm init -y >/dev/null && npm i --no-audit --no-fund playwright@1.50.0 >/dev/null && cp /scripts/screenshots.mjs . && node screenshots.mjs"
