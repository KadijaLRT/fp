import Groq from 'groq-sdk';
import { checkRateLimit, sendRateLimitResponse } from './_rateLimit.js';

const groq = process.env.GROQ_API_KEY ? new Groq({ apiKey: process.env.GROQ_API_KEY }) : null;

// llama-3.3-70b-versatile was deprecated Aug 16, 2026. Groq's recommended
// replacement for general reasoning is openai/gpt-oss-120b. Configurable via
// env so the next deprecation cycle doesn't require a code deploy.
const REASONING_MODEL = process.env.GROQ_REASONING_MODEL || 'openai/gpt-oss-120b';
const REQUEST_TIMEOUT_MS = 15000;

function withTimeout(promise, ms) {
  let timeoutId;
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error('Groq request timed out')), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timeoutId));
}

// Fallback explanation if the LLM call fails — the driver still gets
// something useful instead of a blank error state.
function buildFallbackExplanation(originalOrder, newOrder) {
  const movedCount = Array.isArray(originalOrder) && Array.isArray(newOrder)
    ? originalOrder.filter((id, idx) => newOrder[idx] !== id).length
    : 0;
  return `Your route was re-sequenced to reduce total drive time${
    movedCount ? ` (${movedCount} stop${movedCount === 1 ? '' : 's'} moved)` : ''
  }. This usually happens to avoid backtracking or to hit an approaching delivery window.`;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const rateLimit = await checkRateLimit(req, 'explainRoute');
  if (!rateLimit.allowed) {
    return sendRateLimitResponse(res, rateLimit);
  }

  try {
    const { originalOrder, newOrder, reasoningFactors } = req.body || {};

    if (!Array.isArray(originalOrder) || !Array.isArray(newOrder)) {
      return res.status(400).json({ error: 'originalOrder and newOrder must be arrays.' });
    }

    if (!groq) {
      console.error('GROQ_API_KEY is not set; returning fallback explanation.');
      return res.status(200).json({
        explanation: buildFallbackExplanation(originalOrder, newOrder),
        fallback: true
      });
    }

    try {
      const completion = await withTimeout(
        groq.chat.completions.create({
          model: REASONING_MODEL,
          messages: [
            {
              role: 'system',
              content:
                'You are an AI driver assistant. Provide a clear, reassuring, 2-sentence explanation ' +
                'for why a delivery route order changed. Keep it plain-English, no jargon, no code.'
            },
            {
              role: 'user',
              content: `Explain why the route order changed from ${JSON.stringify(
                originalOrder
              )} to ${JSON.stringify(newOrder)}. Factors considered: ${JSON.stringify(
                reasoningFactors || {}
              )}.`
            }
          ],
          temperature: 0.3,
          max_tokens: 200
        }),
        REQUEST_TIMEOUT_MS
      );

      const explanation = completion?.choices?.[0]?.message?.content?.trim();
      if (!explanation) {
        throw new Error('Empty explanation from Groq');
      }

      return res.status(200).json({ explanation, fallback: false });
    } catch (err) {
      console.error('Groq explain-route call failed, using fallback:', err);
      // Never block the driver's dashboard on an LLM hiccup — degrade gracefully.
      return res.status(200).json({
        explanation: buildFallbackExplanation(originalOrder, newOrder),
        fallback: true
      });
    }
  } catch (error) {
    console.error('Unhandled explain-route endpoint error:', error);
    return res.status(500).json({ error: 'Failed to generate explanation.' });
  }
}
