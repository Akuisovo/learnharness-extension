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
  return fs.mkdtempSync(path.join(os.tmpdir(), "ibpp-"));
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

test("registers question type, tools, instructions and handlers", () => {
  const dir = tempDir();
  const { ctx, state } = makeCtx(dir);
  const cleanup = backend.activate(ctx);

  assert.equal(state.questionTypes.length, 1);
  assert.equal(state.questionTypes[0].id, "ibdocs-pastpaper");
  assert.equal(state.questionTypes[0].label, "IB Docs past-paper question");
  assert.equal(state.questionTypes[0].teach.toolName, "ask_ibdocs_pastpaper_question");
  assert.equal(state.tools.length, 1);
  assert.equal(state.tools[0].agents[0], "teacher");
  assert.equal(state.instructions.length, 1);
  assert.match(state.instructions[0].text, /fetch_ibdocs_pastpaper/);
  assert.match(state.instructions[0].text, /ibdocs\.re/);
  for (const name of ["getStatus", "listPapers", "deletePaper", "testFetch", "diagnosePage"]) {
    assert.ok(state.handles.has(name), `missing handler ${name}`);
  }

  const tools = state.tools[0].create({ chatId: "c1", agent: "teacher" });
  assert.equal(tools[0].name, "fetch_ibdocs_pastpaper");

  cleanup();
  assert.equal(state.questionTypes.length, 0);
  assert.equal(state.tools.length, 0);
  assert.equal(state.instructions.length, 0);
  removeDir(dir);
});

