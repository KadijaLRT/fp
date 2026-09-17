/**
 * When Groq's vision OCR fails, the fallback is client-side Tesseract.js —
 * but Tesseract returns raw unstructured text, not the clean JSON schema
 * Groq's vision model produces. This module makes a best-effort attempt to
 * extract stop-shaped data from that raw text using pattern matching, but
 * it is explicitly NOT trusted the way the Groq path is: every stop this
 * produces is presented to the driver for review/edit before it's used
 * (see ManualStopReview.jsx), never silently accepted the way OCR normally
 * is. This is deliberately conservative — a wrong package count is
 * annoying; a wrong address the driver doesn't get a chance to check
 * before navigating is a real problem.
 */

// A very loose "looks like a US street address" pattern: a number, then
// words, optionally followed by a city/state/zip fragment. This will miss
// many real addresses and false-positive on some non-addresses — it exists
// to give the driver a head start on manual entry, not to be authoritative.
const ADDRESS_LINE_PATTERN = /\d{1,6}\s+[A-Za-z0-9.,'\s-]{4,60}(?:\b[A-Z]{2}\b\s*\d{5})?/;

const PACKAGE_COUNT_PATTERN = /(\d+)\s*(?:pkg|pkgs|package|packages|item|items)\b/i;

const TIME_WINDOW_PATTERN = /(\d{1,2}:\d{2}\s*[AP]M\s*[-–to]+\s*\d{1,2}:\d{2}\s*[AP]M|\bby\s+\d{1,2}:\d{2}\s*[AP]M)/i;

/**
 * Splits raw OCR text into candidate stop blocks and extracts whatever
 * fields it can find. Always returns at least one (possibly mostly-empty)
 * stop rather than an empty array, so the review screen always has
 * something to start from instead of leaving the driver with nothing.
 */
export function parseRawOcrText(rawText) {
  if (!rawText || typeof rawText !== 'string') {
    return [emptyStop(1)];
  }

  const lines = rawText
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

  // Bug fix: this used to filter `lines` into `candidateLines` (losing
  // each line's original position), then re-find each one's index via
  // `lines.indexOf(line)` — which returns the *first* match of that exact
  // text. Two stops with identical address-line text (plausible for
  // duplicate deliveries to the same apartment complex) would then both
  // resolve to the same source position, and the second one's package
  // count / delivery window would be silently pulled from the first
  // stop's block of text instead of its own. Filtering {line, index}
  // pairs up front keeps each candidate's real position, even when the
  // text collides with another line elsewhere in the screenshot.
  const candidateEntries = lines
    .map((line, index) => ({ line, index }))
    .filter(({ line }) => {
      if (!ADDRESS_LINE_PATTERN.test(line)) return false;

      // Reject lines that are basically just "N packages" or "N item(s)" —
      // these match the address pattern (a leading number) but aren't
      // addresses. A real street address has more going on than two words.
      const wordCount = line.split(/\s+/).filter(Boolean).length;
      if (wordCount < 3) return false;

      // Reject lines that are essentially just a time window with little
      // else — stripping the matched time text should still leave a
      // meaningful amount of content behind for this to be an address line.
      const strippedOfTime = line.replace(TIME_WINDOW_PATTERN, '').trim();
      if (strippedOfTime.length < 6) return false;

      return true;
    });

  if (candidateEntries.length === 0) {
    return [emptyStop(1)];
  }

  // Flex screenshots typically put package count and delivery window on
  // separate lines below the address, not inline — so search a small
  // window of following lines (up to the next address line) rather than
  // only the address line itself, which would miss them entirely.
  return candidateEntries.map(({ line, index: startIdx }, idx) => {
    const endIdx =
      idx + 1 < candidateEntries.length ? candidateEntries[idx + 1].index : Math.min(lines.length, startIdx + 5);
    const blockLines = lines.slice(startIdx, endIdx);
    const blockText = blockLines.join(' ');

    const addressMatch = line.match(ADDRESS_LINE_PATTERN);
    const packageMatch = blockText.match(PACKAGE_COUNT_PATTERN);
    const windowMatch = blockText.match(TIME_WINDOW_PATTERN);

    return {
      stopNumber: idx + 1,
      address: addressMatch ? addressMatch[0].trim() : '',
      packageCount: packageMatch ? Math.max(1, parseInt(packageMatch[1], 10)) : 1,
      deliveryWindow: windowMatch ? windowMatch[0].trim() : null,
      notes: null,
      // Flags this as a low-confidence, heuristically-extracted stop so
      // the UI can visually distinguish it from a normal Groq OCR result.
      needsManualReview: true
    };
  });
}

export function emptyStop(stopNumber) {
  return {
    stopNumber,
    address: '',
    packageCount: 1,
    deliveryWindow: null,
    notes: null,
    needsManualReview: true
  };
}
