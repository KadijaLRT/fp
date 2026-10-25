import { parseRawOcrText, isHeaderLine } from './ocrTextParser.js';

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
const SCAN_TIMEOUT_MS = 20000;
const HARD_CAP_MS = 55000;

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

// Never wait on terminate(): a stuck engine never answers, and waiting on it
// is exactly what froze the batch. Shut it down in the background and move on.
function killInBackground(p) {
  if (!p) return;
  Promise.resolve(p)
    .then((w) => w.terminate())
    .catch(() => {});
}

export async function terminateTextScanWorker() {
  const p = workerPromise;
  workerPromise = null;
  // A new batch gets a fresh chance.
  disabled = false;
  timeouts = 0;
  scanChain = Promise.resolve();
  killInBackground(p);
}

function resetWorker() {
  const p = workerPromise;
  workerPromise = null;
  killInBackground(p);
}

// Scans run one at a time so a deadline measures the scan itself, not time
// spent queued behind another screenshot.
let scanChain = Promise.resolve();

/**
 * @param {string|File|Blob} image a (downscaled) data URL is best: full-size phone screenshots are slow to scan
 * @returns {Promise<string|null>} raw text, or null if the scan failed, timed out or is switched off
 */
export function scanTextFromImage(image) {
  const run = scanChain.then(() => scanOne(image), () => scanOne(image));
  scanChain = run.then(() => undefined, () => undefined);
  // Hard cap including queue time: after this the caller moves on regardless.
  return withDeadline(run, HARD_CAP_MS, 'Text scan gave up').catch(() => {
    disabled = true;
    resetWorker();
    scanChain = Promise.resolve();
    return null;
  });
}

