/**
 * Offline tests: mock the LearnHarness backend context and verify registration,
 * handlers, and the fetch tool's behaviour without network access.
 */
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const zlib = require("node:zlib");
const test = require("node:test");

const backend = require("../src/backend.cjs");

function makeCtx(dataDirectory) {
  const state = {
    handles: new Map(),
    questionTypes: [],
    tools: [],
    instructions: [],
    cleanups: [],
  };
  const ctx = {
    dataDirectory,
    signal: { aborted: false },
    cleanup(fn) {
      state.cleanups.push(fn);
    },
    handle(name, handler) {
      state.handles.set(name, handler);
    },
    registerQuestionType(def) {
      state.questionTypes.push(def);
      return () => { state.questionTypes = state.questionTypes.filter((d) => d !== def); };
    },
    registerTools(contribution) {
      state.tools.push(contribution);
      return () => { state.tools = state.tools.filter((d) => d !== contribution); };
    },
    registerInstructions(contribution) {
      state.instructions.push(contribution);
      return () => { state.instructions = state.instructions.filter((d) => d !== contribution); };
    },
  };
  return { ctx, state };
}

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "xpib-"));
}

function removeDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

/** Build a tiny fake PDF whose deflate stream contains extractable text. */
function fakePdf(text) {
  const content = Buffer.from(`BT (${text}) ET`, "latin1");
  const deflated = zlib.deflateSync(content);
  return Buffer.concat([
    Buffer.from("%PDF-1.6\nstream\n", "latin1"),
    deflated,
    Buffer.from("\nendstream\n%%EOF", "latin1"),
  ]);
}

/** Build a synthetic XtremePapers directory listing page. */
function listing(rows, title = "Papers | XtremePapers") {
  const trs = rows.map((r) => {
    if (r.dir) {
      return `<tr class="xp-dir"><td class="fname"><a href="index.php?dirpath=${r.dirpath}&amp;order=0" class="directory xp-row-link">${r.name}</a></td></tr>`;
    }
    return `<tr class="xp-file"><td class="fname"><a href="${r.href}" class="file xp-row-link">${r.name}</a></td><td class="fsize">1 MB</td></tr>`;
  }).join("\n");
  return `<!doctype html><html><head><title>${title}</title></head><body><table>${trs}</table></body></html>`;
}

function pdfResponse(pdf) {
  return {
    ok: true,
    status: 200,
    arrayBuffer: async () => pdf.buffer.slice(pdf.byteOffset, pdf.byteOffset + pdf.byteLength),
  };
}

/** A folder tree containing one math paper whose PDF has the wanted text. */
function treeFixtures(pdf) {
  const dir = (name, dirpath) => ({ dir: true, name, dirpath });
  const file = (name, href) => ({ name, href });
  const base = "https://papers.xtremepape.rs";
  const yearPath = "./IB/2025+Examination+Session/";
  const sessionPath = "./IB/2025+Examination+Session/May+2025+Examination+Session/";
  const catPath = sessionPath + "Mathematics/";
  const pdfHref = "IB/2025%20Examination%20Session/May%202025%20Examination%20Session/Mathematics/Mathematics_analysis_and_approaches_paper_1_TZ1_HL.pdf";
  const map = new Map();
  map.set(`${base}/index.php?dirpath=./IB/&order=0`, listing([dir("2025 Examination Session", yearPath)]));
  map.set(`${base}/index.php?dirpath=${yearPath}&order=0`, listing([dir("May 2025 Examination Session", sessionPath)]));
  map.set(`${base}/index.php?dirpath=${sessionPath}&order=0`, listing([dir("Mathematics", catPath)]));
  map.set(`${base}/index.php?dirpath=${catPath}&order=0`, listing([
    file("Mathematics_analysis_and_approaches_paper_1_TZ1_HL.pdf", pdfHref),
    file("Mathematics_analysis_and_approaches_paper_1_TZ1_HL_markscheme.pdf", pdfHref.replace(".pdf", "_markscheme.pdf")),
  ], `Mathematics | Papers | XtremePapers`));
  map.set(`${base}/${pdfHref}`, pdf);
  map.set(`${base}/${pdfHref.replace(".pdf", "_markscheme.pdf")}`, fakePdf("mark scheme guidance"));
  return { map, pdfHref, catPath };
}

test("registers question type, tools, instructions and handlers", () => {
  const dir = tempDir();
  const { ctx, state } = makeCtx(dir);
  const cleanup = backend.activate(ctx);

  assert.equal(state.questionTypes.length, 1);
  assert.equal(state.questionTypes[0].id, "xtremepapers-pastpaper");
  assert.equal(state.questionTypes[0].label, "XtremePapers IB past-paper question");
  assert.equal(state.questionTypes[0].teach.toolName, "ask_xtremepapers_pastpaper_question");
  assert.equal(state.tools.length, 1);
  assert.equal(state.tools[0].agents[0], "teacher");
  assert.equal(state.instructions.length, 1);
  assert.match(state.instructions[0].text, /fetch_xtremepapers_pastpaper/);
  assert.match(state.instructions[0].text, /papers\.xtremepape\.rs/);
  for (const name of ["getStatus", "listPapers", "deletePaper", "testFetch", "diagnosePage"]) {
    assert.ok(state.handles.has(name), `missing handler ${name}`);
  }

  const tools = state.tools[0].create({ chatId: "c1", agent: "teacher" });
  assert.equal(tools[0].name, "fetch_xtremepapers_pastpaper");

  cleanup();
  assert.equal(state.questionTypes.length, 0);
  assert.equal(state.tools.length, 0);
  assert.equal(state.instructions.length, 0);
  removeDir(dir);
});

