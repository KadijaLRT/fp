import { parseRawOcrText } from './ocrTextParser.js';

/**
 * On-device text scan (Tesseract.js, self-hosted under public/tesseract/).
 * One shared worker is reused for a whole batch (creating a worker is the
 * slow part), then terminated. Never throws: resolves to null when the scan
 * can't run so the caller can carry on with the AI read alone.
 */
let workerPromise = null;

async function getWorker() {
  if (!workerPromise) {
    workerPromise = (async () => {
      const { createWorker } = await import('tesseract.js');
      // Absolute URLs: the worker starts from a blob, where relative paths don't resolve.
      const base = `${window.location.origin}/tesseract`;
      return createWorker('eng', 1, {
        workerPath: `${base}/worker.min.js`,
        corePath: base,
        langPath: base,
        gzip: true
      });
    })().catch((err) => {
      workerPromise = null;
      throw err;
    });
  }
  return workerPromise;
}

export async function terminateTextScanWorker() {
  if (!workerPromise) return;
  const p = workerPromise;
  workerPromise = null;
  try {
    const w = await p;
    await w.terminate();
  } catch {
    /* ignore */
  }
}

/** @returns {Promise<string|null>} raw text, or null if the scan failed or timed out */
export async function scanTextFromImage(file, timeoutMs = 60000) {
  try {
    const worker = await getWorker();
    const result = await Promise.race([
      worker.recognize(file),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Text scan timed out')), timeoutMs))
    ]);
    const text = result?.data?.text;
    return typeof text === 'string' && text.trim() ? text : null;
  } catch (err) {
    console.warn('Text scan unavailable:', err?.message || err);
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

  const extras = [...unusedDraft].map((i) => ({ ...draft[i], scanConfirmed: false, needsManualReview: true }));
  return { stops: [...merged, ...extras], confirmedCount: merged.filter((s) => s.scanConfirmed).length, extraCount: extras.length };
}
