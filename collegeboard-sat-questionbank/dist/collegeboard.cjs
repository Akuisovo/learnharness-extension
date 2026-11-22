/**
 * College Board SAT Suite Question Bank helpers.
 *
 * Uses the public digital question bank endpoints used by College Board's
 * question bank interfaces:
 *   POST /questionbank/digital/get-questions  -> metadata list per domain
 *   POST /questionbank/digital/get-question   -> full question + rationale
 *
 * No authentication is required. Questions/rationales are official College
 * Board content and may include HTML/MathML; callers must treat them as
 * untrusted when rendering. Node built-ins only.
 */

"use strict";

const https = require("node:https");

const API_BASE = "https://qbank-api.collegeboard.org/msreportingquestionbank-prod/questionbank/digital";
const OFFICIAL_SOURCE_NAME = "College Board SAT Suite Question Bank";
const OFFICIAL_SOURCE_URL = "https://satsuiteeducatorquestionbank.collegeboard.org/digital/search";

const TESTS = [
  { id: 99, name: "SAT" },
  { id: 100, name: "PSAT/NMSQT & PSAT 10" },
  { id: 102, name: "PSAT 8/9" },
];

const DOMAINS = [
  { code: "H", name: "Algebra", section: "Math", skills: [
    { id: "H.A.", code: "H.A.", name: "Linear equations in one variable" },
    { id: "H.B.", code: "H.B.", name: "Linear functions" },
    { id: "H.C.", code: "H.C.", name: "Linear equations in two variables" },
    { id: "H.D.", code: "H.D.", name: "Systems of two linear equations in two variables" },
    { id: "H.E.", code: "H.E.", name: "Linear inequalities in one or two variables" },
  ]},
  { code: "P", name: "Advanced Math", section: "Math", skills: [
    { id: "P.A.", code: "P.A.", name: "Equivalent expressions" },
    { id: "P.B.", code: "P.B.", name: "Nonlinear equations in one variable and systems of equations in two variables" },
    { id: "P.C.", code: "P.C.", name: "Nonlinear functions" },
  ]},
  { code: "Q", name: "Problem-Solving and Data Analysis", section: "Math", skills: [
    { id: "Q.A.", code: "Q.A.", name: "Ratios, rates, proportional relationships, and units" },
    { id: "Q.B.", code: "Q.B.", name: "Percentages" },
    { id: "Q.C.", code: "Q.C.", name: "One-variable data: distributions and measures of center and spread" },
    { id: "Q.D.", code: "Q.D.", name: "Two-variable data: models and scatterplots" },
    { id: "Q.E.", code: "Q.E.", name: "Probability and conditional probability" },
    { id: "Q.F.", code: "Q.F.", name: "Inference from sample statistics and margin of error" },
    { id: "Q.G.", code: "Q.G.", name: "Evaluating statistical claims: observational studies and experiments" },
  ]},
  { code: "S", name: "Geometry and Trigonometry", section: "Math", skills: [
    { id: "S.A.", code: "S.A.", name: "Area and volume" },
    { id: "S.B.", code: "S.B.", name: "Lines, angles, and triangles" },
    { id: "S.C.", code: "S.C.", name: "Right triangles and trigonometry" },
    { id: "S.D.", code: "S.D.", name: "Circles" },
  ]},
  { code: "INI", name: "Information and Ideas", section: "Reading and Writing", skills: [
    { id: "INI.A.", code: "INI.A.", name: "Central ideas and details" },
    { id: "INI.B.", code: "INI.B.", name: "Inferences" },
    { id: "INI.C.", code: "INI.C.", name: "Command of evidence" },
  ]},
  { code: "CAS", name: "Craft and Structure", section: "Reading and Writing", skills: [
    { id: "CAS.A.", code: "CAS.A.", name: "Words in context" },
    { id: "CAS.B.", code: "CAS.B.", name: "Text structure and purpose" },
    { id: "CAS.C.", code: "CAS.C.", name: "Cross-text connections" },
  ]},
  { code: "EOI", name: "Expression of Ideas", section: "Reading and Writing", skills: [
    { id: "EOI.A.", code: "EOI.A.", name: "Rhetorical synthesis" },
    { id: "EOI.B.", code: "EOI.B.", name: "Transitions" },
  ]},
  { code: "SEC", name: "Standard English Conventions", section: "Reading and Writing", skills: [
    { id: "SEC.A.", code: "SEC.A.", name: "Boundaries" },
    { id: "SEC.B.", code: "SEC.B.", name: "Form, structure, and sense" },
  ]},
];

const DIFFICULTIES = [
  { code: "E", name: "Easy" },
  { code: "M", name: "Medium" },
  { code: "H", name: "Hard" },
];

function isAbortSignal(value) {
  return typeof AbortSignal !== "undefined" && value instanceof AbortSignal;
}

function isActiveQuestion(meta) {
  const ibn = meta && meta.ibn;
  return !!(ibn != null && String(ibn).trim() !== "");
}

function formatQuestionId(value) {
  const raw = String(value == null ? "" : value).trim();
  if (!raw) return "";
  if (/^\d+$/.test(raw)) return raw.padStart(8, "0");
  if (/^[A-Za-z0-9]{8}$/.test(raw)) return raw;
  return raw;
}

function difficultyName(code) {
  const found = DIFFICULTIES.find(d => d.code === code);
  return found ? found.name : String(code || "");
}

function testName(id) {
  const n = Number(id);
  const found = TESTS.find(t => t.id === n);
  return found ? found.name : `Test ${id}`;
}

function domainByCode(code) {
  return DOMAINS.find(d => d.code === code) || null;
}

