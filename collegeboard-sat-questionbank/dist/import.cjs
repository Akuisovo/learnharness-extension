"use strict";

const fs = require("node:fs");
const path = require("node:path");

const IMPORT_FILE = "imports.json";
const SCHEMA_VERSION = 1;

function nowIso() { return new Date().toISOString(); }
function uid(prefix = "imp") { return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`; }

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

function norm(s) { return String(s || "").trim().toLowerCase().replace(/\s+/g, " "); }

function indexCatalog(domains) {
  const domainByCode = new Map();
  const domainByName = new Map();
  const skillByCode = new Map();
  const skillByName = new Map();
  for (const d of Array.isArray(domains) ? domains : []) {
    const code = String(d.code || "").toUpperCase();
    domainByCode.set(code, d);
    domainByName.set(norm(d.name), d);
    for (const s of Array.isArray(d.skills) ? d.skills : []) {
      const sc = String(s.code || s.id || "").toUpperCase();
      const rec = { ...s, code: sc, domainCode: code, domainName: d.name };
      skillByCode.set(sc, rec);
      skillByName.set(norm(s.name), rec);
    }
  }
  return { domainByCode, domainByName, skillByCode, skillByName };
}

function mapTarget(raw, catalog, defaults = {}) {
  const src = raw && typeof raw === "object" ? raw : {};
  const { domainByCode, domainByName, skillByCode, skillByName } = catalog;
  const errors = [];
  const warnings = [];

  let domainCode = String(src.domainCode || src.domain_code || "").trim().toUpperCase();
  let domainName = String(src.domain || src.domainName || "").trim();
  let skillCode = String(src.skillCode || src.skill_code || "").trim().toUpperCase();
  let skillName = String(src.skill || src.skillName || "").trim();
  const difficulty = String(src.difficulty || defaults.difficulty || "").trim().toUpperCase();
  const difficultyCode = ["E", "M", "H"].includes(difficulty) ? difficulty : "";

  if (skillCode && skillByCode.has(skillCode)) {
    const s = skillByCode.get(skillCode);
    skillName = skillName || s.name;
    domainCode = domainCode || s.domainCode;
    domainName = domainName || s.domainName;
  } else if (skillName && skillByName.has(norm(skillName))) {
    const s = skillByName.get(norm(skillName));
    skillCode = skillCode || s.code;
    domainCode = domainCode || s.domainCode;
    domainName = domainName || s.domainName;
  } else if (skillCode || skillName) {
    warnings.push(`Unmapped skill: ${skillCode || skillName}`);
  }

  if (domainCode && domainByCode.has(domainCode)) {
    const d = domainByCode.get(domainCode);
    domainName = domainName || d.name;
  } else if (domainName && domainByName.has(norm(domainName))) {
    const d = domainByName.get(norm(domainName));
    domainCode = d.code;
    domainName = d.name;
  } else if (domainCode || domainName) {
    warnings.push(`Unmapped domain: ${domainCode || domainName}`);
  }

  const mapped = !!(domainCode || skillCode);
  if (!mapped) errors.push("Target must map to a College Board domain or skill.");

  const missedCount = Math.max(0, Math.min(500, Number(src.missedCount ?? src.missed ?? src.count ?? 1) || 1));
  const confidence = ["low", "medium", "high"].includes(String(src.confidence || "").toLowerCase()) ? String(src.confidence).toLowerCase() : (mapped ? "medium" : "low");
  const notes = String(src.notes || "").trim().slice(0, 1000);
  const sourceQuestionId = String(src.externalId || src.questionId || src.uId || "").trim().slice(0, 120);

  return {
    targetId: uid("tgt"),
    testId: Number(src.testId || defaults.testId || 99) || 99,
    test: String(src.test || defaults.test || "").trim(),
    domainCode: domainByCode.has(domainCode) ? domainCode : "",
    domain: domainByCode.has(domainCode) ? domainByCode.get(domainCode).name : domainName,
    skillCode: skillByCode.has(skillCode) ? skillCode : "",
    skill: skillByCode.has(skillCode) ? skillByCode.get(skillCode).name : skillName,
    difficultyCode,
    difficulty: difficultyCode === "E" ? "Easy" : difficultyCode === "M" ? "Medium" : difficultyCode === "H" ? "Hard" : "",
    missedCount,
    confidence,
    notes,
    sourceQuestionId,
    mapped,
    needsReview: !mapped || warnings.length > 0 || confidence === "low",
    warnings,
    errors,
  };
}

function parseDelimited(text) {
  const rows = [];
  let row = []; let field = ""; let inQuotes = false;
  const s = String(text || "").replace(/\r\n?/g, "\n");
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inQuotes) {
      if (ch === '"' && s[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') inQuotes = false;
      else field += ch;
    } else {
      if (ch === '"') inQuotes = true;
      else if (ch === ',' || ch === '\t') { row.push(field); field = ""; }
      else if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ""; }
      else field += ch;
    }
  }
  row.push(field);
  if (row.some(c => String(c).trim() !== "")) rows.push(row);
  return rows;
}

function parseImportText(text) {
  const raw = String(text || "").trim();
  if (!raw) return [];
  // JSON array/object
  if (raw.startsWith("[") || raw.startsWith("{")) {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed;
    if (parsed && Array.isArray(parsed.targets)) return parsed.targets;
    if (parsed && Array.isArray(parsed.items)) return parsed.items;
    return [parsed];
  }
  // CSV/TSV with header
  const rows = parseDelimited(raw).filter(r => r.some(c => String(c).trim() !== ""));
  if (!rows.length) return [];
  const header = rows[0].map(h => norm(h));
  const hasHeader = header.some(h => ["domain", "domaincode", "skill", "skillcode", "difficulty", "missed", "missedcount", "notes", "testid"].includes(h.replace(/[^a-z]/g, "")));
  if (hasHeader) {
    const keys = rows[0].map(h => String(h || "").trim());
    return rows.slice(1).map(r => {
      const obj = {};
      keys.forEach((k, i) => { obj[k] = r[i]; });
      return obj;
    });
  }
  // Fallback: lines "Domain | Skill | difficulty | missed | notes"
  return raw.split(/\n+/).map(line => {
    const parts = line.split("|").map(p => p.trim()).filter(Boolean);
    if (!parts.length) return null;
    const [domain = "", skill = "", difficulty = "", missedCount = "1", ...rest] = parts;
    return { domain, skill, difficulty, missedCount, notes: rest.join(" | ") };
  }).filter(Boolean);
}

function createImportStore(ctx, domains) {
  const file = path.join(ctx.dataDirectory, IMPORT_FILE);
  let store = readJson(file, { version: SCHEMA_VERSION, imports: [] });
  if (!store || typeof store !== "object" || !Array.isArray(store.imports)) store = { version: SCHEMA_VERSION, imports: [] };
  const persist = () => writeJsonAtomic(file, { version: SCHEMA_VERSION, imports: store.imports });

  function importWeaknesses(input) {
    const src = input && typeof input === "object" ? input : {};
    const defaults = { testId: Number(src.testId || 99) || 99, test: String(src.test || ""), difficulty: src.difficulty || "" };
    const catalog = indexCatalog(domains);
    let targetsRaw = [];
    if (Array.isArray(src.targets)) targetsRaw = src.targets;
    else if (Array.isArray(src.items)) targetsRaw = src.items;
    else if (typeof src.text === "string" && src.text.trim()) targetsRaw = parseImportText(src.text);
    else if (typeof src.csv === "string" && src.csv.trim()) targetsRaw = parseImportText(src.csv);
    else throw new Error("Provide targets array or text/csv/JSON content to import.");

    const mappedTargets = targetsRaw.map(t => mapTarget(t, catalog, defaults));
    const confirmed = src.confirm === true;
    const accepted = mappedTargets.filter(t => t.mapped && (confirmed || !t.needsReview));
    const pending = mappedTargets.filter(t => !accepted.includes(t));

    const record = {
      importId: uid("imp"),
      createdAt: nowIso(),
      sourceLabel: String(src.sourceLabel || src.label || "Manual import").trim().slice(0, 200),
      sourceType: String(src.sourceType || "manual").trim().slice(0, 80),
      notes: String(src.notes || "").trim().slice(0, 2000),
      testId: defaults.testId,
      confirmed,
      acceptedCount: accepted.length,
      pendingCount: pending.length,
      targets: mappedTargets,
    };
    store.imports = [record, ...store.imports].slice(0, 200);
    persist();
    return record;
  }

  function listImports(limit = 50) {
    return store.imports.slice(0, Math.max(1, Math.min(200, Number(limit) || 50))).map(i => ({
      importId: i.importId, createdAt: i.createdAt, sourceLabel: i.sourceLabel, sourceType: i.sourceType,
      testId: i.testId, confirmed: !!i.confirmed, acceptedCount: i.acceptedCount || 0, pendingCount: i.pendingCount || 0,
      targets: (i.targets || []).map(t => ({ targetId: t.targetId, domain: t.domain, domainCode: t.domainCode, skill: t.skill, skillCode: t.skillCode, difficulty: t.difficulty, missedCount: t.missedCount, mapped: !!t.mapped, needsReview: !!t.needsReview, warnings: t.warnings || [] })),
    }));
  }

  function getTargets({ onlyAccepted = true, limit = 200 } = {}) {
    const out = [];
    for (const imp of store.imports) {
      for (const t of imp.targets || []) {
        if (onlyAccepted && !(t.mapped && (imp.confirmed || !t.needsReview))) continue;
        out.push({ ...t, importId: imp.importId, sourceLabel: imp.sourceLabel, createdAt: imp.createdAt });
        if (out.length >= limit) return out;
      }
    }
    return out;
  }

  return { importWeaknesses, listImports, getTargets, _file: file };
}

module.exports = { createImportStore, parseImportText, mapTarget, indexCatalog };
