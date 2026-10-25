import { normalizeDeliveryWindow } from './deliveryWindow.js';

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
 * Header-based layouts (all current Flex itinerary variants):
 *   "38) © Expected by 8:00 AM 1"            then "# A.L01.OV", street, city
 *   "(26) © # E-29.1C • Scheduled 5:00 - 10:00 PM", street, [unit], city
 *   "2" alone, then "# G-1.3A • Deliver by 5:00 PM", street, city, "Deliver 1 package"
 * A row starts at a header line (has a time or Scheduled/Expected). Each row's
 * stop number is the EXACT number read for it (header text, a number line above
 * it, or the separate number-box read passed in as headerNumbers). Numbers are
 * never guessed: an unreadable number stays null for the driver to fill in. The
 * only inference is a gap that is fully determined by two certain neighbours
 * (e.g. 30, ?, 32 -> 31), because Amazon numbers can skip but never repeat.
 */
const TIME_LOOSE = /\b\d{1,2}:?\d{2}\s*[AP]M\b/i;

export function isHeaderLine(line) {
  const l = String(line || '').trim();
  if (!l) return false;
  if (/deliver\s+\d+\s+packages?/i.test(l)) return false;
  return TIME_LOOSE.test(l) || /\b(?:scheduled|expected|fxnected)\b/i.test(l);
}

