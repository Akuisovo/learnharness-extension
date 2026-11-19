/**
 * XtremePapers IB past papers — plugin backend (Node CommonJS).
 *
 * Registers:
 *   - an "xtremepapers-pastpaper" teaching question type (host-built tool)
 *   - a fetch_xtremepapers_pastpaper tool that finds IB past-paper questions on
 *     papers.xtremepape.rs by topic (walking the public directory tree and
 *     searching PDF text), by direct PDF URL, or from learner-pasted text
 *   - additive teacher instructions
 *   - ctx.handle operations used by the frontend Settings view
 *
 * papers.xtremepape.rs is public — no session cookie is required.
 */

"use strict";

const fs = require("node:fs");
const path = require("node:path");
const xp = require("./xtremepapers.cjs");

const QUESTION_TYPE_ID = "xtremepapers-pastpaper";
const TEACH_TOOL_NAME = "ask_xtremepapers_pastpaper_question";
const FETCH_TOOL_NAME = "fetch_xtremepapers_pastpaper";
const PAPERS_FILE = "papers.json";

const questionSchema = {
  type: "object",
  properties: {
    question: {
      type: "string",
      minLength: 1,
      description: "Learner-visible question text in Markdown. Keep the exact exam wording here.",
    },
    sourceUrl: { type: "string", description: "papers.xtremepape.rs page or PDF URL the question came from." },
    pdfUrl: { type: "string", description: "Direct PDF URL for the source document." },
    markschemeUrl: { type: "string", description: "Direct URL of the matching mark scheme PDF, when found." },
    subject: { type: "string", description: "Subject name, e.g. Physics or Mathematics Analysis and Approaches." },
    paper: { type: "string", description: "Paper reference such as 2025-May-Paper-1-HL." },
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
  for (const field of ["sourceUrl", "pdfUrl", "markschemeUrl"]) {
    if (payload[field] !== undefined) {
      if (typeof payload[field] !== "string") errors.push(`payload.${field} must be a string.`);
      else if (!xp.isAllowedXtremePapersUrl(payload[field])) {
        errors.push(`payload.${field} must be a https://papers.xtremepape.rs URL.`);
      }
    }
  }
  return errors.length ? errors : undefined;
}

const questionType = {
  id: QUESTION_TYPE_ID,
  label: "XtremePapers IB past-paper question",
  contractVersion: 1,
  showThinking: true,
  questionSchema,
  answerSchema,
  teach: {
    toolName: TEACH_TOOL_NAME,
    description:
      "Ask the learner an IB past-paper question sourced from papers.xtremepape.rs. Supply the exam wording in 'question' and, when available, 'markscheme', 'sourceUrl', 'pdfUrl', 'markschemeUrl', 'subject', 'paper' and 'topic'. The mark scheme is revealed only after the learner answers.",
  },
  validateQuestion({ input }) {
    return validateQuestionPayload(input);
  },
};

const TEACHER_INSTRUCTIONS = [
  "An XtremePapers (papers.xtremepape.rs) past-paper integration is available; it needs no login.",
  "When the lesson calls for an IB past-paper or exam-style question, search by TOPIC first: call fetch_xtremepapers_pastpaper with {search:true, topic:'<topic>', subject:'<subject if known>', autoFetch:true}. This walks recent public IB folders, downloads a small bounded set of real past-paper PDFs, searches their text, and returns matching excerpts with source and mark-scheme links.",
  "If a subject hint is supplied, the search is limited to that subject's category for speed and relevance. Common hints: 'math aa', 'math ai', 'physics', 'chemistry', 'biology', 'economics', 'business management'.",
  "You may also fetch a specific PDF with {url:'https://papers.xtremepape.rs/IB/.../paper.pdf'} or list any folder with {list:true, url:'https://papers.xtremepape.rs/index.php?dirpath=./IB/...&order=0'}.",
  "Check the returned 'fetched' field for the full excerpt and source links. Topic search returns snippets from real PDFs — quote them faithfully and do not invent wording or a source URL.",
  "After retrieving a question, pose exactly one using ask_xtremepapers_pastpaper_question. Put the exam wording in 'question' and any mark-scheme text in 'markscheme'. Include sourceUrl, pdfUrl, markschemeUrl, subject, paper and topic when known.",
  "The mark scheme is revealed only after the learner answers; do not show it in your teaching text before the question is posed.",
  "You may also use {add:true, question, markscheme?, subject?, paper?, topic?, sourceUrl?, pdfUrl?, markschemeUrl?} to save learner-pasted past-paper text into the plugin's local store, and {useStored:true} to retrieve a saved item.",
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

/** Resolve a user URL / bare path to a XtremePapers target. */
function resolveTarget(input) {
  if (!input || typeof input !== "object") return null;
  const raw = String(input.url || input.documentUrl || input.documentId || input.dirpath || "").trim();
  if (!raw) return null;
  let url;
  if (/^https?:\/\//i.test(raw)) url = raw;
  else if (/^papers\.xtremepape\.rs\//i.test(raw)) url = `https://${raw}`;
  else if (raw.startsWith("./") || raw.startsWith("IB/") || raw.includes("dirpath=")) {
    url = `${xp.BASE_URL}/index.php?dirpath=${encodeURIComponent(raw).replace(/%2F/g, "/")}&order=0`;
  } else if (/\.pdf$/i.test(raw)) url = `${xp.BASE_URL}/${raw}`;
  else url = `${xp.BASE_URL}/index.php?dirpath=${encodeURIComponent("./IB/" + raw + "/")}&order=0`;
  if (!xp.isAllowedXtremePapersUrl(url)) return null;
  const kind = /\.pdf$/i.test(new URL(url).pathname)
    ? "pdf"
    : /[?&]dirpath=/i.test(url)
      ? "listing"
      : "listing";
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
    const buffer = await xp.fetchBinary(pdfUrl, signal);
    const text = xp.extractPdfText(buffer);
    if (pdfCache.size > 40) pdfCache.clear();
    pdfCache.set(pdfUrl, text);
    return text;
  }

  async function listingRows(url, signal) {
    const page = await xp.fetchPage(url, signal);
    return { rows: xp.extractRows(page.html, page.url || url), page };
  }

  /** Collect PDF rows by walking recent years -> sessions -> category folders. */
  async function collectDocuments(subject, sessionHint, maxYears, signal) {
    const years = Math.min(6, Math.max(1, Number(maxYears) || xp.DEFAULT_YEARS));
    const seen = new Set();
    const docs = [];

    const root = await listingRows(xp.IB_ROOT, signal);
    const yearFolders = xp.yearFolders(root.rows).slice(0, years);
    if (isAborted(ctx.signal, signal)) throw new Error("Plugin disabled or tool cancelled.");

    // Without a subject hint, keep the walk small: only the most recent session
    // per year across all categories. With a hint we can afford two sessions
    // and a single matching category.
    const sessionLimit = subject ? 2 : 1;

    for (const year of yearFolders) {
      if (isAborted(ctx.signal, signal)) throw new Error("Plugin disabled or tool cancelled.");
      let yearRows;
      try {
        yearRows = (await listingRows(year.href, signal)).rows;
      } catch (e) {
        if (/disabled|cancelled/i.test(String(e && e.message))) throw e;
        continue;
      }
      const sessions = xp.sessionFolders(yearRows, sessionHint).slice(0, sessionLimit);
      for (const session of sessions) {
        if (isAborted(ctx.signal, signal)) throw new Error("Plugin disabled or tool cancelled.");
        let sessionRows;
        try {
          sessionRows = (await listingRows(session.href, signal)).rows;
        } catch (e) {
          if (/disabled|cancelled/i.test(String(e && e.message))) throw e;
          continue;
        }
        const categories = xp.categoryFolders(sessionRows, subject);
        for (const category of categories) {
          if (isAborted(ctx.signal, signal)) throw new Error("Plugin disabled or tool cancelled.");
          let categoryRows;
          try {
            categoryRows = (await listingRows(category.href, signal)).rows;
          } catch (e) {
            if (/disabled|cancelled/i.test(String(e && e.message))) throw e;
            continue;
          }
          for (const pdf of xp.pdfRows(categoryRows, subject)) {
            if (seen.has(pdf.href)) continue;
            seen.add(pdf.href);
            docs.push({
              ...pdf,
              markschemeUrl: xp.markschemeFor(pdf.href, categoryRows),
              category: category.name,
              session: session.name,
              yearFolder: year.name,
              listingUrl: category.href,
            });
            if (docs.length >= 400) return docs;
          }
        }
      }
    }
    return docs;
  }

  // --- Frontend operations -------------------------------------------------
  ctx.handle("getStatus", () => ({
    configured: true,
    storedCount: papers.length,
    baseUrl: xp.BASE_URL,
    rootUrl: xp.IB_ROOT,
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

  // Shared implementation used by the tool and the settings "test" handler.
  async function fetchFromXtremePapers(input, signal) {
    const value = assertObject(input, "Input");

    if (value.add === true) {
      const question = typeof value.question === "string" ? value.question.trim() : "";
      if (!question) throw new Error("question must contain non-whitespace text.");
      const created = {
        id: `manual_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
        question,
        markscheme: typeof value.markscheme === "string" ? value.markscheme : "",
        markschemeUrl: typeof value.markschemeUrl === "string" ? value.markschemeUrl : "",
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
    const sessionHint = typeof value.session === "string" ? value.session.trim() : "";
    if (value.search === true) {
      if (!topic) throw new Error("topic must be a non-empty string when search is true.");
      const maxDocuments = Math.min(20, Math.max(1, Number(value.maxDocuments) || 8));
      const docs = await collectDocuments(subject, sessionHint, value.maxYears, signal);
      if (!docs.length) {
        throw new Error(
          `No XtremePapers PDFs found for subject "${subject || "(any)"}". Try a different subject hint such as "math aa", "physics" or "biology".`
        );
      }

      // Rank by topic words in the filename. Sample evenly across the rest so
      // a single search covers different papers and sessions.
      for (const doc of docs) doc.score = xp.scoreName(doc.name, topic) + (doc.isMarkscheme ? -1 : 0);
      docs.sort((a, b) => b.score - a.score);
      const nameMatches = docs.filter((d) => d.score > 0);
      const rest = docs.filter((d) => d.score <= 0);
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
          const text = await pdfText(doc.href, signal);
          if (!text) continue;
          pdfsScanned++;
          const snippet = xp.snippetFor(text, topic);
          const cText = xp.compact(text);
          const cTopic = xp.compact(topic);
          const hasPhrase = !!cTopic && cText.includes(cTopic);
          const words = xp.topicWords(topic);
          const wordHits = words.filter((w) => cText.includes(w)).length;
          if (hasPhrase || wordHits >= Math.max(1, Math.ceil(words.length / 2)) || doc.score > 0) {
            results.push({
              id: doc.href,
              name: doc.title || doc.name,
              url: doc.listingUrl || doc.href,
              pdfUrl: doc.href,
              markschemeUrl: doc.markschemeUrl || "",
              snippet,
              subject: doc.category,
              paper: doc.paper,
              level: doc.level,
              year: doc.year,
              session: doc.session,
              matchedBy: hasPhrase ? "pdf-phrase" : wordHits ? "pdf-words" : "title",
              score: doc.score + wordHits,
            });
          }
        } catch (e) {
          if (/disabled|cancelled/i.test(String(e && e.message))) throw e;
          // Skip one failing PDF; keep the rest of the search alive.
        }
      }

      results.sort((a, b) => (b.score || 0) - (a.score || 0));
      const top = results.slice(0, 12);

      // Optionally take a result's excerpt as a poseable question. Prefer a
      // non-mark-scheme document that actually yielded text.
      let fetched = null;
      if (top.length && value.autoFetch === true) {
        const chosen =
          top.find((r) => r.pdfUrl && !/markscheme/i.test(r.name) && r.snippet && r.snippet.trim()) ||
          top.find((r) => r.pdfUrl && r.snippet && r.snippet.trim()) ||
          top[0];
        if (chosen && chosen.pdfUrl) {
          const text = await pdfText(chosen.pdfUrl, signal);
          if (text) {
            fetched = {
              question: xp.snippetFor(text, topic, 1600) || text.slice(0, 1600),
              markscheme: "",
              sourceUrl: chosen.url,
              pdfUrl: chosen.pdfUrl,
              markschemeUrl: chosen.markschemeUrl || "",
              subject: chosen.subject,
              paper: chosen.paper,
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
        session: sessionHint,
        listingCount: docs.length,
        pdfsScanned,
        count: top.length,
        results: top,
        fetched,
        message: top.length
          ? ""
          : `No past-paper text matched "${topic}" in ${pdfsScanned} PDF(s). Try a broader topic or a subject hint, or paste the question text with add:true.`,
      };
    }

    // --- Fetch a specific PDF / list a folder ------------------------------
    const target = resolveTarget(value);
    if (!target) {
      throw new Error(
        "Provide a papers.xtremepape.rs PDF URL, a folder URL with {list:true}, or {search:true, topic:'...'}."
      );
    }

    if (value.list === true || target.kind === "listing") {
      const { rows, page } = await listingRows(target.url, signal);
      const title = ((page.html.match(/<title>([^<]*)<\/title>/i) || [])[1] || "")
        .replace(/\s*\|\s*Papers\s*\|\s*XtremePapers\s*$/i, "")
        .replace(/\s*\|\s*XtremePapers\s*$/i, "")
        .trim();
      return {
        kind: "links",
        url: target.url,
        title,
        links: rows,
        message: rows.length ? "" : "No file rows found on that page.",
      };
    }

    const pdfUrl = target.url;
    const meta = xp.pdfMetadata(pdfUrl);
    const text = await pdfText(pdfUrl, signal);
    if (!text) {
      throw new Error(
        "No readable PDF text could be extracted from that PDF. Try a different document, or paste the question text with {add:true, question}."
      );
    }

    const item = {
      id: `xp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      question: text.slice(0, 6000),
      markscheme: typeof value.markscheme === "string" ? value.markscheme : "",
      markschemeUrl: typeof value.markschemeUrl === "string" ? value.markschemeUrl : "",
      subject: (typeof value.subject === "string" && value.subject) || meta.category || "",
      paper: (typeof value.paper === "string" && value.paper) || meta.paper || "",
      topic: (typeof value.topic === "string" && value.topic) || "",
      sourceUrl: pdfUrl,
      pdfUrl,
      createdAt: new Date().toISOString(),
      origin: "fetch",
      confidence: "medium",
    };
    savePapers([...papers, item]);
    return { kind: "question", item };
  }

  ctx.handle("testFetch", async (input) => {
    const result = await fetchFromXtremePapers(input, ctx.signal);
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
      listingCount: result.listingCount,
      pdfsScanned: result.pdfsScanned || 0,
      message: result.message || "",
    };
  });

  // Diagnostic: report a page's title, row count and detected PDF links without
  // exposing anything sensitive (the site is public, but this aids support).
  ctx.handle("diagnosePage", async (input) => {
    const value = assertObject(input, "Input");
    const url = typeof value.url === "string" && value.url.trim() ? value.url.trim() : xp.IB_ROOT;
    if (!xp.isAllowedXtremePapersUrl(url)) throw new Error("url must be a https://papers.xtremepape.rs URL.");
    const { rows, page } = await listingRows(url, ctx.signal);
    return {
      requestedUrl: url,
      finalUrl: page.url,
      status: page.status,
      htmlLength: page.html.length,
      title: ((page.html.match(/<title>([^<]*)<\/title>/i) || [])[1] || "").trim(),
      rowCount: rows.length,
      documentRows: rows.filter((r) => r.isPdf).length,
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
        label: "Fetch XtremePapers IB past paper",
        description:
          "Find an IB past-paper question from papers.xtremepape.rs by TOPIC (search:true with topic, optionally subject), fetch one by direct PDF URL, list a folder, or save learner-pasted text. No login required. Returns structured JSON; never invent a source.",
        parameters: {
          type: "object",
          properties: {
            url: { type: "string", description: "A papers.xtremepape.rs PDF URL or an index.php folder listing URL." },
            documentId: { type: "string", description: "A bare relative path or folder name under the IB archive." },
            list: { type: "boolean", description: "When true, list the file/folder rows on a listing page." },
            subject: { type: "string", description: "Optional subject hint, e.g. 'math aa', 'physics', 'biology'." },
            session: { type: "string", description: "Optional session hint, e.g. 'May' or 'November'." },
            paper: { type: "string", description: "Optional paper reference used for metadata." },
            topic: { type: "string", description: "Topic to search for, e.g. 'binomial theorem'. Used with search:true." },
            search: { type: "boolean", description: "When true, search past-paper PDFs by topic instead of fetching a specific PDF." },
            maxDocuments: { type: "integer", description: "Maximum number of PDFs to scan in a topic search (1-20, default 8)." },
            maxYears: { type: "integer", description: "Maximum number of recent years to walk in a topic search (1-6, default 3)." },
            autoFetch: { type: "boolean", description: "With search:true, also return a longer excerpt from the top result." },
            markscheme: { type: "string", description: "Optional mark scheme to attach when the PDF could not supply one." },
            markschemeUrl: { type: "string", description: "Optional direct mark scheme PDF URL." },
            add: { type: "boolean", description: "When true, save learner-pasted question text into the local store." },
            question: { type: "string", description: "Learner-pasted question text. Required when add is true." },
            useStored: { type: "boolean", description: "When true, return a previously saved past-paper item." },
            id: { type: "string", description: "Saved item id for useStored." },
          },
          additionalProperties: false,
        },
        execute: async (_toolCallId, input, signal) => {
          if (isAborted(ctx.signal, signal)) throw new Error("Plugin disabled or tool cancelled.");
          const result = await fetchFromXtremePapers(input, signal);
          return {
            content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
            details: {
              plugin: "xtremepapers-ib",
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

// Exported for offline tests.
exports.__test = { resolveTarget, validateQuestionPayload, TEACHER_INSTRUCTIONS };