test("question validation rejects bad payloads and non-ibdocs URLs", () => {
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
        sourceUrl: "https://ibdocs.re/documents/1",
        pdfUrl: "https://ibdocs.re/p/paper.pdf",
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
  assert.equal(status.baseUrl, "https://ibdocs.re");
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

  const listingHtml = `<!doctype html><html><body>
    <a class="file-row" href="/documents/doc1"><span class="file-name"><span>Binomial Paper</span></span><span class="file-size">10</span></a>
  </body></html>`;
  const docHtml = `<!doctype html><html><head><title>Binomial Paper | IB Documents</title></head><body>
    <script type="application/ld+json">{"contentUrl":"https://ibdocs.re/p/paper.pdf"}</script>
  </body></html>`;
  const pdf = fakePdf("binomial theorem expansion example");
  const originalFetch = global.fetch;
  global.fetch = async (url) => {
    if (/\/past-papers-by-subject\//.test(url)) {
      return { status: 200, url, text: async () => listingHtml };
    }
    if (/\/documents\//.test(url)) {
      return { status: 200, url, text: async () => docHtml };
    }
    if (/\/p\/.*\.pdf/.test(url)) {
      return { ok: true, status: 200, url, arrayBuffer: async () => pdf.buffer.slice(pdf.byteOffset, pdf.byteOffset + pdf.byteLength) };
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
    assert.deepEqual(parsed.searchedSubjects, ["mathematics-analysis-and-approaches"]);
    assert.ok(parsed.pdfsScanned >= 1);
    assert.ok(parsed.count >= 1);
    assert.match(parsed.results[0].snippet, /binomial theorem/);
    assert.ok(parsed.fetched);
    assert.match(parsed.fetched.question, /binomial theorem/);
    assert.equal(parsed.fetched.sourceUrl, "https://ibdocs.re/documents/doc1");
  } finally {
    global.fetch = originalFetch;
  }
  removeDir(dir);
});

test("tool fetches a specific document by bare id and saves it", async () => {
  const dir = tempDir();
  const { ctx, state } = makeCtx(dir);
  backend.activate(ctx);

  const docHtml = `<!doctype html><html><head><title>Derivative Paper | IB Documents</title></head><body>
    <script type="application/ld+json">{"contentUrl":"https://ibdocs.re/p/derivative.pdf"}</script>
  </body></html>`;
  const pdf = fakePdf("find the derivative of the function example");
  const originalFetch = global.fetch;
  global.fetch = async (url) => {
    if (/\/documents\//.test(url)) return { status: 200, url, text: async () => docHtml };
    if (/\/p\/.*\.pdf/.test(url)) {
      return { ok: true, status: 200, url, arrayBuffer: async () => pdf.buffer.slice(pdf.byteOffset, pdf.byteOffset + pdf.byteLength) };
    }
    throw new Error(`Unexpected URL: ${url}`);
  };
  try {
    const tool = state.tools[0].create({ chatId: "c1", agent: "teacher" })[0];
    const res = await tool.execute("t3", { documentId: "derivative-paper-123", subject: "Mathematics" });
    const parsed = JSON.parse(res.content[0].text);
    assert.equal(parsed.kind, "question");
    assert.match(parsed.item.question, /derivative/);
    assert.equal(parsed.item.subject, "Mathematics");
    assert.equal(parsed.item.sourceUrl, "https://ibdocs.re/documents/derivative-paper-123");
  } finally {
    global.fetch = originalFetch;
  }
  removeDir(dir);
});

test("tool lists rows of a folder with list:true", async () => {
  const dir = tempDir();
  const { ctx, state } = makeCtx(dir);
  backend.activate(ctx);

  const listingHtml = `<!doctype html><html><head><title>Physics | IB Documents</title></head><body>
    <a class="file-row" href="/documents/paper-a"><span class="file-name"><span>Paper A</span></span><span class="file-size">12</span></a>
    <a class="file-row" href="/past-papers-by-subject/physics/2024"><span class="file-name"><span>2024</span></span><span class="file-size">-</span></a>
  </body></html>`;
  const originalFetch = global.fetch;
  global.fetch = async (url) => ({ status: 200, url, text: async () => listingHtml });
  try {
    const tool = state.tools[0].create({ chatId: "c1", agent: "teacher" })[0];
    const res = await tool.execute("t4", {
      list: true,
      url: "https://ibdocs.re/past-papers-by-subject/physics",
    });
    const parsed = JSON.parse(res.content[0].text);
    assert.equal(parsed.kind, "links");
    assert.equal(parsed.links.length, 2);
    assert.equal(parsed.links[0].name, "Paper A");
  } finally {
    global.fetch = originalFetch;
  }
  removeDir(dir);
});

test("diagnosePage reports page metadata without a cookie", async () => {
  const dir = tempDir();
  const { ctx, state } = makeCtx(dir);
  backend.activate(ctx);

  const html = `<!doctype html><html><head><title>Mathematics Analysis and Approaches | IB Documents</title></head><body>
    <a class="file-row" href="/documents/doc9"><span class="file-name"><span>Paper 1</span></span><span class="file-size">9</span></a>
  </body></html>`;
  const originalFetch = global.fetch;
  global.fetch = async (url) => ({ status: 200, url, text: async () => html });
  try {
    const report = await state.handles.get("diagnosePage")({
      url: "https://ibdocs.re/past-papers-by-subject/mathematics-analysis-and-approaches",
    });
    assert.equal(report.status, 200);
    assert.match(report.title, /Mathematics Analysis/);
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

  const listingHtml = `<a class="file-row" href="/documents/doc1"><span class="file-name"><span>Binomial Paper</span></span><span class="file-size">10</span></a>`;
  const docHtml = `<!doctype html><html><head><title>Binomial Paper | IB Documents</title></head><body>
    <script type="application/ld+json">{"contentUrl":"https://ibdocs.re/p/paper.pdf"}</script>
  </body></html>`;
  const pdf = fakePdf("binomial theorem expansion example");
  const originalFetch = global.fetch;
  global.fetch = async (url) => {
    if (/\/past-papers-by-subject\//.test(url)) return { status: 200, url, text: async () => listingHtml };
    if (/\/documents\//.test(url)) return { status: 200, url, text: async () => docHtml };
    if (/\/p\/.*\.pdf/.test(url)) {
      return { ok: true, status: 200, url, arrayBuffer: async () => pdf.buffer.slice(pdf.byteOffset, pdf.byteOffset + pdf.byteLength) };
    }
    throw new Error(`Unexpected URL: ${url}`);
  };
  try {
    const result = await state.handles.get("testFetch")({
      search: true, topic: "binomial theorem", subject: "math aa", autoFetch: true,
    });
    assert.equal(result.count, 1);
    assert.equal(result.pdfsScanned, 1);
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
