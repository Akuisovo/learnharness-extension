/**
 * Offline tests for the ibdocs.re content-access helpers. Uses small synthetic
 * HTML/PDF fixtures (plus the real saved fixtures when available) and never
 * performs network requests.
 */
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");
const test = require("node:test");

const ib = require("../src/ibdocs.cjs");

const TMP = "/private/var/folders/w6/98pyz4wn4p319f3tm5ds_0w00000gn/T/opencode";

test("isAllowedIbdocsUrl only accepts https ibdocs.re hosts", () => {
  assert.equal(ib.isAllowedIbdocsUrl("https://ibdocs.re/documents/1"), true);
  assert.equal(ib.isAllowedIbdocsUrl("https://www.ibdocs.re/paper.pdf"), true);
  assert.equal(ib.isAllowedIbdocsUrl("http://ibdocs.re/documents/1"), false);
  assert.equal(ib.isAllowedIbdocsUrl("https://evil.example/?u=ibdocs.re"), false);
  assert.equal(ib.isAllowedIbdocsUrl("not a url"), false);
});

test("subjectSlug maps friendly hints and slugifies unknown ones", () => {
  assert.equal(ib.subjectSlug("math aa"), "mathematics-analysis-and-approaches");
  assert.equal(ib.subjectSlug("MATH AA HL"), "mathematics-analysis-and-approaches");
  assert.equal(ib.subjectSlug("math ai"), "mathematics-applications-and-interpretation");
  assert.equal(ib.subjectSlug("Physics"), "physics");
  assert.equal(ib.subjectSlug("Design Technology"), "design-technology");
  assert.equal(ib.subjectSlug(""), "");
  assert.equal(
    ib.subjectListingUrl("physics"),
    "https://ibdocs.re/past-papers-by-subject/physics"
  );
});

test("extractRows parses file rows from a synthetic listing", () => {
  const html = `<section class="file-table">
    <a class="file-row" href="/documents/paper-1-tza"><span class="file-name"><svg class="lucide lucide-file"></svg><span>Paper 1 TZA</span></span><span class="file-size">724 KB</span></a>
    <a class="file-row" href="/past-papers/2026"><span class="file-name"><svg class="lucide lucide-folder"></svg><span>2026</span></span><span class="file-size">-</span></a>
  </section>`;
  const rows = ib.extractRows(html, "https://ibdocs.re/past-papers-by-subject/mathematics");
  assert.equal(rows.length, 2);
  assert.equal(rows[0].name, "Paper 1 TZA");
  assert.equal(rows[0].href, "https://ibdocs.re/documents/paper-1-tza");
  assert.equal(rows[0].size, "724 KB");
  assert.equal(rows[0].isDir, false);
  assert.equal(rows[1].name, "2026");
  assert.equal(rows[1].isDir, true);
});

