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
//
// Bug fix: the previous pattern capped the body at {4,60} characters and
// excluded common real-address characters (#, /), which meant any address
// longer than 60 characters — routine once a city/state/zip is appended,
// e.g. "123 Some Longer Street Name Apt #4B, Springfield, MA 01101" — got
// hard-truncated mid-word by the regex engine hitting its ceiling, not by
// anything actually ending the address. A driver reported this directly:
// addresses were "cut up to the point it becomes incoherent to read."
// Raised the cap to 120 (generous — real US address lines essentially
// never exceed this) and widened the character class to include # and /
// so unit numbers and cross-streets don't prematurely break the match.
const ADDRESS_LINE_PATTERN = /\d{1,6}\s+[A-Za-z0-9.,'#/\s-]{4,120}(?:\b[A-Z]{2}\b\s*\d{5})?/;

const PACKAGE_COUNT_PATTERN = /(\d+)\s*(?:pkg|pkgs|package|packages|item|items)\b/i;

// Flex prints ranges like "3:00 - 8:00 AM" with the meridiem only on the
// END time, as well as "10:00 AM - 12:00 PM" and "by 5:00 PM".
const TIME_WINDOW_PATTERN = /(\d{1,2}:\d{2}\s*(?:[AP]M)?\s*[-–]\s*\d{1,2}:\d{2}\s*[AP]M|\bby\s+\d{1,2}:\d{2}\s*[AP]M)/i;

// Real Flex screenshots frequently pack the address, package count, and
// delivery window onto ONE line (e.g. "45 Elm Street Apt 3 • 1 package •
// by 5:00 PM"), separated by bullets, dashes, or commas — not just on
// separate lines the way the original block-scanning logic assumed. Since
// ADDRESS_LINE_PATTERN's character class allows digits and punctuation
// (needed for unit numbers, zip codes, and cross-streets), it had no way
// to tell "this is still the address" from "this is package/window
// metadata that happens to follow the address on the same line" — so it
// either swallowed the metadata straight into the address text, or (if a
// separator character like • wasn't in its allowed set) got cut off right
// at that character. A driver reported real addresses coming out
// "incoherent," and testing directly against realistic same-line examples
// confirmed both failure modes.
//
// Fixed by finding and removing package-count and time-window matches
// FIRST, then running the address pattern only against what's left, so
// address extraction never has to guess where metadata starts — there's
// simply no metadata text left in the line for it to consume.
function stripKnownMetadata(text) {
  return text.replace(PACKAGE_COUNT_PATTERN, ' ').replace(TIME_WINDOW_PATTERN, ' ');
}

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

      // Flex rows also contain "# SA12 • Scheduled 3:00 - 8:00 AM Today" and
      // "Deliver 1 package" lines; both contain digits followed by words, so
      // they must be excluded explicitly or they masquerade as addresses.
      if (/scheduled|^#|^deliver\b|next stop/i.test(line)) return false;

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

  // Flex screenshots put package count and delivery window either inline
  // on the address line itself (e.g. "45 Elm St • 1 package • by 5:00 PM")
  // or on separate lines below it — so package count / delivery window
  // are searched across a small window of following lines (up to the next
  // address line) covering both layouts, rather than assuming one or the
  // other.
  return candidateEntries.map(({ line, index: startIdx }, idx) => {
    const endIdx =
      idx + 1 < candidateEntries.length ? candidateEntries[idx + 1].index : Math.min(lines.length, startIdx + 5);
    const blockLines = lines.slice(startIdx, endIdx);
    const blockText = blockLines.join(' ');

    // Extract package count and delivery window from the whole block
    // FIRST, then strip only their matched text out of the address LINE
    // (not the full block — a genuinely separate line further down stays
    // untouched) before running the address pattern. This is what stops
    // "45 Elm Street Apt 3 • 1 package • by 5:00 PM" from having the
    // package count and time text end up inside the extracted address:
    // the address pattern never sees them because they're already gone.
    // Real Flex rows put the "Scheduled 3:00 - 8:00 AM Today" line ABOVE
    // the address, and the city line plus "Deliver N package(s)" BELOW it,
    // so the window is also searched in the two lines before the address.
    const packageMatch = blockText.match(PACKAGE_COUNT_PATTERN);
    const precedingText = lines.slice(Math.max(0, startIdx - 2), startIdx).join(' ');
    const windowMatch = blockText.match(TIME_WINDOW_PATTERN) || precedingText.match(TIME_WINDOW_PATTERN);

    // City line directly under the street line (letters only, e.g.
    // "EAST HARTFORD"); appended so the geocoder gets a real locality.
    const nextLine = lines[startIdx + 1] || '';
    const cityLine =
      /^[A-Za-z][A-Za-z .'-]{2,39}$/.test(nextLine) && !/deliver|package|scheduled|today|next stop/i.test(nextLine)
        ? nextLine
        : null;

    // Amazon's stop number is printed in the map pin, which OCR usually
    // reads as a short standalone number line just above the schedule line.
    let amazonNumber = null;
    for (let k = startIdx - 1; k >= Math.max(0, startIdx - 3); k--) {
      if (/^\d{1,3}$/.test(lines[k])) {
        amazonNumber = parseInt(lines[k], 10);
        break;
      }
    }

    const addressLineWithoutMetadata = stripKnownMetadata(line)
      // Metadata is often separated from the address by a bullet, pipe,
      // comma, or dash (e.g. "45 Elm St • 1 package", "78 Oak Ave, 3
      // items, 2:00 PM - 4:00 PM"). Once that metadata text is stripped
      // out, one or more of those separators — possibly several in a row,
      // each with its own surrounding whitespace, if multiple metadata
      // fields were chained on the same line — would otherwise be left
      // dangling at the end (or start) of the address as noise. Repeatedly
      // strips any trailing/leading run of "separator-plus-whitespace"
      // rather than just one, so a line with two chained metadata fields
      // (package count AND time window) doesn't leave a stray leftover
      // comma or bullet behind after only removing one layer.
      .replace(/(?:\s*[•|,\-–]\s*)+$/, '')
      .replace(/^(?:\s*[•|,\-–]\s*)+/, '')
      .trim();

    const addressMatch = addressLineWithoutMetadata.match(ADDRESS_LINE_PATTERN);

    const streetPart = addressMatch ? addressMatch[0].trim() : addressLineWithoutMetadata;

    return {
      stopNumber: amazonNumber ?? idx + 1,
      address: cityLine ? `${streetPart}, ${cityLine}` : streetPart,
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
