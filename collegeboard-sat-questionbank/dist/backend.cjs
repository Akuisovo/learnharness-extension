/**
 * College Board SAT Question Bank — plugin backend (Node CommonJS).
 *
 * Registers:
 *   - a "collegeboard-sat-question" teaching question type
 *   - fetch_collegeboard_sat_question tool: search by test/topics/skills/difficulty,
 *     optionally exclude active questions, and fetch official question+explanation
 *   - additive teacher instructions
 *   - ctx.handle operations for Settings UI
 *
 * Uses public College Board digital question bank endpoints (no login).
 * Official question content and rationales are fetched directly from College Board.
 */

"use strict";

const fs = require("node:fs");
const path = require("node:path");
const cb = require("./collegeboard.cjs");
const { createReviewStore, inferCorrectness } = require("./review.cjs");
const { createImportStore } = require("./import.cjs");

const QUESTION_TYPE_ID = "collegeboard-sat-question";
const TEACH_TOOL_NAME = "ask_collegeboard_sat_question";
const FETCH_TOOL_NAME = "fetch_collegeboard_sat_question";
const SAVED_FILE = "saved.json";

const questionSchema = {
  type: "object",
  properties: {
    question: { type: "string", minLength: 1, description: "Learner-visible question text. MUST begin with question serial/ID(s) and official source; keep official wording (plain-text rendering of MathML/HTML is fine)." },
    promptHtml: { type: "string", description: "Original HTML/MathML stem when available (for display only)." },
    choices: {
      type: "array",
      description: "Answer choices for multiple-choice questions.",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          letter: { type: "string" },
          text: { type: "string" },
          html: { type: "string" },
        },
      },
    },
    correctAnswer: {
      description: "Correct answer key(s)/value(s) from College Board when available.",
    },
    rationale: { type: "string", description: "Official College Board explanation/rationale. Reveal only after the learner answers." },
    rationaleHtml: { type: "string", description: "Original HTML/MathML rationale when available." },
    source: { type: "string", description: "Source label, e.g. College Board SAT Suite Question Bank." },
    sourceUrl: { type: "string", description: "Official College Board source URL (e.g. https://satsuiteeducatorquestionbank.collegeboard.org/digital/search)." },
    externalId: { type: "string", description: "College Board external question id (primary fetch key)." },
    questionId: { type: "string", description: "College Board questionId (serial/reference)." },
    uId: { type: "string", description: "College Board uId (serial/reference)." },
    ibn: { type: "string", description: "College Board IBN when present; non-empty indicates an active assessment question." },
    test: { type: "string", description: "SAT, PSAT/NMSQT & PSAT 10, or PSAT 8/9." },
    domain: { type: "string", description: "Domain/category name." },
    skill: { type: "string", description: "Skill description." },
    skillCode: { type: "string", description: "Skill code." },
    difficulty: { type: "string", description: "Easy, Medium, or Hard." },
    active: { type: "boolean", description: "Whether College Board marks this as an active assessment question." },
  },
  required: ["question"],
  additionalProperties: false,
};

const answerSchema = { type: "string", minLength: 1 };

function validateQuestionPayload(input) {
  const payload = input && input.payload;
  if (!payload || typeof payload !== "object") return ["A payload object with a 'question' string is required."];
  if (typeof payload.question !== "string" || !payload.question.trim()) return ["payload.question must contain non-whitespace text."];
  return undefined;
}

