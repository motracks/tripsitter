// Research helper for VISA_OPTIONS (the duration/fee tiers shown on entry
// cards for statuses like "visa on arrival" — see index.html).
//
// This is deliberately NOT an autonomous scraper: government visa pages are
// prose, redesign without notice, and often gate the real fee table behind a
// nationality/purpose form. So this endpoint fetches a short, hand-picked
// list of official pages (the same URLs already linked from the app's
// VISA_PORTAL table) and asks Gemini to summarise what it finds into
// candidate tiers — for a HUMAN to read, verify against the source, and
// paste into VISA_OPTIONS by hand. It never writes to the repo itself.
//
// Usage: GET /api/research-visa-options (optionally ?cc=NP,TH to limit).
// Requires GEMINI_API_KEY, same as parse-ticket.js. Not linked from the UI —
// run it yourself every few months, the same way scripts/update-visa-data.sh
// is a manual "fetch, review the diff, commit" step, not a live feed.

const TARGETS = [
  {
    cc: 'NP', status: 'visa on arrival',
    label: 'Nepal — tourist visa on arrival',
    url: 'https://www.nepal.immigration.gov.np/pages/tourist-visa',
  },
  {
    cc: 'TH', status: 'e-visa',
    label: 'Thailand — visa exemption / e-visa for tourists',
    url: 'https://www.thaievisa.go.th/',
  },
  {
    cc: 'IN', status: 'e-visa',
    label: 'India — e-Tourist visa',
    url: 'https://indianvisaonline.gov.in/evisa/',
  },
  {
    cc: 'ID', status: 'e-visa',
    label: 'Indonesia — visa on arrival / e-VOA',
    url: 'https://evisa.imigrasi.go.id/',
  },
  {
    cc: 'SCHENGEN', status: 'eta',
    label: 'EU/Schengen — for a US citizen (expect: no tiers, fixed 90/180 rule)',
    url: 'https://travel-europe.europa.eu/etias_en',
  },
  {
    cc: 'US', status: 'eta',
    label: 'United States — ESTA for an EU citizen (expect: no tiers, fixed duration)',
    url: 'https://esta.cbp.dhs.gov/',
  },
];

const MODELS = ['gemini-2.5-flash', 'gemini-flash-latest', 'gemini-3.5-flash'];

const PROMPT = `You are helping a developer draft a small reference table of
visa duration/fee OPTIONS for a travel app. You will be given the fetched
text of one official government visa page.

Task: find any place where a TOURIST from the EU or the US is offered a
CHOICE between multiple visa/entry durations at different prices (e.g. "15
days ($30) / 30 days ($50) / 90 days ($125)"). Many countries only ever offer
ONE fixed duration for these nationalities — that is a valid, useful finding
too, not a failure.

Respond with ONLY a JSON object, no prose, no code fence:
{
  "has_tiers": true | false,
  "tiers": [ { "days": number, "fee": "string, with currency symbol/code as printed", "notes": "string or null" } ],
  "single_duration_days": number | null,   // when has_tiers is false but a fixed duration is stated
  "differs_by_nationality": true | false | "unclear",
  "citizen_scope": "string — who these figures apply to as stated on the page (e.g. 'most nationalities including EU and US' or 'EU only, US differs')",
  "quote": "string — the exact sentence(s) the numbers came from, for the human reviewer to double check",
  "confidence": "high" | "medium" | "low"
}
If the page doesn't contain fee/duration information at all (e.g. it's a
login page or unrelated), return {"has_tiers": false, "tiers": [], "single_duration_days": null, "differs_by_nationality": "unclear", "citizen_scope": null, "quote": null, "confidence": "low"}.`;

export default async function handler(req, res) {
  const key = (process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '').trim();
  if (!key) return res.status(501).json({ error: 'not configured', detail: 'GEMINI_API_KEY not set' });
  if (req.method !== 'GET') return res.status(405).json({ error: 'method not allowed' });

  const only = (req.query?.cc || '').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
  const targets = only.length ? TARGETS.filter((t) => only.includes(t.cc)) : TARGETS;
  if (!targets.length) return res.status(400).json({ error: 'bad request', detail: 'no matching cc in ?cc=' });

  const results = await Promise.all(targets.map((t) => researchOne(t, key)));
  return res.status(200).json({
    fetched_on: new Date().toISOString().slice(0, 10),
    note: 'Draft only — verify each "quote" against its source url before pasting into VISA_OPTIONS in index.html.',
    results,
  });
}

async function researchOne(target, key) {
  try {
    const pageRes = await fetch(target.url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; TripSitterResearchBot/1.0)' },
      redirect: 'follow',
    });
    if (!pageRes.ok) return { ...target, error: `fetch failed: HTTP ${pageRes.status}` };
    const html = await pageRes.text();
    const text = html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 15000); // keep the prompt small; most fee tables are near the top
    if (!text) return { ...target, error: 'page fetched but had no extractable text (likely JS-rendered)' };

    const extracted = await askGemini(text, key);
    return { ...target, ...extracted };
  } catch (err) {
    return { ...target, error: String(err?.message || err) };
  }
}

async function askGemini(pageText, key) {
  const payload = {
    contents: [{ role: 'user', parts: [{ text: PROMPT + '\n\n--- PAGE TEXT ---\n' + pageText }] }],
    generationConfig: { temperature: 0, responseMimeType: 'application/json', maxOutputTokens: 1024 },
  };
  let lastErr = null;
  for (const model of MODELS) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-goog-api-key': key },
      body: JSON.stringify(payload),
    });
    if (!r.ok) { lastErr = `${model}: HTTP ${r.status}`; continue; }
    const j = await r.json();
    const text = (j?.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('');
    try {
      return JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g, '').trim());
    } catch {
      const m = text.match(/\{[\s\S]*\}/);
      if (m) { try { return JSON.parse(m[0]); } catch {} }
      lastErr = `${model}: unparseable response`;
    }
  }
  return { error: `gemini extraction failed: ${lastErr}` };
}
