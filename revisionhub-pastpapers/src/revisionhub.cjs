/**
 * RevisionHub content access helpers.
 *
 * RevisionHub (https://revisionhub.study) is a Next.js App Router application
 * guarded by Clerk authentication. There is no public data API: question and
 * paper content is server-rendered into the page (including the RSC flight
 * payload embedded in <script>self.__next_f.push(...)</script> tags).
 *
 * This module therefore does the following:
 *   1. Fetches a RevisionHub page with the learner's own session cookie.
 *   2. Detects sign-in redirects and reports a clear configuration error.
 *   3. Extracts question / mark-scheme content from the RSC payload and the
 *      rendered HTML using a set of conservative heuristics.
 *
 * It is intentionally defensive: it never invents content and it reports when
 * extraction is uncertain so the teacher can fall back to normal teaching.
 */

"use strict";

const DEFAULT_BASE_URL = "https://revisionhub.study";
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

/** Normalise a pasted cookie string. Accepts either a raw Cookie header or newline-separated pairs. */
function normaliseCookie(raw) {
  if (typeof raw !== "string") return "";
  return raw
    .split(/[\n;]/)
    .map((p) => p.trim())
    .filter(Boolean)
    .join("; ");
}

/** True when the URL is a revisionhub.study HTTPS URL (host or subdomain). */
function isAllowedRevisionHubUrl(raw) {
  try {
    const u = new URL(raw);
    if (u.protocol !== "https:") return false;
    return u.hostname === "revisionhub.study" || u.hostname.endsWith(".revisionhub.study");
  } catch {
    return false;
  }
}

/** Build a canonical RevisionHub URL from a user-supplied URL or bare question id. */
function resolveTarget(input) {
  if (!input || typeof input !== "object") return null;
  const raw = (input.url || input.questionUrl || input.paperUrl || "").trim();
  if (raw) {
    let url;
    if (/^\d+$/.test(raw)) url = `${DEFAULT_BASE_URL}/question/${raw}`;
    else if (/^https?:\/\//i.test(raw)) url = raw;
    else url = `${DEFAULT_BASE_URL}/${raw.replace(/^\/+/, "")}`;
    if (!isAllowedRevisionHubUrl(url)) return null;
    return { kind: inferKind(url), url };
  }
  if (input.questionId !== undefined && input.questionId !== null && String(input.questionId).trim()) {
    const id = String(input.questionId).trim();
    if (!/^\d+$/.test(id)) return null;
    return { kind: "question", url: `${DEFAULT_BASE_URL}/question/${id}` };
  }
  return null;
}

function inferKind(url) {
  if (/\/question\/\d+/.test(url)) return "question";
  if (/\/papers(\/|$)/.test(url)) return "papers";
  if (/\/questionbank(\/|$)/.test(url)) return "questionbank";
  if (/\/ib\//.test(url)) return "subject";
  return "page";
}

/**
 * Fetch a RevisionHub page with the supplied session cookie.
 * Returns { url, html, redirectedToSignIn }.
 */
async function fetchPage(url, cookieString, signal) {
  const headers = {
    Accept: "text/html,application/xhtml+xml",
    "Accept-Language": "en-US,en;q=0.9",
    "User-Agent": USER_AGENT,
  };
  const cookie = normaliseCookie(cookieString);
  if (cookie) headers.Cookie = cookie;

  const response = await fetch(url, {
    method: "GET",
    headers,
    redirect: "manual",
    signal: signal && typeof signal.aborted === "boolean" ? signal : undefined,
  });

  const location = response.headers.get("location") || "";
  // Clerk guards this app. An expired __session produces a 307 to either the
  // sign-in page (no valid session at all) or Clerk's /v1/client/handshake
  // endpoint (session token present but stale). Both mean "not authenticated",
  // so treat them the same way rather than parsing an empty body as results.
  const authRedirect =
    /sign-in|sign-up/.test(location) ||
    (/clerk\.revisionhub\.study/.test(location) && /handshake/i.test(location));
  if (response.status >= 300 && response.status < 400 && authRedirect) {
    return { url: location || url, html: "", redirectedToSignIn: true, status: response.status };
  }

  // Next.js middleware may also rewrite signed-out requests to /sign-up with a 200.
  const finalUrl = response.url || url;
  const html = await response.text();
  if (/\/sign-up|\/sign-in/.test(finalUrl) || /Create your RevisionHub account/.test(html)) {
    return { url: finalUrl, html, redirectedToSignIn: true, status: response.status };
  }
  return { url: finalUrl, html, redirectedToSignIn: false, status: response.status };
}

/** Decode the escaped strings that Next.js streams via self.__next_f.push([1,"..."]). */
function extractFlightStrings(html) {
  const strings = [];
  const re = /self\.__next_f\.push\(\[1,("(?:[^"\\]|\\.)*")\]\)/g;
  let match;
  while ((match = re.exec(html))) {
    try {
      const decoded = JSON.parse(match[1]);
      if (typeof decoded === "string" && decoded.length > 0) strings.push(decoded);
    } catch {
      // Ignore malformed chunks.
    }
  }
  return strings;
}

/** Extract substrings assigned to a named JSON field across flight strings and raw HTML. */
function findJsonFields(sources, fieldNames) {
  const out = [];
  for (const source of sources) {
    for (const field of fieldNames) {
      // Match both quoted keys ("questionMarkdown":"...") and React-style arrays where
      // the value follows the key as a neighbouring string.
      const quoted = new RegExp(`"${field}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`, "g");
      let m;
      while ((m = quoted.exec(source))) {
        try {
          const value = JSON.parse(`"${m[1]}"`);
          if (typeof value === "string" && value.trim()) out.push({ field, value });
        } catch {
          out.push({ field, value: m[1] });
        }
      }
    }
  }
  return out;
}

/** Convert a limited subset of Markdown to plain text for clean display. */
function markdownToPlainText(md) {
  if (typeof md !== "string") return "";
  return md
    .replace(/```[\s\S]*?```/g, (block) => block.replace(/^```[^\n]*\n?/, "").replace(/```$/, ""))
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}#{1,6}\s*/gm, "")
    .replace(/^\s{0,3}>\s?/gm, "")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/^\s*[-*+]\s+/gm, "• ")
    .trim();
}

/** Strip HTML tags and unescape entities as a last-resort text extractor. */
function htmlToText(html) {
  return html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/\s+/g, " ")
    .trim();
}

