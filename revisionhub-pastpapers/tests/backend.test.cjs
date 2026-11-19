/**
 * Offline tests: mock the LearnHarness backend context and verify registration,
 * settings handlers, and the fetch tool's behaviour without network access.
 */
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const backend = require("../src/backend.cjs");
const rh = require("../src/revisionhub.cjs");
const browsercookie = require("../src/browsercookie.cjs");

function makeCtx(dataDirectory, settings = { cookie: "", autoRefreshCookie: false }) {
  // Tests run offline: keep auto-refresh off by default so a real local browser
  // cookie store cannot leak into mocked requests. Tests that exercise refresh
  // can pass their own settings.
  fs.writeFileSync(path.join(dataDirectory, "settings.json"), JSON.stringify(settings));
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

test("registers question type, tools, instructions and handlers", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rhpp-"));
  const { ctx, state } = makeCtx(dir);
  const cleanup = backend.activate(ctx);

  assert.equal(state.questionTypes.length, 1);
  assert.equal(state.questionTypes[0].id, "rh-pastpaper");
  assert.equal(state.questionTypes[0].teach.toolName, "ask_rh_pastpaper_question");
  assert.equal(state.tools.length, 1);
  assert.equal(state.tools[0].agents[0], "teacher");
  assert.equal(state.instructions.length, 1);
  assert.match(state.instructions[0].text, /fetch_rh_pastpaper/);
  for (const name of [
    "getStatus", "setCookie", "clearCookie", "setAutoRefreshCookie", "refreshCookie",
    "listPapers", "deletePaper", "testFetch", "diagnosePage",
  ]) {
    assert.ok(state.handles.has(name), `missing handler ${name}`);
  }

  const tools = state.tools[0].create({ chatId: "c1", agent: "teacher" });
  assert.equal(tools[0].name, "fetch_rh_pastpaper");

  cleanup();
  assert.equal(state.questionTypes.length, 0);
  assert.equal(state.tools.length, 0);
  assert.equal(state.instructions.length, 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("question validation rejects bad payloads", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rhpp-"));
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
    input: { question: "x", payload: { question: "q", sourceUrl: "https://revisionhub.study/question/1" } },
  });
  assert.equal(good, undefined);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("settings handlers store and clear cookie", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rhpp-"));
  const { ctx, state } = makeCtx(dir);
  backend.activate(ctx);

  let status = state.handles.get("getStatus")();
  assert.equal(status.configured, false);

  state.handles.get("setCookie")({ cookie: "__session=abc; __client_uat=123" });
  status = state.handles.get("getStatus")();
  assert.equal(status.configured, true);
  assert.match(status.cookiePreview, /__session=abc/);

  state.handles.get("clearCookie")();
  status = state.handles.get("getStatus")();
  assert.equal(status.configured, false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("tool saves learner-pasted text via add:true without a session", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rhpp-"));
  const { ctx, state } = makeCtx(dir);
  backend.activate(ctx);
  const tool = state.tools[0].create({ chatId: "c1", agent: "teacher" })[0];

  const res = await tool.execute("t1", {
    add: true,
    question: "Solve x^2 = 4.",
    markscheme: "x = ±2",
    subject: "Mathematics",
  });
  assert.equal(res.content[0].type, "text");
  const parsed = JSON.parse(res.content[0].text);
  assert.equal(parsed.kind, "saved");
  assert.equal(parsed.item.question, "Solve x^2 = 4.");

  const list = state.handles.get("listPapers")();
  assert.equal(list.length, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("tool fetches a mocked question page with a configured cookie", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rhpp-"));
  const { ctx, state } = makeCtx(dir);
  backend.activate(ctx);
  state.handles.get("setCookie")({ cookie: "__session=abc" });

  const html = `<!doctype html><html><body>
    <script>self.__next_f.push([1,"4:[\\"$L5\\",null,{\\"questionMarkdown\\":\\"Find the derivative of f(x)=x^3.\\",\\"answerMarkdown\\":\\"f'(x)=3x^2\\"}]"])</script>
  </body></html>`;
  const originalFetch = global.fetch;
  global.fetch = async (url, init) => {
    assert.equal(url, "https://revisionhub.study/question/123");
    assert.match(init.headers.Cookie, /__session=abc/);
    return {
      status: 200,
      url,
      headers: { get: () => null },
      text: async () => html,
    };
  };
  try {
    const tool = state.tools[0].create({ chatId: "c1", agent: "teacher" })[0];
    const res = await tool.execute("t2", { questionId: "123" });
    const parsed = JSON.parse(res.content[0].text);
    assert.equal(parsed.kind, "question");
    assert.match(parsed.item.question, /derivative/);
    assert.match(parsed.item.markscheme, /3x/);
    assert.equal(parsed.item.sourceUrl, "https://revisionhub.study/question/123");
  } finally {
    global.fetch = originalFetch;
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

test("tool searches by topic and auto-fetches first result", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rhpp-"));
  const { ctx, state } = makeCtx(dir);
  backend.activate(ctx);
  state.handles.get("setCookie")({ cookie: "__session=abc" });

  const searchHtml = `<!doctype html><html><body>
    <a href="/question/456">Question 456</a>
    <script>self.__next_f.push([1,"a:[\\"/question/456\\",null]"])</script>
  </body></html>`;
  const questionHtml = `<!doctype html><html><body>
    <script>self.__next_f.push([1,"4:[\\"$L5\\",null,{\\"questionMarkdown\\":\\"Explain the binomial theorem.\\",\\"answerMarkdown\\":\\"(a+b)^n = sum...\\"}]"])</script>
  </body></html>`;
  const originalFetch = global.fetch;
  global.fetch = async (url) => ({
    status: 200,
    url,
    headers: { get: () => null },
    text: async () => (/\/question\/456/.test(url) ? questionHtml : searchHtml),
  });
  try {
    const tool = state.tools[0].create({ chatId: "c1", agent: "teacher" })[0];
    const res = await tool.execute("t3", {
      search: true,
      topic: "binomial theorem",
      subject: "math aa",
      autoFetch: true,
    });
    const parsed = JSON.parse(res.content[0].text);
    assert.equal(parsed.kind, "search");
    assert.equal(parsed.topic, "binomial theorem");
    assert.ok(parsed.count >= 1);
    assert.match(parsed.searchUrl, /questionbank|search/);
    assert.ok(parsed.fetched);
    assert.match(parsed.fetched.question, /binomial/);
    assert.match(parsed.fetched.markscheme, /\(a\+b\)/);
  } finally {
    global.fetch = originalFetch;
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

test("revisionhub helpers: buildSearchUrls and extractSearchResults", () => {
  const urls = rh.buildSearchUrls("mitosis", "biology");
  assert.ok(urls.length >= 4);
  assert.ok(urls.some((u) => u.includes("q=mitosis")));
  assert.ok(urls.every((u) => u.includes("subject=biology")));

  const subj = rh.buildSubjectTopicUrls("mitosis", "biology");
  assert.ok(subj.length >= 1);
  assert.match(subj[0], /Sciences\/Biology\/questionbank/);

  const html = `<a href="https://revisionhub.study/question/789">Q</a>`;
  const results = rh.extractSearchResults(html, "https://revisionhub.study/search");
  assert.equal(results[0].id, "789");
});

test("diagnosePage reports app chunks without exposing the cookie", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rhpp-"));
  const { ctx, state } = makeCtx(dir);
  backend.activate(ctx);
  state.handles.get("setCookie")({ cookie: "__session=SECRET_VALUE_123" });

  const html = `<!doctype html><html><head><title>Search</title></head><body>
    <input type="text" placeholder="Search">
    <script src="/_next/static/chunks/main-app.js"></script>
    <script src="/_next/static/chunks/app/(app)/search/page-abc123.js"></script>
  </body></html>`;
  const originalFetch = global.fetch;
  global.fetch = async (url, init) => {
    assert.match(init.headers.Cookie, /__session=SECRET_VALUE_123/);
    return { status: 200, url, headers: { get: () => null }, text: async () => html };
  };
  try {
    const report = await state.handles.get("diagnosePage")({ url: "https://revisionhub.study/search" });
    assert.equal(report.redirectedToSignIn, false);
    assert.equal(report.hasInput, true);
    assert.ok(report.appChunks.some((c) => c.includes("search/page-abc123.js")));
    assert.ok(report.appChunks.length >= 1);
    assert.ok(!JSON.stringify(report).includes("SECRET_VALUE_123"));
  } finally {
    global.fetch = originalFetch;
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

test("revisionhub helpers: extractScriptChunks handles escaped slashes", () => {
  const html = `<script src="/_next/static/chunks/app/(app)/search/page-abc.js"></script>
    <script>self.__next_f.push([1,"x:\\"/_next/static/chunks/1234-abc.js\\""])</script>`;
  const chunks = rh.extractScriptChunks(html);
  assert.ok(chunks.some((c) => c.includes("app/(app)/search/page-abc.js")));
  assert.ok(chunks.some((c) => c.includes("1234-abc.js")));
});

test("revisionhub helpers: URL handling and flight-string extraction", () => {
  assert.equal(rh.isAllowedRevisionHubUrl("https://revisionhub.study/question/1"), true);
  assert.equal(rh.isAllowedRevisionHubUrl("https://evil.example/question/1"), false);
  assert.equal(rh.isAllowedRevisionHubUrl("http://revisionhub.study/question/1"), false);

  const target = rh.resolveTarget({ url: "123" });
  assert.equal(target.url, "https://revisionhub.study/question/123");
  assert.equal(target.kind, "question");

  const html = `<script>self.__next_f.push([1,"a:{\\"questionMarkdown\\":\\"What is 2+2?\\"}"])</script>`;
  const strings = rh.extractFlightStrings(html);
  assert.ok(strings.length >= 1);
  assert.ok(JSON.stringify(strings).includes("What is 2+2?"));
});

test("getStatus reports auto-refresh state", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rhpp-"));
  const { ctx, state } = makeCtx(dir, { cookie: "", autoRefreshCookie: false });
  backend.activate(ctx);
  let status = state.handles.get("getStatus")();
  assert.equal(status.autoRefreshCookie, false);
  assert.equal(status.configured, false);

  const result = state.handles.get("setAutoRefreshCookie")({ enabled: true });
  assert.equal(result.autoRefreshCookie, true);
  status = state.handles.get("getStatus")();
  assert.equal(status.autoRefreshCookie, true);
  // The on-disk store may not exist in CI; availability is reported but does not throw.
  assert.equal(typeof status.browserCookieAvailable, "boolean");

  const saved = JSON.parse(fs.readFileSync(path.join(dir, "settings.json"), "utf8"));
  assert.equal(saved.autoRefreshCookie, true);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("auto-refresh uses the browser cookie and persists it", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rhpp-"));
  const { ctx, state } = makeCtx(dir, { cookie: "__session=stale", autoRefreshCookie: true });
  backend.activate(ctx);
  state.handles.get("setCookie")({ cookie: "__session=stale" });

  const original = browsercookie.readSearchBrowserCookie;
  const originalMint = browsercookie.mintFreshSessionCookie;
  browsercookie.mintFreshSessionCookie = async () => null; // keep this test offline
  browsercookie.readSearchBrowserCookie = () => "__session=fresh-from-browser; __client_uat=123";
  const originalFetch = global.fetch;
  let usedCookie = "";
  const questionHtml = `<!doctype html><html><body>
    <script>self.__next_f.push([1,"4:[\\"$L5\\",null,{\\"questionMarkdown\\":\\"Find the derivative of x^3.\\",\\"answerMarkdown\\":\\"3x^2\\"}]"])</script>
  </body></html>`;
  global.fetch = async (url, init) => {
    usedCookie = init.headers.Cookie;
    return { status: 200, url, headers: { get: () => null }, text: async () => questionHtml };
  };
  try {
    const tool = state.tools[0].create({ chatId: "c1", agent: "teacher" })[0];
    await tool.execute("t-refresh", { questionId: "999" });
    assert.match(usedCookie, /fresh-from-browser/);
    const saved = JSON.parse(fs.readFileSync(path.join(dir, "settings.json"), "utf8"));
    assert.match(saved.cookie, /fresh-from-browser/);
  } finally {
    browsercookie.readSearchBrowserCookie = original;
    browsercookie.mintFreshSessionCookie = originalMint;
    global.fetch = originalFetch;
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

test("refreshCookie requires auto-refresh to be enabled", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rhpp-"));
  const { ctx, state } = makeCtx(dir, { cookie: "", autoRefreshCookie: false });
  backend.activate(ctx);
  await assert.rejects(
    state.handles.get("refreshCookie")(),
    /Auto-refresh is turned off/
  );
  fs.rmSync(dir, { recursive: true, force: true });
});

test("fetchPage treats a Clerk handshake redirect as auth expired", async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => ({
    status: 307,
    url: "https://revisionhub.study/search?query=binomial",
    headers: {
      get: (name) => name.toLowerCase() === "location"
        ? "https://clerk.revisionhub.study/v1/client/handshake?redirect_url=%2Fsearch&__clerk_hs_reason=session-token-but-no-client-uat"
        : null,
    },
    text: async () => "",
  });
  try {
    const page = await rh.fetchPage("https://revisionhub.study/search?query=binomial", "__session=abc");
    assert.equal(page.redirectedToSignIn, true);
    assert.equal(page.status, 307);
  } finally {
    global.fetch = originalFetch;
  }
});

const APPLE_EPOCH_SECONDS = 978307200;

function makeJwt(payload) {
  const encode = (obj) => Buffer.from(JSON.stringify(obj)).toString("base64url");
  return `${encode({ alg: "none" })}.${encode(payload)}.sig`;
}

function makeBinaryCookieFile(definitions) {
  const records = definitions.map((def) => {
    const domain = Buffer.from(`${def.domain}\0`, "latin1");
    const name = Buffer.from(`${def.name}\0`, "latin1");
    const cookiePath = Buffer.from(`${def.path || "/"}\0`, "latin1");
    const value = Buffer.from(`${def.value}\0`, "latin1");
    const record = Buffer.alloc(56 + domain.length + name.length + cookiePath.length + value.length);
    record.writeUInt32LE(record.length, 0);
    record.writeUInt32LE(def.flags || 0, 8);
    let offset = 56;
    record.writeUInt32LE(offset, 16);
    domain.copy(record, offset); offset += domain.length;
    record.writeUInt32LE(offset, 20);
    name.copy(record, offset); offset += name.length;
    record.writeUInt32LE(offset, 24);
    cookiePath.copy(record, offset); offset += cookiePath.length;
    record.writeUInt32LE(offset, 28);
    value.copy(record, offset);
    record.writeDoubleLE(def.expiresAt / 1000 - APPLE_EPOCH_SECONDS, 40);
    record.writeDoubleLE(def.createdAt / 1000 - APPLE_EPOCH_SECONDS, 48);
    return record;
  });

  const page = Buffer.alloc(8 + records.length * 4);
  page.writeUInt32BE(0x00000100, 0);
  page.writeUInt32LE(records.length, 4);
  let recordOffset = page.length;
  records.forEach((record, i) => {
    page.writeUInt32LE(recordOffset, 8 + i * 4);
    recordOffset += record.length;
  });

  const header = Buffer.alloc(12);
  header.write("cook", 0, "ascii");
  header.writeUInt32BE(1, 4);
  header.writeUInt32BE(page.length + records.reduce((sum, r) => sum + r.length, 0), 8);
  return Buffer.concat([header, page, ...records]);
}

test("browsercookie parses binarycookies format without exposing values in logs", () => {
  const expiresAt = Date.UTC(2027, 10, 19);
  const createdAt = Date.UTC(2026, 10, 19);
  const file = makeBinaryCookieFile([
    { domain: ".revisionhub.study", name: "__client_uat", value: "vat", expiresAt, createdAt },
    { domain: "revisionhub.study", name: "__session", value: "session-jwt", expiresAt, createdAt },
  ]);
  const cookies = browsercookie.parseBinaryCookies(file);
  assert.equal(cookies.length, 2);
  assert.equal(cookies[0].name, "__client_uat");
  assert.equal(cookies[0].domain, ".revisionhub.study");
  assert.equal(cookies[1].value, "session-jwt");
  assert.equal(cookies[1].expiresAt, expiresAt);
  assert.equal(cookies[1].createdAt, createdAt);
});

test("browsercookie mints a fresh Clerk session from the __client token", async () => {
  const now = Date.now();
  const oldJwt = makeJwt({ sid: "sess_1", exp: Math.floor(now / 1000) - 10 });
  const freshJwt = makeJwt({ sid: "sess_1", exp: Math.floor(now / 1000) + 60 });
  const cookies = [
    { domain: ".clerk.revisionhub.study", name: "__client", value: "client-token" },
    { domain: ".revisionhub.study", name: "__client_uat", value: "vat" },
    { domain: "revisionhub.study", name: "__session", value: oldJwt },
  ];
  const originalFetch = global.fetch;
  let tokenUrl = "";
  let authHeader = "";
  global.fetch = async (url, init) => {
    tokenUrl = url;
    authHeader = init.headers.Authorization;
    return { ok: true, status: 200, json: async () => ({ jwt: freshJwt }) };
  };
  try {
    const minted = await browsercookie.mintFreshSessionCookie({ cookies, now });
    assert.match(tokenUrl, /\/v1\/client\/sessions\/sess_1\/tokens$/);
    assert.equal(authHeader, "Bearer client-token");
    assert.equal(minted.sid, "sess_1");
    assert.equal(minted.method, "clerk-token");
    assert.equal(minted.expiresAt, Math.floor(now / 1000) * 1000 + 60000);
    assert.match(minted.cookie, new RegExp(`__session=${freshJwt.replace(/\./g, "\\.")}`));
    assert.ok(!minted.cookie.includes(oldJwt));
  } finally {
    global.fetch = originalFetch;
  }
});

test("tool retries once with a freshly minted session after a sign-in redirect", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rhpp-"));
  const { ctx, state } = makeCtx(dir, { cookie: "__session=stale", autoRefreshCookie: true });
  backend.activate(ctx);

  const originalMint = browsercookie.mintFreshSessionCookie;
  browsercookie.mintFreshSessionCookie = async () => ({
    cookie: "__session=fresh-minted",
    expiresAt: Date.now() + 60000,
    sid: "sess_1",
    method: "clerk-token",
  });

  const questionHtml = `<!doctype html><html><body>
    <script>self.__next_f.push([1,"4:[\\"$L5\\",null,{\\"questionMarkdown\\":\\"Find the derivative of x^3.\\",\\"answerMarkdown\\":\\"3x^2\\"}]"])</script>
  </body></html>`;
  const originalFetch = global.fetch;
  let attempts = 0;
  const usedCookies = [];
  global.fetch = async (url, init) => {
    attempts++;
    usedCookies.push(init.headers.Cookie || "");
    if (attempts === 1) {
      return {
        status: 307,
        url,
        headers: {
          get: (name) => name.toLowerCase() === "location"
            ? "https://clerk.revisionhub.study/v1/client/handshake?redirect_url=%2Fquestion%2F123"
            : null,
        },
        text: async () => "",
      };
    }
    return { status: 200, url, headers: { get: () => null }, text: async () => questionHtml };
  };
  try {
    const tool = state.tools[0].create({ chatId: "c1", agent: "teacher" })[0];
    const res = await tool.execute("t-retry", { questionId: "123" });
    const parsed = JSON.parse(res.content[0].text);
    assert.equal(parsed.kind, "question");
    assert.equal(attempts, 2);
    assert.match(usedCookies[1], /fresh-minted/);
  } finally {
    browsercookie.mintFreshSessionCookie = originalMint;
    global.fetch = originalFetch;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
