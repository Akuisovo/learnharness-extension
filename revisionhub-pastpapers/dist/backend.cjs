/**
 * RevisionHub Past Papers — plugin backend (Node CommonJS).
 *
 * Registers:
 *   - a "rh-pastpaper" teaching question type (host-built ask_rh_pastpaper_question tool)
 *   - a fetch_rh_pastpaper tool that retrieves question / mark-scheme content from
 *     RevisionHub using the learner's own session cookie
 *   - additive teacher instructions describing the workflow
 *   - ctx.handle operations used by the frontend Settings view
 */

"use strict";

const fs = require("node:fs");
const path = require("node:path");
const rh = require("./revisionhub.cjs");
const browsercookie = require("./browsercookie.cjs");

const QUESTION_TYPE_ID = "rh-pastpaper";
const TEACH_TOOL_NAME = "ask_rh_pastpaper_question";
const FETCH_TOOL_NAME = "fetch_rh_pastpaper";
const SETTINGS_FILE = "settings.json";
const PAPERS_FILE = "papers.json";

const questionSchema = {
  type: "object",
  properties: {
    question: {
      type: "string",
      minLength: 1,
      description:
        "Learner-visible question text in Markdown. Keep the exact exam wording here.",
    },
    sourceUrl: {
      type: "string",
      description: "RevisionHub URL the question came from.",
    },
    subject: { type: "string", description: "Subject name, e.g. Biology or Mathematics Analysis and Approaches." },
    paper: { type: "string", description: "Paper reference such as 2024-May-Paper1-HL." },
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
  if (payload.sourceUrl !== undefined) {
    if (typeof payload.sourceUrl !== "string") errors.push("payload.sourceUrl must be a string.");
    else if (!rh.isAllowedRevisionHubUrl(payload.sourceUrl)) {
      errors.push("payload.sourceUrl must be a https://revisionhub.study URL.");
    }
  }
  return errors.length ? errors : undefined;
}

const questionType = {
  id: QUESTION_TYPE_ID,
  label: "RevisionHub past-paper question",
  contractVersion: 1,
  showThinking: true,
  questionSchema,
  answerSchema,
  teach: {
    toolName: TEACH_TOOL_NAME,
    description:
      "Ask the learner a past-paper question sourced from RevisionHub. Supply the exam wording in 'question' and, when available, 'markscheme', 'sourceUrl', 'subject', 'paper' and 'topic'. The mark scheme is revealed only after the learner answers.",
  },
  validateQuestion({ input }) {
    return validateQuestionPayload(input);
  },
};

const TEACHER_INSTRUCTIONS = [
  "A RevisionHub past-paper integration is available.",
  "When the lesson calls for an IB past-paper or exam-style question, search by TOPIC first: call fetch_rh_pastpaper with {search:true, topic:'<topic>', subject:'<subject if known>', autoFetch:true}. This finds a real past-paper question on that topic and returns its text and mark scheme.",
  "If topic search returns several results, you may fetch a specific one with {url:'<result url>'} or a bare question id. You may also list question links from a paper page with {list:true, url:'<paper url>'}.",
  "Check the returned 'fetched' field for the full question and mark scheme. If search returns results but 'fetched' is empty, ask for a specific result URL. If it reports no session is configured, ask the learner to paste their RevisionHub session cookie in the plugin's Settings view, or ask them to paste the past-paper text directly.",
  "After retrieving a question, pose exactly one using ask_rh_pastpaper_question. Put the exam wording in 'question' and the mark scheme in 'markscheme'. Include sourceUrl, subject, paper and topic when known.",
  "Never invent a source URL or claim a question came from RevisionHub if the fetch failed. If nothing could be retrieved, follow your normal teaching flow instead.",
  "The mark scheme is revealed only after the learner answers; do not show it in your teaching text before the question is posed.",
  "You may also use {add:true, question, markscheme?, subject?, paper?, topic?, sourceUrl?} to save learner-pasted past-paper text into the plugin's local store, and {useStored:true} to retrieve a saved item.",
].join(" ");

/** JSON-file helpers restricted to the plugin's own data directory. */
function readJson(file, fallback) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return parsed;
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

exports.activate = (ctx) => {
  const settingsFile = path.join(ctx.dataDirectory, SETTINGS_FILE);
  const papersFile = path.join(ctx.dataDirectory, PAPERS_FILE);

  const defaultSettings = { cookie: "", autoRefreshCookie: true };
  let settings = readJson(settingsFile, defaultSettings);
  if (!settings || typeof settings !== "object") settings = { ...defaultSettings };
  // Older installs only stored { cookie }, so opt them into auto-refresh by default.
  if (typeof settings.autoRefreshCookie !== "boolean") settings.autoRefreshCookie = true;
  let papers = readJson(papersFile, []);
  if (!Array.isArray(papers)) papers = [];

  const saveSettings = (next) => {
    settings = next;
    writeJsonAtomic(settingsFile, settings);
  };
  const savePapers = (next) => {
    papers = next;
    writeJsonAtomic(papersFile, papers);
  };
  const cookieConfigured = () => typeof settings.cookie === "string" && settings.cookie.trim().length > 0;

  /** Return the exp claim (unix seconds) of a Cookie header's __session JWT, or 0. */
  const sessionExpiry = (cookie) => {
    const m = /(?:^|;\s*)__session=([^;]+)/.exec(cookie || "");
    return m ? Math.floor(browsercookie.sessionExpiryMs(m[1]) / 1000) : 0;
  };

  let mintedSession = null; // { cookie, expiresAt, sid, method }

  /**
   * Resolve the best stored/browser Cookie header without network access.
   * When auto-refresh is enabled, read the current session from the local
   * Search.app WebKit cookie store and keep whichever of the stored/browser
   * cookies has the later expiry (the on-disk store can briefly lag the browser).
   */
  const activeCookie = () => {
    let best = cookieConfigured() ? settings.cookie.trim() : "";
    if (settings.autoRefreshCookie) {
      const fresh = browsercookie.readSearchBrowserCookie();
      if (fresh) {
        const bestExp = sessionExpiry(best);
        const freshExp = sessionExpiry(fresh);
        // Prefer the browser's copy when it is newer, or when the stored cookie
        // has no readable expiry (e.g. a manually pasted opaque value) — in
        // that case the live browser store is still the better source of truth.
        if (!best || freshExp > bestExp || bestExp === 0) {
          best = fresh;
          saveSettings({ ...settings, cookie: fresh });
        }
      }
    }
    return best;
  };

  /**
   * Resolve a Cookie header for a real request. Clerk's `__session` JWT only
   * lives about a minute even though its cookie expiry is a year, so ask
   * Clerk for a fresh JWT from the long-lived `__client` token first. The
   * minted token is kept in memory only; the browser-store copy remains the
   * fallback and is what gets persisted to settings.
   */
  const freshCookie = async () => {
    if (!settings.autoRefreshCookie) {
      mintedSession = null;
      return activeCookie();
    }
    if (mintedSession && mintedSession.expiresAt > Date.now() + 15000) {
      return mintedSession.cookie;
    }
    const minted = await browsercookie.mintFreshSessionCookie();
    if (minted) {
      mintedSession = minted;
      return minted.cookie;
    }
    return activeCookie();
  };

  /**
   * Fetch a page and, on a Clerk auth redirect, mint/reload the session once
   * and retry. This handles the race where the on-disk cookie was already
   * stale when the first request was sent.
   */
  const fetchRhPage = async (url, signal) => {
    const firstCookie = await freshCookie();
    let page = await rh.fetchPage(url, firstCookie, signal);
    if (page.redirectedToSignIn && settings.autoRefreshCookie) {
      // Force one renewal attempt. The token may have rotated between the
      // cookie read and the request, or Clerk may have rejected a stale copy
      // from the on-disk store; a single retry is cheap and safe.
      mintedSession = null;
      const retryCookie = await freshCookie();
      if (retryCookie) {
        page = await rh.fetchPage(url, retryCookie, signal);
      }
    }
    return page;
  };

  // --- Frontend operations -------------------------------------------------
  ctx.handle("getStatus", () => {
    const browserCookieAvailable = !!browsercookie.findCookieFile();
    const configured = cookieConfigured() || (settings.autoRefreshCookie && browserCookieAvailable);
    return {
      configured,
      cookiePreview: cookieConfigured()
        ? settings.cookie.replace(/\s+/g, " ").slice(0, 80) + (settings.cookie.length > 80 ? "…" : "")
        : "",
      storedCount: papers.length,
      autoRefreshCookie: settings.autoRefreshCookie,
      browserCookieAvailable,
      sessionExpiresAt: mintedSession && mintedSession.expiresAt > Date.now()
        ? mintedSession.expiresAt
        : sessionExpiry(settings.cookie) * 1000 || undefined,
      sessionMethod: mintedSession && mintedSession.expiresAt > Date.now() ? mintedSession.method : undefined,
    };
  });

  ctx.handle("setCookie", (input) => {
    const value = assertObject(input, "Input");
    if (typeof value.cookie !== "string") throw new Error("cookie must be a string.");
    saveSettings({ ...settings, cookie: value.cookie.trim() });
    return { configured: cookieConfigured() };
  });

  ctx.handle("clearCookie", () => {
    saveSettings({ ...settings, cookie: "" });
    return { configured: false };
  });

  ctx.handle("setAutoRefreshCookie", (input) => {
    const value = assertObject(input, "Input");
    if (typeof value.enabled !== "boolean") throw new Error("enabled must be a boolean.");
    saveSettings({ ...settings, autoRefreshCookie: value.enabled });
    return { autoRefreshCookie: value.enabled };
  });

  // Explicitly copy the current cookie out of Search.app (useful for testing
  // auto-refresh without waiting for a search). Never returns the cookie value.
  ctx.handle("refreshCookie", async () => {
    if (!settings.autoRefreshCookie) {
      throw new Error("Auto-refresh is turned off. Turn it on first.");
    }
    mintedSession = null;
    const minted = await browsercookie.mintFreshSessionCookie();
    if (minted) {
      mintedSession = minted;
      const changed = minted.cookie !== settings.cookie;
      if (changed) saveSettings({ ...settings, cookie: minted.cookie });
      return {
        refreshed: true,
        changed,
        expiresAt: minted.expiresAt,
        method: minted.method,
        configured: true,
      };
    }
    const fresh = browsercookie.readSearchBrowserCookie();
    if (!fresh) {
      throw new Error(
        "No RevisionHub session found in Search.app. Keep RevisionHub open and logged in there, then try again."
      );
    }
    const changed = fresh !== settings.cookie;
    if (changed) saveSettings({ ...settings, cookie: fresh });
    return {
      refreshed: true,
      changed,
      expiresAt: sessionExpiry(fresh) * 1000 || undefined,
      method: "browser-store",
      configured: true,
    };
  });

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

  // Shared fetch implementation used by both the tool and a settings "test" handler.
  async function fetchFromRevisionHub(input, signal) {
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

    const cookie = await freshCookie();
    if (!cookie) {
      throw new Error(
        "No RevisionHub session is configured. Keep RevisionHub open and logged in in Search.app so the session can be renewed automatically, or paste a session cookie in the plugin's Settings view, or use {add:true, question, markscheme?} to save pasted text instead."
      );
    }

    // --- Topic search -----------------------------------------------------
    // Candidate URLs: subject-scoped questionbank pages first (authoritative
    // topical classification), then the general /search page with common
    // query parameter conventions. Use the first page that yields results.
    const topic = typeof value.topic === "string" ? value.topic.trim() : "";
    const subject = typeof value.subject === "string" ? value.subject.trim() : "";
    if (topic && value.search === true) {
      const candidates = [...rh.buildSubjectTopicUrls(topic, subject), ...rh.buildSearchUrls(topic, subject)];
      let lastError = "";
      let results = [];
      let usedUrl = "";
      for (const url of candidates) {
        if (ctx.signal.aborted || (signal && signal.aborted)) throw new Error("Plugin disabled or tool cancelled.");
        try {
          const page = await fetchRhPage(url, signal);
          if (page.redirectedToSignIn) {
            throw new Error(
              "RevisionHub session could not be renewed. Keep RevisionHub open and logged in in Search.app so the plugin can mint a fresh session, or paste a fresh cookie in the plugin's Settings view."
            );
          }
          const found = rh.extractSearchResults(page.html, url);
          if (found.length) {
            results = found;
            usedUrl = url;
            break;
          }
        } catch (e) {
          lastError = e instanceof Error ? e.message : String(e);
          if (/sign-in|disabled|cancelled/i.test(lastError)) throw e;
        }
      }

      // Optionally fetch the full question + mark scheme for the first result.
      let fetched = null;
      if (results.length && results[0].url && value.autoFetch === true) {
        const page = await fetchRhPage(results[0].url, signal);
        if (!page.redirectedToSignIn) {
          const extracted = rh.extractQuestion(page.html, results[0].url);
          if (extracted) {
            const meta = rh.metadataFromUrl(results[0].url);
            fetched = {
              question: extracted.question,
              markscheme: extracted.markscheme,
              sourceUrl: results[0].url,
              subject: meta.subject,
              topic,
              confidence: extracted.confidence,
            };
          }
        }
      }

      return {
        kind: "search",
        topic,
        subject,
        searchUrl: usedUrl,
        attemptedUrls: candidates,
        count: results.length,
        results,
        fetched,
        message: results.length
          ? ""
          : `No results found for "${topic}". ${lastError || "Try a broader topic, a subject hint, or paste the text with add:true."}`,
      };
    }

    const target = rh.resolveTarget(value);
    if (!target) {
      throw new Error(
        "Provide a RevisionHub /question/:id URL, a paper page URL, a bare question id, or {search:true, topic:'...'}."
      );
    }

    const page = await fetchRhPage(target.url, signal);
    if (ctx.signal.aborted) throw new Error("Plugin disabled.");
    if (signal && signal.aborted) throw new Error("Tool call cancelled.");
    if (page.redirectedToSignIn) {
      throw new Error(
        "RevisionHub session expired. Keep RevisionHub open and logged in in Search.app (the plugin refreshes the cookie automatically), or paste a fresh cookie in the plugin's Settings view."
      );
    }
    if (page.status && page.status >= 400) {
      throw new Error(`RevisionHub returned HTTP ${page.status} for ${target.url}.`);
    }

    if (value.list === true || target.kind === "papers" || target.kind === "questionbank") {
      const links = rh.extractQuestionLinks(page.html, target.url);
      if (!links.length) {
        return {
          kind: "links",
          url: target.url,
          links: [],
          message: "No /question/:id links were found on that page. It may require an authenticated view or a different URL.",
        };
      }
      return { kind: "links", url: target.url, links };
    }

    const extracted = rh.extractQuestion(page.html, target.url);
    if (!extracted) {
      throw new Error(
        "Question content could not be extracted from that RevisionHub page. Try the exact /question/:id URL, or paste the text with {add:true, question, markscheme?}."
      );
    }

    const meta = rh.metadataFromUrl(target.url);
    const item = {
      id: `rh_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      question: extracted.question,
      markscheme: extracted.markscheme || (typeof value.markscheme === "string" ? value.markscheme : ""),
      subject: (typeof value.subject === "string" && value.subject) || meta.subject,
      paper: (typeof value.paper === "string" && value.paper) || meta.paper,
      topic: (typeof value.topic === "string" && value.topic) || meta.topic,
      sourceUrl: target.url,
      createdAt: new Date().toISOString(),
      origin: "fetch",
      confidence: extracted.confidence,
    };
    savePapers([...papers, item]);
    return { kind: "question", item };
  }

  ctx.handle("testFetch", async (input) => {
    const value = assertObject(input, "Input");
    const result = await fetchFromRevisionHub(value, ctx.signal);
    // Test fetches should not accumulate saved copies.
    if (result.item && result.item.id) {
      const id = result.item.id;
      savePapers(papers.filter((p) => String(p.id) !== String(id)));
    }
    return {
      ok: true,
      kind: result.kind,
      preview:
        result.kind === "links"
          ? `Found ${result.links.length} question link(s).`
          : result.kind === "search"
            ? `Found ${result.count} result(s) for "${result.topic}".${result.fetched ? " Fetched top result." : ""}`
            : String(result.item.question).slice(0, 500),
      searchUrl: result.searchUrl || "",
      attemptedUrls: result.attemptedUrls || [],
      message: result.message || "",
    };
  });

  // Diagnostic: fetch a RevisionHub page with the stored cookie and report the
  // client chunks it loads. This lets us discover the real /search route chunk
  // (and therefore its query parameters) without exposing the cookie in chat.
  ctx.handle("diagnosePage", async (input) => {
    const value = assertObject(input, "Input");
    const diagnosticCookie = await freshCookie();
    if (!diagnosticCookie) {
      throw new Error("Keep RevisionHub open and logged in in Search.app, or save your RevisionHub cookie first.");
    }
    const url = typeof value.url === "string" && value.url.trim()
      ? value.url.trim()
      : "https://revisionhub.study/search";
    if (!rh.isAllowedRevisionHubUrl(url)) throw new Error("url must be a https://revisionhub.study URL.");

    const page = await fetchRhPage(url, ctx.signal);
    const chunks = rh.extractScriptChunks(page.html);
    const flight = rh.extractFlightStrings(page.html);
    return {
      requestedUrl: url,
      finalUrl: page.url,
      status: page.status,
      redirectedToSignIn: page.redirectedToSignIn,
      htmlLength: page.html.length,
      title: (page.html.match(/<title>([^<]*)<\/title>/i) || [])[1] || "",
      hasInput: /<input\b/i.test(page.html),
      appChunks: chunks.filter((c) => c.includes("/app/")),
      allChunks: chunks,
      flightChunks: flight.length,
      flightSample: flight.join(" ").slice(0, 1200),
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
        label: "Fetch RevisionHub past paper",
        description:
          "Find an IB past-paper question from RevisionHub by TOPIC (search:true with topic), or fetch one by URL/id, or save learner-pasted text. Uses the learner's configured session. Returns structured JSON; never invent a source.",
        parameters: {
          type: "object",
          properties: {
            url: {
              type: "string",
              description:
                "A RevisionHub URL: a /question/:id page or a /ib/.../papers listing page.",
            },
            questionId: {
              type: "string",
              description: "A bare RevisionHub question id as a string, e.g. \"1234\".",
            },
            list: {
              type: "boolean",
              description: "When true, return the /question/:id links found on a paper or questionbank page.",
            },
            subject: { type: "string", description: "Optional subject hint used for metadata." },
            paper: { type: "string", description: "Optional paper reference used for metadata." },
            topic: { type: "string", description: "Topic to search for, e.g. 'binomial theorem' or 'cell respiration'. Used with search:true." },
            search: {
              type: "boolean",
              description: "When true, search RevisionHub by topic instead of fetching a specific URL. Combine with topic and optionally subject.",
            },
            autoFetch: {
              type: "boolean",
              description: "With search:true, also fetch the full question and mark scheme for the first result.",
            },
            markscheme: {
              type: "string",
              description: "Optional mark scheme to attach when the page could not supply one.",
            },
            add: {
              type: "boolean",
              description: "When true, save learner-pasted question text into the local store instead of fetching.",
            },
            question: {
              type: "string",
              description: "Learner-pasted question text. Required when add is true.",
            },
            useStored: {
              type: "boolean",
              description: "When true, return a previously saved past-paper item instead of fetching.",
            },
            id: { type: "string", description: "Saved item id for useStored, or to delete via the settings view." },
          },
          additionalProperties: false,
        },
        execute: async (_toolCallId, input, signal) => {
          if (ctx.signal.aborted || (signal && signal.aborted)) throw new Error("Plugin disabled or tool cancelled.");
          const result = await fetchFromRevisionHub(input, signal);
          const text = JSON.stringify(result, null, 2);
          return {
            content: [{ type: "text", text }],
            details: {
              plugin: "revisionhub-pastpapers",
              kind: result.kind,
              chatId: toolContext.chatId,
              agent: toolContext.agent,
              sourceUrl: result.item && result.item.sourceUrl ? result.item.sourceUrl : result.url || "",
            },
          };
        },
      },
    ],
  });

  // --- Question type -------------------------------------------------------
  const unregisterQuestion = ctx.registerQuestionType(questionType);

  return () => {
    unregisterQuestion();
    unregisterTools();
    unregisterInstructions();
  };
};