test("question validation rejects bad payloads and non-XtremePapers URLs", () => {
  const dir = tempDir();
  const { ctx, state } = makeCtx(dir);
  backend.activate(ctx);
  const def = state.questionTypes[0];

  const bad = def.validateQuestion({ input: { question: "x", payload: { question: "" } } });
  assert.ok(Array.isArray(bad) && bad.length > 0);

  const badUrl = def.validateQuestion({
    input: { question: "x", payload: { question: "q", sourceUrl: "https://evil.example" } },
  });
  assert.ok(Array.isArray(badUrl) && badUrl.length > 0);

  const good = def.validateQuestion({
    input: {
      question: "x",
      payload: {
        question: "q",
        sourceUrl: "https://papers.xtremepape.rs/IB/2025/paper.pdf",
        pdfUrl: "https://papers.xtremepape.rs/IB/2025/paper.pdf",
        markschemeUrl: "https://papers.xtremepape.rs/IB/2025/paper_markscheme.pdf",
      },
    },
  });
  assert.equal(good, undefined);
  removeDir(dir);
});

test("getStatus reports public access and saved count", () => {
  const dir = tempDir();
  const { ctx, state } = makeCtx(dir);
  backend.activate(ctx);
  const status = state.handles.get("getStatus")();
  assert.equal(status.configured, true);
  assert.equal(status.storedCount, 0);
  assert.equal(status.baseUrl, "https://papers.xtremepape.rs");
  assert.match(status.rootUrl, /dirpath=\.\/IB\//);
  removeDir(dir);
});

test("tool saves learner-pasted text via add:true and can retrieve/delete it", async () => {
  const dir = tempDir();
  const { ctx, state } = makeCtx(dir);
  backend.activate(ctx);
  const tool = state.tools[0].create({ chatId: "c1", agent: "teacher" })[0];

  const res = await tool.execute("t1", {
    add: true,
    question: "Solve x^2 = 4.",
    markscheme: "x = ±2",
    subject: "Mathematics",
  });
  const parsed = JSON.parse(res.content[0].text);
  assert.equal(res.content[0].type, "text");
  assert.equal(parsed.kind, "saved");
  assert.equal(parsed.item.question, "Solve x^2 = 4.");

  let list = state.handles.get("listPapers")();
  assert.equal(list.length, 1);

  const stored = await tool.execute("t1b", { useStored: true, id: parsed.item.id });
  const storedParsed = JSON.parse(stored.content[0].text);
  assert.equal(storedParsed.kind, "stored");
  assert.equal(storedParsed.item.markscheme, "x = ±2");

  state.handles.get("deletePaper")({ id: parsed.item.id });
  list = state.handles.get("listPapers")();
  assert.equal(list.length, 0);
  removeDir(dir);
});

test("tool searches past-paper PDFs by topic and auto-fetches the top excerpt", async () => {
  const dir = tempDir();
  const { ctx, state } = makeCtx(dir);
  backend.activate(ctx);

  const pdf = fakePdf("binomial theorem expansion example");
  const { map, catPath } = treeFixtures(pdf);
  const originalFetch = global.fetch;
  global.fetch = async (url) => {
    const key = String(url);
    if (map.has(key)) {
      const value = map.get(key);
      if (Buffer.isBuffer(value)) return pdfResponse(value);
      return { status: 200, url: key, text: async () => value };
    }
    throw new Error(`Unexpected URL: ${url}`);
  };
  try {
    const tool = state.tools[0].create({ chatId: "c1", agent: "teacher" })[0];
    const res = await tool.execute("t2", {
      search: true,
      topic: "binomial theorem",
      subject: "math aa",
      autoFetch: true,
    });
    const parsed = JSON.parse(res.content[0].text);
    assert.equal(parsed.kind, "search");
    assert.equal(parsed.topic, "binomial theorem");
    assert.equal(parsed.subject, "math aa");
    assert.ok(parsed.pdfsScanned >= 1);
    assert.ok(parsed.count >= 1);
    assert.match(parsed.results[0].snippet, /binomial theorem/);
    assert.match(parsed.results[0].markschemeUrl, /markscheme\.pdf$/);
    assert.ok(parsed.fetched);
    assert.match(parsed.fetched.question, /binomial theorem/);
    assert.equal(parsed.fetched.subject, "Mathematics");
  } finally {
    global.fetch = originalFetch;
  }
  removeDir(dir);
});

test("tool fetches a specific PDF URL and saves it", async () => {
  const dir = tempDir();
  const { ctx, state } = makeCtx(dir);
  backend.activate(ctx);

  const pdf = fakePdf("find the derivative of the function example");
  const pdfUrl = "https://papers.xtremepape.rs/IB/2025/Mathematics/derivative_paper_1_HL.pdf";
  const originalFetch = global.fetch;
  global.fetch = async (url) => {
    if (String(url) === pdfUrl) return pdfResponse(pdf);
    throw new Error(`Unexpected URL: ${url}`);
  };
  try {
    const tool = state.tools[0].create({ chatId: "c1", agent: "teacher" })[0];
    const res = await tool.execute("t3", { url: pdfUrl, subject: "Mathematics" });
    const parsed = JSON.parse(res.content[0].text);
    assert.equal(parsed.kind, "question");
    assert.match(parsed.item.question, /derivative/);
    assert.equal(parsed.item.subject, "Mathematics");
    assert.equal(parsed.item.sourceUrl, pdfUrl);
    assert.equal(parsed.item.pdfUrl, pdfUrl);
  } finally {
    global.fetch = originalFetch;
  }
  removeDir(dir);
});

test("tool lists rows of a folder with list:true", async () => {
  const dir = tempDir();
  const { ctx, state } = makeCtx(dir);
  backend.activate(ctx);

  const html = listing([
    { name: "2025 Examination Session", dir: true, dirpath: "./IB/2025+Examination+Session/" },
    {
      name: "paper.pdf",
      href: "IB/2025/paper.pdf",
    },
  ], "IB | Papers | XtremePapers");
  const originalFetch = global.fetch;
  global.fetch = async (url) => ({ status: 200, url, text: async () => html });
  try {
    const tool = state.tools[0].create({ chatId: "c1", agent: "teacher" })[0];
    const res = await tool.execute("t4", {
      list: true,
      url: "https://papers.xtremepape.rs/index.php?dirpath=./IB/&order=0",
    });
    const parsed = JSON.parse(res.content[0].text);
    assert.equal(parsed.kind, "links");
    assert.equal(parsed.links.length, 2);
    assert.equal(parsed.links[0].name, "2025 Examination Session");
    assert.equal(parsed.links[1].name, "paper.pdf");
  } finally {
    global.fetch = originalFetch;
  }
  removeDir(dir);
});

test("diagnosePage reports page metadata without a cookie", async () => {
  const dir = tempDir();
  const { ctx, state } = makeCtx(dir);
  backend.activate(ctx);

  const html = listing([
    {
      name: "paper.pdf",
      href: "IB/2025/paper.pdf",
    },
  ], "Mathematics | Papers | XtremePapers");
  const originalFetch = global.fetch;
  global.fetch = async (url) => ({ status: 200, url, text: async () => html });
  try {
    const report = await state.handles.get("diagnosePage")({
      url: "https://papers.xtremepape.rs/index.php?dirpath=./IB/&order=0",
    });
    assert.equal(report.status, 200);
    assert.match(report.title, /Mathematics/);
    assert.equal(report.rowCount, 1);
    assert.equal(report.documentRows, 1);
  } finally {
    global.fetch = originalFetch;
  }
  removeDir(dir);
});

test("testFetch does not accumulate a saved copy", async () => {
  const dir = tempDir();
  const { ctx, state } = makeCtx(dir);
  backend.activate(ctx);

  await state.handles.get("testFetch")({ add: true, question: "temporary question" });
  assert.equal(state.handles.get("listPapers")().length, 0);
  removeDir(dir);
});

test("testFetch search preview includes count and a top-excerpt sample", async () => {
  const dir = tempDir();
  const { ctx, state } = makeCtx(dir);
  backend.activate(ctx);

  const pdf = fakePdf("binomial theorem expansion example");
  const { map } = treeFixtures(pdf);
  const originalFetch = global.fetch;
  global.fetch = async (url) => {
    const key = String(url);
    if (map.has(key)) {
      const value = map.get(key);
      if (Buffer.isBuffer(value)) return pdfResponse(value);
      return { status: 200, url: key, text: async () => value };
    }
    throw new Error(`Unexpected URL: ${url}`);
  };
  try {
    const result = await state.handles.get("testFetch")({
      search: true, topic: "binomial theorem", subject: "math aa", autoFetch: true,
    });
    assert.equal(result.count, 1);
    assert.equal(result.pdfsScanned, 2);
    assert.match(result.preview, /1 matching excerpt/);
    assert.match(result.preview, /Top excerpt:/);
    assert.match(result.preview, /binomial theorem expansion/);
  } finally {
    global.fetch = originalFetch;
  }
  removeDir(dir);
});

test("backend tolerates a missing signal on the context", () => {
  const dir = tempDir();
  const state = {
    handles: new Map(),
  };
  const ctx = {
    dataDirectory: dir,
    // no signal: cancellation checks must not throw
    cleanup() {},
    handle(n, h) { state.handles.set(n, h); },
    registerQuestionType() { return () => {}; },
    registerTools() { return () => {}; },
    registerInstructions() { return () => {}; },
  };
  backend.activate(ctx);
  const status = state.handles.get("getStatus")();
  assert.equal(status.configured, true);
  removeDir(dir);
});
