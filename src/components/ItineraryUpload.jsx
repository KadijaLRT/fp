import React, { useState, useRef } from 'react';
import ManualStopReview from './ManualStopReview';
import { parseRawOcrText, emptyStop } from '../utils/ocrTextParser';

const MAX_FILE_BYTES = 8 * 1024 * 1024; // 8MB
const ACCEPTED_TYPES = ['image/png', 'image/jpeg', 'image/jpg', 'image/webp', 'image/heic', 'image/heif'];
const UPLOAD_TIMEOUT_MS = 30000;

function withTimeout(promise, ms) {
  let timeoutId;
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error('Upload timed out. Check your connection and try again.')), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timeoutId));
}

export default function ItineraryUpload({ onRouteImported }) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  // 'idle' | 'scanning' | 'review' — drives the OCR-fallback flow when
  // the primary Groq vision OCR fails.
  const [fallbackMode, setFallbackMode] = useState('idle');
  const [reviewStops, setReviewStops] = useState(null);
  const lastFailedFileRef = useRef(null);

  const handleFileUpload = async (event) => {
    const file = event.target.files?.[0];
    // Reset the input so selecting the same file twice in a row still fires onChange.
    event.target.value = '';
    if (!file) return;

    setError(null);

    if (!ACCEPTED_TYPES.includes(file.type)) {
      setError('Unsupported file type. Please upload a PNG, JPG, WEBP, or HEIC screenshot.');
      return;
    }
    if (file.size > MAX_FILE_BYTES) {
      setError('That image is too large (max 8MB). Try a lower-resolution screenshot.');
      return;
    }
    if (file.size === 0) {
      setError('That file appears to be empty.');
      return;
    }

    setLoading(true);

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
        throw new Error('Server sent back an unreadable response. Please try again.');
      }

      if (!response.ok || !result.success) {
        throw new Error(result?.error || 'Failed to parse screenshot. Try a clearer photo.');
      }
      if (!Array.isArray(result.data?.stops) || result.data.stops.length === 0) {
        throw new Error('No stops were detected in that screenshot.');
      }

      onRouteImported(result.data.stops);
    } catch (err) {
      console.error('Itinerary upload failed:', err);
      setError(err.message || 'Something went wrong processing that screenshot.');
      lastFailedFileRef.current = file;
    } finally {
      setLoading(false);
    }
  };

  const convertToBase64 = (file) => {
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
  };

  // Fallback path 1: when the primary Groq vision OCR fails, run a
  // client-side Tesseract.js pass on the same image instead of dead-ending
  // the driver. Tesseract's raw text output is heuristically parsed (see
  // ocrTextParser.js) into candidate stops, which are then shown for
  // mandatory review/edit — this path is never trusted the way the Groq
  // JSON output is, since Tesseract has no structured-output guarantee.
  const handleTryTextScan = async () => {
    const file = lastFailedFileRef.current;
    if (!file) {
      setError('No image to re-scan — please upload a screenshot first.');
      return;
    }

    setFallbackMode('scanning');
    setError(null);

    try {
      // Dynamically imported: Tesseract.js (and its wasm/worker assets) is
      // large, and most sessions never need it since the primary Groq OCR
      // path usually succeeds — no reason to pay that bundle cost upfront.
      const Tesseract = await import('tesseract.js');
      const { data } = await Tesseract.recognize(file, 'eng');
      const parsedStops = parseRawOcrText(data?.text);
      setReviewStops(parsedStops);
      setFallbackMode('review');
    } catch (err) {
      console.error('Client-side text scan failed:', err);
      setError('Text scan also failed. You can enter stops manually instead.');
      setFallbackMode('idle');
    }
  };

  // Fallback path 2: skip scanning entirely and let the driver type stops
  // in by hand — the checklist's "structured manual form insertion"
  // option, and the only path guaranteed to work regardless of image
  // quality or OCR availability.
  const handleManualEntry = () => {
    setReviewStops([emptyStop(1)]);
    setFallbackMode('review');
    setError(null);
  };

  const handleReviewConfirm = (confirmedStops) => {
    setFallbackMode('idle');
    setReviewStops(null);
    onRouteImported(confirmedStops);
  };

  const handleReviewCancel = () => {
    setFallbackMode('idle');
    setReviewStops(null);
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

  return (
    <div className="p-4 max-w-md mx-auto text-center">
      <div className="border-2 border-dashed border-gray-300 rounded-2xl p-6 bg-gray-50 flex flex-col items-center justify-center">
        <span className="text-4xl mb-3" aria-hidden="true">📸</span>
        <h2 className="text-lg font-bold text-gray-800">Upload Flex Itinerary</h2>
        <p className="text-xs text-gray-500 mt-1 mb-4">
          Choose the screenshot of your stop list from your photos.
        </p>

        <label className="cursor-pointer bg-blue-600 text-white text-sm font-semibold py-3 px-6 rounded-xl shadow-md active:scale-95 transition-all min-h-[48px] flex items-center justify-center">
          {loading ? 'Processing OCR…' : 'Choose Screenshot'}
          <input
            type="file"
            accept="image/png,image/jpeg,image/webp,image/heic,image/heif"
            onChange={handleFileUpload}
            disabled={loading || fallbackMode === 'scanning'}
            className="hidden"
          />
        </label>
        <p className="text-[11px] text-gray-400 mt-2">
          Opens your photo library — most Flex itineraries are screenshots you already have saved, not something to photograph live.
        </p>

        {fallbackMode === 'scanning' && (
          <p className="mt-3 text-xs text-blue-600 font-semibold">Scanning text locally, this can take a moment…</p>
        )}

        {error && (
          <div className="mt-3">
            <p role="alert" className="text-xs text-red-500 font-semibold">{error}</p>
            <div className="flex gap-2 mt-2 justify-center">
              {lastFailedFileRef.current && (
                <button
                  onClick={handleTryTextScan}
                  disabled={fallbackMode === 'scanning'}
                  className="text-xs bg-slate-700 text-white font-semibold px-3 py-2 rounded-lg min-h-[36px]"
                >
                  Try text scan instead
                </button>
              )}
              <button
                onClick={handleManualEntry}
                className="text-xs bg-gray-200 text-gray-700 font-semibold px-3 py-2 rounded-lg min-h-[36px]"
              >
                Enter stops manually
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