const IGNORE_LINE = /mailroom|redirects delivery|if needed|navy blue|after you.?re assigned|your itinerary|^(?:am|pm)?\s*today$|^next stop/i;
const UNIT_START = /^(?:apt|apartment|unit|ste|suite|fl|floor|rm|room|bldg|building|#|\d)/i;

function normTime(h, m, ap) {
  const hh = parseInt(h, 10);
  const mm = parseInt(m, 10);
  if (!(hh >= 1 && hh <= 12) || !(mm >= 0 && mm <= 59)) return null;
  return { text: `${hh}:${String(mm).padStart(2, '0')}`, ap: ap ? ap.toUpperCase() : null, hh, mm };
}

function parseWindow(headerLine) {
  const kw = headerLine.search(/\b(?:scheduled|deliver|expected|fxnected)\b/i);
  const tail = kw >= 0 ? headerLine.slice(kw) : headerLine.slice(Math.max(0, headerLine.lastIndexOf('#')));
  const times = [];
  const re = /\b(\d{1,2}):?(\d{2})\s*([AP]M)?\b/gi;
  let m;
  while ((m = re.exec(tail)) !== null) {
    const t = normTime(m[1], m[2], m[3]);
    if (t) times.push(t);
  }
  if (times.length === 0) return null;
  const by = /\bb[yv]\b/i.test(tail);
  if (times.length === 1) {
    const t = times[0];
    if (!t.ap) return null; // garbled read, better blank than wrong
    return `${by ? 'by ' : ''}${t.text} ${t.ap}`;
  }
  const [t1, t2] = times;
  if (t1.text === '12:00' && t1.ap === 'AM' && t2.text === '11:59' && t2.ap === 'PM') return null;
  const first = t1.ap ? `${t1.text} ${t1.ap}` : t1.text;
  return `${first} - ${t2.text}${t2.ap ? ` ${t2.ap}` : ''}`;
}

function parseHeaderLayout(lines, headerNumbers, opts = {}) {
  const headers = [];
  lines.forEach((line, i) => {
    if (isHeaderLine(line)) headers.push({ i, line });
  });
  if (headers.length === 0) return null;

  const rows = [];
  headers.forEach((h, k) => {
    // Number candidates: leading token on the header line (or a number alone on
    // the line above) and the separate number-box read. Resolved below.
    let tokenNum = null;
    const m = h.line.match(/^\W{0,2}([A-Za-z0-9]{1,3})\s*[\)\]]?(?![:\d])/);
    if (m && /^\d{1,3}$/.test(m[1])) tokenNum = parseInt(m[1], 10);
    const prev = lines[h.i - 1];
    if (tokenNum === null && prev && /^\d{1,3}$/.test(prev.trim())) tokenNum = parseInt(prev.trim(), 10);
    let boxNum = Array.isArray(headerNumbers) ? headerNumbers[k] : null;
    if (!Number.isInteger(boxNum) || boxNum < 1) boxNum = null;
    if (tokenNum !== null && tokenNum < 1) tokenNum = null;

    const end = k + 1 < headers.length ? headers[k + 1].i : lines.length;
    // The number line above the NEXT header belongs to that header, not this block.
    const nextHeaderHasNumLineAbove = k + 1 < headers.length && /^\d{1,3}$/.test((lines[end - 1] || '').trim());
    const block = lines
      .slice(h.i + 1, nextHeaderHasNumLineAbove ? end - 1 : end)
      .filter((l) => !/^#/.test(l) && (/^\d+[A-Za-z]?\s+\S+/.test(l) || !IGNORE_LINE.test(l)));
    const streetIdx = block.findIndex((l) => /^\d+[A-Za-z]?\s+\S+/.test(l));
    if (streetIdx === -1) return; // cut off at the screen edge
    const cityIdx = block.findIndex((l, j) => j > streetIdx && /^[A-Z][A-Z .'\-]{2,}$/.test(l));
    const between = cityIdx === -1 ? [] : block.slice(streetIdx + 1, cityIdx);
    let street = block[streetIdx].replace(/\s+/g, ' ').trim();
    const noteParts = [];
    between.forEach((l) => {
      if (UNIT_START.test(l)) street = `${street} ${l.replace(/\s+/g, ' ').trim()}`;
      else noteParts.push(l.trim());
    });
    const city = cityIdx === -1 ? null : block[cityIdx].replace(/\s+/g, ' ').trim();
    const after = cityIdx === -1 ? [] : block.slice(cityIdx + 1);

    let count = 1;
    const pkgLine = after.find((l) => /deliver\s+(\d+)\s+packages?/i.test(l)) || lines.slice(h.i + 1, end).find((l) => /deliver\s+(\d+)\s+packages?/i.test(l));
    if (pkgLine) count = Math.max(1, parseInt(pkgLine.match(/deliver\s+(\d+)\s+packages?/i)[1], 10));
    else {
      const t = h.line.match(/[AP]M\W*\s(\d)\S?\s*$/i);
      if (t) count = Math.max(1, parseInt(t[1], 10));
    }
    const tag = after.find((l) => /^(locker|business|signature|leave at door|hand to customer)\b/i.test(l));
    if (tag) noteParts.push(tag.trim());

    rows.push({
      pos: k,
      tokenNum,
      boxNum,
      num: null,
      street,
      city,
      count,
      window: parseWindow(h.line),
      notes: noteParts.length ? noteParts.join('; ') : null
    });
  });
  if (rows.length === 0) return null;

  // Leading row: a block of address lines with no header above it (its header is
  // clipped off the top edge). It gets its number only from the number box.
  const firstHeader = headers[0].i;
  const lead = lines.slice(0, firstHeader).filter((l) => !/^#/.test(l) && (/^\d+[A-Za-z]?\s+\S+/.test(l) || !IGNORE_LINE.test(l)));
  const lStreet = lead.findIndex((l) => /^\d+[A-Za-z]?\s+\S+/.test(l));
  if (lStreet !== -1) {
    const lCity = lead.findIndex((l, j) => j > lStreet && /^[A-Z][A-Z .'\-]{2,}$/.test(l));
    if (lCity !== -1) {
      let st = lead[lStreet].replace(/\s+/g, ' ').trim();
      const notes = [];
      lead.slice(lStreet + 1, lCity).forEach((l) => {
        if (UNIT_START.test(l)) st = `${st} ${l.replace(/\s+/g, ' ').trim()}`;
        else notes.push(l.trim());
      });
      const ln = Number.isInteger(opts.leadingNumber) && opts.leadingNumber > 0 ? opts.leadingNumber : null;
      rows.forEach((r) => {
        r.pos += 1;
      });
      rows.unshift({ pos: 0, tokenNum: null, boxNum: ln, num: null, street: st, city: lead[lCity].replace(/\s+/g, ' ').trim(), count: 1, window: null, notes: notes.length ? notes.join('; ') : null });
    }
  }

  // Resolve each row's number. Every read (header text, number box) is a candidate.
  // Numbers on one screenshot rise by at least one per row (gaps allowed; repeats and
  // backwards steps are not), so pick the set of candidates that keeps the most rows in
  // that order; on a tie prefer the smaller jumps. Rows left out stay blank.
  const nodes = [];
  rows.forEach((r, i) => {
    [...new Set([r.tokenNum, r.boxNum].filter((v) => v !== null))].forEach((v) => {
      nodes.push({ row: i, pos: r.pos, num: v, key: v - r.pos });
    });
  });
  const dp = nodes.map(() => ({ len: 1, cost: 0, prev: -1 }));
  for (let x = 0; x < nodes.length; x++) {
    for (let y = 0; y < x; y++) {
      const A = nodes[y];
      const B = nodes[x];
      if (A.row >= B.row || A.num >= B.num || A.key > B.key) continue;
      const len = dp[y].len + 1;
      const cost = dp[y].cost + (B.key - A.key);
      if (len > dp[x].len || (len === dp[x].len && cost < dp[x].cost)) dp[x] = { len, cost, prev: y };
    }
  }
  if (nodes.length) {
    let end = 0;
    dp.forEach((d, x) => {
      if (d.len > dp[end].len || (d.len === dp[end].len && d.cost < dp[end].cost)) end = x;
    });
    for (let x = end; x !== -1; x = dp[x].prev) rows[nodes[x].row].num = nodes[x].num;
  }

  // Fill a gap only when two certain neighbours fully determine it.
  const known = rows.filter((r) => r.num !== null);
  for (let a = 0; a < known.length - 1; a++) {
    const lo = known[a];
    const hi = known[a + 1];
    const between = rows.filter((r) => r.pos > lo.pos && r.pos < hi.pos);
    if (between.length > 0 && hi.num - lo.num === hi.pos - lo.pos && between.every((r) => r.num === null)) {
      between.forEach((r) => {
        r.num = lo.num + (r.pos - lo.pos);
      });
    }
  }

  return rows.map((r) => ({
    stopNumber: r.num,
    numberFromPin: r.num !== null,
    cityFound: Boolean(r.city),
    address: r.city ? `${r.street}, ${r.city}` : r.street,
    packageCount: r.count,
    deliveryWindow: r.window,
    notes: r.notes,
    needsManualReview: true
  }));
}

/**
 * Splits raw OCR text into candidate stop blocks and extracts whatever
 * fields it can find. Always returns at least one (possibly mostly-empty)
 * stop rather than an empty array, so the review screen always has
 * something to start from instead of leaving the driver with nothing.
 */
export function parseRawOcrText(rawText, opts = {}) {
  if (!rawText || typeof rawText !== 'string') {
    return [emptyStop(2)];
  }

  const lines = rawText
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    // Tesseract often reads the map-pin number and the "# code • window" line as
    // ONE line ("2 # G-1.3A Deliver by 5:00 PM"); split them apart so the pin
    // number is recognised and the header never looks like an address.
    .flatMap((l) => {
      const m = l.match(/^(\d{1,3})\s+(#.*)$/);
      return m ? [m[1], m[2]] : [l];
    })
    // Flex sometimes prints the street line twice in a row; keep one.
    .filter((l, i, arr) => i === 0 || l.toLowerCase() !== arr[i - 1].toLowerCase());

  const headerRows = parseHeaderLayout(lines, opts.headerNumbers, opts);
  if (headerRows) return headerRows;

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
    return [emptyStop(2)];
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
    let blockLines = lines.slice(startIdx, endIdx);
    // The block must stop where the NEXT stop's header begins (its pin
    // number line or its "# code • window" line), or this stop would
    // inherit the next stop's delivery window.
    const cut = blockLines.findIndex((l, i) => i > 0 && (/^\d{1,3}$/.test(l) || /^#/.test(l)));
    if (cut > 0) blockLines = blockLines.slice(0, cut);
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
    const windowMatch = precedingText.match(TIME_WINDOW_PATTERN) || blockText.match(TIME_WINDOW_PATTERN);

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

    // Small gray tag line under the package count (e.g. "Locker").
    const afterPackage = blockLines.find((l) => /^(locker|business|signature|leave at door|hand to customer)\b/i.test(l));
    const tagLine = afterPackage || null;

    const streetPart = addressMatch ? addressMatch[0].trim() : addressLineWithoutMetadata;

    return {
      stopNumber: amazonNumber, // exact read only; null when the pin number was not read
      numberFromPin: amazonNumber !== null,
      cityFound: Boolean(cityLine),
      address: cityLine ? `${streetPart}, ${cityLine}` : streetPart,
      packageCount: packageMatch ? Math.max(1, parseInt(packageMatch[1], 10)) : 1,
      deliveryWindow: windowMatch ? normalizeDeliveryWindow(windowMatch[0]) : null,
      notes: tagLine,
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
