/**
 * XtremePapers (https://papers.xtremepape.rs) content access helpers.
 *
 * papers.xtremepape.rs is a public, server-rendered directory archive of IB past
 * papers. There is no login and no JSON search API: the site exposes browsable
 * folder listings and PDF documents. This module implements topic search by:
 *   1. walking a bounded slice of the IB tree (recent years -> sessions ->
 *      subject categories),
 *   2. extracting PDF rows from those listings,
 *   3. ranking rows by subject/topic words in the filename,
 *   4. downloading a small set of PDFs and searching their extracted text.
 *
 * PDF text is extracted with Node's built-in zlib only — no third-party
 * packages. The extractor is intentionally best-effort and never invents text.
 */

"use strict";

const zlib = require("node:zlib");

const BASE_URL = "https://papers.xtremepape.rs";
const IB_ROOT = `${BASE_URL}/index.php?dirpath=./IB/&order=0`;
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Version/17.4 Safari/605.1.15";
const DEFAULT_YEARS = 3;

/** IB category folders, in a sensible fallback order. */
const DEFAULT_CATEGORIES = [
  "Mathematics",
  "Experimental sciences",
  "Individuals and societies",
  "Studies in language and literature",
  "Language acquisition",
];

/** Map friendly subject hints to the category folder used by XtremePapers. */
const SUBJECT_CATEGORIES = {
  "math aa": "Mathematics",
  "math aa hl": "Mathematics",
  "math aa sl": "Mathematics",
  "mathematics analysis and approaches": "Mathematics",
  "analysis and approaches": "Mathematics",
  "math ai": "Mathematics",
  "math ai hl": "Mathematics",
  "math ai sl": "Mathematics",
  "mathematics applications and interpretation": "Mathematics",
  "applications and interpretation": "Mathematics",
  mathematics: "Mathematics",
  maths: "Mathematics",
  "further mathematics": "Mathematics",
  physics: "Experimental sciences",
  chemistry: "Experimental sciences",
  biology: "Experimental sciences",
  "environmental systems and societies": "Experimental sciences",
  ess: "Experimental sciences",
  "design technology": "Experimental sciences",
  "computer science": "Experimental sciences",
  economics: "Individuals and societies",
  "business management": "Individuals and societies",
  business: "Individuals and societies",
  psychology: "Individuals and societies",
  geography: "Individuals and societies",
  history: "Individuals and societies",
  "digital society": "Individuals and societies",
  english: "Studies in language and literature",
  "language a": "Studies in language and literature",
  "language b": "Language acquisition",
  spanish: "Language acquisition",
  french: "Language acquisition",
  german: "Language acquisition",
};

/** Filename patterns used to narrow a category folder to one subject. */
const SUBJECT_FILE_PATTERNS = {
  "math aa": /analysis_and_approaches/i,
  "math aa hl": /analysis_and_approaches/i,
  "math aa sl": /analysis_and_approaches/i,
  "mathematics analysis and approaches": /analysis_and_approaches/i,
  "analysis and approaches": /analysis_and_approaches/i,
  "math ai": /applications_and_interpretation/i,
  "math ai hl": /applications_and_interpretation/i,
  "math ai sl": /applications_and_interpretation/i,
  "mathematics applications and interpretation": /applications_and_interpretation/i,
  "applications and interpretation": /applications_and_interpretation/i,
  mathematics: /mathematic/i,
  maths: /mathematic/i,
  "further mathematics": /further[_-]?mathematic/i,
  physics: /physics/i,
  chemistry: /chemistr/i,
  biology: /biology/i,
  "environmental systems and societies": /environmental|ess/i,
  ess: /environmental|ess/i,
  "design technology": /design[_-]?technology/i,
  "computer science": /computer[_-]?science/i,
  economics: /economic/i,
  "business management": /business/i,
  business: /business/i,
  psychology: /psychology/i,
  geography: /geograph/i,
  history: /history/i,
  "digital society": /digital[_-]?society/i,
  english: /english/i,
  "language a": /language[_-]?a/i,
  "language b": /language[_-]?b/i,
  spanish: /spanish/i,
  french: /french/i,
  german: /german/i,
};

function isAllowedXtremePapersUrl(raw) {
  try {
    const u = new URL(raw);
    if (u.protocol !== "https:") return false;
    return u.hostname === "papers.xtremepape.rs";
  } catch {
    return false;
  }
}

/** Node's fetch rejects a plain object as `signal`; only pass a real one. */
function isAbortSignal(value) {
  return typeof AbortSignal !== "undefined" && value instanceof AbortSignal;
}

function decodeHtml(s) {
  return String(s)
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#160;|&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)));
}

function subjectKey(subject) {
  return typeof subject === "string" ? subject.trim().toLowerCase().replace(/\s+/g, " ") : "";
}

function subjectCategory(subject) {
  const key = subjectKey(subject);
  return key ? SUBJECT_CATEGORIES[key] || "" : "";
}

function subjectFilePattern(subject) {
  const key = subjectKey(subject);
  return key ? SUBJECT_FILE_PATTERNS[key] || null : null;
}

function encodeDirSegment(name) {
  return encodeURIComponent(String(name)).replace(/%20/g, "+");
}

function listingUrl(dirpath, order = 0) {
  return `${BASE_URL}/index.php?dirpath=${dirpath}&order=${order}`;
}

function dirpathFromHref(href, baseUrl) {
  try {
    const u = new URL(decodeHtml(href), baseUrl || IB_ROOT);
    return u.searchParams.get("dirpath") || "";
  } catch {
    return "";
  }
}

function decodeDirpath(dirpath) {
  try {
    return decodeURIComponent(String(dirpath).replace(/\+/g, " "));
  } catch {
    return String(dirpath).replace(/\+/g, " ");
  }
}

/** Fetch a page and return { url, status, html }. */
async function fetchPage(url, signal) {
  const response = await fetch(url, {
    method: "GET",
    headers: { Accept: "text/html,application/xhtml+xml", "User-Agent": USER_AGENT },
    redirect: "follow",
    signal: isAbortSignal(signal) ? signal : undefined,
  });
  const html = await response.text();
  // The site occasionally serves NUL bytes in its streamed HTML; strip them.
  return { url: response.url || url, status: response.status, html: html.replace(/\0/g, "") };
}

