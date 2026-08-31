#!/usr/bin/env bash
# Refresh the bundled airport lookup table (IATA -> coords).
# Source: OurAirports (public domain). Run occasionally:
#   bash scripts/update-airports.sh
set -euo pipefail

RAW="https://davidmegginson.github.io/ourairports-data/airports.csv"

cd "$(dirname "$0")/.."

echo "Fetching $RAW …"
TMP="$(mktemp)"
curl -sL "$RAW" -o "$TMP"

node - "$TMP" <<'NODE'
const fs = require('fs');
const csv = fs.readFileSync(process.argv[2], 'utf8');

// minimal CSV parser (handles quoted fields with commas)
function parseLine(line) {
  const out = []; let cur = ''; let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') q = false;
      else cur += c;
    } else {
      if (c === '"') q = true;
      else if (c === ',') { out.push(cur); cur = ''; }
      else cur += c;
    }
  }
  out.push(cur);
  return out;
}

const lines = csv.split(/\r?\n/).filter(Boolean);
const header = parseLine(lines[0]);
const idx = (k) => header.indexOf(k);
const iIata = idx('iata_code'), iType = idx('type'), iName = idx('name'),
      iLat = idx('latitude_deg'), iLon = idx('longitude_deg'),
      iMuni = idx('municipality'), iCountry = idx('iso_country'),
      iSched = idx('scheduled_service');

const out = {};
for (let i = 1; i < lines.length; i++) {
  const r = parseLine(lines[i]);
  const iata = (r[iIata] || '').trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(iata)) continue;
  const type = r[iType] || '';
  if (type === 'closed' || type === 'heliport') continue;
  // keep airports with scheduled service, plus large/medium airports regardless
  if (r[iSched] !== 'yes' && type !== 'large_airport' && type !== 'medium_airport') continue;
  const lat = Number(r[iLat]), lng = Number(r[iLon]);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
  out[iata] = {
    name: r[iName] || null,
    city: r[iMuni] || null,
    country: (r[iCountry] || '').toUpperCase() || null,
    lat: Math.round(lat * 1e5) / 1e5,
    lng: Math.round(lng * 1e5) / 1e5,
  };
}

const count = Object.keys(out).length;
if (count < 3000) {
  console.error(`Refusing to save — only ${count} airports, download looks broken.`);
  process.exit(1);
}
fs.writeFileSync('data/airports.json', JSON.stringify(out) + '\n');
console.log(`Done. ${count} airports written to data/airports.json`);
NODE

rm -f "$TMP"
echo "Review the diff, then: git add data/airports.json && git commit -m 'Refresh airports'"
