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
  type ("hotel" | "hostel" | "airbnb" | "other"),
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

const MODEL = 'gemini-2.0-flash';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method not allowed' });
  const key = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  if (!key) return res.status(501).json({ error: 'parsing not configured' });

  try {
    const { image, mime, kind } = req.body || {};
    if (!image || !SCHEMAS[kind]) return res.status(400).json({ error: 'bad request' });

    const sys =
      'You extract travel logistics from a photo of a ticket, booking confirmation, ' +
      'or travel document. Respond with ONLY a single JSON object — no prose, no code fence. ' +
      'Do NOT extract passenger names, passport numbers, dates of birth, or frequent-flyer ' +
      'numbers even if visible. If a field is unreadable, omit its key.';

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${encodeURIComponent(key)}`;
    const gres = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: sys }] },
        contents: [{
          role: 'user',
          parts: [
            { inline_data: { mime_type: mime || 'image/jpeg', data: image } },
            { text: SCHEMAS[kind] },
          ],
        }],
        generationConfig: { temperature: 0, responseMimeType: 'application/json', maxOutputTokens: 1024 },
      }),
    });

    if (!gres.ok) {
      console.error('parse-ticket: gemini', gres.status);
      return res.status(502).json({ error: 'parse failed' });
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
  } catch (err) {
    console.error('parse-ticket:', err?.message || 'error');
    return res.status(500).json({ error: 'parse failed' });
  }
}