/** Fetch a binary resource (PDF) as a Buffer. */
async function fetchBinary(url, signal) {
  const response = await fetch(url, {
    method: "GET",
    headers: { Accept: "application/pdf,*/*", "User-Agent": USER_AGENT },
    redirect: "follow",
    signal: isAbortSignal(signal) ? signal : undefined,
  });
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
  return Buffer.from(await response.arrayBuffer());
}

/**
 * Extract folder/file rows from a XtremePapers listing page.
 * Returns [{ name, href, size, modified, isDir, isPdf, dirpath }] with absolute
 * hrefs. Sorting controls on the page are ignored.
 */
function extractRows(html, baseUrl) {
  const rows = [];
  const trRe = /<tr\b[^>]*>[\s\S]*?<\/tr>/gi;
  let m;
  while ((m = trRe.exec(html))) {
    const tr = m[0];
    const anchor = tr.match(/<a\s+[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!anchor) continue;
    const rawHref = decodeHtml(anchor[1]);
    if (/sort|order=/i.test(anchor[0]) && !/dirpath=/i.test(rawHref)) continue;
    let href;
    try {
      href = new URL(rawHref, baseUrl || IB_ROOT).href;
    } catch {
      continue;
    }
    const isDir = /class="[^"]*\bdirectory\b/i.test(anchor[0]) || /[?&]dirpath=/.test(rawHref);
    const rawName = decodeHtml(anchor[2].replace(/<[^>]+>/g, " ")).trim();
    let name = rawName.replace(/\s+/g, " ");
    if (!name || /^(parent folder|name|size|modified)$/i.test(name)) {
      const path = isDir ? dirpathFromHref(rawHref, baseUrl) : new URL(href).pathname;
      name = decodeDirpath(path).split("/").filter(Boolean).pop() || "";
    }
    if (!name) continue;
    const size = decodeHtml((tr.match(/<td[^>]*class="fsize"[^>]*>([\s\S]*?)<\/td>/i) || [])[1] || "")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    const modified = decodeHtml((tr.match(/<time[^>]*datetime="([^"]+)"/i) || [])[1] || "");
    rows.push({
      name,
      href,
      size,
      modified,
      isDir,
      isPdf: !isDir && /\.pdf$/i.test(new URL(href).pathname),
      dirpath: isDir ? dirpathFromHref(rawHref, baseUrl) : "",
    });
  }
  return rows;
}

function yearFolders(rows) {
  return rows
    .filter((r) => r.isDir && /^\d{4}/.test(r.name))
    .map((r) => ({ ...r, year: Number((r.name.match(/^\d{4}/) || [0])[0]) }))
    .sort((a, b) => b.year - a.year);
}

function sessionFolders(rows, sessionHint) {
  const wanted = subjectKey(sessionHint);
  const sessions = rows.filter((r) => {
    if (!r.isDir || /parent folder/i.test(r.name)) return false;
    if (!/may|november|donated/i.test(r.name)) return false;
    if (!wanted) return true;
    return r.name.toLowerCase().includes(wanted);
  });
  // Prefer real exam sessions over donated bundles unless the user asked for
  // them, and within each group show the newest session first.
  const sessionRank = (name) => {
    const m = String(name).match(/\b(20\d{2})\b/);
    const month = /november/i.test(name) ? 11 : /may/i.test(name) ? 5 : 0;
    return (Number((m || [0])[0]) || 0) * 12 + month;
  };
  return sessions.sort((a, b) => {
    const aDonated = /donated/i.test(a.name) ? 1 : 0;
    const bDonated = /donated/i.test(b.name) ? 1 : 0;
    return aDonated - bDonated || sessionRank(b.name) - sessionRank(a.name) || b.name.localeCompare(a.name);
  });
}

function categoryFolders(rows, subject) {
  const category = subjectCategory(subject);
  const wanted = category ? category.toLowerCase() : "";
  return rows.filter((r) => {
    if (!r.isDir || /parent folder|audio/i.test(r.name)) return false;
    if (!wanted) return DEFAULT_CATEGORIES.some((c) => c.toLowerCase() === r.name.toLowerCase());
    return r.name.toLowerCase() === wanted;
  });
}

function pdfRows(rows, subject) {
  const pattern = subjectFilePattern(subject);
  return rows
    .filter((r) => r.isPdf && (!pattern || pattern.test(r.name)))
    .map((r) => ({ ...r, ...pdfMetadata(r.href) }));
}

/** Derive useful metadata from a direct PDF URL. */
function pdfMetadata(pdfUrl) {
  let decoded = "";
  try {
    decoded = decodeDirpath(new URL(pdfUrl).pathname.replace(/^\//, ""));
  } catch {
    decoded = decodeDirpath(String(pdfUrl));
  }
  const parts = decoded.split("/").filter(Boolean);
  const filename = (parts.pop() || "").replace(/\.pdf$/i, "");
  const title = filename.replace(/_/g, " ").replace(/\s+/g, " ").trim();
  return {
    title,
    year: Number((decoded.match(/\b(20\d{2})\b/) || [0])[0]) || 0,
    session: (decoded.match(/\b((?:May|November)\s+\d{4})\b/i) || [])[1] || "",
    category: parts[parts.length - 1] || "",
    paper: (filename.match(/paper[_ ]?(\d+)/i) || [])[1] || "",
    level: (filename.match(/(?:^|[^A-Za-z])(HL|SL)(?:$|[^A-Za-z])/i) || [])[1] || "",
    zone: (filename.match(/TZ\d/i) || [])[0] || "",
    isMarkscheme: /markscheme|mark[ -]?scheme/i.test(filename),
  };
}

/** Find the matching mark-scheme row for a question PDF in the same listing. */
function markschemeFor(pdfUrl, rows) {
  const meta = pdfMetadata(pdfUrl);
  if (meta.isMarkscheme) return pdfUrl;
  const base = (meta.title || "").replace(/\s+markscheme$/i, "").toLowerCase();
  const match = rows.find((r) => {
    if (!r.isPdf || !/markscheme/i.test(r.name)) return false;
    const m = pdfMetadata(r.href);
    return m.year === meta.year && m.paper === meta.paper && m.level === meta.level &&
      m.zone === meta.zone && m.title.toLowerCase().startsWith(base.slice(0, 24));
  });
  return match ? match.href : "";
}


/** Decode a PDF literal string (contents between parentheses). */
function decodePdfString(raw) {
  let bytes = raw
    .replace(/\\n/g, "\n")
    .replace(/\\r/g, "\r")
    .replace(/\\t/g, "\t")
    .replace(/\\([()\\])/g, "$1");

  // UTF-16BE strings start with 0xFE 0xFF when ported to latin1 as þÿ.
  if (bytes.startsWith("þÿ")) {
    const body = bytes.slice(2);
    const out = [];
    for (let i = 0; i + 1 < body.length; i += 2) {
      out.push(String.fromCharCode((body.charCodeAt(i) << 8) | body.charCodeAt(i + 1)));
    }
    return out.join("");
  }
  // Octal escapes such as \101 -> A.
  bytes = bytes.replace(/\\([0-7]{1,3})/g, (_, o) => String.fromCharCode(parseInt(o, 8)));
  return bytes;
}

/** Tidy text produced by the PDF string parser. */
function cleanPdfText(text) {
  return String(text)
    .replace(/þÿ/g, "")
    // C1 control bytes (e.g. octal \226) are layout glyphs, not readable text.
    .replace(/[\u0080-\u009f]/g, " ")
    // Some math fonts map number-set symbols into the private-use area.
    .replace(/\uF0A1/g, "\u211d") // ℝ (real numbers)
    .replace(/\uF0A2/g, "\u211a") // ℚ (rational numbers)
    .replace(/\ben-(?:US|GB)\b/gi, "")
    .replace(/\b(?:[A-Za-z]\s+){2,}[A-Za-z]\b/g, (m) => m.replace(/\s+/g, ""))
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Some PDF streams contain font programs or other binary blobs that happen to
 * include `BT ... ET`, so naive string extraction produces garbage. Real text
 * streams are overwhelmingly printable ASCII with plenty of letters.
 */
function isReadableStream(text) {
  if (!text || text.length < 8) return false;
  let printable = 0;
  let letters = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if ((code >= 32 && code <= 126) || code === 9 || code === 10 || code === 13) {
      printable++;
      if ((code >= 65 && code <= 90) || (code >= 97 && code <= 122)) letters++;
    }
  }
  return printable / text.length >= 0.9 && letters / text.length >= 0.3;
}

/* ------------------------------------------------------------------------ *
 * Font-aware PDF text decoding
 *
 * IB papers are typeset with subset fonts whose glyph codes are NOT ASCII.
 * E.g. the fraction "1/(1+x^2)" uses codes 0x1F/0x1E that look like control
 * characters but are actually the glyphs "one" and "two". The same code can
 * mean different things in different fonts, so decoding must track the font
 * selected by Tf in each text stream and use that font's own ToUnicode CMap
 * (or its /Encoding /Differences glyph names). A single global remap produces
 * nonsense such as "- - ∈ x", so we deliberately work font-by-font.
 * ------------------------------------------------------------------------ */

/** Glyph names from /Encoding /Differences that we can map to Unicode. */
const PDF_GLYPH_UNICODE = {
  zero: "0", one: "1", two: "2", three: "3", four: "4",
  five: "5", six: "6", seven: "7", eight: "8", nine: "9",
  minus: "\u2212", plus: "+", equal: "=", lessequal: "\u2264",
  greaterequal: "\u2265", notequal: "\u2260", equivalence: "\u2261",
  element: "\u2208", noteelement: "\u2209", pi: "\u03c0", theta: "\u03b8",
  beta: "\u03b2", alpha: "\u03b1", gamma: "\u03b3", delta: "\u03b4",
  epsilon: "\u03b5", lambda: "\u03bb", mu: "\u03bc", sigma: "\u03c3",
  phi: "\u03c6", omega: "\u03c9", minute: "\u2032", second: "\u2033",
  fraction: "\u2044", multiply: "\u00d7", divide: "\u00f7", plusminus: "\u00b1",
  degree: "\u00b0", infinity: "\u221e", integral: "\u222b", summation: "\u2211",
  radical: "\u221a", partialdiff: "\u2202", onesuperior: "\u00b9",
  twosuperior: "\u00b2", threesuperior: "\u00b3", onehalf: "\u00bd",
  onequarter: "\u00bc", threequarters: "\u00be", space: " ",
  periodcentered: "\u00b7", bullet: "\u2022", endash: "\u2013",
  emdash: "\u2014", quoteleft: "\u2018", quoteright: "\u2019",
  quotedblleft: "\u201c", quotedblright: "\u201d", dotlessi: "\u0131",
};
for (let i = 0; i < 26; i++) {
  const lower = String.fromCharCode(97 + i);
  PDF_GLYPH_UNICODE[lower] = lower;
  PDF_GLYPH_UNICODE[lower.toUpperCase()] = lower.toUpperCase();
}

/** Inflate a FlateDecode stream, falling back to the raw latin1 bytes. */
function inflatePdfStream(data) {
  try {
    return zlib.inflateSync(Buffer.from(data, "latin1")).toString("latin1");
  } catch {
    return Buffer.from(data, "latin1").toString("latin1");
  }
}

/** Parse all PDF objects (regular + inside /ObjStm) into num -> body. */
function parsePdfObjects(buffer) {
  const raw = buffer.toString("latin1");
  const objects = new Map();
  const objRe = /(\d+)\s+(\d+)\s+obj\b([\s\S]*?)endobj/g;
  let m;
  // Regular objects first so object streams can reference anything already seen.
  while ((m = objRe.exec(raw))) {
    if (/\bObjStm\b/.test(m[3])) continue;
    objects.set(Number(m[1]), m[3]);
  }
  // Then unpack object streams (/N /First + header of "objNum offset" pairs).
  while ((m = objRe.exec(raw))) {
    const body = m[3];
    if (!/\bObjStm\b/.test(body)) continue;
    const count = Number((body.match(/\/N\s+(\d+)/) || [])[1]);
    const first = Number((body.match(/\/First\s+(\d+)/) || [])[1]);
    const si = body.indexOf("stream");
    if (si < 0 || !count || !first) continue;
    const data = body.slice(si + 6).replace(/^\r?\n/, "").replace(/\r?\nendstream[\s\S]*$/, "");
    const s = inflatePdfStream(data);
    const header = s.slice(0, first).trim().split(/\s+/).map(Number);
    for (let i = 0; i < count; i++) {
      const num = header[i * 2];
      const off = header[i * 2 + 1];
      if (!Number.isFinite(num) || !Number.isFinite(off)) continue;
      const next = i + 1 < count ? header[(i + 1) * 2 + 1] : s.length;
      objects.set(num, s.slice(first + off, first + next));
    }
  }
  return objects;
}

/** Return the (inflated) stream contents of an object, or its body if inline. */
function pdfStreamOf(body) {
  const si = body.indexOf("stream");
  if (si < 0) return body;
  const data = body.slice(si + 6).replace(/^\r?\n/, "").replace(/\r?\nendstream[\s\S]*$/, "");
  return inflatePdfStream(data);
}

/** Parse a ToUnicode CMap's bfchar/bfrange entries into code -> string maps. */
function parsePdfCMap(content) {
  const map1 = new Map(); // single-byte codes
  const map2 = new Map(); // two-byte codes (4 hex digits, upper case)
  const toUnicode = (hex) => {
    let out = "";
    if (hex.length % 4 === 0) {
      for (let i = 0; i < hex.length; i += 4) {
        out += String.fromCharCode(parseInt(hex.slice(i, i + 4), 16));
      }
    } else {
      out = String.fromCharCode(parseInt(hex, 16));
    }
    return out;
  };
  for (const block of content.matchAll(/\d+\s+beginbfchar([\s\S]*?)endbfchar/g)) {
    for (const mm of block[1].matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g)) {
      const src = mm[1];
      const uni = toUnicode(mm[2]);
      if (src.length <= 2) map1.set(parseInt(src, 16), uni);
      else map2.set(src.toUpperCase(), uni);
    }
  }
  for (const block of content.matchAll(/\d+\s+beginbfrange([\s\S]*?)endbfrange/g)) {
    for (const mm of block[1].matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*(?:<([0-9A-Fa-f]+)>|\[([\s\S]*?)\])/g)) {
      const lo = parseInt(mm[1], 16);
      const hi = parseInt(mm[2], 16);
      const len = mm[1].length;
      if (mm[3] !== undefined) {
        const base = parseInt(mm[3], 16);
        for (let code = lo; code <= hi; code++) {
          const uni = toUnicode((base + code - lo).toString(16).padStart(4, "0"));
          if (len <= 2) map1.set(code, uni);
          else map2.set(code.toString(16).padStart(4, "0").toUpperCase(), uni);
        }
      } else if (mm[4]) {
        let i = 0;
        for (const dm of mm[4].matchAll(/<([0-9A-Fa-f]+)>/g)) {
          const code = lo + i++;
          const uni = toUnicode(dm[1]);
          if (len <= 2) map1.set(code, uni);
          else map2.set(code.toString(16).padStart(4, "0").toUpperCase(), uni);
        }
      }
    }
  }
  return { map1, map2 };
}

/** Parse /Encoding /Differences into code -> glyph-name map. */
function parsePdfEncodingDifferences(encodingBody) {
  const out = new Map();
  const dm = encodingBody.match(/Differences\s*\[([\s\S]*?)\]/);
  if (!dm) return out;
  const tokens = dm[1].match(/\/([A-Za-z0-9_.]+)|(\d+)/g) || [];
  let code = 0;
  for (const token of tokens) {
    if (/^\d+$/.test(token)) code = parseInt(token, 10);
    else {
      out.set(code, token.slice(1));
      code++;
    }
  }
  return out;
}

/** Build a decoder for one font object: ToUnicode first, then glyph names. */
function buildPdfFontDecoder(objects, fontObjNum) {
  const body = objects.get(fontObjNum) || "";
  const subtype = (body.match(/\/Subtype\s*\/([A-Za-z0-9]+)/) || [])[1] || "";
  const isType0 = subtype === "Type0";
  let map1 = new Map();
  let map2 = new Map();
  const toUnicode = (body.match(/\/ToUnicode\s+(\d+)\s+\d+\s+R/) || [])[1];
  if (toUnicode) {
    const cmap = parsePdfCMap(pdfStreamOf(objects.get(Number(toUnicode)) || ""));
    map1 = cmap.map1;
    map2 = cmap.map2;
  }
  const encRef = body.match(/\/Encoding\s+(\d+)\s+\d+\s+R/);
  let encodingBody = "";
  if (encRef) encodingBody = objects.get(Number(encRef[1])) || "";
  else encodingBody = (body.match(/\/Encoding\s*(<<[\s\S]*?>>)/) || [])[1] || "";
  const differences = encodingBody ? parsePdfEncodingDifferences(encodingBody) : new Map();
  return { isType0, map1, map2, differences };
}

/** Extract the /Resources /Font << name obj R >> map from a dict-like body. */
function parsePdfFontResources(body) {
  const ri = body.indexOf("/Resources");
  if (ri < 0) return new Map();
  const sub = body.slice(ri, ri + 6000);
  const fi = sub.indexOf("/Font");
  if (fi < 0) return new Map();
  const lt = sub.indexOf("<<", fi);
  if (lt < 0) return new Map();
  let depth = 0;
  let end = -1;
  for (let i = lt; i < sub.length; i++) {
    if (sub[i] === "<" && sub[i + 1] === "<") { depth++; i++; }
    else if (sub[i] === ">" && sub[i + 1] === ">") { depth--; i++; if (depth === 0) { end = i; break; } }
  }
  const dict = end > 0 ? sub.slice(lt + 2, end - 1) : sub.slice(lt + 2);
  const out = new Map();
  for (const mm of dict.matchAll(/\/([^\s/<]+)\s+(\d+)\s+\d+\s+R/g)) {
    out.set(mm[1], Number(mm[2]));
  }
  return out;
}

/** Map each text-stream object to its font-name -> decoder map (pages + forms). */
function buildPdfContentFontMaps(objects) {
  const contentFonts = new Map();
  for (const [num, body] of objects) {
    const isPage = /\/Type\s*\/Page(?![sA-Za-z])/.test(body);
    const isForm = /\/Subtype\s*\/Form/.test(body);
    if (!isPage && !isForm) continue;
    let contentNum = num;
    if (isPage) {
      const cm = body.match(/\/Contents\s+(\d+)\s+\d+\s+R/);
      if (!cm) continue;
      contentNum = Number(cm[1]);
    }
    const resources = parsePdfFontResources(body);
    if (!resources.size) continue;
    const decoders = new Map();
    for (const [name, fontObj] of resources) decoders.set(name, buildPdfFontDecoder(objects, fontObj));
    contentFonts.set(contentNum, decoders);
  }
  return contentFonts;
}

/** Decode one byte/code with a font decoder. */
function decodePdfCode(decoder, code, twoByte, hexKey) {
  if (twoByte) {
    if (decoder.map2.has(hexKey)) return decoder.map2.get(hexKey);
    if (decoder.map1.has(code)) return decoder.map1.get(code);
  } else if (decoder.map1.has(code)) {
    return decoder.map1.get(code);
  }
  if (decoder.differences.has(code)) {
    const uni = PDF_GLYPH_UNICODE[decoder.differences.get(code)];
    if (uni) return uni;
  }
  // Identity for ordinary ASCII; drop unmapped control/high codes.
  return code >= 0x20 && code <= 0x7e ? String.fromCharCode(code) : "";
}

/**
 * Tokenize a content stream in order, ignoring dictionaries (whose parenthesised
 * values such as /Lang (en-GB) are not shown text). Keeps strings and hex strings.
 */
function tokenizePdfContent(s) {
  const tokens = [];
  let i = 0;
  const n = s.length;
  while (i < n) {
    const c = s[i];
    if (/\s/.test(c)) { i++; continue; }
    if (c === "%") { while (i < n && s[i] !== "\n") i++; continue; }
    if (c === "<" && s[i + 1] === "<") {
      let depth = 0;
      while (i < n) {
        if (s[i] === "<" && s[i + 1] === "<") { depth++; i += 2; }
        else if (s[i] === ">" && s[i + 1] === ">") { depth--; i += 2; if (depth === 0) break; }
        else i++;
      }
      tokens.push({ t: "dict" });
      continue;
    }
    if (c === "(") {
      let depth = 0;
      let out = "";
      let j = i + 1;
      while (j < n) {
        const ch = s[j];
        if (ch === "\\") {
          j++;
          if (j >= n) break;
          const nx = s[j];
          if (nx === "n") { out += "\n"; j++; }
          else if (nx === "r") { out += "\r"; j++; }
          else if (nx === "t") { out += "\t"; j++; }
          else if (nx === "b") { out += "\b"; j++; }
          else if (nx === "f") { out += "\f"; j++; }
          else if (nx >= "0" && nx <= "7") {
            let oct = "";
            while (oct.length < 3 && j < n && s[j] >= "0" && s[j] <= "7") { oct += s[j]; j++; }
            out += String.fromCharCode(parseInt(oct, 8) & 0xff);
          } else if (nx === "\r") { j++; if (s[j] === "\n") j++; }
          else if (nx !== "\n") { out += nx; j++; }
          else j++;
          continue;
        }
        if (ch === "(") { depth++; out += "("; j++; continue; }
        if (ch === ")") { if (depth === 0) { j++; break; } depth--; out += ")"; j++; continue; }
        out += ch;
        j++;
      }
      tokens.push({ t: "str", v: out });
      i = j;
      continue;
    }
    if (c === "<") {
      const e = s.indexOf(">", i + 1);
      if (e < 0) break;
      tokens.push({ t: "hex", v: s.slice(i + 1, e).replace(/[^0-9A-Fa-f]/g, "") });
      i = e + 1;
      continue;
    }
    if (c === "/") {
      let j = i + 1;
      while (j < n && !/[\s/<>()[\]{}]/.test(s[j])) j++;
      tokens.push({ t: "name", v: s.slice(i + 1, j) });
      i = j;
      continue;
    }
    if (/[0-9.+-]/.test(c)) {
      let j = i;
      while (j < n && /[0-9.+-]/.test(s[j])) j++;
      tokens.push({ t: "num", v: s.slice(i, j) });
      i = j;
      continue;
    }
    if (/[A-Za-z'"]/.test(c)) {
      let j = i;
      while (j < n && /[A-Za-z'"]/.test(s[j])) j++;
      tokens.push({ t: "op", v: s.slice(i, j) });
      i = j;
      continue;
    }
    i++;
  }
  return tokens;
}

/** Decode a content stream using its font map (or raw latin1 if unavailable). */
function decodePdfContent(s, fontMap) {
  const tokens = tokenizePdfContent(s);
  let currentFont = null;
  let out = "";
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.t === "op" && token.v === "Tf") {
      for (let k = i - 1; k >= 0; k--) {
        if (tokens[k].t === "name") { currentFont = tokens[k].v; break; }
      }
    } else if (token.t === "str" || token.t === "hex") {
      const decoder = fontMap && fontMap.get(currentFont);
      if (!decoder) {
        if (token.t === "str" && token.v.trim()) out += token.v;
        continue;
      }
      // Type0 fonts use two-byte CIDs even inside literal (parenthesised)
      // strings. Reading those as Latin-1 drops glyphs such as π, + and ℝ.
      const twoByte = decoder.isType0 || decoder.map2.size >= 4;
      if (token.t === "hex") {
        const step = twoByte ? 4 : 2;
        for (let j = 0; j < token.v.length; j += step) {
          const key = token.v.slice(j, j + step).toUpperCase();
          out += decodePdfCode(decoder, parseInt(key, 16) || 0, twoByte, key);
        }
      } else if (twoByte) {
        for (let j = 0; j + 1 < token.v.length; j += 2) {
          const code = ((token.v.charCodeAt(j) & 0xff) << 8) | (token.v.charCodeAt(j + 1) & 0xff);
          out += decodePdfCode(decoder, code, true, code.toString(16).padStart(4, "0").toUpperCase());
        }
      } else {
        for (let j = 0; j < token.v.length; j++) {
          out += decodePdfCode(decoder, token.v.charCodeAt(j) & 0xff, false, "");
        }
      }
    }
  }
  return out;
}

/* ------------------------------------------------------------------------ *
 * 2D math reconstruction
 *
 * Fractions, radicals and superscripts in IB PDFs are not encoded as text: a
 * fraction is a horizontal rule with text above/below, a radical is a filled
 * vector path, and a superscript is a smaller, raised text run. We therefore
 * interpret enough of the content-stream graphics/text state to recover the
 * geometry, then fold it back into a readable linear form (π/6, √3, a²).
 * ------------------------------------------------------------------------ */

/** Product of PDF matrices [a,b,c,d,e,f] in row-vector (p * M) convention. */
function pdfMultiplyMatrix(a, b) {
  return [
    a[0] * b[0] + a[1] * b[2],
    a[0] * b[1] + a[1] * b[3],
    a[2] * b[0] + a[3] * b[2],
    a[2] * b[1] + a[3] * b[3],
    a[4] * b[0] + a[5] * b[2] + b[4],
    a[4] * b[1] + a[5] * b[3] + b[5],
  ];
}

function pdfTransformPoint(m, x, y) {
  return { x: m[0] * x + m[2] * y + m[4], y: m[1] * x + m[3] * y + m[5] };
}

/** Decode one string/hex token with the current font (shared by both renderers). */
function decodePdfTextToken(token, decoder) {
  if (!decoder) return token.t === "str" ? token.v : "";
  const twoByte = decoder.isType0 || decoder.map2.size >= 4;
  if (token.t === "hex") {
    let out = "";
    const step = twoByte ? 4 : 2;
    for (let j = 0; j < token.v.length; j += step) {
      const key = token.v.slice(j, j + step).toUpperCase();
      out += decodePdfCode(decoder, parseInt(key, 16) || 0, twoByte, key);
    }
    return out;
  }
  let out = "";
  if (twoByte) {
    for (let j = 0; j + 1 < token.v.length; j += 2) {
      const code = ((token.v.charCodeAt(j) & 0xff) << 8) | (token.v.charCodeAt(j + 1) & 0xff);
      out += decodePdfCode(decoder, code, true, code.toString(16).padStart(4, "0").toUpperCase());
    }
  } else {
    for (let j = 0; j < token.v.length; j++) {
      out += decodePdfCode(decoder, token.v.charCodeAt(j) & 0xff, false, "");
    }
  }
  return out;
}

const SUPERSCRIPT_CHARS = { 0: "\u2070", 1: "\u00b9", 2: "\u00b2", 3: "\u00b3",
  4: "\u2074", 5: "\u2075", 6: "\u2076", 7: "\u2077", 8: "\u2078", 9: "\u2079",
  "+": "\u207a", "-": "\u207b", "=": "\u207d", "(": "\u207d", ")": "\u207e" };
const SUBSCRIPT_CHARS = { 0: "\u2080", 1: "\u2081", 2: "\u2082", 3: "\u2083",
  4: "\u2084", 5: "\u2085", 6: "\u2086", 7: "\u2087", 8: "\u2088", 9: "\u2089",
  "+": "\u208a", "-": "\u208b", "=": "\u208c", "(": "\u208d", ")": "\u208e" };

function formatRaised(text, table, fallbackPrefix) {
  const s = String(text || "");
  if (!s) return "";
  if ([...s].every((c) => table[c])) return [...s].map((c) => table[c]).join("");
  return `${fallbackPrefix}{${s}}`;
}

function needsMathParens(text) {
  // Plain multi-character denominators such as "12" read better unparenthesised;
  // compound expressions (1+x², 2+√3) need grouping.
  return /[+\-=/√^({\s]/.test(String(text));
}

/**
 * Interpret a content stream into an ordered event list. Text events carry
 * page-space baselines and effective sizes; line/radical events carry the
 * vector geometry needed for fraction and radical reconstruction.
 */
function collectPdfContentEvents(s, fontMap) {
  const tokens = tokenizePdfContent(s);
  const events = [];
  const stateStack = [];
  const marks = [];
  let ctm = [1, 0, 0, 1, 0, 0];
  let tm = null;
  let tlm = null;
  let font = null;
  let fontSize = 1;
  let leading = 0;
  let path = [];
  let pathIsRect = false;
  let figureId = 0;
  let nextFigureId = 1;
  const scaleY = () => Math.sqrt(Math.abs(ctm[1] * ctm[2] - ctm[0] * ctm[3])) || 1;

  const emitText = (text) => {
    if (!text || !tm) return;
    const p = pdfTransformPoint(ctm, tm[4], tm[5]);
    events.push({
      type: "text",
      text,
      x: p.x,
      y: p.y,
      size: Math.abs(fontSize * tm[0]) * scaleY(),
      figureId,
    });
  };

  let operands = [];
  for (const token of tokens) {
    if (token.t !== "op") { operands.push(token); continue; }
    const op = token.v;
    const nums = () => operands.filter((o) => o.t === "num").map((o) => Number(o.v));
    const lastName = () => {
      for (let i = operands.length - 1; i >= 0; i--) if (operands[i].t === "name") return operands[i].v;
      return null;
    };

    if (op === "q") {
      stateStack.push({ ctm: ctm.slice(), tm: tm && tm.slice(), tlm: tlm && tlm.slice(),
        font, fontSize, leading });
    } else if (op === "Q") {
      const st = stateStack.pop();
      if (st) ({ ctm, tm, tlm, font, fontSize, leading } = st);
    } else if (op === "cm") {
      const m = nums();
      if (m.length === 6) ctm = pdfMultiplyMatrix(m, ctm);
    } else if (op === "BT") {
      tm = [1, 0, 0, 1, 0, 0];
      tlm = tm.slice();
    } else if (op === "ET") {
      tm = null;
      tlm = null;
    } else if (op === "Tf") {
      const names = nums();
      font = lastName();
      fontSize = names.length ? names[names.length - 1] : 1;
    } else if (op === "TL") {
      const n = nums();
      if (n.length) leading = n[n.length - 1];
    } else if (op === "Tm" || op === "Td" || op === "TD") {
      const n = nums();
      if (op === "Tm" && n.length === 6) {
        tm = n.slice();
        tlm = n.slice();
      } else if (n.length >= 2) {
        const [tx, ty] = n.slice(-2);
        if (op === "TD") leading = -ty;
        if (tlm) {
          tlm = pdfMultiplyMatrix([1, 0, 0, 1, tx, ty], tlm);
          tm = tlm.slice();
        }
      }
    } else if (op === "T*") {
      if (tlm) {
        tlm = pdfMultiplyMatrix([1, 0, 0, 1, 0, -leading], tlm);
        tm = tlm.slice();
      }
    } else if (op === "Tj" || op === "TJ" || op === "'" || op === '"') {
      const decoder = font && fontMap ? fontMap.get(font) : null;
      emitText(operands.filter((o) => o.t === "str" || o.t === "hex")
        .map((o) => decodePdfTextToken(o, decoder)).join(""));
    } else if (op === "m") {
      const n = nums();
      if (n.length >= 2) { path = [pdfTransformPoint(ctm, n[0], n[1])]; pathIsRect = false; }
    } else if (op === "l") {
      const n = nums();
      if (n.length >= 2 && path.length) path.push(pdfTransformPoint(ctm, n[0], n[1]));
    } else if (op === "c") {
      const n = nums();
      if (n.length >= 6 && path.length) {
        path.push(pdfTransformPoint(ctm, n[0], n[1]), pdfTransformPoint(ctm, n[2], n[3]),
          pdfTransformPoint(ctm, n[4], n[5]));
      }
    } else if (op === "re") {
      const n = nums();
      if (n.length >= 4) {
        const [x, y, w, h] = n.slice(-4);
        path = [pdfTransformPoint(ctm, x, y), pdfTransformPoint(ctm, x + w, y),
          pdfTransformPoint(ctm, x + w, y + h), pdfTransformPoint(ctm, x, y + h)];
        pathIsRect = true;
      }
    } else if (op === "S" || op === "s") {
      if (path.length === 2) {
        const [a, b] = path;
        if (Math.abs(a.y - b.y) <= 0.8 && Math.abs(a.x - b.x) >= 3) {
          events.push({ type: "line", x1: Math.min(a.x, b.x), x2: Math.max(a.x, b.x),
            y: (a.y + b.y) / 2, figureId });
        }
      }
      path = [];
    } else if (op === "f" || op === "F" || op === "f*" || op === "B" || op === "b") {
      if (!pathIsRect && path.length >= 6) {
        const xs = path.map((p) => p.x);
        const ys = path.map((p) => p.y);
        const x1 = Math.min(...xs), x2 = Math.max(...xs);
        const y1 = Math.min(...ys), y2 = Math.max(...ys);
        const w = x2 - x1, h = y2 - y1;
        if (w >= 4 && w <= 40 && h >= 4 && h <= 40 && w / h >= 0.35 && w / h <= 2.8) {
          events.push({ type: "radical", x1, x2, y1, y2, figureId });
        }
      }
      path = [];
    } else if (op === "n") {
      path = [];
    } else if (op === "BDC") {
      const isFigure = operands.some((o) => o.t === "name" && o.v === "Figure");
      const id = isFigure ? nextFigureId++ : 0;
      marks.push(id);
      if (isFigure) figureId = id;
    } else if (op === "EMC") {
      marks.pop();
      figureId = 0;
      for (let i = marks.length - 1; i >= 0; i--) {
        if (marks[i] > 0) { figureId = marks[i]; break; }
      }
    }
    operands = [];
  }
  return events;
}

/** Fold a figure's text runs, rules and radical paths into one math string. */
function reconstructFigureMath(block) {
  const runs = block.filter((e) => e.type === "text" && e.text.trim());
  if (!runs.length) return "";
  // Work at glyph level: a single run such as "3i" can contain both the
  // radicand and the text following the radical.
  const atoms = [];
  for (const r of runs) {
    const advance = r.size * 0.52;
    [...r.text].forEach((ch, idx) => atoms.push({
      text: ch, x: r.x + idx * advance, y: r.y, size: r.size, used: false,
    }));
  }
  const byPosition = (a, b) => a.x - b.x || b.y - a.y;

  // Superscripts/subscripts inside a figure: smaller text raised above its base.
  for (const atom of atoms) {
    const bases = atoms.filter((b) => b !== atom && b.x < atom.x && b.x > atom.x - 30 && !b.used);
    if (!bases.length) continue;
    const base = bases.reduce((best, b) => (b.x > best.x ? b : best));
    if (atom.size < base.size * 0.86 && atom.y > base.y + 1.2) {
      base.text += formatRaised(atom.text, SUPERSCRIPT_CHARS, "^");
      atom.used = true;
    } else if (atom.size < base.size * 0.86 && atom.y < base.y - 1.2) {
      base.text += formatRaised(atom.text, SUBSCRIPT_CHARS, "_");
      atom.used = true;
    }
  }

  // Radicals: the filled check path plus the glyphs beneath its overbar (the
  // right-hand part of the path). This keeps trailing text outside the radical.
  for (const rad of block.filter((e) => e.type === "radical")) {
    const width = rad.x2 - rad.x1;
    const candidates = atoms.filter((a) => !a.used && a.x >= rad.x1 + width * 0.45 && a.x <= rad.x2 + 3 &&
      a.y >= rad.y1 - 12 && a.y <= rad.y2 + 14);
    if (!candidates.length) continue;
    candidates.sort(byPosition);
    const radicand = candidates.map((a) => a.text).join("");
    candidates.forEach((a) => { a.used = true; });
    atoms.push({ text: needsMathParens(radicand) ? `√(${radicand})` : `√${radicand}`,
      x: rad.x1, y: rad.y1, size: candidates[0].size, used: false });
  }

  // Fractions: top bar first so nested fractions collapse into their parent.
  // A rule just above a radical is that radical's overbar, not a fraction.
  const bars = block.filter((e) => e.type === "line" && !block.some((r) =>
    r.type === "radical" && e.y > r.y2 - 1 && e.y < r.y2 + 20 &&
    e.x1 <= r.x2 + 20 && e.x2 >= r.x1 - 40)).sort((a, b) => b.y - a.y);
  for (const bar of bars) {
    const above = atoms.filter((a) => !a.used && a.x >= bar.x1 - 4 && a.x <= bar.x2 + 4 &&
      a.y > bar.y + 0.5);
    const below = atoms.filter((a) => !a.used && a.x >= bar.x1 - 4 && a.x <= bar.x2 + 4 &&
      a.y < bar.y - 0.5);
    if (!above.length || !below.length) continue;
    above.sort(byPosition); below.sort(byPosition);
    const num = above.map((a) => a.text).join("");
    const den = below.map((a) => a.text).join("");
    above.concat(below).forEach((a) => { a.used = true; });
    atoms.push({ text: `${needsMathParens(num) ? `(${num})` : num}/${needsMathParens(den) ? `(${den})` : den}`,
      x: (bar.x1 + bar.x2) / 2, y: bar.y,
      size: Math.max(...above.concat(below).map((a) => a.size)), used: false });
  }

  return atoms.filter((a) => !a.used).sort(byPosition).map((a) => a.text).join("");
}

/** Render a stream with 2D math reconstruction, falling back where uncertain. */
function decodePdfContent2D(s, fontMap) {
  const events = collectPdfContentEvents(s, fontMap);
  if (!events.some((e) => e.type === "text")) return decodePdfContent(s, fontMap);
  let out = "";
  let prev = null;
  let baseRef = null;
  let raised = "";
  let raisedKind = "";
  const flushRaised = () => {
    if (raised) out += formatRaised(raised,
      raisedKind === "sub" ? SUBSCRIPT_CHARS : SUPERSCRIPT_CHARS,
      raisedKind === "sub" ? "_" : "^");
    raised = "";
    raisedKind = "";
  };
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    if (e.figureId) {
      const block = [];
      while (i < events.length && events[i].figureId === e.figureId) block.push(events[i++]);
      i--;
      flushRaised();
      out += reconstructFigureMath(block);
      prev = null;
      baseRef = null;
      continue;
    }
    if (e.type !== "text" || !e.text) continue;
    const ref = raised && baseRef ? baseRef : prev;
    let kind = "";
    // Restrict to short math-like runs; otherwise size/baseline differences in
    // prose (titles, captions) would be misread as superscripts/subscripts.
    const mathLike = ref && ref.text.length <= 3 && e.text.length <= 4 &&
      ref.size >= 8 && e.size >= 4 && Math.abs(e.x - ref.x) < 80;
    if (mathLike) {
      if (e.size < ref.size * 0.86 && e.y > ref.y + 1.2) kind = "sup";
      else if (e.size < ref.size * 0.86 && e.y < ref.y - 1.2) kind = "sub";
    }
    if (kind) {
      if (raisedKind && raisedKind !== kind) flushRaised();
      raisedKind = kind;
      raised += e.text;
    } else {
      flushRaised();
      out += e.text;
      baseRef = e;
    }
    prev = e;
  }
  flushRaised();
  return out;
}

/** Best-effort check that decoded text is real text, not a binary font blob. */
function isDecodedPdfTextReadable(text) {
  if (!text || text.length < 8) return false;
  let good = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 9 || c === 10 || c === 13 || c === 32 ||
        (c >= 0x21 && c <= 0x7e) || (c >= 0xa0 && c <= 0x24f) ||
        (c >= 0x370 && c <= 0x3ff) || (c >= 0x2000 && c <= 0x2bff) ||
        (c >= 0xf000 && c <= 0xf0ff)) good++;
  }
  return good / text.length >= 0.98 && good >= 8;
}

/**
 * Best-effort font-aware text extraction from a PDF Buffer using only zlib.
 * Tracks each stream's font and decodes its ToUnicode CMap / glyph names so
 * subset-font numbers and symbols (e.g. fractions, ≤, π) come out readable.
 * Returns "" when no readable text is found.
 */
function extractPdfText(buffer) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) return "";
  const objects = parsePdfObjects(buffer);
  const contentFonts = buildPdfContentFontMaps(objects);
  const texts = [];
  const addStream = (stream, fontMap) => {
    if (!/BT[\s\S]*?ET/.test(stream)) return;
    const linear = decodePdfContent(stream, fontMap);
    let decoded = fontMap ? decodePdfContent2D(stream, fontMap) : linear;
    // Never regress to an empty result if the interpreter cannot read a stream.
    if (!decoded.trim() && linear.trim()) decoded = linear;
    if (decoded.trim() && isDecodedPdfTextReadable(decoded)) texts.push(decoded);
  };

  if (objects.size) {
    for (const [num, body] of objects) addStream(pdfStreamOf(body), contentFonts.get(num));
  } else {
    // Fallback for tiny/synthetic PDFs without a parseable object table.
    const raw = buffer.toString("latin1");
    const streamRe = /stream\r?\n([\s\S]*?)endstream/g;
    let m;
    while ((m = streamRe.exec(raw))) addStream(inflatePdfStream(m[1].replace(/\r?\n$/, "")), null);
  }
  return cleanPdfText(texts.join("\n"));
}

