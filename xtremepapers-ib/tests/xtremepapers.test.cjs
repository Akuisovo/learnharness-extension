/**
 * Offline tests for the papers.xtremepape.rs content-access helpers. Uses small synthetic
 * HTML/PDF fixtures and never performs network requests.
 */
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");
const test = require("node:test");

const xp = require("../src/xtremepapers.cjs");

const TMP = "/private/var/folders/w6/98pyz4wn4p319f3tm5ds_0w00000gn/T/opencode";

test("isAllowedXtremePapersUrl only accepts https papers.xtremepape.rs hosts", () => {
  assert.equal(xp.isAllowedXtremePapersUrl("https://papers.xtremepape.rs/index.php?dirpath=./IB/"), true);
  assert.equal(xp.isAllowedXtremePapersUrl("https://papers.xtremepape.rs/IB/2025/paper.pdf"), true);
  assert.equal(xp.isAllowedXtremePapersUrl("http://papers.xtremepape.rs/index.php"), false);
  assert.equal(xp.isAllowedXtremePapersUrl("https://evil.example/?u=papers.xtremepape.rs"), false);
  assert.equal(xp.isAllowedXtremePapersUrl("not a url"), false);
});

test("subject mapping resolves categories and filename patterns", () => {
  assert.equal(xp.subjectCategory("math aa"), "Mathematics");
  assert.equal(xp.subjectCategory("MATH AA HL"), "Mathematics");
  assert.equal(xp.subjectCategory("physics"), "Experimental sciences");
  assert.equal(xp.subjectCategory("biology"), "Experimental sciences");
  assert.equal(xp.subjectCategory("economics"), "Individuals and societies");
  assert.equal(xp.subjectCategory(""), "");
  assert.equal(xp.subjectCategory("unknown subject"), "");

  assert.match("Mathematics_analysis_and_approaches_paper_1.pdf", xp.subjectFilePattern("math aa"));
  assert.match("Mathematics_applications_and_interpretation_paper_1.pdf", xp.subjectFilePattern("math ai"));
  assert.doesNotMatch("Mathematics_applications_and_interpretation_paper_1.pdf", xp.subjectFilePattern("math aa"));
  assert.match("Biology_paper_1A_TZ1_HL.pdf", xp.subjectFilePattern("biology"));
  assert.equal(xp.subjectFilePattern("unknown subject"), null);
});

test("listing URL helpers encode and decode dirpaths", () => {
  assert.equal(
    xp.listingUrl("./IB/2025+Examination+Session/"),
    "https://papers.xtremepape.rs/index.php?dirpath=./IB/2025+Examination+Session/&order=0"
  );
  assert.equal(xp.encodeDirSegment("May 2025 Examination Session"), "May+2025+Examination+Session");
  assert.equal(xp.decodeDirpath("./IB/2025+Examination+Session/"), "./IB/2025 Examination Session/");
  assert.equal(
    xp.dirpathFromHref("index.php?dirpath=./IB/Mathematics/&amp;order=0", xp.IB_ROOT),
    "./IB/Mathematics/"
  );
});

test("extractRows parses directories and PDFs from a synthetic XtremePapers listing", () => {
  const html = `<table>
    <tr class="odd xp-file"><td class="fname"><a href="index.php?dirpath=./IB/2025+Examination+Session/&amp;order=0" class="directory xp-row-link">2025 Examination Session</a></td><td class="fmtime"><time datetime="2026-01-01T00:00:00+00:00"></time></td></tr>
    <tr class="even xp-file"><td class="fname"><a href="IB/2025%20Examination%20Session/Mathematics/Mathematics_analysis_and_approaches_paper_1_TZ1_HL.pdf" class="file xp-row-link">Mathematics_analysis_and_approaches_paper_1_TZ1_HL.pdf</a><a href="https://prepare.xtremepape.rs/papers/4/832?sol=1" class="solution-link">Solutions</a></td><td class="fsize">1.134 MB</td><td class="fmtime"><time datetime="2025-08-27T17:00:46+03:00"></time></td></tr>
    <tr class="odd xp-file"><td class="fname"><a href="IB/2025%20Examination%20Session/Mathematics/Mathematics_analysis_and_approaches_paper_1_TZ1_HL_markscheme.pdf" class="file xp-row-link">Mathematics_analysis_and_approaches_paper_1_TZ1_HL_markscheme.pdf</a></td></tr>
  </table>`;
  const base = "https://papers.xtremepape.rs/index.php?dirpath=./IB/2025+Examination+Session/May+2025+Examination+Session/Mathematics/&order=0";
  const rows = xp.extractRows(html, base);
  assert.equal(rows.length, 3);
  assert.equal(rows[0].isDir, true);
  assert.equal(rows[0].name, "2025 Examination Session");
  assert.equal(rows[0].dirpath, "./IB/2025 Examination Session/");
  assert.equal(rows[1].isPdf, true);
  assert.equal(rows[1].size, "1.134 MB");
  assert.equal(rows[1].modified, "2025-08-27T17:00:46+03:00");
  assert.equal(rows[2].isPdf, true);
});

