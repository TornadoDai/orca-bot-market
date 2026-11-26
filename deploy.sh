#!/usr/bin/env bash
set -euo pipefail

echo "1/4 Checking Cloudflare login..."
npx wrangler whoami

if grep -q "REPLACE_WITH_YOUR_D1_DATABASE_ID" wrangler.toml; then
  echo "2/4 Creating D1 database 'orca-bot-market'..."
  OUT="$(npx wrangler d1 create orca-bot-market 2>&1)"
  echo "$OUT"
  DB_ID="$(echo "$OUT" | grep -oE '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' | head -n 1)"
  if [ -z "$DB_ID" ]; then
    echo "Could not parse database_id automatically. Copy database_id into wrangler.toml and re-run."
    exit 1
  fi
  sed -i.bak "s/REPLACE_WITH_YOUR_D1_DATABASE_ID/${DB_ID}/g" wrangler.toml && rm -f wrangler.toml.bak
  echo "Updated wrangler.toml with database_id=${DB_ID}"
else
  echo "2/4 Using existing D1 database_id from wrangler.toml"
fi

echo "3/4 Applying D1 schema..."
npx wrangler d1 execute orca-bot-market --remote --file=./schema.sql

echo "4/4 Deploying Cloudflare Worker..."
npx wrangler deploy
