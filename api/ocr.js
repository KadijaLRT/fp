import Groq from 'groq-sdk';
import { checkRateLimit, sendRateLimitResponse } from './_rateLimit.js';

const groq = process.env.GROQ_API_KEY ? new Groq({ apiKey: process.env.GROQ_API_KEY }) : null;

// Groq deprecates preview models frequently (llama-3.2-11b-vision-preview was
// decommissioned in April 2025, and qwen/qwen3.6-27b — this file's previous
// default — was subsequently withdrawn too, returning HTTP 404 despite still
// being listed in Groq's docs at the time; it's a preview model, "intended
// for evaluation, not production" per Groq's own vision docs, which is
// exactly the kind of model that gets pulled with little notice). Model ID
// is env-configurable so a future deprecation is a config change, not a
// code change. As of Sept 2026, Groq's current documented vision-capable
// models are qwen/qwen3.6-27b and qwen/qwen3.8-27b — using the newer one by
// default since the older one has already been pulled once. Verify current
// availability at https://console.groq.com/docs/vision before deploying.
const VISION_MODEL = process.env.GROQ_VISION_MODEL || 'qwen/qwen3.8-27b';

const MAX_IMAGE_BYTES = 8 * 1024 * 1024; // 8MB — generous for a phone screenshot
// Bug fix, found from a real "check connection" failure report that grew
// worse with batch size: the server's own worst-case retry time (3
// attempts × REQUEST_TIMEOUT_MS + backoff) could reach ~76.5s at the
// previous 25000ms setting, while the client gave up after 30s — meaning
// a single retry (25s) plus its 500ms backoff already exceeded the
// client's entire budget before the server's second attempt even
// started. Every image that needed even one retry looked like a
// connection failure to the client while the server was still correctly
// working. Reduced here so the full worst case comfortably fits under
// the client's timeout (see UPLOAD_TIMEOUT_MS in ItineraryUpload.jsx),
// instead of the two budgets working against each other.
const REQUEST_TIMEOUT_MS = 12000;
const MAX_RETRIES = 2;

function withTimeout(promise, ms) {
  let timeoutId;
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error('Groq request timed out')), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timeoutId));
}

function estimateBase64Bytes(base64Str) {
  // rough but fast: base64 encodes 3 bytes as 4 chars
  const commaIdx = base64Str.indexOf(',');
  const payload = commaIdx >= 0 ? base64Str.slice(commaIdx + 1) : base64Str;
  return Math.floor((payload.length * 3) / 4);
}

function isLikelyImageDataUrl(str) {
  return typeof str === 'string' && /^data:image\/(png|jpe?g|webp|heic|heif);base64,/i.test(str);
}

// Validate the shape Groq should have returned. If it's malformed, we don't
// want to silently hand the client garbage — better to flag it clearly.
function validateParsedItinerary(parsed) {
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.stops)) {
    return { valid: false, reason: 'Response missing a "stops" array.' };
  }
  const cleanedStops = [];
  for (const raw of parsed.stops) {
    if (!raw || typeof raw !== 'object') continue;
    const address = typeof raw.address === 'string' ? raw.address.trim() : '';
    if (!address) continue; // an address-less stop is useless downstream

    cleanedStops.push({
      stopNumber: Number.isFinite(Number(raw.stopNumber)) ? Number(raw.stopNumber) : cleanedStops.length + 1,
      address,
      packageCount: Number.isFinite(Number(raw.packageCount)) && Number(raw.packageCount) > 0
        ? Math.floor(Number(raw.packageCount))
        : 1,
      deliveryWindow: typeof raw.deliveryWindow === 'string' && raw.deliveryWindow.trim() ? raw.deliveryWindow.trim() : null,
      notes: typeof raw.notes === 'string' && raw.notes.trim() ? raw.notes.trim() : null
    });
  }

  if (cleanedStops.length === 0) {
    return { valid: false, reason: 'No usable stops with addresses were found in the image.' };
  }

  return { valid: true, stops: cleanedStops };
}

