// Ticket / travel-doc field extraction via the Google Gemini API
// (generativelanguage.googleapis.com — AI Studio key).
//
// GDPR note: the uploaded image is held in memory for this single request
// only. It is never written to disk, never logged, and not retained by this
// function. The prompt asks Gemini to extract travel logistics only — never
// passenger name, passport number, DOB, or frequent-flyer number, even when
// those are visible on the ticket. (Google's consumer AI Studio tier may use
// submitted data to improve their products; a paid API tier does not.)

const COMMON = `
The image(s) may be a photo, a screenshot, or a forwarded email with the
details buried in prose. Read everything, including body text. Be decisive:
if a value is stated or clearly implied, extract it — do not leave a field
blank just because it isn't in a labelled box. If several images are given,
combine them. If there are multiple prices, pick the one that represents the
main cost of THIS booking (ignore optional add-ons and "not included" notes).
Dates with a written month ("September 7th 2026") → ISO. Return {} only if
the image genuinely contains none of the requested information.

Read every digit of every time individually before answering — do not guess
from the shape of the text. Times are frequently printed in 24-hour format
(e.g. "14:32", "09:05") — copy the hour exactly as printed and never invent
an AM/PM split for it. If a time has no minutes shown (e.g. just "14"),
treat it as ":00". If the same time appears more than once in the image
(e.g. once large and once small, or repeated in a summary line), cross-check
that all copies agree; if they conflict, prefer the one printed next to an
explicit "departs"/"arrives"/"from"/"to" label over a bare or ambiguous one.
Do not confuse a boarding time, gate-closing time, check-in time, or duration
("2h 15m") with the actual departure or arrival time. When a date is shown
without a time, or a time without a date, still return whichever part is
present rather than guessing the other.`;

const SCHEMAS = {
  transport: `${COMMON}
Return a JSON object with any of these keys you can determine:
  type: one of "flight" | "bus" | "train" | "ferry" | "car"
  origin: departure city / airport / station, human readable
  destination: arrival city / airport / station
  departure: ISO 8601 datetime — the actual departure time, not boarding/check-in
        (local time as printed, 24-hour hour value taken verbatim; date-only is fine)
  arrival: ISO 8601 datetime — the actual arrival time, same rules as departure
  carrier: airline / train operator / bus company name only (not the service number)
  train_number: for trains only — the train/service number as printed (e.g. "ICE 529",
        "TGV 6109"). Omit for non-train transport.
  track_info: for trains only — the departure track, platform, or gate as printed
        (e.g. "Track 12", "Platform 4B"). Omit for non-train transport.
  booking_code: PNR / booking reference / ticket number
  price: number only (no currency symbol)
  currency: ISO 4217 code (e.g. EUR, USD, INR)
  notes: anything useful that doesn't fit above (pickup contact, luggage, etc.) —
        for flights and buses, include the flight/service number here if not
        already folded into carrier`,
  stay: `${COMMON}
Return a JSON object with any of these keys you can determine:
  type: the purpose of the stay — exactly one of:
        "hotel", "hostel", "airbnb" (short-term rental), "guesthouse" (B&B / homestay),
        "family" (staying with friends or relatives),
        "retreat" (yoga / meditation / wellness retreat),
        "course" (a training, teacher training, workshop, or study programme — e.g. a
                  yoga teacher training, a language course, a diving certification),
        "work" (volunteering, work exchange, WWOOF, an internship),
        "sport" (a training camp — surf, climbing, football, etc.),
        "housesit" (looking after a home and/or pets while the owner is away),
        "other".
        Infer it from the sender and the wording: a "School of Yoga" sending a "Teacher
        Training Course" welcome letter → "course".
  city: town / city of the stay
  start_date: ISO date (check-in / arrival / course start)
  end_date: ISO date (check-out / departure / course end)
  host_name: property, school, host or organiser name
  address: full postal address if given
  price: number only — the main cost of the stay / course (no symbol)
  currency: ISO 4217 code
  notes: meal times, what's included/excluded, contacts, room category, etc.`,
  doc: `${COMMON}
Return a JSON object with any of these keys you can determine:
  doc_type: one of "ESTA" | "Visa" | "Global Entry" | "Passport" | "Vaccination" | "Insurance" | "other"
  country: country the document is for
  status: e.g. "Approved", "Active", "Pending"
  expires_on: ISO date
  reference_number: application / reference / policy number
  max_stay_days: for a Visa only — the maximum CONTINUOUS stay permitted per
        entry, in days, as a plain number (e.g. a line reading "continuous
        stay ... should not exceed 90 days" → 90). This is the per-entry limit,
        not a total/annual cap across multiple entries (e.g. ignore a separate
        "maximum stay during one calendar year restricted to 180 days" line —
        that is not what this field means). Omit if the document doesn't state
        a per-entry day limit.
  annual_cap_days: for a Visa only — a separate total/cumulative stay limit
        per calendar year stated on the document, as a plain number (e.g.
        "maximum stay ... during one calendar year restricted to 180 days" →
        180). This is distinct from max_stay_days (per-entry) — only fill
        this when the document states a calendar-year or 12-month cumulative
        cap. Omit if none is stated.
  notes: anything else useful that the two fields above didn't capture`,
};

