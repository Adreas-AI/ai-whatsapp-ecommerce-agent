#!/usr/bin/env bash
# Renders docs/architecture.mmd to SVG and PNG with a pinned mermaid-cli image.
# Requires Docker. Alternative without Docker: npx -y @mermaid-js/mermaid-cli@11.4.2 (same flags).
set -euo pipefail
cd "$(dirname "$0")/../docs"
IMG=minlag/mermaid-cli:11.4.2
DOCS_DIR="$(pwd -W 2>/dev/null || pwd)"
export MSYS_NO_PATHCONV=1
docker run --rm -v "$DOCS_DIR:/data" "$IMG" -i /data/architecture.mmd -o /data/architecture.svg -c /data/mermaid-config.json -b white
docker run --rm -v "$DOCS_DIR:/data" "$IMG" -i /data/architecture.mmd -o /data/architecture.png -c /data/mermaid-config.json -b white -w 1400 -s 2
echo "rendered docs/architecture.svg and docs/architecture.png"