/** Compact comparison form: lower-case alphanumeric only. */
function compact(s) {
  return String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** Topic words longer than 2 characters, used for scoring/snippets. */
function topicWords(topic) {
  return String(topic || "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 2);
}

/** Score a document name against the topic (exact phrase wins, then words). */
function scoreName(name, topic) {
  const cName = compact(name);
  const cTopic = compact(topic);
  if (!cTopic) return 0;
  if (cName.includes(cTopic)) return 100;
  const words = topicWords(topic);
  let score = 0;
  for (const w of words) if (cName.includes(w)) score += 10;
  return score;
}

/** Find a readable snippet around the first topic match in extracted PDF text. */
function snippetFor(text, topic, maxLength = 420) {
  if (!text) return "";
  const words = topicWords(topic);
  const cText = compact(text);
  let pos = -1;
  const cTopic = compact(topic);
  if (cTopic) pos = cText.indexOf(cTopic);
  if (pos < 0) {
    for (const w of words) {
      pos = cText.indexOf(w);
      if (pos >= 0) break;
    }
  }
  // compact() removed non-alphanumerics, so map back approximately by walking
  // the original string until we have consumed `pos` alphanumeric characters.
  let index = 0;
  if (pos >= 0) {
    let seen = 0;
    for (let i = 0; i < text.length && seen < pos; i++) {
      if (/[a-z0-9]/i.test(text[i])) seen++;
      index = i + 1;
    }
  } else {
    index = 0;
  }
  const start = Math.max(0, index - 120);
  const snippet = text.slice(start, start + maxLength).replace(/\s+/g, " ").trim();
  return start > 0 ? `…${snippet}` : snippet;
}

module.exports = {
  BASE_URL,
  IB_ROOT,
  DEFAULT_YEARS,
  DEFAULT_CATEGORIES,
  SUBJECT_CATEGORIES,
  SUBJECT_FILE_PATTERNS,
  isAllowedXtremePapersUrl,
  isAbortSignal,
  decodeHtml,
  subjectKey,
  subjectCategory,
  subjectFilePattern,
  encodeDirSegment,
  listingUrl,
  dirpathFromHref,
  decodeDirpath,
  fetchPage,
  fetchBinary,
  extractRows,
  yearFolders,
  sessionFolders,
  categoryFolders,
  pdfRows,
  pdfMetadata,
  markschemeFor,
  extractPdfText,
  cleanPdfText,
  isReadableStream,
  isDecodedPdfTextReadable,
  parsePdfCMap,
  parsePdfEncodingDifferences,
  parsePdfObjects,
  pdfStreamOf,
  buildPdfFontDecoder,
  parsePdfFontResources,
  buildPdfContentFontMaps,
  tokenizePdfContent,
  decodePdfCode,
  decodePdfContent,
  decodePdfTextToken,
  collectPdfContentEvents,
  reconstructFigureMath,
  decodePdfContent2D,
  compact,
  topicWords,
  scoreName,
  snippetFor,
};
