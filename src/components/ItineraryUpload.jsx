import React, { useState, useRef } from 'react';
import ManualStopReview from './ManualStopReview';
import { parseRawOcrText, emptyStop } from '../utils/ocrTextParser';
import { scanScreenshot, terminateTextScanWorker } from '../utils/textScan';

const MAX_FILE_BYTES = 8 * 1024 * 1024; // 8MB
const ACCEPTED_TYPES = ['image/png', 'image/jpeg', 'image/jpg', 'image/webp', 'image/heic', 'image/heif'];
// Bug fix: this used to be 30000 (30s), while the server's own worst-case
// retry time (api/ocr.js, 3 attempts + backoff) could reach ~76.5s at its
// previous settings — meaning the client gave up on a single retry alone
// before the server's second attempt had even started, showing "Upload
// timed out. Check your connection" for what was actually the server
// still correctly working through its own retry logic. Raised to
// comfortably exceed the server's new worst case (~37.5s at its reduced
// REQUEST_TIMEOUT_MS) with real margin for network transit on top.
const UPLOAD_TIMEOUT_MS = 58000;
// A single Flex itinerary screenshot typically shows ~15-20 stops before
// scrolling, so a 55-stop route realistically needs 3-4 images. Processing
// them with limited concurrency (not all at once) keeps this comfortably
// under /api/ocr's rate limit even for a larger batch, and keeps the
// progress UI readable rather than a wall of simultaneous spinners.
const OCR_CONCURRENCY = 2;

function withTimeout(promise, ms) {
  let timeoutId;
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error('Upload timed out. Check your connection and try again.')), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timeoutId));
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.readAsDataURL(file);
    reader.onload = () => {
      if (typeof reader.result === 'string') {
        resolve(reader.result);
      } else {
        reject(new Error('Failed to read image file.'));
      }
    };
    reader.onerror = () => reject(new Error('Failed to read image file.'));
  });
}

// A real, confirmed contributor to OCR timeouts: modern phones take
// screenshots at 3x/retina resolution (e.g. 1170x2532 or larger), which
// as a PNG data URL routinely runs several megabytes — every extra pixel
// past what a vision model actually needs to read on-screen text just
// makes the upload slower and Groq's own inference slower, especially
// under this app's 3-way concurrent batch processing where several large
// payloads compete at once. A vision model reading UI text doesn't need
// retina resolution; 1600px on the long edge is comfortably more than
// enough to read even small text clearly, so screenshots are downscaled
// (and re-encoded as JPEG, which compresses screenshot-style UI content
// far better than PNG) before ever being sent. This can only shrink the
// payload — never changes what text is legible, since screenshots don't
// have DPI-sensitive fine detail the way a real photo might.
// The scan runs on this phone (nothing is uploaded), and small digits blur when
// a screenshot is shrunk, so only very large images are reduced.
const MAX_LONG_EDGE_PX = 2800;
const JPEG_QUALITY = 0.92;

async function convertToBase64(file) {
  const original = await readFileAsDataUrl(file);

  // HEIC/HEIF can't be drawn to a canvas in most browsers (no native
  // decode support), so those are sent through unresized rather than
  // silently producing a blank/broken image — Groq's vision model can
  // still read the original directly.
  if (/^data:image\/hei[cf]/i.test(original)) {
    return original;
  }

  try {
    const img = await new Promise((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error('Failed to decode image for resizing.'));
      el.src = original;
    });

    const longEdge = Math.max(img.width, img.height);
    if (longEdge <= MAX_LONG_EDGE_PX) {
      // Already small enough — resizing further would only lose quality
      // for no real payload-size benefit.
      return original;
    }

    const scale = MAX_LONG_EDGE_PX / longEdge;
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(img.width * scale);
    canvas.height = Math.round(img.height * scale);
    const ctx = canvas.getContext('2d');
    if (!ctx) return original; // no canvas support — fall back to the original rather than fail the upload

    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    const resized = canvas.toDataURL('image/jpeg', JPEG_QUALITY);
    // Guard against a canvas that silently failed to encode (some browsers
    // return a 1x1 transparent PNG data URL on failure rather than
    // throwing) — if the resized output isn't a real, smaller image,
    // trust the original instead of shipping something broken.
    return resized && resized.length > 100 && resized.length < original.length ? resized : original;
  } catch (err) {
    // Resizing is purely an optimization — never let a resize failure
    // block the upload itself. Fall back to the original, full-size image.
    console.warn('Image resize before OCR failed, using original:', err);
    return original;
  }
}

/**
 * Reads one screenshot with the on-device text scan (free, no API). The
 * driver confirms every stop on the review screen before routing.
 */
