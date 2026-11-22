"use strict";

const fs = require("node:fs");
const path = require("node:path");

const REVIEW_FILE = "review.json";
const SCHEMA_VERSION = 1;

function nowIso() { return new Date().toISOString(); }
function uid(prefix = "att") { return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`; }

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch (e) { if (e && e.code === "ENOENT") return fallback; throw e; }
}

function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file);
}

function normaliseResult(v) {
  const s = String(v || "").trim().toLowerCase();
  if (["correct", "right", "pass", "passed", "true", "1"].includes(s)) return "correct";
  if (["incorrect", "wrong", "fail", "failed", "false", "0"].includes(s)) return "incorrect";
  if (["partial", "partially_correct", "partially-correct"].includes(s)) return "partial";
  if (["unknown", "skipped", "skip", ""].includes(s)) return "unknown";
  return "unknown";
}

function clampInt(n, min, max, fallback) {
  const x = Number(n);
  if (!Number.isFinite(x)) return fallback;
  return Math.max(min, Math.min(max, Math.round(x)));
}

function addDays(iso, days) {
  const d = new Date(iso || nowIso());
  if (Number.isNaN(d.getTime())) return nowIso();
  d.setUTCDate(d.getUTCDate() + Number(days || 0));
  return d.toISOString();
}

function normaliseAnswerForCompare(v) {
  if (v == null) return "";
  if (Array.isArray(v)) return v.map(normaliseAnswerForCompare).filter(Boolean).sort().join("|");
  let s = String(v).trim().toLowerCase();
  s = s.replace(/^\$+|\$+$/g, "");
  s = s.replace(/\\,/g, "");
  s = s.replace(/[()\[\]{}]/g, "");
  s = s.replace(/\s+/g, " ");
  s = s.replace(/\s*([=+\-*/,:])\s*/g, "$1");
  return s;
}

function inferCorrectness(answer, correctAnswer) {
  if (correctAnswer == null) return "unknown";
  if (Array.isArray(correctAnswer) && correctAnswer.length === 0) return "unknown";
  const a = normaliseAnswerForCompare(answer);
  if (!a) return "unknown";
  const c = normaliseAnswerForCompare(correctAnswer);
  if (!c) return "unknown";
  return a === c ? "correct" : "incorrect";
}

// Simple spaced schedule: correct increases interval, incorrect/partial resets short.
function nextSchedule(prev, result) {
  const now = nowIso();
  const reps = clampInt(prev && prev.reps, 0, 10000, 0);
  const intervalDays = clampInt(prev && prev.intervalDays, 0, 3650, 0);
  if (result === "correct") {
    const nextReps = reps + 1;
    const nextInterval = nextReps === 1 ? 1 : nextReps === 2 ? 3 : Math.min(60, Math.max(1, Math.round(intervalDays * 2 || 4)));
    return { reps: nextReps, intervalDays: nextInterval, nextReviewAt: addDays(now, nextInterval), status: "scheduled" };
  }
  if (result === "partial") {
    return { reps: 0, intervalDays: 1, nextReviewAt: addDays(now, 1), status: "due" };
  }
  if (result === "incorrect") {
    return { reps: 0, intervalDays: 0, nextReviewAt: now, status: "due" };
  }
  // unknown: keep previous schedule, but ensure record exists
  return {
    reps,
    intervalDays,
    nextReviewAt: (prev && prev.nextReviewAt) || addDays(now, 1),
    status: (prev && prev.status) || "scheduled",
  };
}

function makeKey(record) {
  const externalId = String(record.externalId || "").trim();
  if (externalId) return `q:${externalId}`;
  const skill = String(record.skillCode || record.skill || "").trim().toLowerCase();
  const domain = String(record.domainCode || record.domain || "").trim().toLowerCase();
  const questionId = String(record.questionId || record.uId || "").trim();
  if (questionId) return `qid:${questionId}`;
  if (skill) return `skill:${domain}:${skill}:${String(record.testId || 99)}`;
  return "";
}

function cleanText(v, max = 500) {
  const s = String(v == null ? "" : v).trim();
  return s.length > max ? s.slice(0, max) : s;
}

function normaliseAttemptInput(input, inferred = {}) {
  const src = input && typeof input === "object" ? input : {};
  const result = normaliseResult(src.result || inferred.result);
  const externalId = cleanText(src.externalId || inferred.externalId, 120);
  const rawQuestionId = cleanText(src.questionId || inferred.questionId, 120);
  const questionId = /^\d+$/.test(rawQuestionId) ? rawQuestionId.padStart(8, "0") : rawQuestionId;
  const rawUId = cleanText(src.uId || inferred.uId, 120);
  const uId = /^\d+$/.test(rawUId) ? rawUId.padStart(8, "0") : rawUId;
  const ibn = cleanText(src.ibn || inferred.ibn, 120);
  const skill = cleanText(src.skill || inferred.skill, 200);
  const skillCode = cleanText(src.skillCode || inferred.skillCode, 80);
  const domain = cleanText(src.domain || inferred.domain, 120);
  const domainCode = cleanText(src.domainCode || inferred.domainCode, 40).toUpperCase();
  const difficulty = cleanText(src.difficulty || inferred.difficulty, 40);
  const difficultyCode = cleanText(src.difficultyCode || inferred.difficultyCode, 20).toUpperCase();
  const testId = clampInt(src.testId || inferred.testId || 99, 1, 9999, 99);
  const test = cleanText(src.test || inferred.test, 80);
  const answer = typeof src.answer === "string" ? cleanText(src.answer, 2000) : (src.answer == null ? "" : cleanText(JSON.stringify(src.answer), 2000));
  const correctAnswer = src.correctAnswer !== undefined ? src.correctAnswer : inferred.correctAnswer;
  const prompt = cleanText(src.question || inferred.question, 240);
  const sourceUrl = cleanText(src.sourceUrl || inferred.sourceUrl, 500);
  const source = cleanText(src.source || inferred.source || "College Board SAT Suite Question Bank", 200);
  const manual = src.manual === true || inferred.manual === true;
  return {
    externalId, questionId, uId, ibn, skill, skillCode, domain, domainCode,
    difficulty, difficultyCode, testId, test, answer, correctAnswer, prompt, sourceUrl, source,
    result, manual,
    notes: cleanText(src.notes || inferred.notes, 1000),
    tags: Array.isArray(src.tags) ? src.tags.map(t => cleanText(t, 60)).filter(Boolean).slice(0, 20) : [],
  };
}

function loadStore(file) {
  const raw = readJson(file, { version: SCHEMA_VERSION, attempts: [] });
  if (!raw || typeof raw !== "object") return { version: SCHEMA_VERSION, attempts: [] };
  const attempts = Array.isArray(raw.attempts) ? raw.attempts.filter(a => a && typeof a === "object") : [];
  return { version: SCHEMA_VERSION, attempts };
}

function saveStore(file, store) {
  writeJsonAtomic(file, { version: SCHEMA_VERSION, attempts: Array.isArray(store.attempts) ? store.attempts : [] });
}

function summarizeAttempt(a) {
  return {
    attemptId: a.attemptId,
    key: a.key,
    externalId: a.externalId || "",
    questionId: a.questionId || "",
    uId: a.uId || "",
    ibn: a.ibn || "",
    testId: a.testId,
    test: a.test || "",
    domain: a.domain || "",
    domainCode: a.domainCode || "",
    skill: a.skill || "",
    skillCode: a.skillCode || "",
    difficulty: a.difficulty || "",
    result: a.result || "unknown",
    nextReviewAt: a.nextReviewAt || "",
    intervalDays: a.intervalDays || 0,
    reps: a.reps || 0,
    status: a.status || "scheduled",
    manual: !!a.manual,
    answeredAt: a.answeredAt || "",
    prompt: a.prompt || "",
    sourceUrl: a.sourceUrl || "",
  };
}

function createReviewStore(ctx) {
  const file = path.join(ctx.dataDirectory, REVIEW_FILE);
  let store = loadStore(file);
  const persist = () => saveStore(file, store);

  function recordAttempt(input, inferred = {}) {
    const rec = normaliseAttemptInput(input, inferred);
    if (!rec.externalId && !rec.skill && !rec.skillCode && !rec.domain && !rec.domainCode) {
      throw new Error("record attempt requires at least externalId or domain/skill.");
    }
    const key = makeKey(rec);
    if (!key) throw new Error("Unable to derive review key for attempt.");
    const prev = store.attempts.find(a => a && a.key === key);
    const schedule = nextSchedule(prev, rec.result);
    const attempt = {
      ...(prev || {}),
      attemptId: (prev && prev.attemptId) || uid("att"),
      key,
      ...rec,
      correctAnswer: rec.correctAnswer,
      answeredAt: nowIso(),
      updatedAt: nowIso(),
      createdAt: (prev && prev.createdAt) || nowIso(),
      ...schedule,
      history: [...((prev && Array.isArray(prev.history)) ? prev.history : []).slice(-49), {
        at: nowIso(),
        result: rec.result,
        answer: rec.answer,
        manual: !!rec.manual,
      }],
    };
    store.attempts = [attempt, ...store.attempts.filter(a => a && a.key !== key)].slice(0, 2000);
    persist();
    return attempt;
  }

  function listAttempts({ limit = 100, result, dueOnly = false, domainCode, skillCode } = {}) {
    const now = Date.now();
    let items = store.attempts.slice();
    if (result) items = items.filter(a => a.result === normaliseResult(result));
    if (domainCode) items = items.filter(a => String(a.domainCode || "").toUpperCase() === String(domainCode).toUpperCase());
    if (skillCode) items = items.filter(a => String(a.skillCode || "").toLowerCase() === String(skillCode).toLowerCase());
    if (dueOnly) items = items.filter(a => { const t = Date.parse(a.nextReviewAt || ""); return !Number.isFinite(t) || t <= now; });
    items.sort((a, b) => {
      const da = Date.parse(a.nextReviewAt || 0) || 0;
      const db = Date.parse(b.nextReviewAt || 0) || 0;
      if (dueOnly && da !== db) return da - db;
      return (Date.parse(b.answeredAt || 0) || 0) - (Date.parse(a.answeredAt || 0) || 0);
    });
    return items.slice(0, clampInt(limit, 1, 500, 100)).map(summarizeAttempt);
  }

  function getStats() {
    const now = Date.now();
    const attempts = store.attempts;
    const bySkill = new Map();
    let due = 0, correct = 0, incorrect = 0, unknown = 0;
    for (const a of attempts) {
      if (a.result === "correct") correct++; else if (a.result === "incorrect" || a.result === "partial") incorrect++; else unknown++;
      const t = Date.parse(a.nextReviewAt || "");
      if (!Number.isFinite(t) || t <= now) due++;
      const skillKey = String(a.skillCode || a.skill || "unknown").toLowerCase();
      const entry = bySkill.get(skillKey) || { skill: a.skill || "", skillCode: a.skillCode || "", domain: a.domain || "", domainCode: a.domainCode || "", correct: 0, incorrect: 0, unknown: 0, due: 0 };
      if (a.result === "correct") entry.correct++; else if (a.result === "incorrect" || a.result === "partial") entry.incorrect++; else entry.unknown++;
      if (!Number.isFinite(t) || t <= now) entry.due++;
      bySkill.set(skillKey, entry);
    }
    const weakSkills = [...bySkill.values()].sort((a, b) => (b.incorrect - a.incorrect) || (b.due - a.due)).slice(0, 20);
    return { total: attempts.length, due, correct, incorrect, unknown, weakSkills };
  }

  function markReviewed(input) {
    const src = input && typeof input === "object" ? input : {};
    const key = String(src.key || (src.externalId ? makeKey({ externalId: src.externalId }) : "")).trim();
    const attemptId = String(src.attemptId || "").trim();
    const idx = store.attempts.findIndex(a => a && ((key && a.key === key) || (attemptId && a.attemptId === attemptId)));
    if (idx < 0) throw new Error("Review record not found.");
    const prev = store.attempts[idx];
    const result = normaliseResult(src.result || prev.result || "unknown");
    const schedule = nextSchedule(prev, result);
    const next = { ...prev, result, ...schedule, updatedAt: nowIso(), reviewedAt: nowIso() };
    store.attempts[idx] = next;
    persist();
    return next;
  }

  return { recordAttempt, listAttempts, getStats, markReviewed, _file: file, _load: () => loadStore(file) };
}

module.exports = { createReviewStore, inferCorrectness, normaliseResult, normaliseAttemptInput, nextSchedule, makeKey };