async function scanOne(image) {
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
      resetWorker();
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


// ---------------------------------------------------------------------------
// Pin-number boxes. The stop number is white text on a gray (or green, for
// "Next Stop") rounded box, which the full-page read often skips or garbles.
// The boxes are found by colour, each is cropped, enlarged and read with a
// digits-only setting, and the result is matched to its row by position.
// Browser only; any failure just means no box numbers (never an error).
// ---------------------------------------------------------------------------

function loadImageElement(image) {
  return new Promise((resolve, reject) => {
    const el = new Image();
    let url = null;
    el.onload = () => {
      if (url) URL.revokeObjectURL(url);
      resolve(el);
    };
    el.onerror = () => reject(new Error('image decode failed'));
    if (typeof image === 'string') el.src = image;
    else {
      url = URL.createObjectURL(image);
      el.src = url;
    }
  });
}

/** Finds vertical runs of box-coloured rows in the left strip of the screenshot. */
export function findNumberBoxes(data, W, H) {
  const x0 = Math.round(W * 0.04);
  const x1 = Math.round(W * 0.1);
  const mx0 = Math.round(W * 0.45);
  const mx1 = Math.round(W * 0.6);
  const flags = new Array(H).fill(false);
  for (let y = 0; y < H; y++) {
    let fill = 0;
    for (let x = x0; x < x1; x++) {
      const i = (y * W + x) * 4;
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      const br = (r + g + b) / 3;
      if (br >= 55 && br <= 170) fill++;
    }
    if (fill / (x1 - x0) < 0.25) continue;
    // Box rows are dark in the middle of the screen (median); the blue header band is not.
    const mids = [];
    for (let x = mx0; x < mx1; x += 3) {
      const i = (y * W + x) * 4;
      mids.push((data[i] + data[i + 1] + data[i + 2]) / 3);
    }
    mids.sort((a, b) => a - b);
    if (mids[Math.floor(mids.length / 2)] < 45) flags[y] = true;
  }
  const minLen = Math.round(W * 0.045);
  const boxes = [];
  let start = -1;
  let gap = 0;
  for (let y = 0; y <= H; y++) {
    const on = y < H && flags[y];
    if (on) {
      if (start === -1) start = y;
      gap = 0;
    } else if (start !== -1) {
      gap++;
      if (gap > 6 || y === H) {
        const end = y - gap;
        if (end - start + 1 >= minLen && end - start + 1 <= W * 0.12) boxes.push({ y0: start, y1: end, x0, x1 });
        start = -1;
        gap = 0;
      }
    }
  }
  return boxes;
}

function cropDigitsCanvas(img, box, leftCut = 0) {
  const inset = 3;
  const sw = box.x1 - box.x0 - inset * 2 - leftCut;
  const sh = box.y1 - box.y0 - inset * 2;
  if (sw < 10 || sh < 10) return null;
  const scale = 3;
  const c = document.createElement('canvas');
  c.width = sw * scale + 40;
  c.height = sh * scale + 40;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(img, box.x0 + inset + leftCut, box.y0 + inset, sw, sh, 20, 20, sw * scale, sh * scale);
  const id = ctx.getImageData(0, 0, c.width, c.height);
  const d = id.data;
  for (let i = 0; i < d.length; i += 4) {
    const white = Math.min(d[i], d[i + 1], d[i + 2]) >= 200;
    const v = white ? 0 : 255; // black digits on white
    d[i] = d[i + 1] = d[i + 2] = v;
    d[i + 3] = 255;
  }
  ctx.putImageData(id, 0, 0);
  return c;
}

function ocrLinesOf(data) {
  if (Array.isArray(data?.lines) && data.lines.length) return data.lines;
  const out = [];
  (data?.blocks || []).forEach((b) => (b.paragraphs || []).forEach((p) => (p.lines || []).forEach((l) => out.push(l))));
  return out;
}

async function readBoxNumbers(worker, image, lines) {
  const img = await loadImageElement(image);
  const W = img.naturalWidth;
  const H = img.naturalHeight;
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  if (!ctx) return [];
  ctx.drawImage(img, 0, 0);
  const boxes = findNumberBoxes(ctx.getImageData(0, 0, W, H).data, W, H);

  const textLines = lines.map((l) => ({ text: String(l.text || '').trim(), box: l.bbox })).filter((l) => l.text && l.box);
  const headers = textLines.filter((l) => isHeaderLine(l.text)).map((l) => ({ yc: (l.box.y0 + l.box.y1) / 2 }));
  // Street line of a leading row whose header is clipped off the top edge.
  const firstHeaderPos = textLines.findIndex((l) => isHeaderLine(l.text));
  const leadStreet = firstHeaderPos > 0 ? textLines.slice(0, firstHeaderPos).find((l) => /^\d+[A-Za-z]?\s+\S+/.test(l.text)) : null;
  if (headers.length === 0 || boxes.length === 0) return { headerNumbers: headers.map(() => null), leadingNumber: null };

  // Read each box's digits (digits-only, single line).
  await worker.setParameters({ tessedit_char_whitelist: '0123456789', tessedit_pageseg_mode: '7' });
  const reads = [];
  try {
    for (const box of boxes) {
      const readCrop = async (crop) => {
        if (!crop) return null;
        try {
          const r = await withDeadline(worker.recognize(crop), 6000, 'box read timed out');
          const t = String(r?.data?.text || '').replace(/\s+/g, '');
          const conf = typeof r?.data?.confidence === 'number' ? r.data.confidence : 0;
          return /^\d{1,3}$/.test(t) && conf >= 50 && parseInt(t, 10) >= 1 ? parseInt(t, 10) : null;
        } catch {
          return null;
        }
      };
      let value = await readCrop(cropDigitsCanvas(img, box));
      // A map-pin icon at the left of the box reads as an extra digit ("929" for 29):
      // read again with the left third cut off when the first read looks wrong.
      if (value === null || value >= 100) {
        const second = await readCrop(cropDigitsCanvas(img, box, Math.round((box.x1 - box.x0) * 0.32)));
        if (second !== null && second < 100) value = second;
        else if (value !== null && value >= 100) value = null;
      }
      reads.push({ ...box, value, used: false });
    }
  } finally {
    await worker.setParameters({ tessedit_char_whitelist: '', tessedit_pageseg_mode: '3' }).catch(() => {});
  }

  // Match each header row to the nearest box (the box is level with the header,
  // or one line above it for the "Next Stop" row).
  const headerNumbers = headers.map((h) => {
    let best = null;
    for (const b of reads) {
      if (b.used) continue;
      const boxH = b.y1 - b.y0;
      const d = h.yc < b.y0 ? b.y0 - h.yc : h.yc > b.y1 ? h.yc - b.y1 : 0;
      if (d <= boxH * 1.2 && (!best || d < best.d)) best = { b, d };
    }
    if (!best) return null;
    best.b.used = true;
    return best.b.value;
  });

  let leadingNumber = null;
  if (leadStreet) {
    const yc = (leadStreet.box.y0 + leadStreet.box.y1) / 2;
    let best = null;
    for (const b of reads) {
      if (b.used) continue;
      const boxH = b.y1 - b.y0;
      const d = yc < b.y0 ? b.y0 - yc : yc > b.y1 ? yc - b.y1 : 0;
      if (d <= boxH * 2 && (!best || d < best.d)) best = { b, d };
    }
    if (best) leadingNumber = best.b.value;
  }
  return { headerNumbers, leadingNumber };
}

/**
 * Full-page text scan plus a separate read of the pin-number boxes.
 * @returns {Promise<{ text: string|null, headerNumbers: Array<number|null>, leadingNumber: number|null }>}
 */
export function scanScreenshot(image) {
  const run = scanChain.then(() => scanScreenshotOne(image), () => scanScreenshotOne(image));
  scanChain = run.then(() => undefined, () => undefined);
  return withDeadline(run, HARD_CAP_MS, 'Text scan gave up').catch(() => {
    disabled = true;
    resetWorker();
    scanChain = Promise.resolve();
    return { text: null, headerNumbers: [], leadingNumber: null };
  });
}

async function scanScreenshotOne(image) {
  if (disabled) return { text: null, headerNumbers: [], leadingNumber: null };
  try {
    const worker = await getWorker();
    const result = await withDeadline(worker.recognize(image), SCAN_TIMEOUT_MS, 'Text scan timed out');
    const text = result?.data?.text;
    if (typeof text !== 'string' || !text.trim()) return { text: null, headerNumbers: [], leadingNumber: null };
    let headerNumbers = [];
    let leadingNumber = null;
    try {
      const boxes = await withDeadline(readBoxNumbers(worker, image, ocrLinesOf(result.data)), 25000, 'box numbers timed out');
      headerNumbers = boxes.headerNumbers;
      leadingNumber = boxes.leadingNumber;
    } catch (err) {
      console.warn('Pin number read unavailable:', err?.message || err);
      await worker.setParameters({ tessedit_char_whitelist: '', tessedit_pageseg_mode: '3' }).catch(() => {});
    }
    return { text, headerNumbers, leadingNumber };
  } catch (err) {
    console.warn('Text scan unavailable:', err?.message || err);
    if (/did not start/i.test(err?.message || '')) {
      disabled = true;
    } else {
      timeouts++;
      resetWorker();
      if (timeouts >= 2) disabled = true;
    }
    return { text: null, headerNumbers: [], leadingNumber: null };
  }
}
