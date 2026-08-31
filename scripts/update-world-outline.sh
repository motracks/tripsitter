#!/usr/bin/env bash
# Refresh the bundled country-outline GeoJSON used by the maps (globe + mini-map).
# Source: Natural Earth 1:110m admin-0 countries (public domain). Rarely changes.
#   bash scripts/update-world-outline.sh
set -euo pipefail

RAW="https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_110m_admin_0_countries.geojson"

cd "$(dirname "$0")/.."

echo "Fetching $RAW …"
TMP="$(mktemp)"
curl -sL "$RAW" -o "$TMP"

node - "$TMP" <<'NODE'
const fs = require('fs');
const g = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const r = (n) => Math.round(n * 100) / 100;
function roundCoords(c) {
  if (typeof c[0] === 'number') return [r(c[0]), r(c[1])];
  return c.map(roundCoords);
}
const out = {
  type: 'FeatureCollection',
  features: g.features.map(f => {
    const p = f.properties;
    let iso = p.ISO_A2_EH && p.ISO_A2_EH !== '-99' ? p.ISO_A2_EH
            : (p.ISO_A2 && p.ISO_A2 !== '-99' ? p.ISO_A2 : null);
    return {
      type: 'Feature',
      properties: { iso2: iso ? iso.toUpperCase() : null, name: p.NAME || p.ADMIN || null },
      geometry: { type: f.geometry.type, coordinates: roundCoords(f.geometry.coordinates) },
    };
  }),
};
if (out.features.length < 150) {
  console.error(`Refusing to save — only ${out.features.length} features.`);
  process.exit(1);
}
fs.writeFileSync('data/world-110m.json', JSON.stringify(out) + '\n');
console.log(`Done. ${out.features.length} countries written to data/world-110m.json`);
NODE

rm -f "$TMP"
echo "Review the diff, then: git add data/world-110m.json && git commit -m 'Refresh world outline'"
