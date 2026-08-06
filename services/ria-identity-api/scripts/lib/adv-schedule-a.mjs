// Schedule A reader — a firm's own filed list of direct owners and executive officers,
// read out of the Form ADV Part 1 PDF the SEC publishes for that firm.
//
// WHY THIS EXISTS. `adv_officer` in claim.mjs is the only AUTHORITY signal in the whole
// evidence model — the only one that answers "may this person act for this entity". It has
// never once fired in production, because it reads `firm.scheduleAPersons` and the Cloud SQL
// firms table does not carry Schedule A at all (sql-store.mjs is explicit: the field is
// ABSENT, not empty). Firm claims therefore rest entirely on domain_email plus roster
// membership. This module supplies the missing input from the firm's own filing.
//
// EVERYTHING BELOW WAS MEASURED against live filings on 2026-08-06, not inferred from a spec.
// Six behaviours of these PDFs are surprising enough to be encoded here rather than left to
// a caller — each one silently returns garbage if you do the obvious thing instead:
//
//  1. THE PAGE CONTENT STREAMS ARE CUMULATIVE, NOT PER-PAGE. These reports are produced by
//     ExpertPdf, which lays out the whole document once and then emits, for every page, a
//     content stream containing EVERYTHING UP TO THAT PAGE, clipped to the visible window.
//     Measured on a 21-page filing: page 1 decoded to 3,779 characters, page 21 to 79,130,
//     and every page's text strictly contained the previous page's. Concatenating all 21
//     pages the naive way produced 850,764 characters — the same document about eleven times
//     over, with the Schedule A table appearing four times. mergeStreamTexts() drops any
//     chunk that is contained in another and recovers the true 79,130-character document.
//
//  2. THE SAME PDF CARRIES SCHEDULE B, WHOSE TABLE HEADER STARTS IDENTICALLY. Both begin
//     "FULL LEGAL NAME (Individuals: Last Name, First Name, Middle Name) / DE/FE/I". The only
//     difference is that Schedule B — indirect owners — inserts an "Entity in Which Interest
//     is Owned" column. Matching the first header found on a large filing therefore returns
//     the firm's holding-company chain rather than its officers. isScheduleAHeader() is the
//     discriminator, and it is load-bearing.
//
//  3. THE HEADER'S LINE BREAKS MOVE BETWEEN FILINGS. Three real filings rendered it as
//     "FULL LEGAL NAME (Individuals: Last\nName, ...", "FULL LEGAL NAME\n(Individuals: Last
//     Name, First\nName, ..." and with the column captions "Title or Status" / "Title or\n
//     Status" / just "Status". So the anchor is a whitespace-insensitive regex, and the end
//     of the header block is found by its LAST cell, which every variant ends with: "ID No.".
//
//  4. THE INDIVIDUAL CRD IS ON EVERY INDIVIDUAL'S ROW. This is the decisive property. It
//     means authority can be matched by CRD exactly — against the roster this service already
//     fetches — and never has to be guessed from a name. Name matching is a fallback.
//
//  5. ENTITY ROWS CARRY NO CRD AT ALL. A "DE" row runs ...date, code, control, PR and then
//     the NEXT ROW'S NAME begins. A parser that assumes a fixed field count eats the next
//     owner's name. Rows are read as a positional stream with the identifier optional.
//
//  6. A TRUNCATED COPY OF THE TABLE CAN SURVIVE THE DEDUPE. On one large filing, an earlier
//     page's chunk diverged slightly from the final one, so it was not a substring of it and
//     both were kept — leaving one complete copy of Schedule A (9 rows) and one copy cut off
//     mid-row (8 rows, the last one missing half its title). Every candidate section is
//     parsed and the one yielding the MOST rows wins. Do not "merge" candidates: the
//     truncated copy's last row is WRONG, not missing, and merging would keep it.
//
// This module reads a document the firm itself filed and the SEC itself publishes. It infers
// nothing, and it returns only rows the filing actually contains.

import { Buffer } from "node:buffer";
import zlib from "node:zlib";

