#!/usr/bin/env bash
# Refresh the bundled passport-index visa dataset.
# Run every few months:  bash scripts/update-visa-data.sh
set -euo pipefail

REPO="imorte/passport-index-data"
RAW="https://raw.githubusercontent.com/${REPO}/main/passport-index.json"
API="https://api.github.com/repos/${REPO}/commits?path=passport-index.json&per_page=1"

cd "$(dirname "$0")/.."

echo "Fetching $RAW …"
curl -sL "$RAW" -o data/passport-index.json

# sanity check: valid JSON with ~199 passports
COUNT=$(node -e "console.log(Object.keys(require('./data/passport-index.json')).length)")
if [ "$COUNT" -lt 150 ]; then
  echo "Refusing to save — only $COUNT passports, download looks broken." >&2
  git checkout -- data/passport-index.json 2>/dev/null || true
  exit 1
fi

META=$(curl -sL "$API")
SHA=$(echo "$META" | grep -m1 '"sha"'  | sed 's/.*"sha": "//;s/".*//')
DATE=$(echo "$META" | grep -m1 '"date"' | sed 's/.*"date": "//;s/".*//')

cat > data/passport-index.meta.json <<EOF
{
  "source": "https://github.com/${REPO}",
  "file": "passport-index.json",
  "upstream_commit": "${SHA}",
  "upstream_commit_date": "${DATE}",
  "fetched_on": "$(date -u +%Y-%m-%d)"
}
EOF

echo "Done. $COUNT passports, upstream commit ${DATE}."
echo "Review the diff, then: git add data/ && git commit -m 'Refresh visa data'"