async function callGroqWithRetry(imageBase64) {
  let lastError;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const completion = await withTimeout(
        groq.chat.completions.create({
          model: VISION_MODEL,
          messages: [
            {
              role: 'user',
              content: [
                {
                  type: 'text',
                  text: `Extract the delivery itinerary details from this Amazon Flex screenshot.
Return ONLY a JSON object strictly following this structure, with no markdown fences or commentary:
{
  "stops": [
    {
      "stopNumber": number,
      "address": "string",
      "packageCount": number,
      "deliveryWindow": "string or null",
      "notes": "string or null"
    }
  ]
}
If the image is blurry, cropped, or you cannot confidently read an address, omit that stop rather than guessing.`
                },
                { type: 'image_url', image_url: { url: imageBase64 } }
              ]
            }
          ],
          response_format: { type: 'json_object' },
          temperature: 0.1
        }),
        REQUEST_TIMEOUT_MS
      );
      return completion;
    } catch (err) {
      lastError = err;
      const status = err?.status || err?.response?.status;
      // Don't retry on client errors like bad auth or malformed request —
      // only retry on rate limits (429) and transient server/network errors.
      const retryable = status === 429 || status >= 500 || err.message === 'Groq request timed out';
      if (!retryable || attempt === MAX_RETRIES) break;
      const backoffMs = 500 * Math.pow(2, attempt);
      await new Promise((r) => setTimeout(r, backoffMs));
    }
  }
  throw lastError;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const rateLimit = await checkRateLimit(req, 'ocr');
  if (!rateLimit.allowed) {
    return sendRateLimitResponse(res, rateLimit);
  }

  if (!groq) {
    console.error('GROQ_API_KEY is not set in the environment.');
    return res.status(500).json({ error: 'OCR service is not configured. Contact support.' });
  }

  try {
    const { imageBase64 } = req.body || {};

    if (!imageBase64) {
      return res.status(400).json({ error: 'Missing image payload.' });
    }
    if (!isLikelyImageDataUrl(imageBase64)) {
      return res.status(400).json({ error: 'Image must be a base64 data URL (png, jpg, webp, or heic).' });
    }
    if (estimateBase64Bytes(imageBase64) > MAX_IMAGE_BYTES) {
      return res.status(413).json({ error: 'Image is too large. Please upload a screenshot under 8MB.' });
    }

    let completion;
    try {
      completion = await callGroqWithRetry(imageBase64);
    } catch (err) {
      console.error('Groq OCR call failed after retries:', err);
      const status = err?.status || err?.response?.status;
      if (status === 429) {
        return res.status(429).json({ error: 'OCR service is busy. Please try again in a moment.' });
      }
      if (err.message === 'Groq request timed out') {
        return res.status(504).json({ error: 'OCR request timed out. Check your connection and try again.' });
      }
      // A 404 here almost always means the configured vision model has been
      // withdrawn or renamed by Groq — this has already happened once (see
      // the comment on VISION_MODEL above). Surfacing this distinctly
      // instead of the generic fallback below matters: without it, a model
      // misconfiguration looks identical to a network problem, and every
      // screenshot fails with no clue why — which is exactly what happened
      // here before this branch existed.
      if (status === 404) {
        console.error(
          `Groq returned 404 for vision model "${VISION_MODEL}" — it may have been withdrawn or renamed. ` +
            `Check https://console.groq.com/docs/vision and update GROQ_VISION_MODEL.`
        );
        return res.status(502).json({
          error: 'The OCR model is temporarily unavailable (configuration issue on our end, not your screenshot). Try again shortly, or use text scan / manual entry for now.'
        });
      }
      return res.status(502).json({ error: 'Failed to reach the OCR service.' });
    }

    const rawContent = completion?.choices?.[0]?.message?.content;
    if (!rawContent) {
      return res.status(502).json({ error: 'OCR service returned an empty response.' });
    }

    let parsed;
    try {
      parsed = JSON.parse(rawContent);
    } catch (parseErr) {
      console.error('Failed to parse Groq OCR JSON:', parseErr, 'raw:', rawContent);
      return res.status(502).json({ error: 'OCR service returned malformed data. Try a clearer screenshot.' });
    }

    const validation = validateParsedItinerary(parsed);
    if (!validation.valid) {
      return res.status(422).json({ error: validation.reason });
    }

    return res.status(200).json({ success: true, data: { stops: validation.stops } });
  } catch (error) {
    console.error('Unhandled OCR endpoint error:', error);
    return res.status(500).json({ error: 'Failed to parse itinerary screenshot.' });
  }
}
