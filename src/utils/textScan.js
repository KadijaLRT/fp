import { parseRawOcrText } from './ocrTextParser.js';

/**
 * On-device text scan (Tesseract.js, self-hosted under public/tesseract/).
 * One shared worker is reused for a whole batch (creating a worker is the
 * slow part), then terminated. Never throws: resolves to null when the scan
 * can't run so the caller can carry on with the AI read alone.
 */
let workerPromise = null;
// If the engine can't start, or scans keep timing out, text scanning is
// switched off for the rest of the batch so the app moves on to the AI read
// instead of waiting on a stuck engine.
let disabled = false;
let timeouts = 0;
const START_TIMEOUT_MS = 30000;
const SCAN_TIMEOUT_MS = 25000;

function withDeadline(promise, ms, label) {
  let id;
  const t = new Promise((_, reject) => {
    id = setTimeout(() => reject(new Error(label)), ms);
  });
  return Promise.race([promise, t]).finally(() => clearTimeout(id));
}

async function getWorker() {
  if (!workerPromise) {
    workerPromise = withDeadline(
      (async () => {
        const { createWorker } = await import('tesseract.js');
        // Absolute URLs: the worker starts from a blob, where relative paths don't resolve.
        const base = `${window.location.origin}/tesseract`;
        return createWorker('eng', 1, {
          workerPath: `${base}/worker.min.js`,
          corePath: base,
          langPath: base,
          gzip: true
        });
      })(),
      START_TIMEOUT_MS,
      'Text scan engine did not start'
    ).catch((err) => {
      workerPromise = null;
      throw err;
    });
  }
  return workerPromise;
}

export async function terminateTextScanWorker() {
  const p = workerPromise;
  workerPromise = null;
  // A new batch gets a fresh chance.
  disabled = false;
  timeouts = 0;
  if (!p) return;
  try {
    const w = await p;
    await w.terminate();
  } catch {
    /* ignore */
  }
}

async function resetWorker() {
  const p = workerPromise;
  workerPromise = null;
  if (!p) return;
  try {
    const w = await p;
    await w.terminate();
  } catch {
    /* ignore */
  }
}

/**
 * @param {string|File|Blob} image a (downscaled) data URL is best: full-size phone screenshots are slow to scan
 * @returns {Promise<string|null>} raw text, or null if the scan failed, timed out or is switched off
 */
export async function scanTextFromImage(image) {
  if (disabled) return null;
  try {
    const worker = await getWorker();
    const result = await withDeadline(worker.recognize(image), SCAN_TIMEOUT_MS, 'Text scan timed out');
    const text = result?.data?.text;
    return typeof text === 'string' && text.trim() ? text : null;
  } catch (err) {
    console.warn('Text scan unavailable:', err?.message || err);
    const startFailed = /did not start/i.test(err?.message || '');
    if (startFailed) {
      disabled = true;
    } else {
      // A scan that timed out leaves the engine busy: replace it so the next
      // screenshot is not queued behind it.
      timeouts++;
      await resetWorker();
      if (timeouts >= 2) disabled = true;
    }
    return null;
  }
}

function tokens(address) {
  return new Set(
    String(address || '')
      .toLowerCase()
      .replace(/[^a-z0-9 ]/g, ' ')
      .split(/\s+/)
      .filter((t) => t.length > 1)
  );
}

function similarity(a, b) {
  const A = tokens(a);
  const B = tokens(b);
  if (A.size === 0 || B.size === 0) return 0;
  let shared = 0;
  A.forEach((t) => {
    if (B.has(t)) shared++;
  });
  return shared / Math.min(A.size, B.size);
}

/**
 * Text scan runs first and gives a draft; the AI vision read is authoritative
 * for structure and maps each stop. A stop is "confirmed" when both agree
 * (same stop number or a matching address). Stops only the text scan found
 * are kept but flagged for review so nothing is silently lost.
 *
 * @param {Array} aiStops  stops from /api/ocr
 * @param {string|null} text raw text scan output
 */
export function reconcileStops(aiStops, text) {
  const draft = text ? parseRawOcrText(text).filter((s) => s.address) : [];
  const unusedDraft = new Set(draft.map((_, i) => i));

  const merged = aiStops.map((stop) => {
    let bestIdx = -1;
    let bestScore = 0;
    draft.forEach((d, i) => {
      const sameNumber = Number.isInteger(stop.stopNumber) && d.stopNumber === stop.stopNumber;
      const score = similarity(stop.address, d.address) + (sameNumber ? 0.25 : 0);
      if (score > bestScore) {
        bestScore = score;
        bestIdx = i;
      }
    });
    const confirmed = bestIdx >= 0 && bestScore >= 0.7;
    if (confirmed) unusedDraft.delete(bestIdx);
    return { ...stop, scanConfirmed: confirmed };
  });

  // A leftover text-scan stop with the SAME pin number as an AI stop is that
  // same stop read slightly differently (not a new stop): never add it twice.
  const aiNumbers = new Set(aiStops.map((st) => st.stopNumber).filter(Number.isInteger));
  const extras = [...unusedDraft]
    .filter((i) => !(Number.isInteger(draft[i].stopNumber) && aiNumbers.has(draft[i].stopNumber)))
    .map((i) => ({ ...draft[i], scanConfirmed: false, needsManualReview: true }));
  return { stops: [...merged, ...extras], confirmedCount: merged.filter((s) => s.scanConfirmed).length, extraCount: extras.length };
}


/**
 * Decides whether the on-device text scan is trustworthy enough to skip the
 * AI call entirely (saves API usage). Every stop must have a pin number read
 * from the screenshot, a street address starting with a house number, a city
 * line and a package count; pin numbers must strictly increase; and there
 * must be at least one stop. Anything shakier goes to the AI read.
 */
function stopLooksValid(st) {
  if (!st.numberFromPin || !st.cityFound) return false;
  if (!/^\d+[A-Za-z]?\s+\S+/.test(String(st.address || '').trim())) return false;
  if (/[#•|]|deliver|package|scheduled/i.test(st.address)) return false;
  return Number.isInteger(st.stopNumber);
}

export function textScanLooksClean(stops) {
  if (!Array.isArray(stops) || stops.length === 0) return false;
  let prev = 0;
  for (const st of stops) {
    if (!stopLooksValid(st) || st.stopNumber <= prev) return false;
    prev = st.stopNumber;
  }
  return true;
}

/**
 * Rows cut off at the top or bottom edge of a screenshot read as incomplete
 * stops; those two edge rows are dropped (the AI read skips them too, and the
 * next screenshot normally shows them whole). Everything left must be valid.
 */
export function cleanTextScanStops(text) {
  let draft = text ? parseRawOcrText(text).filter((st) => st.address) : [];
  if (draft.length > 1 && !stopLooksValid(draft[draft.length - 1])) draft = draft.slice(0, -1);
  if (draft.length > 1 && !stopLooksValid(draft[0])) draft = draft.slice(1);
  return textScanLooksClean(draft) ? draft : null;
}