// Tried in order; first that responds wins. Flash-tier vision models
// confirmed available on the project's key (see GET ?models).
const MODELS = ['gemini-2.5-flash', 'gemini-flash-latest', 'gemini-3.5-flash'];

async function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') { try { return JSON.parse(req.body); } catch { return {}; } }
  // stream fallback
  const chunks = [];
  for await (const c of req) chunks.push(c);
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return {}; }
}

export default async function handler(req, res) {
  const key = (process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '').trim();

  // GET → debug. ?models lists what the key can actually use.
  if (req.method === 'GET') {
    if ('models' in (req.query || {}) && key) {
      try {
        const r = await fetch('https://generativelanguage.googleapis.com/v1beta/models?pageSize=100', { headers: { 'X-goog-api-key': key } });
        const j = await r.json();
        const names = (j.models || [])
          .filter(m => (m.supportedGenerationMethods || []).includes('generateContent'))
          .map(m => m.name.replace('models/', ''));
        return res.status(r.status).json({ generateContent_models: names });
      } catch (e) { return res.status(500).json({ error: String(e) }); }
    }
    const seen = Object.keys(process.env).filter(k => /GEMINI|GOOGLE|GENAI|AI_?STUDIO/i.test(k));
    return res.status(200).json({
      ok: true,
      has_GEMINI_API_KEY: !!process.env.GEMINI_API_KEY,
      has_GOOGLE_API_KEY: !!process.env.GOOGLE_API_KEY,
      matching_env_var_names: seen,
      tried_models: MODELS,
    });
  }
  if (req.method !== 'POST') return res.status(405).json({ error: 'method not allowed' });
  if (!key) return res.status(501).json({ error: 'parsing not configured', detail: 'GEMINI_API_KEY not set' });

  try {
    const body = await readBody(req);
    const kind = body.kind;
    // accept a single {image,mime} or an array {images:[{data,mime}]}
    let images = [];
    if (Array.isArray(body.images)) images = body.images.map(i => ({ data: i.data || i.image, mime: i.mime }));
    else if (body.image) images = [{ data: body.image, mime: body.mime }];
    images = images.filter(i => i.data).slice(0, 4);
    if (!images.length) return res.status(400).json({ error: 'bad request', detail: 'no image' });
    if (!SCHEMAS[kind]) return res.status(400).json({ error: 'bad request', detail: 'unknown kind: ' + kind });

    const sys =
      'You extract travel logistics from photos, screenshots, or forwarded emails. ' +
      'Respond with ONLY a single JSON object — no prose, no code fence. ' +
      'Do NOT extract passenger names, passport numbers, dates of birth, or frequent-flyer ' +
      'numbers even if visible.';

    const payload = {
      contents: [{
        role: 'user',
        parts: [
          ...images.map(i => ({ inlineData: { mimeType: i.mime || 'image/jpeg', data: i.data } })),
          { text: sys + '\n\n' + SCHEMAS[kind] },
        ],
      }],
      generationConfig: { temperature: 0, responseMimeType: 'application/json', maxOutputTokens: 2048 },
    };

    let lastErr = null;
    for (const model of MODELS) {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
      const gres = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-goog-api-key': key },
        body: JSON.stringify(payload),
      });
      if (!gres.ok) {
        lastErr = { status: gres.status, body: (await gres.text()).slice(0, 300) };
        console.error('parse-ticket: gemini', model, gres.status, lastErr.body);
        continue;
      }
      const j = await gres.json();
      const text = (j?.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('');
      let parsed = {};
      try {
        parsed = JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g, '').trim());
      } catch {
        const m = text.match(/\{[\s\S]*\}/);
        if (m) { try { parsed = JSON.parse(m[0]); } catch {} }
      }
      if (parsed && typeof parsed === 'object') { delete parsed.name; delete parsed.passenger; }
      // wrap so the client can distinguish "read nothing" from an error
      return res.status(200).json({ fields: parsed || {}, model, raw: text.slice(0, 600) });
    }
    return res.status(502).json({ error: 'gemini error', detail: lastErr });
  } catch (err) {
    console.error('parse-ticket:', err?.message || err);
    return res.status(500).json({ error: 'parse failed', detail: String(err?.message || err) });
  }
}
