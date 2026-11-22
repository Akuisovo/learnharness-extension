"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { createReviewStore, inferCorrectness } = require("../src/review.cjs");
const { createImportStore, parseImportText, mapTarget, indexCatalog } = require("../src/import.cjs");
const cb = require("../src/collegeboard.cjs");

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), "cb-sat-")); }

test("inferCorrectness compares normalized answers", () => {
  assert.equal(inferCorrectness("A", ["A"]), "correct");
  assert.equal(inferCorrectness(" a ", "A"), "correct");
  assert.equal(inferCorrectness("B", ["A"]), "incorrect");
  assert.equal(inferCorrectness("", ["A"]), "unknown");
  assert.equal(inferCorrectness("A", []), "unknown");
});

test("review store records attempts and computes due/weak skills", () => {
  const dir = tmp();
  const store = createReviewStore({ dataDirectory: dir });
  store.recordAttempt({ externalId: "ex1", domainCode: "H", domain: "Algebra", skillCode: "H.C.", skill: "Linear equations in two variables", difficulty: "M", result: "incorrect", question: "Q1" });
  store.recordAttempt({ externalId: "ex1", domainCode: "H", domain: "Algebra", skillCode: "H.C.", skill: "Linear equations in two variables", difficulty: "M", result: "correct", question: "Q1" });
  const stats = store.getStats();
  assert.equal(stats.total, 1);
  assert.equal(stats.correct, 1);
  const due = store.listAttempts({ dueOnly: true, limit: 10 });
  assert.equal(due.length, 0);
  const all = store.listAttempts({ limit: 10 });
  assert.equal(all[0].externalId, "ex1");
  assert.equal(all[0].reps, 1);
});

test("import parser and mapping handle CSV/manual targets", () => {
  const rows = parseImportText("domainCode,skillCode,difficulty,missedCount,notes\nH,H.C.,M,2,missed lines\n");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].domainCode, "H");
  const catalog = indexCatalog(cb.DOMAINS);
  const mapped = mapTarget({ domainCode: "H", skillCode: "H.C.", difficulty: "M", missedCount: 2 }, catalog, { testId: 99 });
  assert.equal(mapped.mapped, true);
  assert.equal(mapped.needsReview, false);
  assert.equal(mapped.domainCode, "H");
  assert.equal(mapped.skillCode, "H.C.");
});

test("import store keeps pending unmapped targets and accepts confirmed mapped targets", () => {
  const dir = tmp();
  const store = createImportStore({ dataDirectory: dir }, cb.DOMAINS);
  const rec = store.importWeaknesses({ sourceLabel: "Bluebook Test", text: "domainCode,skillCode,difficulty,missedCount\nH,H.C.,M,1\nX,NOPE,E,1\n", confirm: false, testId: 99 });
  assert.equal(rec.acceptedCount, 1);
  assert.equal(rec.pendingCount, 1);
  const targets = store.getTargets({ onlyAccepted: true });
  assert.equal(targets.length, 1);
  assert.equal(targets[0].skillCode, "H.C.");
});
