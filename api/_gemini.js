// Shared Gemini vision-call helper for parse-ticket.js and detect-qr.js.
// Leading underscore keeps Vercel from registering this as its own route.

// Tried in order; first that responds wins. Flash-tier vision models
// confirmed available on the project's key (see GET /api/parse-ticket?models).
export const MODELS = ['gemini-2.5-flash', 'gemini-flash-latest', 'gemini-3.5-flash'];

// Call one Gemini model, retrying a couple of times (short backoff) on a
// transient overload/rate-limit response before giving up on it — a bare
// 503 "model is overloaded" is common on the free/shared tier and usually
// clears within a second or two, so failing straight to "enter manually"
// on the very first hiccup was needless. Non-transient errors (bad request,
// unknown model) fail immediately so the caller can move to the next model.
export async function callGeminiWithRetry(model, payload, key, logTag, maxAttempts = 3) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
  let err = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const gres = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-goog-api-key': key },
      body: JSON.stringify(payload),
    });
    if (gres.ok) return { ok: true, gres };
    const body = (await gres.text()).slice(0, 300);
    err = { status: gres.status, body };
    console.error(`${logTag}: gemini`, model, gres.status, body, `(attempt ${attempt}/${maxAttempts})`);
    const transient = gres.status === 503 || gres.status === 429;
    if (!transient || attempt === maxAttempts) break;
    await new Promise((r) => setTimeout(r, 500 * attempt));
  }
  return { ok: false, err };
}