/** The SEC-facing identity of this service. Same string iapd.mjs uses — one service, one
 *  contactable name in the SEC's logs. */
export const DEFAULT_USER_AGENT = "hushh-ria-identity-api/0.1 (+https://hushh.ai; contact ankit@hushh.ai)";

/** Public, unauthenticated. `<firmCRD>` appears twice; that is the SEC's URL shape, not a typo. */
export const ADV_PDF_BASE = "https://reports.adviserinfo.sec.gov/reports/ADV";

export const advPdfUrl = (firmCrd, base = ADV_PDF_BASE) => `${base}/${firmCrd}/PDF/${firmCrd}.pdf`;

/** Measured: a solo RIA's filing is ~600KB, a large one ~3.6MB. 20s is generous for both and
 *  still well inside a Cloud Run request. */
const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_RETRY_DELAY_MS = 500;
/** A ceiling, not an expectation. The largest filing measured was 3.6MB. */
const DEFAULT_MAX_BYTES = 32 * 1024 * 1024;

export const SCHEDULE_A_CACHE_PREFIX = "advScheduleA:v1:";

// ---------------------------------------------------------------------------
// typed errors — the caller treats these three very differently
// ---------------------------------------------------------------------------

/** The PDF could not be retrieved. Transport, not content. */
export class AdvFetchError extends Error {
  constructor(message, { status = null, retriable = false, cause = null } = {}) {
    super(message);
    this.name = "AdvFetchError";
    this.status = status;
    this.retriable = retriable;
    if (cause) this.cause = cause;
  }
}

/** Bytes arrived but they are not a PDF we can read text out of. */
export class AdvPdfError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = "AdvPdfError";
    if (options.cause) this.cause = options.cause;
  }
}

/** We have the document's text and could NOT find or read its Schedule A.
 *
 *  Distinct from an empty array on purpose, and the distinction is the whole point of the
 *  type: `[]` means the firm filed a Schedule A that lists nobody, which is a real answer
 *  about the firm. This error means we do not know what the firm filed, which is a fact
 *  about US. A caller must never let the second read as the first — "not an officer" and
 *  "we could not check" have to reach different code paths. */
