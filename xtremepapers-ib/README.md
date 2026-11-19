# XtremePapers IB Past Papers — LearnHarness extension

A LearnHarness community plugin that finds IB past-paper questions from the
public archive at [papers.xtremepape.rs](https://papers.xtremepape.rs) and registers them as teaching
questions the teacher agent can pose during a lesson.

## What it does

- Adds a `fetch_xtremepapers_pastpaper` tool to the **teacher** agent. It can:
  - **search by topic** (`{ search: true, topic: "...", subject: "...",
    autoFetch: true }`). It walks recent IB folders, downloads a small bounded
    set of real past-paper PDFs and returns matching text excerpts with source
    and mark-scheme links. `autoFetch` also returns a longer excerpt from the
    top result.
  - fetch a specific PDF by direct URL;
  - list the file/folder rows of any folder page (`{ list: true, url }`);
  - save learner-pasted text locally (`{ add: true, question, markscheme? }`);
  - return a previously saved item (`{ useStored: true }`).
- Registers the `xtremepapers-pastpaper` question type with a host-built
  `ask_xtremepapers_pastpaper_question` posing tool and a custom renderer (question
  view, answer editor, and mark-scheme reveal after answering).
- Adds teacher instructions describing when and how to use the tool, including
  honest attribution (no invented wording or source URLs).
- Provides a Settings page to test topic search / PDF fetch and manage saved
  items, plus an "XtremePapers IB papers" view in the sidebar.

**No login or cookie is needed — papers.xtremepape.rs is a public site.** All fetched or
saved content lives in this plugin's own data directory. No core learning
records are written.

## How topic search works

papers.xtremepape.rs is a public, server-rendered **directory archive** of IB
past papers. It has **no public JSON search API**, so this plugin searches as a
person would browse:

1. Start at the [IB root](https://papers.xtremepape.rs/index.php?dirpath=./IB/&order=0)
   and walk the most recent years (default 3, max 6) into exam sessions and
   subject category folders (Mathematics, Experimental sciences, etc.).
2. A subject hint narrows the walk: e.g. `math aa` selects the Mathematics
   category and only files whose names contain `analysis_and_approaches`. Other
   useful hints: `math ai`, `physics`, `chemistry`, `biology`, `economics`.
3. Extract the PDF rows, rank them by how well the filename matches the topic,
   and sample the rest evenly so different papers/sessions are covered.
4. Download the top PDFs (bounded, default 8, max 20) and search their extracted
   text for the topic. Each result includes the direct PDF URL, the folder
   listing URL, and a matching mark-scheme PDF URL when one exists.

A broad topic with a subject hint works best, e.g. topic `binomial theorem` +
subject `math aa`. You can also narrow by session with the optional `session`
argument (e.g. `May`).

PDF text extraction uses Node's built-in `zlib` only — no third-party packages.
It tracks each text stream's font and decodes that font's embedded ToUnicode
CMap (or its `/Encoding` glyph names), including two-byte Type0 CIDs, so subset
font numbers and symbols come out readable (`≤`, `π`, `∈ ℚ`) instead of control
characters.

Math that is drawn as 2D layout is also reconstructed: fraction rules become
`1/(1+x²)` and `π/12`, filled radical paths become `√3` and `p+q√3`, and smaller
raised text becomes `a²` or `re^{iθ}`.

Extraction is still best-effort. Subset glyphs without a ToUnicode mapping (for
example `g14`/`g32` in some SymbolMT fonts) can still drop a `+` or `=`, and
diagrams with unusual vector artwork may not reconstruct cleanly. Keyword
snippets are reliable enough to locate the relevant question. The plugin never
invents exam wording or a source URL.

> The archive is provided for personal study. The plugin keeps downloads small
> and bounded; please do not use it to bulk-download or redistribute content.

## Settings

Open **Settings → XtremePapers IB past papers** to:

- **Test topic search** — enter a topic and optional subject hint, then confirm
  matching excerpts are found. This is the quickest end-to-end check.
- **Test fetch** — fetch a specific PDF URL, or list a folder.
- **Diagnose page** — a support report showing a page's title, row count and
  detected directory/PDF rows (useful if the site markup changes).
- **Saved past-paper items** — review and delete locally saved items.

## Install (local)

Build and copy the plugin into the LearnHarness plugins directory:

```sh
npm run build
npm run install:local -- "/Users/augustzhong/Library/Application Support/LearnHarness/data/plugins"
```

`install:local` runs the build and copies the built `dist/` folder into the
target plugins directory. The host, not this helper, decides app compatibility
and whether the plugin is enabled.

Then **restart LearnHarness** and enable **XtremePapers IB past papers** in Settings.

## Troubleshooting

- **"No past-paper text matched"** — try a broader topic, add a subject hint,
  or paste the question text yourself with the tool's `add:true` option.
- **"No readable PDF text"** — that PDF may be a scan with no text layer; try a
  different paper or paste the question text with `add:true`.
- **Site structure changed** — run **Diagnose page** on a folder listing. If
  row count is 0, the HTML selectors in `src/xtremepapers.cjs` (`extractRows`)
  may need updating.

## Development

```sh
npm test           # offline tests (mock the backend context and fetches)
npm run build      # copy source files into dist/ with the runtime layout
```

The plugin uses only public LearnHarness plugin APIs (v1, app `0.6.1+`):
`registerQuestionType`, `registerQuestionRenderer`, `registerTools`,
`registerInstructions`, `registerSettings`, `registerView`, `registerAction`,
`placeAction`, `handle`, and `call`.
