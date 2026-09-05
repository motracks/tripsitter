// Detects the QR code / barcode region in a single ticket image via Gemini's
// spatial (object-detection) understanding, so the client can crop out just
// that region for a full-size, camera-scannable preview — instead of forcing
// the user to squint at (or scan) a whole ticket screenshot.
//
// GDPR note: same as parse-ticket.js — the image is held in memory for this
// request only, never written to disk or logged.

const PROMPT = `Look at this image of a travel ticket, boarding pass, or
booking confirmation. Find the single most prominent scannable QR code or
barcode in it (the kind a gate agent or conductor would scan) — ignore small
decorative logos, app icons, or unrelated graphics that are not actually
scannable codes.

Respond with ONLY a JSON array (no prose, no code fence).
If a QR code or barcode is present, return exactly one object:
[{"box_2d": [ymin, xmin, ymax, xmax]}]
where each value is an integer 0-1000 giving the box's position as a
fraction of the image height/width (top-left origin), tight around the
code's printed border/quiet-zone but not cropping into it.
If no scannable QR code or barcode is visible anywhere in the image, return
an empty array: []`;

const MODELS = ['gemini-2.5-flash', 'gemini-flash-latest', 'gemini-3.5-flash'];

async function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') { try { return JSON.parse(req.body); } catch { return {}; } }
  const chunks = [];
  for await (const c of req) chunks.push(c);
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return {}; }
}

export default async function handler(req, res) {
  const key = (process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '').trim();
  if (req.method !== 'POST') return res.status(405).json({ error: 'method not allowed' });
  if (!key) return res.status(501).json({ error: 'parsing not configured', detail: 'GEMINI_API_KEY not set' });

  try {
    const body = await readBody(req);
    const data = body.image || body.data;
    const mime = body.mime || 'image/jpeg';
    if (!data) return res.status(400).json({ error: 'bad request', detail: 'no image' });

    const payload = {
      contents: [{
        role: 'user',
        parts: [
          { inlineData: { mimeType: mime, data } },
          { text: PROMPT },
        ],
      }],
      generationConfig: { temperature: 0, responseMimeType: 'application/json', maxOutputTokens: 256 },
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
        console.error('detect-qr: gemini', model, gres.status, lastErr.body);
        continue;
      }
      const j = await gres.json();
      const text = (j?.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('');
      let boxes = [];
      try {
        boxes = JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g, '').trim());
      } catch {
        const m = text.match(/\[[\s\S]*\]/);
        if (m) { try { boxes = JSON.parse(m[0]); } catch {} }
      }
      const first = Array.isArray(boxes) ? boxes.find(b => Array.isArray(b?.box_2d) && b.box_2d.length === 4) : null;
      const box = first ? { ymin: first.box_2d[0], xmin: first.box_2d[1], ymax: first.box_2d[2], xmax: first.box_2d[3] } : null;
      return res.status(200).json({ box, model });
    }
    return res.status(502).json({ error: 'gemini error', detail: lastErr });
  } catch (err) {
    console.error('detect-qr:', err?.message || err);
    return res.status(500).json({ error: 'detect failed', detail: String(err?.message || err) });
  }
}