const questionType = {
  id: QUESTION_TYPE_ID,
  label: "College Board SAT question",
  contractVersion: 1,
  showThinking: true,
  questionSchema,
  answerSchema,
  teach: {
    toolName: TEACH_TOOL_NAME,
    description:
      "Ask the learner an official College Board SAT Suite Question Bank question. You MUST include the question serial/ID(s) (externalId, questionId, uId, IBN) and official source (https://satsuiteeducatorquestionbank.collegeboard.org/digital/search) in the question text you present. Supply choices/correctAnswer when applicable and include rationale (official explanation). Rationale is revealed only after the learner answers.",
  },
  validateQuestion({ input }) {
    return validateQuestionPayload(input);
  },
  async gradeAnswer({ input, answer }) {
    const payload = (input && input.payload && typeof input.payload === "object") ? input.payload : {};
    let result = "unknown";
    try {
      result = inferCorrectness(answer, payload.correctAnswer);
    } catch (e) {
      console.error("[collegeboard-sat-questionbank] inferCorrectness failed", e);
      result = "unknown";
    }
    try {
      review.recordAttempt({
        externalId: payload.externalId,
        questionId: payload.questionId,
        uId: payload.uId,
        ibn: payload.ibn,
        testId: payload.testId,
        test: payload.test,
        domain: payload.domain,
        domainCode: payload.domainCode,
        skill: payload.skill,
        skillCode: payload.skillCode,
        difficulty: payload.difficulty,
        difficultyCode: payload.difficultyCode,
        question: payload.question,
        sourceUrl: payload.sourceUrl,
        source: payload.source,
        correctAnswer: payload.correctAnswer,
        answer,
        result,
      }, {});
    } catch (e) {
      console.error("[collegeboard-sat-questionbank] failed to record attempt", e);
    }
    return { outcome: result, autoRecorded: true };
  },
};

const TEACHER_INSTRUCTIONS = [
  "An official College Board SAT Suite Question Bank integration is available (public endpoints, no login). Questions come from official College Board resources: https://satsuiteeducatorquestionbank.collegeboard.org/digital/search (and equivalent SAT Suite Question Bank), fetched via College Board digital question bank endpoints.",
  "To find questions, call fetch_collegeboard_sat_question with {search:true, testId:99|100|102, domains:[...codes], difficulties:['E','M','H'], skills:[...skill codes/descriptions], excludeActive:true|false, limit:N}. Domain codes: H Algebra, P Advanced Math, Q Problem-Solving and Data Analysis, S Geometry and Trigonometry, INI Information and Ideas, CAS Craft and Structure, EOI Expression of Ideas, SEC Standard English Conventions.",
  "Search/fetch results always include question serial/ID fields for manual validation and lookup: externalId (primary fetch key), questionId, uId, and ibn (non-empty IBN means College Board marks it active).",
  "When providing or posing a question in a session you MUST explicitly state: (1) the question ID/serial(s) — externalId, questionId, uId, and IBN when present, and (2) the official source: College Board SAT Suite Question Bank (https://satsuiteeducatorquestionbank.collegeboard.org/digital/search). Do not omit IDs.",
  "Search returns question metadata (including serial IDs, domain, skill, difficulty, active flag) but not full text/rationale. To get official question and explanation, call fetch_collegeboard_sat_question with {fetch:true, externalId:'...'} (pass meta from the search result when available).",
  "excludeActive:true filters out questions marked active by College Board (non-empty IBN). Prefer excluding active questions when the user asks for practice not from active assessments. Some active items may lack externalId and cannot be fetched for full text/rationale, but their serial IDs are still returned for reference.",
  "Official explanations come from College Board's question detail 'rationale' field. Quote or faithfully represent them; do not invent an explanation or answer if fetch fails.",
  "After fetching, pose exactly one using ask_collegeboard_sat_question. Include question text that starts with the ID/serial(s) and official source URL, plus choices/correctAnswer when present, rationale, and serial/ID fields (externalId, questionId, uId, ibn, sourceUrl). Rationale is shown only after the learner answers; do not reveal it before posing.",
  "Missed-skill tracking/spaced review is built in. Question attempts may be auto-recorded; you can also record manually with fetch_collegeboard_sat_question {recordAttempt:true, externalId/questionId, domainCode, skillCode, difficulty, result, answer, correctAnswer}. Use {listReview:true,dueOnly:true} or {getReviewTargets:true} to find due review items and imported weakness targets, then fetch and pose official questions for those skills.",
  "Bluebook/My Practice import is manual-first (no account scraping). Import weaknesses with {importWeaknesses:true, sourceLabel:'Bluebook Practice Test ...', text:'CSV/TSV/JSON/pasted', confirm:true|false} or {targets:[...]}. Add manually checked weaknesses with {addManualWeakness:true, domainCode, skillCode?, difficulty?, notes?, confirm:true}. Map targets to College Board domain/skill codes before drilling; confirm ambiguous mappings with the user.",
  "You may save/reuse items with {add:true,...} or {useStored:true,id}. Respect College Board content: for personal study/practice, do not bulk-download or redistribute; store IDs/progress, re-fetch official question/rationale on demand.",
].join(" ");

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch (e) { if (e.code === "ENOENT") return fallback; throw e; }
}