async function processScreenshot(file, onStage = () => {}) {
  // Downscale once (1600px JPEG): scanning a full-size phone screenshot is slow.
  let prepared = null;
  try {
    prepared = await convertToBase64(file);
  } catch {
    prepared = null;
  }
  onStage('Reading text on this phone...');
  const { text, headerNumbers, leadingNumber } = await scanScreenshot(prepared || file);

  // No AI read: the on-device scan gives a draft and the driver confirms every
  // stop (number and address) before anything is geocoded or routed. Stop
  // numbers are exact reads only; an unreadable number stays blank.
  const draftStops = text ? parseRawOcrText(text, { headerNumbers, leadingNumber }).filter((st) => st.address) : [];
  if (draftStops.length === 0) {
    return {
      stops: null,
      error: 'No stops could be read from this screenshot. Try a sharper screenshot, or add its stops by hand with "Or type stops in manually".'
    };
  }
  const blank = draftStops.filter((st) => !Number.isInteger(st.stopNumber)).length;
  return {
    stops: draftStops.map((st) => ({ ...st, scanConfirmed: false, needsManualReview: true })),
    error: null,
    note: blank ? `${draftStops.length} stops, ${blank} without a number` : `${draftStops.length} stops, numbers read`
  };
}

let nextBatchItemId = 1;

