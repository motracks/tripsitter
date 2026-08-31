// FX rate proxy — frankfurter.app (ECB data, no key).
// The browser often can't reach frankfurter.app directly (CORS / network);
// this runs server-side. Swap the upstream here to change providers.
//   GET /api/fx?from=USD&to=EUR&date=2026-04-24
// → { rate: 0.855, date: "2026-04-24", from, to }  (or { rate: null } on miss)

export default async function handler(req, res) {
  const from = String(req.query?.from || 'EUR').toUpperCase();
  const to = String(req.query?.to || 'EUR').toUpperCase();
  const date = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query?.date || '')) ? req.query.date : null;

  if (from === to) return res.status(200).json({ rate: 1, from, to, date });

  const paths = [
    date ? `https://api.frankfurter.dev/v1/${date}?base=${from}&symbols=${to}` : null,
    `https://api.frankfurter.dev/v1/latest?base=${from}&symbols=${to}`,
  ].filter(Boolean);

  for (const url of paths) {
    try {
      const r = await fetch(url);
      if (!r.ok) continue;
      const j = await r.json();
      const rate = j?.rates?.[to];
      if (rate != null) {
        // cache aggressively — historical rates never change
        res.setHeader('Cache-Control', 'public, max-age=86400, s-maxage=604800');
        return res.status(200).json({ rate, from, to, date: j.date || date });
      }
    } catch { /* try next */ }
  }
  return res.status(200).json({ rate: null, from, to, date });
}
