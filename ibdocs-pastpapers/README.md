# IB Docs Past Papers — LearnHarness extension

A LearnHarness community plugin that finds IB past-paper questions from the
public archive at [ibdocs.re](https://ibdocs.re) and registers them as teaching
questions the teacher agent can pose during a lesson.

## What it does

- Adds a `fetch_ibdocs_pastpaper` tool to the **teacher** agent. It can:
  - **search by topic** (`{ search: true, topic: "...", subject: "...",
    autoFetch: true }`). It scans a small, bounded set of real past-paper PDFs
    and returns matching text excerpts with source links. Optionally it also
    returns a longer excerpt from the top result via `autoFetch`.
  - fetch a specific document from a `/documents/:id` URL or a bare document id;
  - list the file/folder rows of a folder page (`{ list: true, url }`);
  - save learner-pasted text locally (`{ add: true, question, markscheme? }`);
  - return a previously saved item (`{ useStored: true }`).
- Registers the `ibdocs-pastpaper` question type with a host-built
  `ask_ibdocs_pastpaper_question` posing tool and a custom renderer (question
  view, answer editor, and mark-scheme reveal after answering).
- Adds teacher instructions describing when and how to use the tool, including
  honest attribution (no invented wording or source URLs).
- Provides a Settings page to test topic search / document fetch and manage
  saved items, plus an "IB Docs papers" view in the sidebar.

**No login or cookie is needed — ibdocs.re is a public site.** All fetched or
saved content lives in this plugin's own data directory. No core learning
records are written.

## How topic search works

ibdocs.re is a public, server-rendered archive of IB past papers, question
banks, books and reports. It has **no public JSON search API**, so this plugin
searches as a person would browse:

1. Resolve the subject hint to a `/past-papers-by-subject/:slug` listing
   (e.g. `math aa` → `mathematics-analysis-and-approaches`). If no subject is
   given, a set of common subjects is used.
2. Extract the document rows from the listing and rank them by how well the
   document name matches the topic words. The remaining candidates are sampled
   evenly across the whole subject (so older papers are not hidden behind the
   newest entries), with scanned "More Papers" supplements deprioritized.
3. Download the top PDFs (bounded, default 8, max 20) and search their
   extracted text for the topic.
4. Return the best matching excerpts with their source document and PDF links.

Subjects are limited by default for speed and relevance. A broad topic with a
subject hint works best, e.g. topic `binomial theorem` + subject `math aa`.

PDF text extraction uses Node's built-in `zlib` only — no third-party packages.
It tracks each text stream's font and decodes that font's embedded ToUnicode
CMap (or its `/Encoding` glyph names), including two-byte Type0 CIDs, so subset
font numbers and symbols come out readable (`≤`, `π`, `∈ ℚ`) instead of control
characters.

Math that is drawn as 2D layout is also reconstructed: fraction rules become
`1/(1+x²)` and `π/12`, filled radical paths become `√3` and `p+q√3`, and smaller
raised text becomes `a²` or `re^{iθ}`. The extractor reads text baselines, font
sizes and vector paths inside `/Figure` blocks and folds them back into a linear
string. Non-figure text keeps the simpler linear decoder, and streams that the
interpreter cannot read fall back to it as well.

Extraction is still best-effort. Subset glyphs without a ToUnicode mapping (for
example `g14`/`g32` in some SymbolMT fonts) can still drop a `+` or `=`, and
diagrams with unusual vector artwork may not reconstruct cleanly. Keyword
snippets are reliable enough to locate the relevant question. The plugin never
invents exam wording or a source URL.

> The archive is provided for personal study. The plugin keeps downloads small
> and bounded; please do not use it to bulk-download or redistribute content.

## Settings

Open **Settings → IB Docs past papers** to:

- **Test topic search** — enter a topic and optional subject hint, then confirm
  matching excerpts are found. This is the quickest end-to-end check.
- **Test fetch** — fetch a specific document URL/id, or list a folder.
- **Diagnose page** — a support report showing a page's title, row count and
  detected document rows (useful if the site markup changes).
- **Saved past-paper items** — review and delete locally saved items.

## Install (local)

Build and copy the plugin into the LearnHarness plugins directory:

```sh
npm install        # no runtime dependencies; only needed for tooling if any
npm run build
npm run install:local -- "/Users/augustzhong/Library/Application Support/LearnHarness/data/plugins"
```

`install:local` runs the build and copies the built `dist/` folder into the
target plugins directory. The host, not this helper, decides app compatibility
and whether the plugin is enabled.

Then **restart LearnHarness** and enable **IB Docs past papers** in Settings.

## Troubleshooting

- **"No past-paper text matched"** — try a broader topic, add a subject hint,
  or paste the question text yourself with the tool's `add:true` option.
- **"Could not read a document title"** — the URL may not be a document page;
  use a `/documents/:id` URL or a bare id.
- **Site structure changed** — run **Diagnose page** on a subject listing. If
  row count is 0, the HTML selectors in `src/ibdocs.cjs` (`extractRows`) may
  need updating.

## Development

```sh
npm test           # offline tests (mock the backend context and fetches)
npm run build      # copy source files into dist/ with the runtime layout
```

The plugin uses only public LearnHarness plugin APIs (v1, app `0.6.1+`):
`registerQuestionType`, `registerQuestionRenderer`, `registerTools`,
`registerInstructions`, `registerSettings`, `registerView`, `registerAction`,
`placeAction`, `handle`, and `call`.