function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file);
}

function assertObject(input, label) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error(`${label} must be an object.`);
  return input;
}

function toArray(v) {
  if (v == null) return [];
  return Array.isArray(v) ? v : [v];
}

function normaliseDifficulties(v) {
  const map = { easy: "E", medium: "M", hard: "H", e: "E", m: "M", h: "H" };
  return toArray(v).map(x => map[String(x || "").trim().toLowerCase()] || String(x || "").trim().toUpperCase()).filter(x => ["E", "M", "H"].includes(x));
}

function normaliseDomains(v) {
  const allowed = new Set(cb.DOMAINS.map(d => d.code));
  return toArray(v).map(x => String(x || "").trim().toUpperCase()).filter(x => allowed.has(x));
}

function buildSavedItem(detail, meta, extra = {}) {
  const summary = meta ? cb.summariseMetadata(meta, meta._testId || extra.testId || 99) : {};
  const options = Array.isArray(detail.answerOptions) ? detail.answerOptions : [];
  const keys = new Set([].concat(detail.keys || [], detail.correct_answer || []));
  const choices = options.map((opt, idx) => ({
    id: String(opt.id || ""),
    letter: String.fromCharCode(65 + idx),
    text: cb.stripHtml(opt.content),
    html: String(opt.content || ""),
    correct: keys.has(opt.id),
  }));
  const bodyText = cb.formatQuestionText(detail) || cb.stripHtml(detail.stem);
  const rationale = cb.formatRationale(detail);
  const externalId = String(detail.externalid || detail.external_id || summary.externalId || (meta && meta.external_id) || "");
  const questionId = String(summary.questionId || (meta && meta.questionId) || "");
  const uId = String(summary.uId || (meta && meta.uId) || "");
  const ibn = String(summary.ibn || (meta && meta.ibn) || "");
  const idLineParts = [
    externalId ? `externalId: ${externalId}` : "",
    questionId ? `questionId: ${questionId}` : "",
    uId ? `uId: ${uId}` : "",
    ibn ? `IBN: ${ibn}` : "",
  ].filter(Boolean);
  const sourceUrl = cb.OFFICIAL_SOURCE_URL || "https://satsuiteeducatorquestionbank.collegeboard.org/digital/search";
  const sourceName = cb.OFFICIAL_SOURCE_NAME || "College Board SAT Suite Question Bank";
  const headerLines = [];
  if (idLineParts.length) headerLines.push(`Question IDs: ${idLineParts.join(" | ")}`);
  headerLines.push(`Official source: ${sourceName} — ${sourceUrl}`);
  const question = [headerLines.join("\n"), bodyText].filter(Boolean).join("\n\n").trim();

  return {
    id: `cb_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    question,
    promptHtml: String(detail.stem || ""),
    choices,
    correctAnswer: detail.correct_answer || detail.keys || [],
    rationale,
    rationaleHtml: String(detail.rationale || ""),
    source: sourceName,
    sourceUrl,
    externalId,
    questionId,
    uId,
    ibn,
    test: summary.test || cb.testName(extra.testId || 99),
    testId: Number(extra.testId || summary.testId || 99),
    domain: summary.domainName || summary.domain || "",
    domainCode: summary.domain || "",
    skill: summary.skill || "",
    skillCode: summary.skillCode || "",
    difficulty: summary.difficultyName || summary.difficulty || "",
    difficultyCode: summary.difficulty || "",
    active: !!(summary.active || (meta && cb.isActiveQuestion(meta))),
    createdAt: new Date().toISOString(),
    origin: extra.origin || "fetch",
  };
}

exports.activate = (ctx) => {
  const savedFile = path.join(ctx.dataDirectory, SAVED_FILE);
  let saved = readJson(savedFile, []);
  if (!Array.isArray(saved)) saved = [];
  const saveAll = (next) => { saved = next; writeJsonAtomic(savedFile, saved); };
  const review = createReviewStore(ctx);
  const imports = createImportStore(ctx, cb.DOMAINS);

  function normaliseManualTarget(input) {
    const value = assertObject(input || {}, "Input");
    const domainCode = String(value.domainCode || "").trim().toUpperCase();
    const skillCode = String(value.skillCode || "").trim().toUpperCase();
    const domain = cb.DOMAINS.find(d => d.code === domainCode);
    const skill = domain ? (domain.skills || []).find(s => String(s.code || s.id).toUpperCase() === skillCode) : null;
    if (!domain) throw new Error("A valid domainCode is required for manual weakness target.");
    return {
      sourceLabel: String(value.sourceLabel || "Manual weakness").trim() || "Manual weakness",
      sourceType: "manual-checked",
      confirm: value.confirm === true,
      testId: Number(value.testId || 99) || 99,
      test: cb.testName(Number(value.testId || 99) || 99),
      targets: [{
        testId: Number(value.testId || 99) || 99,
        domainCode: domain.code,
        domain: domain.name,
        skillCode: skill ? String(skill.code || skill.id).toUpperCase() : "",
        skill: skill ? skill.name : String(value.skill || "").trim(),
        difficulty: String(value.difficulty || "").trim(),
        missedCount: Math.max(1, Math.min(500, Number(value.missedCount || 1) || 1)),
        notes: String(value.notes || "").trim(),
        confidence: "high",
      }],
    };
  }

  ctx.handle("getOptions", () => ({ tests: cb.TESTS, domains: cb.DOMAINS, difficulties: cb.DIFFICULTIES }));
  ctx.handle("getStatus", () => {
    const stats = review.getStats();
    return { configured: true, storedCount: saved.length, tests: cb.TESTS.length, domains: cb.DOMAINS.length, review: stats };
  });
  ctx.handle("listSaved", () => saved.map(s => ({
    id: s.id, question: String(s.question || "").slice(0, 240),
    externalId: s.externalId || "", questionId: s.questionId || "", uId: s.uId || "", ibn: s.ibn || "",
    sourceUrl: s.sourceUrl || cb.OFFICIAL_SOURCE_URL || "",
    test: s.test || "", domain: s.domain || "", skill: s.skill || "", difficulty: s.difficulty || "", active: !!s.active, createdAt: s.createdAt || "",
  })));
  ctx.handle("recordAttempt", (input) => {
    const value = assertObject(input || {}, "Input");
    const result = review.recordAttempt(value, {});
    return { ok: true, attempt: result };
  });
  ctx.handle("listReview", (input) => {
    const value = input && typeof input === "object" ? input : {};
    return { stats: review.getStats(), attempts: review.listAttempts(value) };
  });
  ctx.handle("markReviewed", (input) => ({ ok: true, attempt: review.markReviewed(input || {}) }));
  ctx.handle("importWeaknesses", (input) => ({ ok: true, import: imports.importWeaknesses(input || {}) }));
  ctx.handle("addManualWeakness", (input) => ({ ok: true, import: imports.importWeaknesses(normaliseManualTarget(input)) }));
  ctx.handle("listImports", (input) => {
    const value = input && typeof input === "object" ? input : {};
    return { imports: imports.listImports(value.limit || 50), targets: imports.getTargets({ onlyAccepted: value.onlyAccepted !== false, limit: value.limitTargets || 200 }) };
  });
  ctx.handle("getReviewTargets", (input) => {
    const value = input && typeof input === "object" ? input : {};
    const stats = review.getStats();
    const due = review.listAttempts({ dueOnly: true, limit: value.limitDue || 50 });
    const imported = imports.getTargets({ onlyAccepted: value.onlyAccepted !== false, limit: value.limitImported || 100 });
    return { stats, due, importedTargets: imported };
  });
  ctx.handle("deleteSaved", (input) => {
    const id = String(assertObject(input, "Input").id || "");
    saveAll(saved.filter(s => String(s.id) !== id));
    return { storedCount: saved.length };
  });
  ctx.handle("saveQuestion", (input) => {
    const value = assertObject(input, "Input");
    const item = value.item && typeof value.item === "object" ? value.item : value;
    if (!item || typeof item.question !== "string" || !item.question.trim()) throw new Error("question is required to save.");
    const record = { ...item, id: item.id || `cb_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`, createdAt: item.createdAt || new Date().toISOString(), origin: item.origin || "manual" };
    saveAll([...saved.filter(s => String(s.id) !== String(record.id)), record]);
    return { item: record, storedCount: saved.length };
  });

  async function searchQuestions(input, signal) {
    const value = assertObject(input, "Input");
    const testId = Number(value.testId || value.test || 99) || 99;
    const domains = normaliseDomains(value.domains || value.domain || value.categories);
    const difficulties = normaliseDifficulties(value.difficulties || value.difficulty);
    const skills = toArray(value.skills || value.skill).map(x => String(x || "").trim()).filter(Boolean);
    const excludeActive = value.excludeActive === true;
    const limit = Math.min(200, Math.max(1, Number(value.limit) || 25));
    const meta = await cb.fetchQuestionMetadata({ asmtEventId: testId, domains: domains.length ? domains : undefined, signal });
    const filtered = cb.filterMetadata(meta, { difficulties, skills, excludeActive, requireExternalId: value.requireExternalId !== false });
    const results = filtered.slice(0, limit).map(item => { item._testId = testId; return cb.summariseMetadata(item, testId); });
    return {
      kind: "search",
      testId,
      test: cb.testName(testId),
      domains: domains.length ? domains : cb.DOMAINS.map(d => d.code),
      difficulties,
      skills,
      excludeActive,
      totalMatched: filtered.length,
      count: results.length,
      results,
      message: results.length ? "" : "No questions matched those filters.",
    };
  }

  async function fetchQuestion(input, signal) {
    const value = assertObject(input, "Input");
    const externalId = String(value.externalId || value.external_id || "").trim();
    if (!externalId) throw new Error("externalId is required to fetch the official question and explanation.");
    const detail = await cb.fetchQuestionDetail(externalId, signal);
    let meta = null;
    if (value.meta && typeof value.meta === "object") meta = value.meta;
    const item = buildSavedItem(detail, meta, { testId: value.testId || value.test || 99, origin: "fetch" });
    return { kind: "question", item };
  }

  async function runTool(input, signal) {
    const value = assertObject(input, "Input");

    if (value.add === true) {
      const item = value.item && typeof value.item === "object" ? value.item : value;
      if (!item || typeof item.question !== "string" || !item.question.trim()) throw new Error("question is required when add is true.");
      const record = { ...item, id: item.id || `cb_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`, createdAt: item.createdAt || new Date().toISOString(), origin: item.origin || "manual", source: item.source || "College Board SAT Suite Question Bank" };
      saveAll([...saved.filter(s => String(s.id) !== String(record.id)), record]);
      return { kind: "saved", item: record };
    }

    if (value.useStored === true) {
      if (!saved.length) throw new Error("No saved questions are available.");
      const wanted = value.id ? String(value.id) : saved[saved.length - 1].id;
      const item = saved.find(s => String(s.id) === wanted);
      if (!item) throw new Error("Requested saved question not found.");
      return { kind: "stored", item };
    }

    if (value.recordAttempt === true) {
      const attempt = review.recordAttempt(value.attempt || value, {});
      return { kind: "attempt-recorded", attempt, stats: review.getStats() };
    }

    if (value.listReview === true) {
      return { kind: "review", stats: review.getStats(), attempts: review.listAttempts(value) };
    }

    if (value.markReviewed === true) {
      return { kind: "review-updated", attempt: review.markReviewed(value) , stats: review.getStats() };
    }

    if (value.importWeaknesses === true || value.import === true) {
      const record = imports.importWeaknesses(value.importData || value);
      return { kind: "imported", import: record };
    }

    if (value.addManualWeakness === true) {
      const record = imports.importWeaknesses(normaliseManualTarget(value));
      return { kind: "manual-weakness", import: record };
    }

    if (value.getReviewTargets === true || value.listTargets === true) {
      const stats = review.getStats();
      return { kind: "targets", stats, due: review.listAttempts({ dueOnly: true, limit: value.limit || 50 }), importedTargets: imports.getTargets({ onlyAccepted: value.onlyAccepted !== false, limit: value.limit || 100 }) };
    }

    if (value.fetch === true || (externalIdPresent(value) && value.search !== true)) {
      return fetchQuestion(value, signal);
    }

    if (value.search === true || value.domains || value.domain || value.categories || value.difficulties || value.difficulty || value.skills || value.skill) {
      return searchQuestions(value, signal);
    }

    if (value.listOptions === true) {
      return { kind: "options", tests: cb.TESTS, domains: cb.DOMAINS, difficulties: cb.DIFFICULTIES };
    }

    throw new Error("Provide {search:true,...}, {fetch:true,externalId}, {recordAttempt:true,...}, {listReview:true}, {markReviewed:true,key/result}, {importWeaknesses:true,...}, {addManualWeakness:true,...}, {getReviewTargets:true}, {add:true,question}, or {useStored:true}.");
  }

  function externalIdPresent(v) {
    return !!String((v && (v.externalId || v.external_id)) || "").trim();
  }

  ctx.handle("searchQuestions", async (input) => searchQuestions(input, ctx.signal));
  ctx.handle("fetchQuestion", async (input) => fetchQuestion(input, ctx.signal));
  ctx.handle("testFetch", async (input) => {
    const res = await runTool(input, ctx.signal);
    if (res.kind === "question" && res.item && res.item.id) {
      // don't persist test fetches as "saved" unless explicitly added; but buildSavedItem doesn't auto-save
    }
    const preview = res.kind === "search"
      ? `Found ${res.count} of ${res.totalMatched} matching question(s) for ${res.test}.`
      : res.kind === "question"
        ? String(res.item.question || "").slice(0, 500)
        : res.kind === "options"
          ? `${res.tests.length} tests, ${res.domains.length} domains.`
          : res.item ? String(res.item.question || "").slice(0, 300) : "";
    return { ok: true, kind: res.kind, preview, ...res };
  });

  const unregisterInstructions = ctx.registerInstructions({ agents: ["teacher"], text: TEACHER_INSTRUCTIONS });

  const unregisterTools = ctx.registerTools({
    agents: ["teacher"],
    create: (toolContext) => [{
      name: FETCH_TOOL_NAME,
      label: "Fetch College Board SAT question",
      description: "Search/fetch official College Board SAT Suite Question Bank questions; record review attempts; list due/weak-skill targets; and import manual Bluebook/My Practice weaknesses (no account scraping). No login required.",
      parameters: {
        type: "object",
        properties: {
          search: { type: "boolean", description: "Search for matching question metadata." },
          fetch: { type: "boolean", description: "Fetch full official question and explanation by externalId." },
          testId: { type: "integer", description: "99 SAT (default), 100 PSAT/NMSQT & PSAT 10, 102 PSAT 8/9." },
          domains: { type: "array", items: { type: "string" }, description: "Domain codes: H,P,Q,S,INI,CAS,EOI,SEC." },
          difficulties: { type: "array", items: { type: "string" }, description: "Difficulty codes: E (easy), M (medium), H (hard)." },
          skills: { type: "array", items: { type: "string" }, description: "Optional skill codes or skill descriptions to filter." },
          excludeActive: { type: "boolean", description: "When true, exclude College Board active-assessment questions (non-empty IBN)." },
          limit: { type: "integer", description: "Max results to return (default varies)." },
          externalId: { type: "string", description: "College Board external question id for fetch/review." },
          listOptions: { type: "boolean", description: "Return available tests/domains/skills/difficulties." },
          add: { type: "boolean", description: "Save a question/item locally." },
          useStored: { type: "boolean", description: "Return a previously saved question." },
          id: { type: "string", description: "Saved item id for useStored." },
          question: { type: "string", description: "Question text when add is true." },
          meta: { type: "object", description: "Optional metadata context when fetching." },
          recordAttempt: { type: "boolean", description: "Record a question attempt for missed-skill tracking/spaced review." },
          result: { type: "string", description: "Attempt result: correct, incorrect, partial, unknown." },
          answer: { type: "string", description: "Learner answer for attempt recording." },
          correctAnswer: { description: "Correct answer for attempt recording/comparison." },
          attempt: { type: "object", description: "Attempt payload object." },
          listReview: { type: "boolean", description: "List review attempts/stats." },
          dueOnly: { type: "boolean", description: "Only due review items." },
          markReviewed: { type: "boolean", description: "Mark/update a review record after review." },
          key: { type: "string", description: "Review record key." },
          attemptId: { type: "string", description: "Review attempt id." },
          importWeaknesses: { type: "boolean", description: "Import Bluebook/My Practice/manual weakness targets." },
          importData: { type: "object", description: "Import payload with targets/text/csv." },
          text: { type: "string", description: "CSV/TSV/JSON/pasted weakness text to import." },
          csv: { type: "string", description: "CSV text to import." },
          targets: { type: "array", items: { type: "object" }, description: "Weakness targets to import." },
          confirm: { type: "boolean", description: "Confirm mapped import targets." },
          sourceLabel: { type: "string", description: "Source label for import, e.g. Bluebook Practice Test 4." },
          addManualWeakness: { type: "boolean", description: "Add a manually checked domain/skill weakness target." },
          getReviewTargets: { type: "boolean", description: "Return due review questions and imported weakness targets." },
          domainCode: { type: "string", description: "Domain code for manual weakness/review filter." },
          skillCode: { type: "string", description: "Skill code for manual weakness/review filter." },
        },
        additionalProperties: false,
      },
      execute: async (_toolCallId, input, signal) => {
        if (ctx.signal && ctx.signal.aborted) throw new Error("Plugin disabled");
        if (signal && signal.aborted) throw new Error("Cancelled");
        const result = await runTool(input, signal || ctx.signal);
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          details: { plugin: "collegeboard-sat-questionbank", kind: result.kind, chatId: toolContext.chatId, agent: toolContext.agent },
        };
      },
    }],
  });

  const unregisterQuestion = ctx.registerQuestionType(questionType);

  return () => {
    unregisterQuestion();
    unregisterTools();
    unregisterInstructions();
  };
};

exports.__test = {
  normaliseDifficulties,
  normaliseDomains,
  buildSavedItem,
  QUESTION_TYPE_ID,
  FETCH_TOOL_NAME,
  TEACH_TOOL_NAME,
};