test("folder helpers filter years, sessions and categories", () => {
  const rows = [
    { name: "2026 Examination Session", isDir: true },
    { name: "2025 Examination Session", isDir: true },
    { name: "2024 Examination Session", isDir: true },
  ];
  const years = xp.yearFolders(rows);
  assert.deepEqual(years.map((y) => y.year), [2026, 2025, 2024]);

  const sessionRows = [
    { name: "Parent folder", isDir: true },
    { name: "May 2025 Examination Session", isDir: true },
    { name: "November 2024 Examination Session", isDir: true },
    { name: "DONATED PAPERS M25", isDir: true },
  ];
  const sessions = xp.sessionFolders(sessionRows, "");
  assert.deepEqual(sessions.map((s) => s.name), [
    "May 2025 Examination Session",
    "November 2024 Examination Session",
    "DONATED PAPERS M25",
  ]);
  assert.equal(xp.sessionFolders(sessionRows, "May").length, 1);

  const categoryRows = [
    { name: "Parent folder", isDir: true },
    { name: "Mathematics", isDir: true },
    { name: "Experimental sciences", isDir: true },
    { name: "audio", isDir: true },
  ];
  assert.deepEqual(xp.categoryFolders(categoryRows, "physics").map((c) => c.name), ["Experimental sciences"]);
  assert.deepEqual(xp.categoryFolders(categoryRows, "").map((c) => c.name), ["Mathematics", "Experimental sciences"]);
});

test("pdfMetadata and markschemeFor read filenames and pair mark schemes", () => {
  const pdfUrl = "https://papers.xtremepape.rs/IB/2025%20Examination%20Session/May%202025%20Examination%20Session/Mathematics/Mathematics_analysis_and_approaches_paper_1_TZ1_HL.pdf";
  const meta = xp.pdfMetadata(pdfUrl);
  assert.equal(meta.year, 2025);
  assert.equal(meta.session, "May 2025");
  assert.equal(meta.paper, "1");
  assert.equal(meta.level, "HL");
  assert.equal(meta.zone, "TZ1");
  assert.equal(meta.isMarkscheme, false);

  const rows = [
    { isPdf: true, href: pdfUrl, name: "Mathematics_analysis_and_approaches_paper_1_TZ1_HL.pdf" },
    {
      isPdf: true,
      href: pdfUrl.replace(".pdf", "_markscheme.pdf"),
      name: "Mathematics_analysis_and_approaches_paper_1_TZ1_HL_markscheme.pdf",
    },
  ];
  assert.match(xp.markschemeFor(pdfUrl, rows), /markscheme\.pdf$/);
  const pdfs = xp.pdfRows(rows, "math aa");
  assert.equal(pdfs.length, 2);
});

test("extractPdfText inflates a deflate stream and cleans the text", () => {
  const content = Buffer.from("BT (binomial theorem example en-US) ET", "latin1");
  const deflated = zlib.deflateSync(content);
  const pdf = Buffer.concat([
    Buffer.from("stream\n", "latin1"),
    deflated,
    Buffer.from("\nendstream", "latin1"),
  ]);
  const text = xp.extractPdfText(pdf);
  assert.match(text, /binomial theorem example/);
  assert.doesNotMatch(text, /en-US/);
  assert.equal(xp.extractPdfText(Buffer.alloc(0)), "");
});

test("isReadableStream rejects binary font data but keeps exam text", () => {
  assert.equal(xp.isReadableStream("binomial theorem expansion example with words"), true);
  assert.equal(xp.isReadableStream("¬°Ç=Æ}Ï³òç¸ÅsÃö ý³£¶È"), false);
  assert.equal(xp.isReadableStream(""), false);
});

test("parsePdfCMap reads bfchar and bfrange entries", () => {
  const cmap = `1 begincodespacerange <0000> <FFFF> endcodespacerange
    3 beginbfchar <1E> <2208> <1F> <002D> <005C> <F0A1> endbfchar
    2 beginbfrange <30> <32> <0030> endbfrange
    1 beginbfrange <0060> <0061> [<0041> <0042>] endbfrange`;
  const { map1, map2 } = xp.parsePdfCMap(cmap);
  assert.equal(map1.get(0x1e), "\u2208");
  assert.equal(map1.get(0x1f), "-");
  assert.equal(map2.get("005C"), "\uF0A1");
  assert.equal(map1.get(0x30), "0");
  assert.equal(map1.get(0x31), "1");
  assert.equal(map1.get(0x32), "2");
  assert.equal(map2.get("0061"), "B");
});

