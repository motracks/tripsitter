// Geocoding proxy — Nominatim (OpenStreetMap, no key).
// The browser can't hit nominatim.openstreetmap.org directly (usage policy
// wants a real User-Agent / Referer and no CORS); this runs server-side and
// caches hard. Swap the upstream here to change providers (Geoapify /
// MapTiler / LocationIQ) without touching the client.
//   GET /api/geocode?q=<free text>&country=<ISO2 optional>
// → { lat, lng, display_name, source: "nominatim" }   (or { lat: null } on miss)

const CONTACT = 'mo.tracks.flights@gmail.com'; // Nominatim usage policy: identifiable contact

export default async function handler(req, res) {
  const q = String(req.query?.q || '').trim();
  const country = String(req.query?.country || '').trim().toLowerCase();
  if (q.length < 2) return res.status(200).json({ lat: null });

  try {
    const url = new URL('https://nominatim.openstreetmap.org/search');
    url.searchParams.set('q', q);
    url.searchParams.set('format', 'json');
    url.searchParams.set('limit', '1');
    url.searchParams.set('email', CONTACT);
    if (/^[a-z]{2}$/.test(country)) url.searchParams.set('countrycodes', country);

    const r = await fetch(url, {
      headers: {
        'User-Agent': `TripSitter/1.0 (${CONTACT})`,
        'Accept-Language': 'en',
      },
    });
    if (!r.ok) return res.status(200).json({ lat: null });
    const j = await r.json();
    const hit = Array.isArray(j) ? j[0] : null;
    if (!hit || hit.lat == null || hit.lon == null) return res.status(200).json({ lat: null });

    // Geocoding results for a fixed query are effectively static — cache long.
    res.setHeader('Cache-Control', 'public, max-age=86400, s-maxage=2592000');
    return res.status(200).json({
      lat: Number(hit.lat),
      lng: Number(hit.lon),
      display_name: hit.display_name || null,
      source: 'nominatim',
    });
  } catch (err) {
    console.error('geocode:', err?.message || 'error');
    return res.status(200).json({ lat: null });
  }
}
