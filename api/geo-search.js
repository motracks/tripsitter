// Place autocomplete proxy — GeoNames search.
// Keeps GEONAMES_USERNAME server-side and normalises the response so the
// frontend never sees the provider. Swappable for Nominatim / Mapbox by
// rewriting only this file.

export default async function handler(req, res) {
  const user = process.env.GEONAMES_USERNAME;
  const q = (req.query?.q || '').toString().trim();
  if (!user) return res.status(200).json({ results: [], fallback: true });
  if (q.length < 2) return res.status(200).json({ results: [] });

  try {
    const url = new URL('http://api.geonames.org/searchJSON');
    url.searchParams.set('q', q);
    url.searchParams.set('maxRows', '6');
    url.searchParams.set('featureClass', 'P'); // populated places
    url.searchParams.append('featureClass', 'A'); // admin regions / countries
    url.searchParams.set('orderby', 'relevance');
    url.searchParams.set('username', user);

    const gr = await fetch(url);
    if (!gr.ok) return res.status(200).json({ results: [], fallback: true });
    const j = await gr.json();

    const kindFor = (fcl, fcode) => {
      if (fcl === 'P') return 'city';
      if (fcode === 'PCLI' || fcode === 'PCL') return 'country';
      if (fcl === 'A') return 'region';
      return 'place';
    };

    const results = (j.geonames || []).map((g) => ({
      label: g.name,
      kind: kindFor(g.fcl, g.fcode),
      country: g.countryCode || null,          // ISO-2
      admin: g.adminName1 || null,
      geonameId: g.geonameId,
      lat: g.lat != null ? Number(g.lat) : null,
      lng: g.lng != null ? Number(g.lng) : null,
      context: [g.adminName1, g.countryName].filter(Boolean).join(', '),
    }));

    return res.status(200).json({ results });
  } catch (err) {
    console.error('geo-search:', err?.message || 'error');
    return res.status(200).json({ results: [], fallback: true });
  }
}