test("parsePdfEncodingDifferences maps codes to glyph names", () => {
  const diff = xp.parsePdfEncodingDifferences(
    "<</BaseEncoding/WinAnsiEncoding/Differences[30/two/one]/Type/Encoding>>"
  );
  assert.equal(diff.get(30), "two");
  assert.equal(diff.get(31), "one");
});

test("decodePdfContent tracks Tf and decodes a subset-font fraction", () => {
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
  const text = xp.decodePdfContent(stream, fontMap);
  assert.equal(text, "Consider 112");
  assert.doesNotMatch(text, /[\u0000-\u001f]/);
});

test("decodePdfContent2D reconstructs fractions, radicals and superscripts", () => {
  const fraction = `/Figure <</MCID 1 >>BDC
    q 1 0 0 1 98 110 cm 0 0 m 20 0 l S Q
    BT /F1 12 Tf 1 0 0 1 100 120 Tm (π) Tj ET
    BT /F1 12 Tf 1 0 0 1 100 100 Tm (6) Tj ET
  EMC`;
  assert.equal(xp.decodePdfContent2D(fraction, null), "π/6");

  const radical = `/Figure <</MCID 2 >>BDC
    q 1 0 0 1 200 100 cm 0 0 m 1.7 0.9 l 4.3 -2.9 l 7.2 8.6 l 13.6 8.6 l
      13.6 8 l 7.7 8 l 4.6 -4.2 l 4 -4.2 l 1 0.1 l 0.2 -0.4 l f Q
    BT /F1 12 Tf 1 0 0 1 207 103 Tm (3) Tj ET
  EMC`;
  assert.equal(xp.decodePdfContent2D(radical, null), "√3");

  const raised = "BT /F1 12 Tf 1 0 0 1 100 100 Tm (a) Tj ET " +
    "BT /F1 7 Tf 1 0 0 1 106 104 Tm (2) Tj ET";
  assert.equal(xp.decodePdfContent2D(raised, null), "a²");

  const multiRaised = "BT /F1 12 Tf 1 0 0 1 100 100 Tm (e) Tj ET " +
    "BT /F1 7 Tf 1 0 0 1 106 104 Tm (i) Tj ET " +
    "BT /F1 7 Tf 1 0 0 1 111 104 Tm (θ) Tj ET";
  assert.equal(xp.decodePdfContent2D(multiRaised, null), "e^{iθ}");
});

test("isDecodedPdfTextReadable accepts math text and rejects binary blobs", () => {
  assert.equal(xp.isDecodedPdfTextReadable("Show that 1 - x2 + x4 where k \u2208 \u211a+ and -\u03c0 < \u03b8 \u2264 \u03c0"), true);
  assert.equal(xp.isDecodedPdfTextReadable("\u0003\u001a\u0001\u00d1gNI\u00fc\u0080#q@Bvl"), false);
});

test("scoreName and snippetFor locate topic words", () => {
  assert.ok(xp.scoreName("Mathematics binomial paper", "binomial theorem") > 0);
  assert.equal(xp.scoreName("Physics paper", "binomial theorem"), 0);
  assert.ok(xp.scoreName("Binomial theorem", "binomial theorem") >= 100);

  const text = "Section A. Show that the binomial expansion of (a+b)^n is valid.";
  const snippet = xp.snippetFor(text, "binomial expansion");
  assert.match(snippet, /binomial expansion/);
});

test("real saved fixtures parse correctly when present", () => {
  const listingPath = path.join(TMP, "xp-math25.html");
  if (fs.existsSync(listingPath)) {
    const html = fs.readFileSync(listingPath, "utf8").replace(/\0/g, "");
    const rows = xp.extractRows(html, "https://papers.xtremepape.rs/index.php?dirpath=./IB/2025+Examination+Session/May+2025+Examination+Session/Mathematics/&order=0");
    assert.ok(rows.some((r) => r.isPdf && /analysis_and_approaches_paper_1_TZ1_HL\.pdf$/.test(r.href)));
    assert.ok(rows.some((r) => r.isPdf && /markscheme\.pdf$/.test(r.name)));
  }

  const pdfPath = path.join(TMP, "ibdocs-test.pdf");
  if (fs.existsSync(pdfPath)) {
    const text = xp.extractPdfText(fs.readFileSync(pdfPath));
    assert.ok(text.length > 1000, `expected real PDF text, got ${text.length} chars`);
    assert.match(text.toLowerCase(), /mathematics/);
    assert.equal((text.match(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g) || []).length, 0);
    assert.match(text, /\u2208 \u211a/);
    assert.match(text, /-\u03c0 < \u03b8 \u2264 \u03c0/);
    assert.match(text, /1 - x\u00b2 \+ x\u2074 - x\u2076/);
    assert.match(text, /1\/\(1\+x\u00b2\)/);
    assert.match(text, /re\^\{i\u03b8\}/);
    assert.match(text, /\u221a3/);
    assert.match(text, /tan\u03c0\/12/);
    assert.match(text, /pq\+\u221a3/);
  }
});
