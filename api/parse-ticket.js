// Ticket / travel-doc field extraction via the Google Gemini API
// (generativelanguage.googleapis.com — AI Studio key).
//
// GDPR note: the uploaded image is held in memory for this single request
// only. It is never written to disk, never logged, and not retained by this
// function. The prompt asks Gemini to extract travel logistics only — never
// passenger name, passport number, DOB, or frequent-flyer number, even when
// those are visible on the ticket. (Google's consumer AI Studio tier may use
// submitted data to improve their products; a paid API tier does not.)

const SCHEMAS = {
  transport: `Extract these keys where readable (omit any you cannot read):
  type ("flight" | "bus" | "train" | "ferry" | "car"),
  origin (city or station, human readable),
  destination,
  departure (ISO 8601 datetime, local time as printed),
  arrival (ISO 8601 datetime),
  carrier (airline / operator, plus flight or service number),
  booking_code (PNR / booking reference / ticket number),
  price (number only), currency (ISO 4217 code).`,
  stay: `Extract these keys where readable (omit any you cannot read):
  type ("hotel" | "hostel" | "airbnb" | "retreat" | "course" | "other"),
  city,
  start_date (ISO date, check-in),
  end_date (ISO date, check-out),
  host_name (property or host name),
  address,
  price (number only), currency (ISO 4217 code).`,
  doc: `Extract these keys where readable (omit any you cannot read):
  doc_type ("ESTA" | "Visa" | "Global Entry" | "Passport" | "Vaccination" | "Insurance" | "other"),
  country,
  status,
  expires_on (ISO date),
  reference_number.`,
};

// Tried in order; first that responds wins. Current flash-tier vision models.
const MODELS = ['gemini-flash-latest', 'gemini-2.5-flash', 'gemini-2.0-flash'];

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
    const { image, mime, kind } = await readBody(req);
    if (!image) return res.status(400).json({ error: 'bad request', detail: 'no image' });
    if (!SCHEMAS[kind]) return res.status(400).json({ error: 'bad request', detail: 'unknown kind: ' + kind });

    const sys =
      'You extract travel logistics from a photo of a ticket, booking confirmation, ' +
      'or travel document. Respond with ONLY a single JSON object — no prose, no code fence. ' +
      'Do NOT extract passenger names, passport numbers, dates of birth, or frequent-flyer ' +
      'numbers even if visible. If a field is unreadable, omit its key.';

    const payload = {
      systemInstruction: { parts: [{ text: sys }] },
      contents: [{
        role: 'user',
        parts: [
          { inline_data: { mime_type: mime || 'image/jpeg', data: image } },
          { text: SCHEMAS[kind] },
        ],
      }],
      generationConfig: { temperature: 0, responseMimeType: 'application/json', maxOutputTokens: 1024 },
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
      return res.status(200).json(parsed || {});
    }
    return res.status(502).json({ error: 'gemini error', detail: lastErr });
  } catch (err) {
    console.error('parse-ticket:', err?.message || err);
    return res.status(500).json({ error: 'parse failed', detail: String(err?.message || err) });
  }
}
