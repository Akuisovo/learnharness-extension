"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const cb = require("../src/collegeboard.cjs");
const backend = require("../src/backend.cjs");

test("stripHtml removes tags and decodes entities", () => {
  const out = cb.stripHtml("<p>Hello &amp; <b>world</b><br/>x</p>");
  assert.match(out, /Hello & world/);
  assert.match(out, /x/);
  assert.doesNotMatch(out, /<p>/);
});

test("formatQuestionText includes stem and answer options without leaking correctness", () => {
  const text = cb.formatQuestionText({
    stem: "<p>What is 2+2?</p>",
    answerOptions: [
      { id: "a", content: "<p>3</p>" },
      { id: "b", content: "<p>4</p>" },
    ],
    keys: ["b"],
    correct_answer: ["b"],
  });
  assert.match(text, /What is 2\+2\?/);
  assert.match(text, /A\. 3/);
  assert.match(text, /B\. 4/);
  assert.doesNotMatch(text, /\(correct\)/);
  assert.doesNotMatch(text, /Correct answer/);
});

test("formatRationale strips html", () => {
  assert.equal(cb.formatRationale({ rationale: "<p>Because <math>x</math></p>" }), "Because x");
});

test("isActiveQuestion based on non-empty ibn", () => {
  assert.equal(cb.isActiveQuestion({ ibn: "022222-DC" }), true);
  assert.equal(cb.isActiveQuestion({ ibn: "" }), false);
  assert.equal(cb.isActiveQuestion({ ibn: null }), false);
  assert.equal(cb.isActiveQuestion({}), false);
});

test("filterMetadata applies difficulty, skill, active and external id filters", () => {
  const items = [
    { external_id: "e1", difficulty: "E", skill_cd: "H.A.", skill_desc: "Linear equations in one variable", ibn: "" },
    { external_id: "e2", difficulty: "H", skill_cd: "H.B.", skill_desc: "Linear functions", ibn: "ACTIVE-1" },
    { external_id: "", difficulty: "M", skill_cd: "H.A.", skill_desc: "Linear equations in one variable", ibn: "" },
  ];
  const easy = cb.filterMetadata(items, { difficulties: ["E"], skills: ["H.A."], excludeActive: false, requireExternalId: true });
  assert.deepEqual(easy.map(i => i.external_id), ["e1"]);
  const noActive = cb.filterMetadata(items, { difficulties: null, skills: null, excludeActive: true, requireExternalId: false });
  assert.deepEqual(noActive.map(i => i.external_id || "none"), ["e1", "none"]);
});

test("summariseMetadata maps fields and pads numeric questionId to 8 digits", () => {
  const s = cb.summariseMetadata({
    external_id: "ex",
    questionId: "87756",
    uId: "uid",
    primary_class_cd: "H",
    primary_class_cd_desc: "Algebra",
    skill_cd: "H.A.",
    skill_desc: "Linear equations in one variable",
    difficulty: "M",
    ibn: "X",
  }, 99);
  assert.equal(s.externalId, "ex");
  assert.equal(s.questionId, "00087756");
  assert.equal(s.domainName, "Algebra");
  assert.equal(s.difficultyName, "Medium");
  assert.equal(s.active, true);
  assert.equal(s.test, "SAT");
});

test("backend normalises filters and builds saved item", () => {
  assert.deepEqual(backend.__test.normaliseDifficulties(["easy", "M", "hard", "x"]), ["E", "M", "H"]);
  assert.deepEqual(backend.__test.normaliseDomains(["h", "P", "nope", "ini"]), ["H", "P", "INI"]);
  const item = backend.__test.buildSavedItem(
    { stem: "<p>Q</p>", rationale: "<p>R</p>", answerOptions: [{ id: "1", content: "<p>A</p>" }], keys: ["1"], correct_answer: ["1"], externalid: "ex1" },
    { external_id: "ex1", questionId: "87756", uId: "uid1", primary_class_cd_desc: "Algebra", skill_desc: "Linear equations in one variable", difficulty: "E", ibn: "IBN1" },
    { testId: 99 }
  );
  assert.equal(item.externalId, "ex1");
  assert.equal(item.questionId, "00087756");
  assert.equal(item.uId, "uid1");
  assert.equal(item.ibn, "IBN1");
  assert.match(item.question, /Question IDs: externalId: ex1 \| questionId: 00087756 \| uId: uid1 \| IBN: IBN1/);
  assert.match(item.question, /Official source: College Board SAT Suite Question Bank — https:\/\/satsuiteeducatorquestionbank\.collegeboard\.org\/digital\/search/);
  assert.match(item.question, /Q\n\nA\. A$/);
  assert.equal(item.rationale, "R");
  assert.equal(item.difficulty, "Easy");
  assert.equal(item.active, true);
  assert.equal(item.sourceUrl, "https://satsuiteeducatorquestionbank.collegeboard.org/digital/search");
  assert.deepEqual(item.correctAnswer, ["1"]);
  assert.equal(item.choices[0].correct, true);
});

test("question type/tool metadata exported", () => {
  assert.equal(backend.__test.QUESTION_TYPE_ID, "collegeboard-sat-question");
  assert.equal(backend.__test.FETCH_TOOL_NAME, "fetch_collegeboard_sat_question");
  assert.equal(backend.__test.TEACH_TOOL_NAME, "ask_collegeboard_sat_question");
});