function stripHtml(html) {
  return String(html || "")
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, " ")
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<\/div>/gi, "\n")
    .replace(/<\/li>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function formatQuestionText(question) {
  const stimulus = stripHtml(question && question.stimulus);
  const stem = stripHtml(question && question.stem);
  const parts = [];
  if (stimulus) parts.push(stimulus);
  if (stem) parts.push(stem);
  const options = Array.isArray(question && question.answerOptions) ? question.answerOptions : [];
  if (options.length) {
    options.forEach((opt, idx) => {
      const letter = String.fromCharCode(65 + idx);
      const text = stripHtml(opt && opt.content);
      parts.push(`${letter}. ${text}`);
    });
  }
  return parts.join("\n\n").trim();
}

function formatRationale(question) {
  const rationale = stripHtml(question && question.rationale);
  return rationale || "";
}

function postJson(path, body, signal) {
  const payload = JSON.stringify(body || {});
  const url = new URL(`${API_BASE}/${path}`);
  return new Promise((resolve, reject) => {
    if (isAbortSignal(signal) && signal.aborted) {
      reject(new Error("Cancelled"));
      return;
    }
    const req = https.request({
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port || 443,
      path: url.pathname + url.search,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json",
        "Content-Length": Buffer.byteLength(payload),
        "User-Agent": "Mozilla/5.0",
      },
    }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", chunk => { text += chunk; });
      res.on("end", () => {
        let json = null;
        try { json = text ? JSON.parse(text) : null; } catch { json = null; }
        if (res.statusCode < 200 || res.statusCode >= 300) {
          const msg = json && (json.message || json.error) ? (json.message || json.error) : `HTTP ${res.statusCode}`;
          reject(new Error(msg));
          return;
        }
        if (json && typeof json === "object" && !Array.isArray(json) && (json.statusCode || json.name === "VALIDATION_ERROR")) {
          reject(new Error(json.message || "College Board API error"));
          return;
        }
        resolve(json);
      });
    });
    req.on("error", reject);
    if (isAbortSignal(signal)) {
      const onAbort = () => {
        req.destroy(new Error("Cancelled"));
      };
      if (signal.aborted) { onAbort(); return; }
      signal.addEventListener("abort", onAbort, { once: true });
      req.on("close", () => signal.removeEventListener("abort", onAbort));
    }
    req.write(payload);
    req.end();
  });
}

async function fetchQuestionMetadata({ asmtEventId, domains, signal }) {
  const testId = Number(asmtEventId) || 99;
  const list = Array.isArray(domains) && domains.length ? domains : DOMAINS.map(d => d.code);
  const out = [];
  const seen = new Set();
  let lastError = null;
  for (const domain of list) {
    if (isAbortSignal(signal) && signal.aborted) throw new Error("Cancelled");
    try {
      const data = await postJson("get-questions", { asmtEventId: testId, test: testId, domain: String(domain) }, signal);
      if (!Array.isArray(data)) continue;
      for (const item of data) {
        const key = String(item && (item.external_id || item.uId || "") || "");
        if (key && seen.has(key)) continue;
        if (key) seen.add(key);
        if (item) out.push(item);
      }
    } catch (err) {
      lastError = err;
    }
  }
  if (!out.length && lastError) throw lastError;
  return out;
}

async function fetchQuestionDetail(externalId, signal) {
  const id = String(externalId || "").trim();
  if (!id) throw new Error("external_id is required to fetch question details and official explanation.");
  const data = await postJson("get-question", { external_id: id }, signal);
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("No question details returned.");
  return data;
}

function filterMetadata(items, { difficulties, skills, excludeActive, requireExternalId }) {
  const diffSet = Array.isArray(difficulties) && difficulties.length ? new Set(difficulties.map(String)) : null;
  const skillSet = Array.isArray(skills) && skills.length ? new Set(skills.map(String)) : null;
  return (Array.isArray(items) ? items : []).filter(item => {
    if (!item) return false;
    if (requireExternalId && !item.external_id) return false;
    if (excludeActive && isActiveQuestion(item)) return false;
    if (diffSet && !diffSet.has(String(item.difficulty || ""))) return false;
    if (skillSet) {
      const sc = String(item.skill_cd || "");
      const sd = String(item.skill_desc || "");
      if (!skillSet.has(sc) && !skillSet.has(sd)) return false;
    }
    return true;
  });
}

function summariseMetadata(item, asmtEventId) {
  return {
    externalId: item.external_id || "",
    questionId: formatQuestionId(item.questionId || ""),
    uId: formatQuestionId(item.uId || ""),
    testId: Number(asmtEventId) || 99,
    test: testName(asmtEventId || 99),
    domain: item.primary_class_cd || "",
    domainName: item.primary_class_cd_desc || "",
    skillCode: item.skill_cd || "",
    skill: item.skill_desc || "",
    difficulty: item.difficulty || "",
    difficultyName: difficultyName(item.difficulty || ""),
    active: isActiveQuestion(item),
    ibn: item.ibn || "",
    scoreBand: item.score_band_range_cd,
    program: item.program || "",
  };
}

module.exports = {
  API_BASE,
  OFFICIAL_SOURCE_NAME,
  OFFICIAL_SOURCE_URL,
  TESTS,
  DOMAINS,
  DIFFICULTIES,
  isAbortSignal,
  isActiveQuestion,
  difficultyName,
  testName,
  domainByCode,
  stripHtml,
  formatQuestionText,
  formatRationale,
  postJson,
  fetchQuestionMetadata,
  fetchQuestionDetail,
  filterMetadata,
  summariseMetadata,
  formatQuestionId,
};