/** Pull question-shaped text out of a flight string using lightweight heuristics. */
function lookForQuestionText(strings) {
  const candidates = [];
  const markers = ["question", "markscheme", "mark scheme", "answer", "solution", "part (a)", "a)", "show that", "calculate", "determine", "explain"];
  for (const s of strings) {
    // Split very long flight strings into paragraph-ish chunks.
    const chunks = s.split(/\n{2,}|\\n{2,}/);
    for (const chunk of chunks) {
      const plain = markdownToPlainText(chunk);
      if (plain.length < 40 || plain.length > 12000) continue;
      const lower = plain.toLowerCase();
      const score = markers.reduce((n, m) => n + (lower.includes(m) ? 1 : 0), 0);
      if (score >= 2 || /\d+\s*marks?\b/i.test(plain) || /\[\s*\d+\s*mark/i.test(plain)) {
        candidates.push(plain);
      }
    }
  }
  // Prefer the longest candidate with the most marker hits, deduplicated.
  const unique = [...new Set(candidates)];
  unique.sort((a, b) => b.length - a.length);
  return unique;
}

/**
 * Extract a single question and its mark scheme from a question page.
 * Returns { question, markscheme, confidence } or null on failure.
 */
function extractQuestion(html, url) {
  const flight = extractFlightStrings(html);
  const fields = findJsonFields(flight, [
    "questionMarkdown",
    "answerMarkdown",
    "markschemeMarkdown",
    "markSchemeMarkdown",
    "questionText",
    "markScheme",
    "markscheme",
    "content",
  ]);

  let question = "";
  let markscheme = "";

  for (const f of fields) {
    const plain = markdownToPlainText(f.value);
    if (!plain) continue;
    // Be careful: "questionMarkdown" contains the substring "mark". Classify
    // mark-scheme fields by the explicit words "answer" or "markscheme".
    const isQuestionField = /question/i.test(f.field);
    const isMarkField = /answer/i.test(f.field) || /markscheme/i.test(f.field);
    if (isQuestionField && plain.length > question.length) question = plain;
    if (isMarkField && plain.length > markscheme.length) markscheme = plain;
  }

  // Fall back to heuristic scanning of flight strings.
  if (!question) {
    const candidates = lookForQuestionText(flight);
    if (candidates.length) question = candidates[0];
  }

  // Last resort: visible text from the rendered DOM.
  if (!question) {
    const text = htmlToText(html);
    const idx = text.toLowerCase().indexOf("question");
    if (idx >= 0) question = text.slice(idx, idx + 4000).trim();
  }

  if (!question) return null;

  // If the mark scheme was not found structurally, try to locate it after the
  // question in the visible text.
  if (!markscheme) {
    const text = htmlToText(html);
    const lower = text.toLowerCase();
    for (const needle of ["markscheme", "mark scheme", "answer"]) {
      const idx = lower.indexOf(needle);
      if (idx >= 0) {
        markscheme = text.slice(idx, idx + 4000).trim();
        break;
      }
    }
  }

  return {
    question: question.slice(0, 12000),
    markscheme: markscheme ? markscheme.slice(0, 12000) : "",
    confidence: question ? (fields.length ? "high" : "low") : "none",
    sourceUrl: url,
  };
}

/** Extract question links from a paper / questionbank listing page. */
function extractQuestionLinks(html, baseUrl) {
  const links = [];
  const re = /href=["']([^"']*\/question\/\d+[^"']*)["']/g;
  let m;
  while ((m = re.exec(html))) {
    try {
      const u = new URL(m[1], baseUrl);
      if (isAllowedRevisionHubUrl(u.href)) links.push(u.href);
    } catch {
      /* ignore */
    }
  }
  return [...new Set(links)].slice(0, 200);
}

/**
 * Build candidate search URLs for a topic query.
 *
 * The exact query parameter used by RevisionHub's /search page is not part of
 * any public contract, so we try the common conventions in priority order. The
 * backend will use the first candidate that returns question results. A subject
 * hint is forwarded as well (best-effort) when provided.
 */
function buildSearchUrls(topic, subject) {
  const base = `${DEFAULT_BASE_URL}/search`;
  // Verified against the live site: the search input's paramKey is "query".
  const params = ["query", "q", "search", "term"];
  const urls = [];
  for (const p of params) {
    const u = new URL(base);
    u.searchParams.set(p, topic);
    if (subject) u.searchParams.set("subject", subject);
    urls.push(u.href);
  }
  // Deduplicate (in case a param collides with a literal topic) while preserving order.
  return [...new Set(urls)];
}

/** Known subject path slugs used by RevisionHub, for mapping a subject hint to a questionbank URL. */
const SUBJECT_PATHS = {
  "business management": "Individuals-and-Societies/Business-Management",
  economics: "Individuals-and-Societies/Economics",
  "math aa": "Mathematics/Mathematics-Analysis-and-Approaches",
  "mathematics analysis and approaches": "Mathematics/Mathematics-Analysis-and-Approaches",
  "math ai": "Mathematics/Mathematics-Applications-and-Interpretation",
  "mathematics applications and interpretation": "Mathematics/Mathematics-Applications-and-Interpretation",
  biology: "Sciences/Biology",
  chemistry: "Sciences/Chemistry",
  physics: "Sciences/Physics",
};

/** Build subject-scoped topic URLs (questionbank pages with topic filters). */
function buildSubjectTopicUrls(topic, subject) {
  if (!subject) return [];
  const key = subject.trim().toLowerCase();
  const path = SUBJECT_PATHS[key];
  if (!path) return [];
  const urls = [];
  for (const p of ["query", "q", "search", "topic"]) {
    const u = new URL(`${DEFAULT_BASE_URL}/ib/${path}/questionbank`);
    u.searchParams.set(p, topic);
    urls.push(u.href);
  }
  return urls;
}

/** Decode a JSON string literal captured from an RSC flight payload. */
function decodeFlightString(raw) {
  try {
    const value = JSON.parse(`"${raw}"`);
    return typeof value === "string" ? value : raw;
  } catch {
    return raw;
  }
}

/**
 * Parse search results from a search / questionbank results page.
 * Returns an array of { id, url, snippet, examTitle } ordered by appearance.
 *
 * The live search page renders each result into the RSC payload as roughly:
 *   ["$","$L3f","555",{"questionId":555,"questionNumber":"7",
 *    "examTitle":"Mathematics ... 2025", ... "line-clamp-3","children":"<snippet>"}]]
 * We parse that structure first, then fall back to plain /question/:id links.
 */
function extractSearchResults(html, baseUrl) {
  const results = new Map();
  const flight = extractFlightStrings(html);

  // 1) Structured RSC result entries (id + exam title + question snippet).
  for (const raw of flight) {
    // Flight chunks may contain JSON quotes escaped one level deeper.
    const s = raw.includes('\\"') ? raw.replace(/\\"/g, '"') : raw;
    const re = /"questionId"\s*:\s*(\d+)/g;
    let m;
    while ((m = re.exec(s))) {
      const id = m[1];
      const next = s.indexOf('"questionId"', m.index + 1);
      const block = next > 0 ? s.slice(m.index, next) : s.slice(m.index, m.index + 4000);
      const examMatch = block.match(/"examTitle"\s*:\s*"((?:[^"\\]|\\.)*)"/);
      const snippetMatch = block.match(/line-clamp-3"\s*,\s*"children"\s*:\s*"((?:[^"\\]|\\.)*)"/);
      const examTitle = examMatch ? decodeFlightString(examMatch[1]) : "";
      const snippet = snippetMatch ? decodeFlightString(snippetMatch[1]) : "";
      if (!results.has(id)) {
        results.set(id, { id, url: `${DEFAULT_BASE_URL}/question/${id}`, snippet: snippet.slice(0, 500), examTitle });
      } else if (!results.get(id).snippet && snippet) {
        results.get(id).snippet = snippet.slice(0, 500);
        results.get(id).examTitle = examTitle;
      }
    }
  }

  // 2) Rendered question links (covers ids not present in the flight payload).
  for (const link of extractQuestionLinks(html, baseUrl)) {
    const id = (link.match(/\/question\/(\d+)/) || [])[1];
    if (id && !results.has(id)) results.set(id, { id, url: link, snippet: "", examTitle: "" });
  }

  // 3) If there are still no results, expose question-shaped text so the
  //    teacher at least gets search context rather than an empty tool output.
  if (!results.size) {
    for (const text of lookForQuestionText(flight).slice(0, 10)) {
      results.set(`text_${results.size}`, { id: "", url: "", snippet: text.slice(0, 500), examTitle: "" });
    }
  }

  return [...results.values()].slice(0, 25);
}

/** Derive display metadata (subject / paper / topic) from the URL path when possible. */
function metadataFromUrl(url) {
  const out = { subject: "", paper: "", topic: "" };
  try {
    const u = new URL(url);
    const parts = u.pathname.split("/").filter(Boolean);
    const ibIndex = parts.indexOf("ib");
    if (ibIndex >= 0 && parts[ibIndex + 1]) out.subject = decodeURIComponent(parts[ibIndex + 1]);
    if (ibIndex >= 0 && parts[ibIndex + 2]) out.subject = decodeURIComponent(parts[ibIndex + 2]);
    const paperMatch = u.pathname.match(/\/(\d{4}-[A-Za-z]+-paper\d+-[A-Za-z0-9-]+)/);
    if (paperMatch) out.paper = paperMatch[1];
    const q = u.searchParams.get("topic");
    if (q) out.topic = q;
  } catch {
    /* ignore */
  }
  return out;
}

/**
 * List Next.js static chunk paths referenced by a page. Used by the diagnostic
 * handler to discover which client chunk implements a route (e.g. /search)
 * so its query-parameter convention can be inspected.
 */
function extractScriptChunks(html) {
  if (typeof html !== "string") return [];
  const normalized = html.replace(/\\\//g, "/");
  const paths = new Set();
  const re = /static\/chunks\/[^"'\s<>]+?\.js/g;
  let m;
  while ((m = re.exec(normalized))) paths.add(m[0]);
  return [...paths].sort();
}

module.exports = {
  DEFAULT_BASE_URL,
  isAllowedRevisionHubUrl,
  resolveTarget,
  fetchPage,
  extractFlightStrings,
  findJsonFields,
  markdownToPlainText,
  htmlToText,
  extractQuestion,
  extractQuestionLinks,
  buildSearchUrls,
  buildSubjectTopicUrls,
  extractSearchResults,
  extractScriptChunks,
  metadataFromUrl,
};
