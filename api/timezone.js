// Timezone lookup proxy — GeoNames timezoneJSON.
// Resolves the IANA timezone id for a coordinate so departure/arrival times
// can always be shown in the LOCATION's own local time (origin for
// departure, destination for arrival), not the viewer's device timezone.
//   GET /api/timezone?lat=<>&lng=<>  →  { tz: "Europe/Berlin" }  (or { tz: null })
// Reuses the same GEONAMES_USERNAME env var as /api/geo-search.

export default async function handler(req, res) {
  const user = process.env.GEONAMES_USERNAME;
  const lat = Number(req.query?.lat);
  const lng = Number(req.query?.lng);
  if (!user) return res.status(200).json({ tz: null, fallback: true });
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return res.status(200).json({ tz: null });

  try {
    const url = new URL('http://api.geonames.org/timezoneJSON');
    url.searchParams.set('lat', String(lat));
    url.searchParams.set('lng', String(lng));
    url.searchParams.set('username', user);

    const gr = await fetch(url);
    if (!gr.ok) return res.status(200).json({ tz: null });
    const j = await gr.json();
    if (!j.timezoneId) return res.status(200).json({ tz: null });

    // A location's IANA timezone id is effectively permanent — cache hard.
    res.setHeader('Cache-Control', 'public, max-age=86400, s-maxage=2592000');
    return res.status(200).json({ tz: j.timezoneId });
  } catch (err) {
    console.error('timezone:', err?.message || 'error');
    return res.status(200).json({ tz: null });
  }
}
