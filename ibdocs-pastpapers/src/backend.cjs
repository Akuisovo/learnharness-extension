/**
 * IB Documents past papers — plugin backend (Node CommonJS).
 *
 * Registers:
 *   - an "ibdocs-pastpaper" teaching question type (host-built tool)
 *   - a fetch_ibdocs_pastpaper tool that finds IB past-paper questions on
 *     ibdocs.re by topic (including PDF text search), by document URL/id, or
 *     from learner-pasted text
 *   - additive teacher instructions
 *   - ctx.handle operations used by the frontend Settings view
 *
 * ibdocs.re is public — no session cookie is required.
 */

"use strict";

const fs = require("node:fs");
const path = require("node:path");
const ib = require("./ibdocs.cjs");

const QUESTION_TYPE_ID = "ibdocs-pastpaper";
const TEACH_TOOL_NAME = "ask_ibdocs_pastpaper_question";
const FETCH_TOOL_NAME = "fetch_ibdocs_pastpaper";
const PAPERS_FILE = "papers.json";

const questionSchema = {
  type: "object",
  properties: {
    question: {
      type: "string",
      minLength: 1,
      description: "Learner-visible question text in Markdown. Keep the exact exam wording here.",
    },
    sourceUrl: { type: "string", description: "ibdocs.re document URL the question came from." },
    pdfUrl: { type: "string", description: "Direct PDF URL for the source document." },
    subject: { type: "string", description: "Subject name, e.g. Physics or Mathematics Analysis and Approaches." },
    paper: { type: "string", description: "Paper reference such as 2025-November-Paper-1-HL." },
    topic: { type: "string", description: "Topic or sub-topic classification." },
    markscheme: {
      type: "string",
      description: "Mark scheme / answer guidance in Markdown. Revealed only after the learner answers.",
    },
  },
  required: ["question"],
  additionalProperties: false,
};

const answerSchema = { type: "string", minLength: 1 };

function validateQuestionPayload(input) {
  const errors = [];
  const payload = input && input.payload;
  if (!payload || typeof payload !== "object") {
    return ["A payload object with a 'question' string is required."];
  }
  if (typeof payload.question !== "string" || !payload.question.trim()) {
    errors.push("payload.question must contain non-whitespace text.");
  }
  for (const field of ["sourceUrl", "pdfUrl"]) {
    if (payload[field] !== undefined) {
      if (typeof payload[field] !== "string") errors.push(`payload.${field} must be a string.`);
      else if (!ib.isAllowedIbdocsUrl(payload[field])) {
        errors.push(`payload.${field} must be a https://ibdocs.re URL.`);
      }
    }
  }
  return errors.length ? errors : undefined;
}

const questionType = {
  id: QUESTION_TYPE_ID,
  label: "IB Docs past-paper question",
  contractVersion: 1,
  showThinking: true,
  questionSchema,
  answerSchema,
  teach: {
    toolName: TEACH_TOOL_NAME,
    description:
      "Ask the learner an IB past-paper question sourced from ibdocs.re. Supply the exam wording in 'question' and, when available, 'markscheme', 'sourceUrl', 'pdfUrl', 'subject', 'paper' and 'topic'. The mark scheme is revealed only after the learner answers.",
  },
  validateQuestion({ input }) {
    return validateQuestionPayload(input);
  },
};

const TEACHER_INSTRUCTIONS = [
  "An IB Documents (ibdocs.re) past-paper integration is available; it needs no login.",
  "When the lesson calls for an IB past-paper or exam-style question, search by TOPIC first: call fetch_ibdocs_pastpaper with {search:true, topic:'<topic>', subject:'<subject if known>', autoFetch:true}. This downloads a small, bounded set of real past-paper PDFs from ibdocs.re, searches their text, and returns matching excerpts with source links.",
  "If a subject hint is supplied, the search is limited to that subject for speed and relevance. Common hints: 'math aa', 'math ai', 'physics', 'chemistry', 'biology', 'economics', 'business management'.",
  "You may also fetch a specific document with {url:'https://ibdocs.re/documents/...'} or a bare document id, and list the rows of a folder with {list:true, url:'<folder url>'}.",
  "Check the returned 'fetched' field for the full excerpt and source links. Topic search returns snippets from real PDFs — quote them faithfully and do not invent wording or a source URL.",
  "After retrieving a question, pose exactly one using ask_ibdocs_pastpaper_question. Put the exam wording in 'question' and any mark-scheme text in 'markscheme'. Include sourceUrl, pdfUrl, subject, paper and topic when known.",
  "The mark scheme is revealed only after the learner answers; do not show it in your teaching text before the question is posed.",
  "You may also use {add:true, question, markscheme?, subject?, paper?, topic?, sourceUrl?, pdfUrl?} to save learner-pasted past-paper text into the plugin's local store, and {useStored:true} to retrieve a saved item.",
  "Respect the source material: it is for personal study. Do not bulk-download or redistribute the archive.",
].join(" ");

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    if (e.code === "ENOENT") return fallback;
    throw e;
  }
}