export class ScheduleAParseError extends Error {
  constructor(message, { candidates = 0 } = {}) {
    super(message);
    this.name = "ScheduleAParseError";
    this.candidates = candidates;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function requireFirmCrd(value) {
  const n = Number(String(value ?? "").trim());
  if (!Number.isInteger(n) || n <= 0) {
    throw new AdvFetchError(`firmCrd must be a positive integer CRD, got ${JSON.stringify(value)}`, { status: 400 });
  }
  return n;
}

// ---------------------------------------------------------------------------
// fetch
// ---------------------------------------------------------------------------

/**
 * The firm's own Form ADV Part 1 PDF.
 *
 * ONE retry, and only on 5xx. A 4xx will not improve by asking again — an unknown CRD is a
 * 404 forever — so it throws immediately and typed. A network fault is not retried either:
 * this is a multi-megabyte download behind an AbortController, and a second full attempt on
 * a flaky socket costs more than the caller's degraded path does (getScheduleA returns null
 * and the claim falls back to domain_email + roster, exactly as it does today).
 *
 * The timeout covers the BODY READ, not just the response headers. Clearing it before
 * arrayBuffer() — the obvious shape — leaves a 3.6MB download with no deadline at all.
 *
 * @param {number|string} firmCrd
 * @param {object} [deps]
 * @returns {Promise<Buffer>}
 */
export async function fetchFirmAdv(firmCrd, deps = {}) {
  const crd = requireFirmCrd(firmCrd);
  const {
    fetchImpl = globalThis.fetch,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    retryDelayMs = DEFAULT_RETRY_DELAY_MS,
    userAgent = DEFAULT_USER_AGENT,
    maxBytes = DEFAULT_MAX_BYTES,
    baseUrl = ADV_PDF_BASE,
    sleepImpl = sleep,
  } = deps;

  if (typeof fetchImpl !== "function") {
    throw new AdvFetchError("No fetch implementation available (adv-pdf)");
  }

  const url = advPdfUrl(crd, baseUrl);
  // Never anonymous. An empty or whitespace override falls back rather than sending nothing:
  // an unidentified multi-megabyte scrape is how a public endpoint stops being public.
  const ua = String(userAgent || "").trim() || DEFAULT_USER_AGENT;

  let lastError = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0) await sleepImpl(retryDelayMs);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(url, {
        headers: { accept: "application/pdf", "user-agent": ua },
        signal: controller.signal,
      });

      const status = Number(response?.status ?? 0);
      if (status >= 500 && status <= 599) {
        lastError = new AdvFetchError(`Form ADV PDF for firm ${crd}: HTTP ${status}`, { status, retriable: true });
        continue; // the only retriable case
      }
      if (response && response.ok === false) {
        throw new AdvFetchError(`Form ADV PDF for firm ${crd}: HTTP ${status}`, { status });
      }

      const body = Buffer.from(await response.arrayBuffer());
      if (body.length > maxBytes) {
        throw new AdvPdfError(`Form ADV PDF for firm ${crd} is ${body.length} bytes, over the ${maxBytes} limit`);
      }
      if (!looksLikePdf(body)) {
        // Measured shape of a bad day: an edge cache serving an HTML error page with HTTP
        // 200. Checking `%PDF` here turns that into a typed error instead of "this firm
        // filed no Schedule A".
        throw new AdvPdfError(`Form ADV response for firm ${crd} is not a PDF (${body.length} bytes)`);
      }
      return body;
    } catch (error) {
      if (error instanceof AdvPdfError) throw error;
      if (error instanceof AdvFetchError && !error.retriable) throw error;
      // Network fault, DNS, or the abort above. Not retried — see the note on the function.
      throw new AdvFetchError(`Form ADV PDF for firm ${crd} failed: ${error?.message || "unknown error"}`, {
        cause: error,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  throw lastError || new AdvFetchError(`Form ADV PDF for firm ${crd} failed`);
}

/** `%PDF` at the head, tolerating the leading junk the spec allows before the header. */
export function looksLikePdf(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 5) return false;
  return buffer.subarray(0, 1024).includes("%PDF");
}

// ---------------------------------------------------------------------------
// PDF text layer
// ---------------------------------------------------------------------------

/** WinAnsi's one real divergence from Latin-1: 0x80-0x9F, where Latin-1 has control codes and
 *  WinAnsi has the typographic characters a filing actually uses (curly quotes, dashes).
 *  Decoding a content stream as pure latin1 turns a smart apostrophe in a title into an
 *  invisible control character. */
const WIN_ANSI_HIGH = {
  0x80: "€", 0x82: "‚", 0x83: "ƒ", 0x84: "„", 0x85: "…",
  0x86: "†", 0x87: "‡", 0x88: "ˆ", 0x89: "‰", 0x8a: "Š",
  0x8b: "‹", 0x8c: "Œ", 0x8e: "Ž", 0x91: "‘", 0x92: "’",
  0x93: "“", 0x94: "”", 0x95: "•", 0x96: "–", 0x97: "—",
  0x98: "˜", 0x99: "™", 0x9a: "š", 0x9b: "›", 0x9c: "œ",
  0x9e: "ž", 0x9f: "Ÿ",
};

const decodeByte = (code) => WIN_ANSI_HIGH[code] || String.fromCharCode(code);

/**
 * Every stream object in the file, as {dict, start, end} byte offsets.
 *
 * The `re.lastIndex = end` at the bottom is not an optimisation — it is a correctness fix.
 * Stream bodies are compressed binary, and binary very happily contains byte sequences that
 * match `\d+ \d+ obj`. Without skipping past the body, one 930KB filing yielded 432 "objects"
 * of which the extras were phantoms found inside real streams, and the phantom "endstream"
 * they resolved to re-decoded content that had already been read.
 */
function scanStreamObjects(buffer, latin) {
  const objects = [];
  const re = /(\d+)\s+(\d+)\s+obj\b/g;
  let match;
  while ((match = re.exec(latin)) !== null) {
    const bodyStart = re.lastIndex;
    const endobj = latin.indexOf("endobj", bodyStart);
    const streamAt = latin.indexOf("stream", bodyStart);
    if (streamAt === -1) break;
    // `endobj` before `stream` means this object has no stream of its own.
    if (endobj !== -1 && endobj < streamAt) continue;

    const dict = latin.slice(bodyStart, streamAt);
    let start = streamAt + 6;
    if (latin[start] === "\r") start++;
    if (latin[start] === "\n") start++;
    const end = latin.indexOf("endstream", start);
    if (end === -1) break;

    objects.push({ number: Number(match[1]), dict, start, end });
    re.lastIndex = end + "endstream".length;
  }
  return objects;
}

/**
 * Text out of ONE decoded content stream.
 *
 * Deliberately not a full PDF interpreter. It walks the byte stream pulling out literal
 * `(...)` and hex `<...>` strings — which is every string a text operator can take — and
 * emits a newline at each `Td`, `TD` or `T*`, the operators that move to a new line. That is
 * enough to preserve the one thing this parser depends on: Schedule A's cells arrive one per
 * line, in column order, and a wrapped title arrives as consecutive lines.
 *
 * Exported because it is the risky half of extraction and deserves its own tests from plain
 * synthetic strings, with no PDF anywhere near them.
 */
export function decodeContentStreamText(stream) {
  const str = String(stream ?? "");
  let out = "";
  let i = 0;
  while (i < str.length) {
    const c = str[i];
    if (c === "(") {
      const { text, next } = readLiteralString(str, i);
      out += text;
      i = next;
      continue;
    }
    if (c === "<" && str[i + 1] !== "<") {
      const close = str.indexOf(">", i);
      if (close === -1) break;
      const hex = str.slice(i + 1, close).replace(/[^0-9a-fA-F]/g, "");
      for (let k = 0; k + 1 < hex.length; k += 2) out += decodeByte(parseInt(hex.slice(k, k + 2), 16));
      i = close + 1;
      continue;
    }
    // Td / TD / T*  — a new text line. (Tj/TJ paint the string we already took above.)
    if (c === "T" && (str[i + 1] === "*" || str[i + 1] === "d" || str[i + 1] === "D")) {
      out += "\n";
      i += 2;
      continue;
    }
    i++;
  }
  return out;
}

/** PDF literal-string escapes, including the three-digit octal form. Nested parens are legal
 *  and unescaped inside a literal string, so depth is tracked rather than stopping at the
 *  first `)`. */
function readLiteralString(str, start) {
  let depth = 0;
  let text = "";
  let i = start;
  for (; i < str.length; i++) {
    const c = str[i];
    if (c === "\\") {
      const d = str[i + 1];
      if (d === "n") text += "\n";
      else if (d === "r") text += "\r";
      else if (d === "t") text += "\t";
      else if (d === "b") text += "\b";
      else if (d === "f") text += "\f";
      else if (d >= "0" && d <= "7") {
        let octal = "";
        let j = i + 1;
        while (j < str.length && octal.length < 3 && str[j] >= "0" && str[j] <= "7") octal += str[j++];
        text += decodeByte(parseInt(octal, 8) & 0xff);
        i = j - 1;
        continue;
      } else if (d === "\n") {
        // a line continuation inside the string: emits nothing
      } else text += d ?? "";
      i++;
      continue;
    }
    if (c === "(") {
      depth++;
      if (depth === 1) continue;
      text += c;
      continue;
    }
    if (c === ")") {
      depth--;
      if (depth === 0) {
        i++;
        break;
      }
      text += c;
      continue;
    }
    text += c;
  }
  return { text, next: i };
}

/**
 * Collapse the cumulative page streams of trap #1 back into one document.
 *
 * A chunk fully contained in another chunk is dropped. Exact duplicates keep the first.
 * Whatever remains is joined in file order — which is the right answer for BOTH producers:
 * a normal PDF's pages are mutually distinct and all survive, while ExpertPdf's chain
 * collapses to its longest member.
 *
 * Exported and independently tested: it is the difference between reading a 79,130-character
 * document and an 850,764-character hall of mirrors.
 */
export function mergeStreamTexts(texts) {
  const chunks = (Array.isArray(texts) ? texts : []).filter((t) => typeof t === "string" && t.length > 0);
  const kept = chunks.filter((text, i) =>
    !chunks.some(
      (other, j) =>
        j !== i &&
        other.length >= text.length &&
        // For an exact-length duplicate, keep the earlier one — otherwise each would drop
        // the other and both would vanish.
        (other.length > text.length || j < i) &&
        other.includes(text),
    ),
  );
  return kept.join("\n");
}

/**
 * PDF bytes -> the document's text layer.
 *
 * Pure Node: node:zlib inflates the FlateDecode content streams and the walker above reads
 * the text operators. No dependency was added — see the module note in the service README
 * and the live measurements in trap #1.
 *
 * @param {Buffer} buffer
 * @returns {string}
 */
export function extractText(buffer) {
  if (!Buffer.isBuffer(buffer)) throw new AdvPdfError("extractText expects a Buffer");
  if (!looksLikePdf(buffer)) throw new AdvPdfError("Buffer does not begin with a %PDF header");

  const latin = buffer.toString("latin1");
  const objects = scanStreamObjects(buffer, latin);
  const texts = [];

  for (const object of objects) {
    // Images are the bulk of these files (388 of 432 objects on one filing) and never carry
    // text. Skipping them by dictionary is far cheaper than inflating them to find out.
    if (/\/Subtype\s*\/Image/.test(object.dict)) continue;
    if (/\/(DCT|JPX|CCITTFax|JBIG2)Decode/.test(object.dict)) continue;
    if (!/\/FlateDecode/.test(object.dict)) continue;

    const raw = buffer.subarray(object.start, object.end);
    let inflated;
    try {
      inflated = zlib.inflateSync(raw);
    } catch {
      try {
        inflated = zlib.inflateRawSync(raw);
      } catch {
        continue; // an encrypted or damaged stream is skipped, not fatal
      }
    }

    const stream = inflated.toString("latin1");
    if (!/BT[\s\r\n]/.test(stream)) continue; // no text-drawing block: font program, metadata, ...
    texts.push(decodeContentStreamText(stream));
  }

  const text = mergeStreamTexts(texts);
  if (!text.trim()) {
    throw new AdvPdfError(
      `No text layer recovered from ${buffer.length} bytes of PDF (scanned ${objects.length} stream objects)`,
    );
  }
  return text;
}

// ---------------------------------------------------------------------------
// Schedule A table
// ---------------------------------------------------------------------------

/** Trap #3: the line breaks inside this caption move between filings, so every gap is `\s+`. */
const HEADER_ANCHOR = /FULL\s+LEGAL\s+NAME\s*\(\s*Individuals\s*:/g;
/** The last cell of the header. Everything after it is data.
 *
 *  THIS MUST TOLERATE A LINE BREAK, and the reason is worth keeping. It was the literal string
 *  "ID No." and the header's last cell reads "...IRS Tax No. or Employer ID No." — but the
 *  renderer wraps that cell wherever the column happens to end, so plenty of filings emit
 *  "Employer ID\nNo." instead. The literal then found nothing, the section was skipped whole,
 *  and getScheduleA returned null — so `adv_officer` could never fire for that firm no matter
 *  who was claiming it. Measured on 60 real filings: 3 of 45 randomly sampled firms plus
 *  HIGHTOWER ADVISORS (CRD 145323, ~2,700 advisers, 11 officers on its Schedule A) were losing
 *  their entire table to a missing newline. */
const HEADER_END = /ID\s+No\./;

/** Where the header's last cell ends in `text`, or -1. Returns the END offset so callers do not
 *  have to know how long the matched text was — with a variable-width pattern, they can't. */
function headerEndOffset(text, from = 0) {
  const match = HEADER_END.exec(text.slice(from));
  return match ? from + match.index + match[0].length : -1;
}
/** Schedule A ends where Schedule B begins. */
const SECTION_TERMINATOR = "Schedule B";

const MARKER = /^(I|DE|FE)$/i;
const DATE_ACQUIRED = /^(0?[1-9]|1[0-2])\/(1[89]|20)\d{2}$/;
/** NA <5%, A 5-10%, B 10-25%, C 25-50%, D 50-75%, E 75%+. F is not on the current form but
 *  appears in older filings and in this service's own fixtures, so it is accepted. */
const OWNERSHIP_CODE = /^(NA|A|B|C|D|E|F)$/i;
const YES_NO = /^(Y|N|YES|NO)$/i;
const PR_FLAG = /^(Y|N|YES|NO|PR)$/i;
/** The last column: a CRD, or an entity's tax/employer ID. Never a name — names start with a
 *  letter, and that is exactly what lets an entity row (trap #5) simply omit it. */
const IDENTIFIER = /^\d[\d-]{2,}$/;

/** A name wraps at most across a couple of lines; a title across a few more. These bounds are
 *  what stop a lost row from consuming the rest of the document looking for a match. */
const MAX_NAME_LINES = 6;
const MAX_TITLE_LINES = 12;

/** Trap #2. Schedule B's table has one extra column and is otherwise identical. */
export function isScheduleAHeader(header) {
  return !/Entity\s+in\s+Which/i.test(String(header ?? ""));
}

const collapse = (s) => String(s ?? "").replace(/\s+/g, " ").trim();

/**
 * A filed name in a form a name matcher can use.
 *
 * Individuals are filed surname-first ("DOE, JANE, Q") and the case is inconsistent between
 * rows of the same table — one real filing had a fully-capitalised row directly above a
 * mixed-case one ("DOE, JANE, Q" over "Roe, Samuel, T", in the fixtures' shape).
 * Uppercasing and restoring natural order gives one stable key.
 * Entities are left as filed: "CPI HOLDCO B, LLC" is not a surname-first person and
 * reordering it would produce nonsense.
 */
export function normalizeScheduleAName(name, isIndividual = true) {
  const raw = collapse(name);
  if (!raw) return "";
  if (!isIndividual || !raw.includes(",")) return raw.toUpperCase();
  const parts = raw.split(",").map((p) => collapse(p)).filter(Boolean);
  if (parts.length < 2) return raw.replace(/,/g, " ").replace(/\s+/g, " ").trim().toUpperCase();
  const [last, ...given] = parts;
  return collapse([...given, last].join(" ")).toUpperCase();
}

/**
 * Rows out of ONE candidate section body.
 *
 * Schedule A is a POSITIONAL stream: name, DE/FE/I, title (wrapped), date, ownership code,
 * control person, PR, and — only for individuals — the CRD. There is no delimiter between
 * rows. So when a row does not validate we STOP, rather than skip a line and try again:
 * once alignment is lost there is no honest way to know where the next row begins, and a
 * resynchronising parser would invent owners. Stopping loses rows we cannot read; guessing
 * would fabricate authority. The caller then prefers whichever candidate section yielded the
 * most rows, which is what makes a truncated copy (trap #6) lose to a complete one.
 */
function parseSectionRows(lines, warn) {
  const rows = [];
  let i = 0;

  while (i < lines.length) {
    // A repeated header inside the body means the table broke across a page. Skip it and
    // keep reading the same table rather than treating the continuation as a new section.
    if (/^FULL\s+LEGAL\s+NAME/i.test(lines[i])) {
      // The last header cell may be wrapped, so the resume line is whichever one ENDS the
      // header — "…Employer ID No." on one line, or just "No." when it wrapped.
      const resume = lines.findIndex(
        (line, k) => k > i && (HEADER_END.test(line) || /^No\.$/.test(line.trim())),
      );
      if (resume === -1) break;
      i = resume + 1;
      continue;
    }

    // --- name (may wrap) then the DE/FE/I marker
    const nameLines = [];
    while (i < lines.length && !MARKER.test(lines[i]) && nameLines.length < MAX_NAME_LINES) {
      nameLines.push(lines[i++]);
    }
    if (i >= lines.length || !MARKER.test(lines[i])) {
      if (nameLines.length) warn(`stopped: no DE/FE/I marker after ${JSON.stringify(nameLines[0])}`);
      break;
    }
    const marker = lines[i++].toUpperCase();
    const isIndividual = marker === "I";
    const name = collapse(nameLines.join(" "));
    if (!name) {
      warn("stopped: a DE/FE/I marker with no name before it");
      break;
    }

    // --- title (wraps freely) up to the acquisition date
    const titleLines = [];
    while (i < lines.length && !DATE_ACQUIRED.test(lines[i]) && titleLines.length < MAX_TITLE_LINES) {
      titleLines.push(lines[i++]);
    }
    if (i >= lines.length || !DATE_ACQUIRED.test(lines[i])) {
      warn(`stopped: no MM/YYYY acquisition date for ${JSON.stringify(name)}`);
      break;
    }
    const dateAcquired = lines[i++];

    // --- the three fixed single-token columns
    if (!OWNERSHIP_CODE.test(lines[i] ?? "")) {
      warn(`stopped: ${JSON.stringify(lines[i] ?? "")} is not an ownership code for ${JSON.stringify(name)}`);
      break;
    }
    const ownershipCode = lines[i++].toUpperCase();

    if (!YES_NO.test(lines[i] ?? "")) {
      warn(`stopped: ${JSON.stringify(lines[i] ?? "")} is not a control-person flag for ${JSON.stringify(name)}`);
      break;
    }
    const isControlPerson = /^(Y|YES)$/i.test(lines[i++]);

    if (!PR_FLAG.test(lines[i] ?? "")) {
      warn(`stopped: ${JSON.stringify(lines[i] ?? "")} is not a PR flag for ${JSON.stringify(name)}`);
      break;
    }
    const prRaw = lines[i++];
    const isPublicReporting = /^(Y|YES|PR)$/i.test(prRaw);

    // --- the identifier column, present for individuals and absent on entity rows (trap #5)
    let individualCrd = null;
    if (i < lines.length && IDENTIFIER.test(lines[i])) {
      const identifier = lines[i++];
      // An entity's line here is a tax or employer ID, NOT a CRD. Consumed so it cannot be
      // mistaken for the next row's name; never reported as a person's CRD.
      if (isIndividual && /^\d+$/.test(identifier)) individualCrd = Number(identifier);
    }

    rows.push({
      name,
      nameNormalized: normalizeScheduleAName(name, isIndividual),
      individualCrd,
      isIndividual,
      title: collapse(titleLines.join(" ")) || null,
      dateAcquired,
      ownershipCode,
      isControlPerson,
      isPublicReporting,
    });
  }

  return rows;
}

/**
 * Every Schedule A candidate in the document text, most promising order not assumed.
 * Exported so a diagnostic can see what the discriminator threw away.
 */
export function findScheduleASections(text) {
  const body = String(text ?? "");
  const sections = [];
  HEADER_ANCHOR.lastIndex = 0;
  let match;
  while ((match = HEADER_ANCHOR.exec(body)) !== null) {
    // The header block is short; searching the whole document for "ID No." from here would
    // happily run past the table on a filing whose header is malformed.
    const window = body.slice(match.index, match.index + 800);
    const endOffset = headerEndOffset(window);
    if (endOffset === -1) continue;
    const header = window.slice(0, endOffset);
    const start = match.index + endOffset;
    const terminator = body.indexOf(SECTION_TERMINATOR, start);
    sections.push({
      at: match.index,
      header,
      isScheduleA: isScheduleAHeader(header),
      body: body.slice(start, terminator === -1 ? body.length : terminator),
    });
  }
  return sections;
}

/**
 * Document text -> the firm's filed direct owners and executive officers.
 *
 * @param {string} text
 * @param {{onWarn?:(message:string)=>void}} [options]
 * @returns {Array<{name:string,nameNormalized:string,individualCrd:number|null,isIndividual:boolean,
 *                  title:string|null,dateAcquired:string,ownershipCode:string,
 *                  isControlPerson:boolean,isPublicReporting:boolean}>}
 * @throws {ScheduleAParseError} when the table cannot be found or cannot be read at all —
 *         which is NOT the same as a firm that lists nobody (that returns []).
 */
export function parseScheduleA(text, options = {}) {
  const onWarn = typeof options.onWarn === "function" ? options.onWarn : () => {};
  if (typeof text !== "string" || !text.trim()) {
    throw new ScheduleAParseError("parseScheduleA needs the document text");
  }

  const sections = findScheduleASections(text);
  const candidates = sections.filter((s) => s.isScheduleA);
  const rejected = sections.length - candidates.length;
  if (rejected) onWarn(`ignored ${rejected} Schedule B table(s) sharing the Schedule A header`);

  if (!candidates.length) {
    throw new ScheduleAParseError(
      sections.length
        ? `found ${sections.length} owner table(s) but all of them were Schedule B`
        : "no Schedule A table found in this document",
      { candidates: sections.length },
    );
  }

  const parsed = candidates.map((section) => {
    const lines = section.body.split("\n").map((line) => line.trim()).filter(Boolean);
    const warnings = [];
    const rows = parseSectionRows(lines, (message) => warnings.push(message));
    return { section, lines, rows, warnings };
  });

  // Trap #6: the complete copy wins. Ties go to the tighter section — the one whose body ran
  // to its "Schedule B" terminator soonest is the one that actually had one.
  const best = parsed.reduce((a, b) =>
    b.rows.length > a.rows.length || (b.rows.length === a.rows.length && b.lines.length < a.lines.length) ? b : a,
  );

  if (!best.rows.length) {
    // Header present, nothing under it: the firm filed a Schedule A that lists nobody.
    if (parsed.every((p) => p.lines.length === 0)) return [];
    for (const warning of best.warnings) onWarn(warning);
    throw new ScheduleAParseError(
      `Schedule A table found (${candidates.length} candidate(s)) but no row could be read from it`,
      { candidates: candidates.length },
    );
  }

  for (const warning of best.warnings) onWarn(warning);
  return best.rows;
}

// ---------------------------------------------------------------------------
// the one function callers use
// ---------------------------------------------------------------------------

/**
 * Fetch, extract and parse — and NEVER throw.
 *
 * `null` is the contract for every failure: the SEC is down, the PDF is unreadable, the
 * table moved. A claim evaluation that calls this must keep working when Schedule A is
 * unavailable, degrading to exactly the domain_email + roster path it uses today. An empty
 * array is not a failure and is cached like any other answer — the firm told us it has no
 * reportable direct owners, and that is worth remembering.
 *
 * Cache-aware: pass `deps.cache` (a cache.mjs TtlCache, or anything with `wrap`, or a plain
 * `get`/`set` pair). A failure is deliberately NOT cached — the fetch happens inside the
 * producer, so a rejected producer leaves the key cold and the next caller retries.
 *
 * @param {number|string} firmCrd
 * @param {object} [deps]
 * @returns {Promise<Array|null>}
 */
export async function getScheduleA(firmCrd, deps = {}) {
  const onWarn = typeof deps.onWarn === "function" ? deps.onWarn : () => {};
  try {
    const crd = requireFirmCrd(firmCrd);
    const key = `${SCHEDULE_A_CACHE_PREFIX}${crd}`;
    const cache = deps.cache;
    const extract = typeof deps.extractTextImpl === "function" ? deps.extractTextImpl : extractText;

    const produce = async () => {
      const buffer = await fetchFirmAdv(crd, deps);
      const text = extract(buffer);
      return parseScheduleA(text, { onWarn });
    };

    if (cache && typeof cache.wrap === "function") return await cache.wrap(key, produce);
    if (cache && typeof cache.get === "function" && typeof cache.set === "function") {
      const hit = cache.get(key);
      if (hit !== undefined) return hit;
      return cache.set(key, await produce());
    }
    return await produce();
  } catch (error) {
    onWarn(`getScheduleA(${firmCrd}) degraded to null: ${error?.name || "Error"}: ${error?.message || error}`);
    return null;
  }
}