export default function ItineraryUpload({ onRouteImported }) {
  const [error, setError] = useState(null);
  // 'idle' | 'scanning' | 'review' — drives the OCR-fallback flow when a
  // single failed screenshot needs Tesseract/manual recovery.
  const [fallbackMode, setFallbackMode] = useState('idle');
  const [reviewStops, setReviewStops] = useState(null);
  const lastFailedFileRef = useRef(null);

  // One entry per selected file: { id, file, status: 'pending'|'processing'|'success'|'error', stops, error }.
  // Multiple screenshots merge into one itinerary — a 55-stop route
  // realistically needs several images, since a single Flex screenshot
  // only shows ~15-20 stops before scrolling.
  const [batch, setBatch] = useState([]);
  // Set while the final confirm screen (all merged stops) is showing.
  const finalReviewRef = useRef(false);
  const [batchRunning, setBatchRunning] = useState(false);

  const updateBatchItem = (id, patch) => {
    setBatch((prev) => prev.map((item) => (item.id === id ? { ...item, ...patch } : item)));
  };

  const runBatch = async (items) => {
    setBatchRunning(true);
    let cursor = 0;

    async function worker() {
      let isFirst = true;
      while (true) {
        // Claim the next item atomically (check-then-increment with no
        // await in between) before doing anything async. A stagger delay
        // placed *before* this claim (an earlier version of this fix)
        // created a real race: multiple workers could pass the bounds
        // check on a stale cursor value while awaiting, then all try to
        // claim past the array's end once they resumed — producing
        // `undefined` entries and silently dropping items from larger
        // batches. Claiming first, then pacing, avoids that entirely.
        if (cursor >= items.length) break;
        const item = items[cursor++];

        // Small stagger between requests within each worker (not just
        // limiting concurrency to 3) — complements /api/ocr's existing
        // server-side retry-with-backoff on a 429, which only kicks in
        // *after* a rate limit is already tripped. Spacing requests out
        // reduces the chance of tripping a burst-sensitive limit (Groq's
        // own account-level quota, not this app's rate limiter) in the
        // first place, which matters more as batch size grows.
        if (!isFirst) {
          await new Promise((resolve) => setTimeout(resolve, 400));
        }
        isFirst = false;

        updateBatchItem(item.id, { status: 'processing' });
        // Last-resort cap so one row can never hang the whole batch.
        const { stops, error: ocrError, note } = await withTimeout(
          processScreenshot(item.file, (stage) => updateBatchItem(item.id, { stage })),
          170000
        ).catch(() => ({ stops: null, error: 'This screenshot took too long. Tap "Retry failed screenshots".' }));
        if (stops) {
          updateBatchItem(item.id, { status: 'success', stops, error: null, note });
        } else {
          updateBatchItem(item.id, { status: 'error', stops: null, error: ocrError });
        }
      }
    }

    const workers = Array.from({ length: Math.min(OCR_CONCURRENCY, items.length) }, worker);
    await Promise.all(workers);
    await terminateTextScanWorker();
    setBatchRunning(false);
  };

  const handleFilesSelected = (event) => {
    const files = Array.from(event.target.files || []);
    // Reset the input so selecting the same file(s) again still fires onChange.
    event.target.value = '';
    if (files.length === 0) return;

    setError(null);

    const validFiles = [];
    const rejectedNames = [];

    for (const file of files) {
      if (!ACCEPTED_TYPES.includes(file.type) || file.size === 0 || file.size > MAX_FILE_BYTES) {
        rejectedNames.push(file.name);
        continue;
      }
      validFiles.push(file);
    }

    if (rejectedNames.length > 0) {
      setError(
        `${rejectedNames.length} file(s) skipped (unsupported type, empty, or over 8MB): ${rejectedNames.join(', ')}`
      );
    }
    if (validFiles.length === 0) return;

    const newItems = validFiles.map((file) => ({
      id: nextBatchItemId++,
      file,
      status: 'pending',
      stops: null,
      error: null
    }));

    setBatch((prev) => [...prev, ...newItems]);
    runBatch(newItems);
  };

  const handleRetryFailed = () => {
    const failedItems = batch.filter((item) => item.status === 'error');
    if (failedItems.length === 0) return;
    failedItems.forEach((item) => updateBatchItem(item.id, { status: 'pending', error: null }));
    runBatch(failedItems);
  };

  const handleRemoveItem = (id) => {
    setBatch((prev) => prev.filter((item) => item.id !== id));
  };

  const handleStartOver = () => {
    setBatch([]);
    setError(null);
  };

  // Merges every successfully-OCR'd screenshot into one itinerary using
  // Amazon's own stop numbers (the number in each row's map pin), so the
  // app's numbering matches the Flex app exactly. Screenshots of a
  // scrolling list usually overlap, so a stop seen twice (same number) is
  // kept once, preferring the copy with the longer/more complete address.
  // Result is sorted by Amazon's number. If any stop is missing its
  // number (OCR couldn't read the pin), numbers can't be trusted, so it
  // falls back to file order with sequential numbering.
  const handleContinue = () => {
    const successfulItems = batch.filter((item) => item.status === 'success');
    const all = successfulItems
      .flatMap((item) => item.stops || [])
      .map(({ fromReview, scanConfirmed, needsManualReview, ...st }) => {
        void fromReview;
        void scanConfirmed;
        void needsManualReview;
        return st;
      });

    const normAddr = (a) => String(a || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    const sameAddr = (a, b) => {
      const x = normAddr(a);
      const y = normAddr(b);
      return Boolean(x) && Boolean(y) && (x === y || x.includes(y) || y.includes(x));
    };

    // Amazon numbers are kept exactly as read. The same number seen twice with
    // the same address is an overlap between screenshots (kept once). The same
    // number with a DIFFERENT address means one was misread, so the later one
    // loses its number and is left blank for the driver to check.
    const byNumber = new Map();
    const blanks = [];
    for (const st of all) {
      const n = Number.isInteger(st.stopNumber) && st.stopNumber > 0 ? st.stopNumber : null;
      if (n === null) {
        blanks.push({ ...st, stopNumber: null });
        continue;
      }
      const existing = byNumber.get(n);
      if (!existing) {
        byNumber.set(n, st);
      } else if (sameAddr(existing.address, st.address)) {
        if ((st.address || '').length > (existing.address || '').length) byNumber.set(n, st);
      } else {
        blanks.push({ ...st, stopNumber: null });
      }
    }
    const numbered = [...byNumber.values()].sort((x, y) => x.stopNumber - y.stopNumber);

    // Numberless stops that repeat a numbered stop (or each other) are overlap.
    const keptBlanks = [];
    for (const st of blanks) {
      if (numbered.some((n) => sameAddr(n.address, st.address))) continue;
      if (keptBlanks.some((k) => sameAddr(k.address, st.address))) continue;
      keptBlanks.push(st);
    }

    // Stops with no number come first so they are the first thing checked.
    const mergedStops = [...keptBlanks, ...numbered];

    if (mergedStops.length === 0) {
      setError('No stops to import yet. Process at least one screenshot successfully first.');
      return;
    }

    // Every address is confirmed by the driver before anything is geocoded
    // or routed; the API is only used afterwards to place and order stops.
    finalReviewRef.current = true;
    lastFailedFileRef.current = null;
    setReviewStops(mergedStops.map(({ fromReview, scanConfirmed, needsManualReview, ...st }) => {
      void fromReview;
      void scanConfirmed;
      void needsManualReview;
      return st;
    }));
    setFallbackMode('review');
    setError(null);
  };

  // Fallback path 2: skip scanning entirely and let the driver type a
  // failed screenshot's stops in by hand.
  const handleManualEntry = (failedItem) => {
    lastFailedFileRef.current = failedItem || null;
    setReviewStops([emptyStop(2)]);
    setFallbackMode('review');
    setError(null);
  };

  // Confirming the review screen replaces the failed batch item's entry
  // with the manually-recovered stops, so it merges into the batch like
  // any other successful screenshot instead of requiring a separate flow.
  const handleReviewConfirm = (confirmedStops) => {
    if (finalReviewRef.current) {
      finalReviewRef.current = false;
      setFallbackMode('idle');
      setReviewStops(null);
      onRouteImported(confirmedStops.map((st, i) => ({
        ...st,
        stopNumber: Number.isInteger(st.stopNumber) && st.stopNumber > 0 ? st.stopNumber : i + 2
      })));
      return;
    }
    const failedItem = lastFailedFileRef.current;
    setFallbackMode('idle');
    setReviewStops(null);
    lastFailedFileRef.current = null;

    if (failedItem?.id) {
      updateBatchItem(failedItem.id, { status: 'success', stops: confirmedStops.map((st) => ({ ...st, fromReview: true })), error: null });
    } else {
      // Manual entry with nothing to recover into (batch empty / no
      // specific failed item) — treat it as its own one-off item so it
      // still flows through the same "Continue" merge step.
      setBatch((prev) => [
        ...prev,
        { id: nextBatchItemId++, file: null, status: 'success', stops: confirmedStops.map((st) => ({ ...st, fromReview: true })), error: null }
      ]);
    }
  };

  const handleReviewCancel = () => {
    finalReviewRef.current = false;
    setFallbackMode('idle');
    setReviewStops(null);
    lastFailedFileRef.current = null;
  };

  if (fallbackMode === 'review') {
    return (
      <ManualStopReview
        initialStops={reviewStops}
        onConfirm={handleReviewConfirm}
        onCancel={handleReviewCancel}
      />
    );
  }

  const successCount = batch.filter((i) => i.status === 'success').length;
  const errorCount = batch.filter((i) => i.status === 'error').length;
  const pendingCount = batch.filter((i) => i.status === 'pending' || i.status === 'processing').length;
  // What Continue will import: numbers are kept exactly as read; stops with no
  // readable number are listed first on the confirm screen for the driver to fill in.
  const okStops = batch.filter((i) => i.status === 'success').flatMap((i) => i.stops || []);
  const numberedList = okStops
    .filter((st) => Number.isInteger(st.stopNumber) && st.stopNumber > 0)
    .map((st) => st.stopNumber);
  const seenNumbers = new Set(numberedList);
  const duplicateCount = numberedList.length - seenNumbers.size;
  const blankCount = okStops.length - numberedList.length;
  const totalMergedStops = seenNumbers.size + blankCount;

  // Missing numbers between lowest and highest, collapsed into ranges ("6-10, 16-30").
  const missingNumbers = [];
  let missingCount = 0;
  if (seenNumbers.size > 1) {
    const nums = [...seenNumbers];
    const lo = Math.min(...nums);
    const hi = Math.max(...nums);
    let start = null;
    for (let n = lo; n <= hi + 1; n++) {
      const missing = n <= hi && !seenNumbers.has(n);
      if (missing && start === null) start = n;
      if (!missing && start !== null) {
        const end = n - 1;
        missingCount += end - start + 1;
        missingNumbers.push(start === end ? String(start) : start + '-' + end);
        start = null;
      }
    }
  }

  return (
    <div className="p-4 max-w-md mx-auto text-center">
      <div className="border-2 border-dashed border-neutral-800 rounded-2xl p-6 bg-neutral-900 flex flex-col items-center justify-center">
        <span className="text-4xl mb-3" aria-hidden="true">📸</span>
        <h2 className="text-lg font-bold text-neutral-50">Upload Flex Itinerary</h2>
        <p className="text-xs text-neutral-500 mt-1 mb-4">
          Choose one or more screenshots of your stop list — a 55-stop route
          usually needs a few, since one screenshot only shows so much
          before scrolling.
        </p>

        <label className="cursor-pointer bg-amber-500 text-neutral-950 text-sm font-bold py-3 px-6 rounded-xl active:scale-95 transition-all min-h-[48px] flex items-center justify-center">
          {batch.length > 0 ? 'Add More Screenshots' : 'Choose Screenshots'}
          <input
            type="file"
            accept="image/*"
            multiple
            onChange={handleFilesSelected}
            disabled={fallbackMode === 'scanning'}
            className="hidden"
          />
        </label>
        <button
          type="button"
          onClick={() => handleManualEntry(null)}
          disabled={fallbackMode === 'scanning'}
          className="mt-3 text-sm text-neutral-300 underline min-h-[44px]"
        >
          Or type stops in manually
        </button>
        <p className="text-[11px] text-neutral-600 mt-2">
          Select several at once from your photo library, or add more one batch at a time.
        </p>
        <p className="text-[10px] text-neutral-700 mt-1">Build {typeof __BUILD_ID__ === 'string' ? __BUILD_ID__ : 'dev'}</p>

        {fallbackMode === 'scanning' && (
          <p className="mt-3 text-xs text-amber-500 font-semibold">Scanning text locally, this can take a moment…</p>
        )}

        {error && (
          <p role="alert" className="mt-3 text-xs text-red-500 font-semibold">{error}</p>
        )}

        {batch.length > 0 && (
          <div className="w-full mt-4 text-left">
            <div className="flex justify-between items-center mb-2">
              <p className="text-xs font-bold text-neutral-300">
                {successCount} of {batch.length} screenshot{batch.length === 1 ? '' : 's'} processed
                {pendingCount > 0 ? ` (${pendingCount} in progress…)` : ''}
              </p>
              <button onClick={handleStartOver} className="text-xs text-neutral-600 underline">
                Start over
              </button>
            </div>

            <div className="space-y-1.5 max-h-56 overflow-y-auto">
              {batch.map((item) => (
                <div key={item.id} className="bg-neutral-950 rounded-lg border border-neutral-800 px-3 py-2 text-xs">
                  <div className="flex justify-between items-center">
                    <span className="truncate flex-1 text-neutral-300">{item.file?.name || 'Manually entered'}</span>
                    {item.status === 'success' && (
                      <span className="text-emerald-600 font-semibold ml-2 whitespace-nowrap">
                        ✓ {item.stops.length} stops{item.note ? ` · ${item.note}` : ''}
                      </span>
                    )}
                    {item.status === 'error' && (
                      <span className="text-red-500 font-semibold ml-2 whitespace-nowrap">✗ Failed</span>
                    )}
                    {(item.status === 'pending' || item.status === 'processing') && (
                      <span className="text-neutral-500 ml-2 whitespace-nowrap">
                        ⏳ {item.status === 'processing' ? (item.stage || 'Starting...') : 'Queued'}
                      </span>
                    )}
                  </div>

                  {item.status === 'error' && (
                    <>
                      {/* Bug fix: this error text used to live only in a
                          `title` attribute — a hover tooltip that does
                          nothing on a touchscreen, the one device type
                          this app actually runs on. A driver had no way
                          to see *why* a screenshot failed. */}
                      {item.error && (
                        <p role="alert" className="text-red-400 mt-1 mb-1.5">{item.error}</p>
                      )}
                      <div className="flex items-center gap-2">
                        <button
                          onClick={() => handleManualEntry(item)}
                          className="text-neutral-500 underline text-[11px]"
                        >
                          Manual
                        </button>
                        <button onClick={() => handleRemoveItem(item.id)} className="text-neutral-600 text-[11px]">
                          Remove
                        </button>
                      </div>
                    </>
                  )}
                </div>
              ))}
            </div>

            {!batchRunning && (
              <div className="mt-3 space-y-2">
                {errorCount > 0 && (
                  <button
                    onClick={handleRetryFailed}
                    className="w-full text-xs bg-neutral-800 text-neutral-200 font-semibold py-2.5 rounded-lg min-h-[40px]"
                  >
                    Retry {errorCount} failed screenshot{errorCount === 1 ? '' : 's'}
                  </button>
                )}
                {successCount > 0 && blankCount > 0 && (
                  <p className="text-xs text-amber-300 bg-amber-950 border border-amber-800 rounded-lg p-2.5">
                    ✏️ {blankCount} stop{blankCount === 1 ? ' has' : 's have'} no readable number. They are listed first on the next screen so you can type the number from your Flex app.
                  </p>
                )}
                {successCount > 0 && missingNumbers.length > 0 && (
                  <p className="text-xs text-neutral-300 bg-neutral-900 border border-neutral-700 rounded-lg p-2.5">
                    Numbers not in these screenshots: {missingNumbers.join(', ')}. Amazon skips numbers sometimes; if a screenshot is missing, add it above.
                    {duplicateCount > 0 ? ` ${duplicateCount} repeated stop${duplicateCount === 1 ? '' : 's'} will be merged.` : ''}
                  </p>
                )}
                {successCount > 0 && (
                  <button
                    onClick={handleContinue}
                    className="w-full bg-emerald-600 text-white font-bold py-3 rounded-xl min-h-[48px]"
                  >
                    Continue with {totalMergedStops} stop{totalMergedStops === 1 ? '' : 's'}
                  </button>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