function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file);
}

function assertObject(input, label) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error(`${label} must be an object.`);
  }
  return input;
}

/** Cancellation check that tolerates a missing/non-standard signal. */
function isAborted(...signals) {
  return signals.some((s) => !!(s && s.aborted));
}

/** Resolve a user URL / bare id to an ibdocs.re target. */
function resolveTarget(input) {
  if (!input || typeof input !== "object") return null;
  const raw = String(input.url || input.documentUrl || input.documentId || "").trim();
  if (!raw) return null;
  let url;
  if (/^https?:\/\//i.test(raw)) url = raw;
  else if (/^ibdocs\.re\//i.test(raw)) url = `https://${raw}`;
  else url = `${ib.BASE_URL}/documents/${encodeURIComponent(raw)}`;
  if (!ib.isAllowedIbdocsUrl(url)) return null;
  const kind = /\/p\/.*\.pdf$/i.test(url) ? "pdf" : /\/documents\//i.test(url) ? "document" : "listing";
  return { kind, url };
}

exports.activate = (ctx) => {
  const papersFile = path.join(ctx.dataDirectory, PAPERS_FILE);
  let papers = readJson(papersFile, []);
  if (!Array.isArray(papers)) papers = [];
  const savePapers = (next) => {
    papers = next;
    writeJsonAtomic(papersFile, papers);
  };

  // Small in-memory cache so repeated searches do not re-download the same PDFs.
  const pdfCache = new Map();

  async function pdfText(pdfUrl, signal) {
    if (pdfCache.has(pdfUrl)) return pdfCache.get(pdfUrl);
    const buffer = await ib.fetchBinary(pdfUrl, signal);
    const text = ib.extractPdfText(buffer);
    if (pdfCache.size > 40) pdfCache.clear();
    pdfCache.set(pdfUrl, text);
    return text;
  }

  // --- Frontend operations -------------------------------------------------
  ctx.handle("getStatus", () => ({
    configured: true,
    storedCount: papers.length,
    baseUrl: ib.BASE_URL,
  }));

  ctx.handle("listPapers", () => papers.map((p) => ({
    id: p.id,
    question: typeof p.question === "string" ? p.question.slice(0, 200) : "",
    subject: p.subject || "",
    sourceUrl: p.sourceUrl || "",
    createdAt: p.createdAt || "",
  })));

  ctx.handle("deletePaper", (input) => {
    const id = String(assertObject(input, "Input").id || "");
    const next = papers.filter((p) => String(p.id) !== id);
    savePapers(next);
    return { storedCount: next.length };
  });

  /** Collect document rows for a subject hint (or a set of common subjects). */
  async function collectDocuments(subject, topic, signal) {
    const slug = ib.subjectSlug(subject);
    const slugs = slug ? [slug] : ib.DEFAULT_SUBJECT_SLUGS;
    const seen = new Set();
    const docs = [];
    for (const s of slugs) {
      if (isAborted(ctx.signal, signal)) throw new Error("Plugin disabled or tool cancelled.");
      const url = ib.subjectListingUrl(s);
      try {
        const page = await ib.fetchPage(url, signal);
        for (const row of ib.extractRows(page.html, page.url || url)) {
          if (row.isDir || !/\/documents\//.test(row.href) || seen.has(row.href)) continue;
          seen.add(row.href);
          docs.push({
            ...row,
            subjectSlug: s,
            score: ib.scoreName(row.name, topic || ""),
            // "More Papers" entries are usually scanned supplements with no
            // text layer; try real papers first when coverage is limited.
            supplement: /more papers/i.test(row.size),
          });
        }
      } catch (e) {
        // One bad subject listing should not fail the whole search.
        if (/disabled|cancelled/i.test(String(e && e.message))) throw e;
      }
    }
    return docs;
  }

  // Shared implementation used by the tool and the settings "test" handler.
  async function fetchFromIbdocs(input, signal) {
    const value = assertObject(input, "Input");

    if (value.add === true) {
      const question = typeof value.question === "string" ? value.question.trim() : "";
      if (!question) throw new Error("question must contain non-whitespace text.");
      const created = {
        id: `manual_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
        question,
        markscheme: typeof value.markscheme === "string" ? value.markscheme : "",
        subject: typeof value.subject === "string" ? value.subject : "",
        paper: typeof value.paper === "string" ? value.paper : "",
        topic: typeof value.topic === "string" ? value.topic : "",
        sourceUrl: typeof value.sourceUrl === "string" ? value.sourceUrl : "",
        pdfUrl: typeof value.pdfUrl === "string" ? value.pdfUrl : "",
        createdAt: new Date().toISOString(),
        origin: "manual",
      };
      savePapers([...papers, created]);
      return { kind: "saved", item: created };
    }

    if (value.useStored === true) {
      if (!papers.length) throw new Error("No saved past-paper items are available.");
      const wanted = value.id ? String(value.id) : papers[papers.length - 1].id;
      const item = papers.find((p) => String(p.id) === String(wanted));
      if (!item) throw new Error("The requested saved item was not found.");
      return { kind: "stored", item };
    }

    // --- Topic search -----------------------------------------------------
    const topic = typeof value.topic === "string" ? value.topic.trim() : "";
    const subject = typeof value.subject === "string" ? value.subject.trim() : "";
    if (value.search === true) {
      if (!topic) throw new Error("topic must be a non-empty string when search is true.");
      const maxDocuments = Math.min(20, Math.max(1, Number(value.maxDocuments) || 8));
      const docs = await collectDocuments(subject, topic, signal);
      if (!docs.length) {
        throw new Error(
          `No IB Documents listing found for subject "${subject || "(any)"}". Try a different subject hint such as "math aa", "physics" or "biology".`
        );
      }

      // Rank by topic words in the document name. For the rest, sample evenly
      // across the whole listing rather than taking only the newest documents —
      // the newest entries are often scanned "more papers" with no text layer,
      // while older papers are the ones whose text can match the topic.
      docs.sort((a, b) => (b.score - a.score) || (Number(a.supplement) - Number(b.supplement)));
      const nameMatches = docs.filter((d) => d.score > 0);
      const rest = docs.filter((d) => d.score === 0);
      const remaining = Math.max(0, maxDocuments - nameMatches.length);
      let fillers = [];
      if (remaining > 0 && rest.length) {
        if (rest.length <= remaining) {
          fillers = rest;
        } else {
          const step = rest.length / remaining;
          fillers = Array.from({ length: remaining }, (_, i) => rest[Math.floor(i * step)]);
        }
      }
      const candidates = [...nameMatches, ...fillers].slice(0, maxDocuments);

      const results = [];
      let pdfsScanned = 0;
      for (const doc of candidates) {
        if (isAborted(ctx.signal, signal)) throw new Error("Plugin disabled or tool cancelled.");
        try {
          const infoPage = await ib.fetchPage(doc.href, signal);
          const info = ib.extractDocumentInfo(infoPage.html, doc.href);
          if (!info.pdfUrl) {
            if (doc.score > 0) {
              results.push({
                id: doc.href, name: doc.name, url: doc.href, pdfUrl: "",
                snippet: "Document page found but no direct PDF link was exposed.",
                subject: doc.subjectSlug, matchedBy: "title",
              });
            }
            continue;
          }
          const text = await pdfText(info.pdfUrl, signal);
          pdfsScanned++;
          const snippet = ib.snippetFor(text, topic);
          const cText = ib.compact(text);
          const cTopic = ib.compact(topic);
          const hasPhrase = !!cTopic && cText.includes(cTopic);
          const words = ib.topicWords(topic);
          const wordHits = words.filter((w) => cText.includes(w)).length;
          if (hasPhrase || wordHits >= Math.max(1, Math.ceil(words.length / 2)) || doc.score > 0) {
            results.push({
              id: info.sourceUrl,
              name: info.title || doc.name,
              url: info.sourceUrl,
              pdfUrl: info.pdfUrl,
              snippet,
              subject: doc.subjectSlug,
              matchedBy: hasPhrase ? "pdf-phrase" : wordHits ? "pdf-words" : "title",
              score: doc.score + wordHits,
            });
          }
        } catch (e) {
          if (/disabled|cancelled/i.test(String(e && e.message))) throw e;
          // Skip one failing document; keep the rest of the search alive.
        }
      }

      results.sort((a, b) => (b.score || 0) - (a.score || 0));
      const top = results.slice(0, 12);

      // Optionally take a result's excerpt as a poseable question. Prefer a
      // document that actually yielded text (some PDFs are scanned images).
      let fetched = null;
      if (top.length && value.autoFetch === true) {
        const chosen =
          top.find((r) => r.pdfUrl && r.snippet && r.snippet.trim()) || top[0];
        if (chosen && chosen.pdfUrl) {
          const text = await pdfText(chosen.pdfUrl, signal);
          if (text) {
            fetched = {
              question: ib.snippetFor(text, topic, 1600) || text.slice(0, 1600),
              markscheme: "",
              sourceUrl: chosen.url,
              pdfUrl: chosen.pdfUrl,
              subject: chosen.subject,
              topic,
              confidence: "medium",
            };
          }
        }
      }

      return {
        kind: "search",
        topic,
        subject,
        searchedSubjects: subject ? [ib.subjectSlug(subject)] : ib.DEFAULT_SUBJECT_SLUGS,
        listingCount: docs.length,
        pdfsScanned,
        count: top.length,
        results: top,
        fetched,
        message: top.length
          ? ""
          : `No past-paper text matched "${topic}" in ${pdfsScanned} document(s). Try a broader topic or a subject hint, or paste the question text with add:true.`,
      };
    }

    // --- Fetch a specific document / folder --------------------------------
    const target = resolveTarget(value);
    if (!target) {
      throw new Error(
        "Provide an ibdocs.re document URL or id, a folder URL with {list:true}, or {search:true, topic:'...'}."
      );
    }

    if (value.list === true || target.kind === "listing") {
      const page = await ib.fetchPage(target.url, signal);
      const rows = ib.extractRows(page.html, page.url || target.url);
      return {
        kind: "links",
        url: target.url,
        title: ((page.html.match(/<title>([^<]*)<\/title>/i) || [])[1] || "").replace(/\s*\|\s*IB Documents\s*$/i, ""),
        links: rows,
        message: rows.length ? "" : "No file rows found on that page.",
      };
    }

    let info;
    let pdfUrl = "";
    if (target.kind === "pdf") {
      pdfUrl = target.url;
      info = {
        title: decodeURIComponent(target.url.split("/").pop() || "").replace(/\.pdf$/i, "").replace(/_/g, " "),
        pdfUrl,
        breadcrumbs: [],
        sourceUrl: target.url,
      };
    } else {
      const page = await ib.fetchPage(target.url, signal);
      if (isAborted(ctx.signal, signal)) throw new Error("Plugin disabled or tool cancelled.");
      info = ib.extractDocumentInfo(page.html, target.url);
      pdfUrl = info.pdfUrl;
      if (!info.title) throw new Error("Could not read a document title from that ibdocs.re page.");
    }

    const text = pdfUrl ? await pdfText(pdfUrl, signal) : "";
    if (!text) {
      throw new Error(
        "No readable PDF text could be extracted from that document. Try a different document, or paste the question text with {add:true, question}."
      );
    }

    const item = {
      id: `ib_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      question: text.slice(0, 6000),
      markscheme: typeof value.markscheme === "string" ? value.markscheme : "",
      subject: (typeof value.subject === "string" && value.subject) || "",
      paper: (typeof value.paper === "string" && value.paper) || "",
      topic: (typeof value.topic === "string" && value.topic) || "",
      sourceUrl: info.sourceUrl,
      pdfUrl,
      createdAt: new Date().toISOString(),
      origin: "fetch",
      confidence: "medium",
    };
    savePapers([...papers, item]);
    return { kind: "question", item };
  }

  ctx.handle("testFetch", async (input) => {
    const result = await fetchFromIbdocs(input, ctx.signal);
    // Test fetches should not accumulate saved copies.
    if (result.item && result.item.id) {
      savePapers(papers.filter((p) => String(p.id) !== String(result.item.id)));
    }
    const sample =
      result.kind === "search"
        ? (result.fetched && result.fetched.question) ||
          (result.results || []).map((r) => r.snippet).find((s) => typeof s === "string" && s.trim()) ||
          ""
        : "";
    return {
      ok: true,
      kind: result.kind,
      preview:
        result.kind === "links"
          ? `Found ${result.links.length} row(s).`
          : result.kind === "search"
            ? `Found ${result.count} matching excerpt(s) from ${result.pdfsScanned} PDF(s) for "${result.topic}".` +
              (sample ? `\nTop excerpt: ${String(sample).slice(0, 240).replace(/\s+/g, " ")}…` : "") +
              (result.fetched ? "\nFetched top excerpt." : "")
            : String(result.item.question).slice(0, 500),
      count: result.count,
      searchedSubjects: result.searchedSubjects || [],
      pdfsScanned: result.pdfsScanned || 0,
      message: result.message || "",
    };
  });

  // Diagnostic: report a page's title, row count and detected PDF links without
  // exposing anything sensitive (the site is public, but this aids support).
  ctx.handle("diagnosePage", async (input) => {
    const value = assertObject(input, "Input");
    const url = typeof value.url === "string" && value.url.trim()
      ? value.url.trim()
      : `${ib.BASE_URL}/past-papers-by-subject/mathematics-analysis-and-approaches`;
    if (!ib.isAllowedIbdocsUrl(url)) throw new Error("url must be a https://ibdocs.re URL.");
    const page = await ib.fetchPage(url, ctx.signal);
    const rows = ib.extractRows(page.html, page.url || url);
    return {
      requestedUrl: url,
      finalUrl: page.url,
      status: page.status,
      htmlLength: page.html.length,
      title: ((page.html.match(/<title>([^<]*)<\/title>/i) || [])[1] || "").trim(),
      rowCount: rows.length,
      documentRows: rows.filter((r) => /\/documents\//.test(r.href)).length,
      sampleRows: rows.slice(0, 8).map((r) => ({ name: r.name, href: r.href, isDir: r.isDir })),
    };
  });

  // --- Agent contributions -------------------------------------------------
  const unregisterInstructions = ctx.registerInstructions({
    agents: ["teacher"],
    text: TEACHER_INSTRUCTIONS,
  });

  const unregisterTools = ctx.registerTools({
    agents: ["teacher"],
    create: (toolContext) => [
      {
        name: FETCH_TOOL_NAME,
        label: "Fetch IB Docs past paper",
        description:
          "Find an IB past-paper question from ibdocs.re by TOPIC (search:true with topic, optionally subject), fetch one by document URL/id, list a folder, or save learner-pasted text. No login required. Returns structured JSON; never invent a source.",
        parameters: {
          type: "object",
          properties: {
            url: { type: "string", description: "An ibdocs.re URL: a /documents/:id page, a /p/...pdf URL, or a folder listing." },
            documentId: { type: "string", description: "A bare ibdocs.re document id slug." },
            list: { type: "boolean", description: "When true, list the file/folder rows on a listing page." },
            subject: { type: "string", description: "Optional subject hint, e.g. 'math aa', 'physics', 'biology'." },
            paper: { type: "string", description: "Optional paper reference used for metadata." },
            topic: { type: "string", description: "Topic to search for, e.g. 'binomial theorem'. Used with search:true." },
            search: { type: "boolean", description: "When true, search past-paper PDFs by topic instead of fetching a specific document." },
            maxDocuments: { type: "integer", description: "Maximum number of PDFs to scan in a topic search (1-20, default 8)." },
            autoFetch: { type: "boolean", description: "With search:true, also return a longer excerpt from the top result." },
            markscheme: { type: "string", description: "Optional mark scheme to attach when the PDF could not supply one." },
            add: { type: "boolean", description: "When true, save learner-pasted question text into the local store." },
            question: { type: "string", description: "Learner-pasted question text. Required when add is true." },
            useStored: { type: "boolean", description: "When true, return a previously saved past-paper item." },
            id: { type: "string", description: "Saved item id for useStored, or to delete via the settings view." },
          },
          additionalProperties: false,
        },
        execute: async (_toolCallId, input, signal) => {
          if (isAborted(ctx.signal, signal)) throw new Error("Plugin disabled or tool cancelled.");
          const result = await fetchFromIbdocs(input, signal);
          return {
            content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
            details: {
              plugin: "ibdocs-pastpapers",
              kind: result.kind,
              chatId: toolContext.chatId,
              agent: toolContext.agent,
              sourceUrl: (result.item && result.item.sourceUrl) || result.url || "",
            },
          };
        },
      },
    ],
  });

  const unregisterQuestion = ctx.registerQuestionType(questionType);

  return () => {
    unregisterQuestion();
    unregisterTools();
    unregisterInstructions();
  };
};