test("extractDocumentInfo reads title and PDF link", () => {
  const html = `<!doctype html><html><head><title>Binomial Paper | IB Documents</title></head><body>
    <script type="application/ld+json">{"contentUrl":"https://ibdocs.re/p/IB%20PAST%20PAPERS/paper.pdf"}</script>
  </body></html>`;
  const info = ib.extractDocumentInfo(html, "https://ibdocs.re/documents/doc-1");
  assert.equal(info.title, "Binomial Paper");
  assert.match(info.pdfUrl, /\/p\//);
  assert.match(info.pdfUrl, /\.pdf$/);
  assert.equal(info.sourceUrl, "https://ibdocs.re/documents/doc-1");
});

test("extractPdfText inflates a deflate stream and cleans the text", () => {
  const content = Buffer.from("BT (binomial theorem example en-US) ET", "latin1");
  const deflated = zlib.deflateSync(content);
  const pdf = Buffer.concat([
    Buffer.from("stream\n", "latin1"),
    deflated,
    Buffer.from("\nendstream", "latin1"),
  ]);
  const text = ib.extractPdfText(pdf);
  assert.match(text, /binomial theorem example/);
  assert.doesNotMatch(text, /en-US/);
  assert.equal(ib.extractPdfText(Buffer.alloc(0)), "");
});

test("isReadableStream rejects binary font data but keeps exam text", () => {
  assert.equal(ib.isReadableStream("binomial theorem expansion example with words"), true);
  assert.equal(ib.isReadableStream("¬°Ç=Æ}Ï³òç¸ÅsÃö ý³£¶È"), false);
  assert.equal(ib.isReadableStream(""), false);
});

test("parsePdfCMap reads bfchar and bfrange entries", () => {
  const cmap = `1 begincodespacerange <0000> <FFFF> endcodespacerange
    3 beginbfchar <1E> <2208> <1F> <002D> <005C> <F0A1> endbfchar
    2 beginbfrange <30> <32> <0030> endbfrange
    1 beginbfrange <0060> <0061> [<0041> <0042>] endbfrange`;
  const { map1, map2 } = ib.parsePdfCMap(cmap);
  assert.equal(map1.get(0x1e), "\u2208");
  assert.equal(map1.get(0x1f), "-");
  assert.equal(map2.get("005C"), "\uF0A1");
  assert.equal(map1.get(0x30), "0");
  assert.equal(map1.get(0x31), "1");
  assert.equal(map1.get(0x32), "2");
  assert.equal(map2.get("0061"), "B");
});

test("parsePdfEncodingDifferences maps codes to glyph names", () => {
  const diff = ib.parsePdfEncodingDifferences(
    "<</BaseEncoding/WinAnsiEncoding/Differences[30/two/one]/Type/Encoding>>"
  );
  assert.equal(diff.get(30), "two");
  assert.equal(diff.get(31), "one");
});

test("decodePdfContent tracks Tf and decodes a subset-font fraction", () => {
  // Font T1_0: code 0x1F -> glyph "one", 0x1E -> glyph "two" (no ToUnicode).
  const fontMap = new Map([
    ["TT0", { isType0: false, map1: new Map(), map2: new Map(), differences: new Map() }],
    ["T1_0", {
      isType0: false,
      map1: new Map(),
      map2: new Map(),
      differences: new Map([[30, "two"], [31, "one"]]),
    }],
  ]);
  const stream = "BT /TT0 1 Tf (Consider ) Tj /T1_0 1 Tf (\\037\\037)Tj (\\036)Tj ET";
  const text = ib.decodePdfContent(stream, fontMap);
  assert.equal(text, "Consider 112");
  assert.doesNotMatch(text, /[\u0000-\u001f]/);
});

test("decodePdfContent2D reconstructs fractions, radicals and superscripts", () => {
  const fraction = `/Figure <</MCID 1 >>BDC
    q 1 0 0 1 98 110 cm 0 0 m 20 0 l S Q
    BT /F1 12 Tf 1 0 0 1 100 120 Tm (π) Tj ET
    BT /F1 12 Tf 1 0 0 1 100 100 Tm (6) Tj ET
  EMC`;
  assert.equal(ib.decodePdfContent2D(fraction, null), "π/6");

  const radical = `/Figure <</MCID 2 >>BDC
    q 1 0 0 1 200 100 cm 0 0 m 1.7 0.9 l 4.3 -2.9 l 7.2 8.6 l 13.6 8.6 l
      13.6 8 l 7.7 8 l 4.6 -4.2 l 4 -4.2 l 1 0.1 l 0.2 -0.4 l f Q
    BT /F1 12 Tf 1 0 0 1 207 103 Tm (3) Tj ET
  EMC`;
  assert.equal(ib.decodePdfContent2D(radical, null), "√3");

  const raised = "BT /F1 12 Tf 1 0 0 1 100 100 Tm (a) Tj ET " +
    "BT /F1 7 Tf 1 0 0 1 106 104 Tm (2) Tj ET";
  assert.equal(ib.decodePdfContent2D(raised, null), "a²");

  const multiRaised = "BT /F1 12 Tf 1 0 0 1 100 100 Tm (e) Tj ET " +
    "BT /F1 7 Tf 1 0 0 1 106 104 Tm (i) Tj ET " +
    "BT /F1 7 Tf 1 0 0 1 111 104 Tm (θ) Tj ET";
  assert.equal(ib.decodePdfContent2D(multiRaised, null), "e^{iθ}");
});

test("isDecodedPdfTextReadable accepts math text and rejects binary blobs", () => {
  assert.equal(ib.isDecodedPdfTextReadable("Show that 1 - x2 + x4 where k \u2208 \u211a+ and -\u03c0 < \u03b8 \u2264 \u03c0"), true);
  assert.equal(ib.isDecodedPdfTextReadable("\u0003\u001a\u0001\u00d1gNI\u00fc\u0080#q@Bvl"), false);
});

test("scoreName and snippetFor locate topic words", () => {
  assert.ok(ib.scoreName("Mathematics binomial paper", "binomial theorem") > 0);
  assert.equal(ib.scoreName("Physics paper", "binomial theorem"), 0);
  assert.ok(ib.scoreName("Binomial theorem", "binomial theorem") >= 100);

  const text = "Section A. Show that the binomial expansion of (a+b)^n is valid.";
  const snippet = ib.snippetFor(text, "binomial expansion");
  assert.match(snippet, /binomial expansion/);
});

test("real saved fixtures parse correctly when present", () => {
  const listingPath = path.join(TMP, "ibdocs-past-papers-by-subject.html");
  if (fs.existsSync(listingPath)) {
    const html = fs.readFileSync(listingPath, "utf8").replace(/\0/g, "");
    const rows = ib.extractRows(html, "https://ibdocs.re/past-papers-by-subject");
    assert.ok(rows.length >= 200, `expected many subject rows, got ${rows.length}`);
    assert.ok(rows.some((r) => r.name === "Physics"));
    assert.ok(rows.some((r) => r.name === "Mathematics Analysis and Approaches"));
  }

  const pdfPath = path.join(TMP, "ibdocs-test.pdf");
  if (fs.existsSync(pdfPath)) {
    const text = ib.extractPdfText(fs.readFileSync(pdfPath));
    assert.ok(text.length > 1000, `expected real PDF text, got ${text.length} chars`);
    assert.match(text.toLowerCase(), /mathematics/);
    // Font-specific decoding must remove control-char glyphs and restore math
    // symbols from the ToUnicode CMaps / Encoding Differences.
    assert.equal((text.match(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g) || []).length, 0);
    assert.match(text, /\u2208 \u211a/); // "∈ ℚ" (element of rationals)
    assert.match(text, /-\u03c0 < \u03b8 \u2264 \u03c0/); // "-π < θ ≤ π"
    // 2D reconstruction: fraction bars, radicals and raised glyphs.
    assert.match(text, /1 - x\u00b2 \+ x\u2074 - x\u2076/);
    assert.match(text, /1\/\(1\+x\u00b2\)/);
    assert.match(text, /re\^\{i\u03b8\}/);
    assert.match(text, /\u221a3/); // √3
    assert.match(text, /tan\u03c0\/12/);
    assert.match(text, /pq\+\u221a3/);
  }
});
