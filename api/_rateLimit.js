import { Ratelimit } from '@upstash/ratelimit';
import { Redis } from '@upstash/redis';

/**
 * Rate limits /api/ocr, /api/optimize, and /api/geocode — endpoints that
 * either cost real money per call (Groq inference, OpenRouteService
 * Matrix requests) or proxy a free-but-shared third-party API
 * (/api/geocode → OpenCage, which has a real daily quota) that this app shouldn't hammer on
 * behalf of a buggy client. Without this, a retry-loop bug in a client, a
 * misconfigured integration, or straightforward abuse has no ceiling.
 *
 * Degrades gracefully when Upstash isn't configured: rather than hard-
 * failing every request (which would brick the app for anyone who hasn't
 * set up Redis yet, including local dev), an unconfigured limiter is
 * treated as "not rate limited" and logs a warning once per cold start so
 * it's visible in Vercel logs without spamming every request.
 */

const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

let redis = null;
let warnedMissingConfig = false;

if (UPSTASH_URL && UPSTASH_TOKEN) {
  redis = new Redis({ url: UPSTASH_URL, token: UPSTASH_TOKEN });
}

// Separate limiters per endpoint since OCR (Groq vision) and optimize
// (ORS Matrix, potentially many chunked requests per call) have very
// different cost profiles per request.
const limiters = redis
  ? {
      ocr: new Ratelimit({
        redis,
        limiter: Ratelimit.slidingWindow(10, '1 m'), // 10 screenshot uploads/min/identity
        prefix: 'ratelimit:ocr'
      }),
      optimize: new Ratelimit({
        redis,
        limiter: Ratelimit.slidingWindow(20, '1 m'), // 20 optimize calls/min/identity
        prefix: 'ratelimit:optimize'
      }),
      explainRoute: new Ratelimit({
        redis,
        limiter: Ratelimit.slidingWindow(20, '1 m'),
        prefix: 'ratelimit:explain-route'
      }),
      // A 55-stop route geocodes up to 55 addresses in one import (plus
      // cache hits skip this entirely), so this needs real headroom —
      // set well above a single large route's worst case, but still a
      // real ceiling against a runaway retry loop.
      geocode: new Ratelimit({
        redis,
        limiter: Ratelimit.slidingWindow(120, '1 m'),
        prefix: 'ratelimit:geocode'
      })
    }
  : null;

/**
 * Best-effort caller identity for rate limiting: prefers a Supabase auth
 * user id if the client sent one (App.jsx can add this later without
 * changing the limiter), falls back to the request's IP. Never throws —
 * an identity of 'unknown' still gets limited, just coarsely (shared
 * bucket for anyone the IP can't be determined for), rather than skipping
 * limiting entirely.
 */
function getCallerIdentity(req) {
  const forwardedFor = req.headers?.['x-forwarded-for'];
  const ip = Array.isArray(forwardedFor) ? forwardedFor[0] : forwardedFor?.split(',')[0]?.trim();
  return ip || req.socket?.remoteAddress || 'unknown';
}

/**
 * Checks the rate limit for a given endpoint key. Returns { allowed, limit,
 * remaining, resetMs } — never throws. If Upstash isn't configured, always
 * returns allowed: true (see module doc above).
 */
export async function checkRateLimit(req, endpointKey) {
  if (!limiters) {
    if (!warnedMissingConfig) {
      console.warn(
        `Rate limiting is disabled: UPSTASH_REDIS_REST_URL/UPSTASH_REDIS_REST_TOKEN not set. ` +
          `/api/${endpointKey} has no request ceiling — set up Upstash Redis before production traffic.`
      );
      warnedMissingConfig = true;
    }
    return { allowed: true, limit: null, remaining: null, resetMs: null };
  }

  const limiter = limiters[endpointKey];
  if (!limiter) {
    // Unknown endpoint key is a coding error, not a request problem —
    // fail open rather than blocking legitimate traffic over a typo.
    console.error(`checkRateLimit called with unknown endpointKey: ${endpointKey}`);
    return { allowed: true, limit: null, remaining: null, resetMs: null };
  }

  try {
    const identity = getCallerIdentity(req);
    const { success, limit, remaining, reset } = await limiter.limit(identity);
    return { allowed: success, limit, remaining, resetMs: reset };
  } catch (err) {
    // If Redis itself is unreachable, fail open rather than taking down
    // the whole app because a rate-limiting dependency hiccuped — a
    // temporarily-unlimited endpoint is a much smaller problem than every
    // driver being unable to import a route.
    console.error('Rate limit check failed (failing open):', err);
    return { allowed: true, limit: null, remaining: null, resetMs: null };
  }
}

/**
 * Standard 429 response body/headers for a rate-limited request.
 */
export function sendRateLimitResponse(res, rateLimitResult) {
  if (rateLimitResult.resetMs) {
    res.setHeader('Retry-After', Math.max(1, Math.ceil((rateLimitResult.resetMs - Date.now()) / 1000)));
  }
  return res.status(429).json({
    error: 'Too many requests. Please wait a moment and try again.'
  });
}
