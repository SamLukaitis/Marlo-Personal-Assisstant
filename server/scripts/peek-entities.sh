#!/bin/bash
# Quick look at what the entities/links layer has stored, for testing during development.
# Usage: from the server/ directory, run: ./scripts/peek-entities.sh
cd "$(dirname "$0")/.."

echo "=== entities ==="
sqlite3 -header -column data/app.db "SELECT id, type, status, confidence, data FROM entities ORDER BY id DESC LIMIT 20;"
echo ""
echo "=== links ==="
sqlite3 -header -column data/app.db "SELECT id, relation, from_type, from_id, to_type, to_id FROM links ORDER BY id DESC LIMIT 20;"
