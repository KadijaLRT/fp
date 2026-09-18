import React, { useState, useRef } from 'react';
import ManualStopReview from './ManualStopReview';
import { parseRawOcrText, emptyStop } from '../utils/ocrTextParser';

const MAX_FILE_BYTES = 8 * 1024 * 1024; // 8MB
const ACCEPTED_TYPES = ['image/png', 'image/jpeg', 'image/jpg', 'image/webp', 'image/heic', 'image/heif'];
const UPLOAD_TIMEOUT_MS = 30000;
// A single Flex itinerary screenshot typically shows ~15-20 stops before
// scrolling, so a 55-stop route realistically needs 3-4 images. Processing
// them with limited concurrency (not all at once) keeps this comfortably
// under /api/ocr's rate limit even for a larger batch, and keeps the
// progress UI readable rather than a wall of simultaneous spinners.
const OCR_CONCURRENCY = 3;

function withTimeout(promise, ms) {
  let timeoutId;
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error('Upload timed out. Check your connection and try again.')), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timeoutId));
}

function convertToBase64(file) {
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

/**
 * Runs Groq OCR on a single image file. Never throws — always resolves to
 * { stops, error } so a batch of these can't be taken down by one bad
 * image, mirroring the geocodeAddressBatch/upsertLocationBatch pattern
 * used elsewhere in the app.
 */
async function ocrSingleFile(file) {
  try {
    const base64Image = await convertToBase64(file);
    const response = await withTimeout(
      fetch('/api/ocr', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ imageBase64: base64Image })
      }),
      UPLOAD_TIMEOUT_MS
    );

    let result;
    try {
      result = await response.json();
    } catch {
      throw new Error('Server sent back an unreadable response.');
    }

    if (!response.ok || !result.success) {
      throw new Error(result?.error || 'Failed to parse screenshot.');
    }
    if (!Array.isArray(result.data?.stops) || result.data.stops.length === 0) {
      throw new Error('No stops were detected in this screenshot.');
    }

    return { stops: result.data.stops, error: null };
  } catch (err) {
    return { stops: null, error: err.message || 'Something went wrong processing this screenshot.' };
  }
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
  const [batchRunning, setBatchRunning] = useState(false);

  const updateBatchItem = (id, patch) => {
    setBatch((prev) => prev.map((item) => (item.id === id ? { ...item, ...patch } : item)));
  };

  const runBatch = async (items) => {
    setBatchRunning(true);
    let cursor = 0;

    async function worker() {
      while (cursor < items.length) {
        const item = items[cursor++];
        updateBatchItem(item.id, { status: 'processing' });
        const { stops, error: ocrError } = await ocrSingleFile(item.file);
        if (stops) {
          updateBatchItem(item.id, { status: 'success', stops, error: null });
        } else {
          updateBatchItem(item.id, { status: 'error', stops: null, error: ocrError });
        }
      }
    }

    const workers = Array.from({ length: Math.min(OCR_CONCURRENCY, items.length) }, worker);
    await Promise.all(workers);
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

  // Merges every successfully-OCR'd screenshot's stops into one itinerary,
  // in the order the files were selected — the closest available signal
  // to the driver's actual stop order, since each image's OCR restarts
  // its own stopNumber at 1 and has no idea it's part of a larger set.
  // Renumbered sequentially here rather than trusting any individual
  // image's stopNumber. This is a best-effort merge, not a guarantee: if
  // two screenshots overlap (the same stops appear in both because the
  // driver's scroll positions overlapped), those stops will appear twice
  // in the merged list — worth a quick glance at the total count against
  // what the Flex app shows before starting the route.
  const handleContinue = () => {
    const successfulItems = batch.filter((item) => item.status === 'success');
    const mergedStops = successfulItems
      .flatMap((item) => item.stops)
      .map((stop, idx) => ({ ...stop, stopNumber: idx + 1 }));

    if (mergedStops.length === 0) {
      setError('No stops to import yet — process at least one screenshot successfully first.');
      return;
    }

    onRouteImported(mergedStops);
  };

  // Fallback path 1: when a screenshot's primary Groq vision OCR fails,
  // run a client-side Tesseract.js pass on that same image instead of
  // losing it from the batch entirely. Tesseract's raw text output is
  // heuristically parsed into candidate stops, then shown for mandatory
  // review/edit — this path is never trusted the way Groq's structured
  // JSON output is.
  const handleTryTextScan = async (failedItem) => {
    lastFailedFileRef.current = failedItem;
    setFallbackMode('scanning');
    setError(null);

    try {
      // Dynamically imported: Tesseract.js (and its wasm/worker assets) is
      // large, and most sessions never need it since the primary Groq OCR
      // path usually succeeds — no reason to pay that bundle cost upfront.
      //
      // Bug fix: `await import('tesseract.js')` returns the ES module
      // namespace object, not the package's default export — Tesseract.js
      // ships as CJS with `recognize`/`createWorker`/etc. attached to
      // `module.exports`, which lands on `.default` here, not on the
      // namespace object directly. The previous code called
      // `Tesseract.recognize(...)` on the namespace object, which is
      // `undefined` there — every text-scan attempt threw a TypeError
      // immediately and was silently swallowed by the catch block below,
      // always reporting "text scan also failed" regardless of the image.
      const { default: Tesseract } = await import('tesseract.js');
      const { data } = await Tesseract.recognize(failedItem.file, 'eng');
      const parsedStops = parseRawOcrText(data?.text);
      setReviewStops(parsedStops);
      setFallbackMode('review');
    } catch (err) {
      console.error('Client-side text scan failed:', err);
      setError('Text scan also failed for that screenshot. You can enter its stops manually, or remove it from the batch and continue with the rest.');
      setFallbackMode('idle');
    }
  };

  // Fallback path 2: skip scanning entirely and let the driver type a
  // failed screenshot's stops in by hand.
  const handleManualEntry = (failedItem) => {
    lastFailedFileRef.current = failedItem || null;
    setReviewStops([emptyStop(1)]);
    setFallbackMode('review');
    setError(null);
  };

  // Confirming the review screen replaces the failed batch item's entry
  // with the manually-recovered stops, so it merges into the batch like
  // any other successful screenshot instead of requiring a separate flow.
  const handleReviewConfirm = (confirmedStops) => {
    const failedItem = lastFailedFileRef.current;
    setFallbackMode('idle');
    setReviewStops(null);
    lastFailedFileRef.current = null;

    if (failedItem?.id) {
      updateBatchItem(failedItem.id, { status: 'success', stops: confirmedStops, error: null });
    } else {
      // Manual entry with nothing to recover into (batch empty / no
      // specific failed item) — treat it as its own one-off item so it
      // still flows through the same "Continue" merge step.
      setBatch((prev) => [
        ...prev,
        { id: nextBatchItemId++, file: null, status: 'success', stops: confirmedStops, error: null }
      ]);
    }
  };

  const handleReviewCancel = () => {
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
  const totalMergedStops = batch
    .filter((i) => i.status === 'success')
    .reduce((sum, i) => sum + (i.stops?.length || 0), 0);

  return (
    <div className="p-4 max-w-md mx-auto text-center">
      <div className="border-2 border-dashed border-gray-300 rounded-2xl p-6 bg-gray-50 flex flex-col items-center justify-center">
        <span className="text-4xl mb-3" aria-hidden="true">📸</span>
        <h2 className="text-lg font-bold text-gray-800">Upload Flex Itinerary</h2>
        <p className="text-xs text-gray-500 mt-1 mb-4">
          Choose one or more screenshots of your stop list — a 55-stop route
          usually needs a few, since one screenshot only shows so much
          before scrolling.
        </p>

        <label className="cursor-pointer bg-blue-600 text-white text-sm font-semibold py-3 px-6 rounded-xl shadow-md active:scale-95 transition-all min-h-[48px] flex items-center justify-center">
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
        <p className="text-[11px] text-gray-400 mt-2">
          Select several at once from your photo library, or add more one batch at a time.
        </p>

        {fallbackMode === 'scanning' && (
          <p className="mt-3 text-xs text-blue-600 font-semibold">Scanning text locally, this can take a moment…</p>
        )}

        {error && (
          <p role="alert" className="mt-3 text-xs text-red-500 font-semibold">{error}</p>
        )}

        {batch.length > 0 && (
          <div className="w-full mt-4 text-left">
            <div className="flex justify-between items-center mb-2">
              <p className="text-xs font-bold text-gray-600">
                {successCount} of {batch.length} screenshot{batch.length === 1 ? '' : 's'} processed
                {pendingCount > 0 ? ` (${pendingCount} in progress…)` : ''}
              </p>
              <button onClick={handleStartOver} className="text-xs text-gray-400 underline">
                Start over
              </button>
            </div>

            <div className="space-y-1.5 max-h-56 overflow-y-auto">
              {batch.map((item) => (
                <div key={item.id} className="bg-white rounded-lg border border-gray-200 px-3 py-2 text-xs">
                  <div className="flex justify-between items-center">
                    <span className="truncate flex-1 text-gray-600">{item.file?.name || 'Manually entered'}</span>
                    {item.status === 'success' && (
                      <span className="text-emerald-600 font-semibold ml-2 whitespace-nowrap">
                        ✓ {item.stops.length} stops
                      </span>
                    )}
                    {item.status === 'error' && (
                      <span className="text-red-500 font-semibold ml-2 whitespace-nowrap">✗ Failed</span>
                    )}
                    {(item.status === 'pending' || item.status === 'processing') && (
                      <span className="text-slate-400 ml-2 whitespace-nowrap">
                        ⏳ {item.status === 'processing' ? 'Scanning…' : 'Queued'}
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
                          onClick={() => handleTryTextScan(item)}
                          className="text-slate-500 underline text-[11px]"
                        >
                          Text scan
                        </button>
                        <button
                          onClick={() => handleManualEntry(item)}
                          className="text-slate-500 underline text-[11px]"
                        >
                          Manual
                        </button>
                        <button onClick={() => handleRemoveItem(item.id)} className="text-slate-400 text-[11px]">
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
                    className="w-full text-xs bg-slate-700 text-white font-semibold py-2.5 rounded-lg min-h-[40px]"
                  >
                    Retry {errorCount} failed screenshot{errorCount === 1 ? '' : 's'}
                  </button>
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

        {batch.length === 0 && (
          <button
            onClick={() => handleManualEntry(null)}
            className="mt-3 text-xs text-gray-400 underline"
          >
            Enter stops manually instead
          </button>
        )}
      </div>
    </div>
  );
}
