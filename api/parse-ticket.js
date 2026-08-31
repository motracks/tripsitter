import Anthropic from '@anthropic-ai/sdk';

// GDPR note: the uploaded image is held in memory for this single request
// only. It is never written to disk, never logged, and not retained by this
// function. Anthropic's API does not train on it. We ask the model to extract
// only travel logistics — never passenger name, passport number, DOB, or
// frequent-flyer number, even when those are visible on the ticket.

const SCHEMAS = {
  transport: `Return JSON with any of these keys you can read (omit unknowns):
  type ("flight" | "bus" | "train" | "ferry" | "car"),
  origin (city or station, human readable),
  destination,
  departure (ISO 8601 datetime, local time as printed),
  arrival (ISO 8601 datetime),
  carrier (airline / operator, plus flight or service number),
  booking_code (PNR / booking reference / ticket number),
  price (number only), currency (ISO 4217 code).`,
  stay: `Return JSON with any of these keys you can read (omit unknowns):
  type ("hotel" | "hostel" | "airbnb" | "other"),
  city,
  start_date (ISO date, check-in),
  end_date (ISO date, check-out),
  host_name (property or host name),
  address,
  price (number only), currency (ISO 4217 code).`,
  doc: `Return JSON with any of these keys you can read (omit unknowns):
  doc_type ("ESTA" | "Visa" | "Global Entry" | "Passport" | "Vaccination" | "Insurance" | "other"),
  country,
  status,
  expires_on (ISO date),
  reference_number.`,
};

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method not allowed' });
  if (!process.env.ANTHROPIC_API_KEY) return res.status(501).json({ error: 'parsing not configured' });

  try {
    const { image, mime, kind } = req.body || {};
    if (!image || !SCHEMAS[kind]) return res.status(400).json({ error: 'bad request' });

    const client = new Anthropic();
    const response = await client.messages.create({
      model: 'claude-sonnet-5',
      max_tokens: 1024,
      system:
        'You extract travel logistics from a photo of a ticket, booking confirmation, ' +
        'or travel document. Respond with ONLY a single JSON object, no prose, no code fence. ' +
        'Do NOT extract passenger names, passport numbers, dates of birth, or frequent-flyer ' +
        'numbers even if visible. If you cannot read a field, omit its key.',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: mime || 'image/jpeg', data: image } },
            { type: 'text', text: SCHEMAS[kind] },
          ],
        },
      ],
    });

    const text = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
    let parsed = {};
    try {
      parsed = JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g, '').trim());
    } catch {
      const m = text.match(/\{[\s\S]*\}/);
      if (m) { try { parsed = JSON.parse(m[0]); } catch {} }
    }
    if (parsed && typeof parsed === 'object') delete parsed.name;
    return res.status(200).json(parsed || {});
  } catch (err) {
    console.error('parse-ticket:', err?.message || 'error');
    return res.status(500).json({ error: 'parse failed' });
  }
}
