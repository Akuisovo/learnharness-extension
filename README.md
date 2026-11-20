# LearnHarness extensions

Three independent LearnHarness community plugins live in this repository. Each
folder is self-contained and has its own source, tests, build output, and GitHub
release.

| Extension | Folder | Release | Authentication |
| --- | --- | --- | --- |
| **IB Docs past papers** | [`ibdocs-pastpapers/`](./ibdocs-pastpapers/) | [`ibdocs-pastpapers-v0.1.0`](https://github.com/Akuisovo/learnharness-extension/releases/tag/ibdocs-pastpapers-v0.1.0) | None — ibdocs.re is public |
| **XtremePapers IB past papers** | [`xtremepapers-ib/`](./xtremepapers-ib/) | [`xtremepapers-ib-v0.1.0`](https://github.com/Akuisovo/learnharness-extension/releases/tag/xtremepapers-ib-v0.1.0) | None — papers.xtremepape.rs is public |
| **Session Notes** | [`session-notes/`](./session-notes/) | [`session-notes-v0.1.21`](https://github.com/Akuisovo/learnharness-extension/releases/tag/session-notes-v0.1.21) | None — notes are stored locally by the plugin |

All extensions target LearnHarness `0.6.1+` and plugin API v1.

## Repository commands

From the repository root:

```sh
npm test          # runs all three extensions' offline test suites
npm run build     # rebuilds all three extensions' dist/ folders
```

Per-extension commands:

```sh
npm --prefix ibdocs-pastpapers test
npm --prefix ibdocs-pastpapers run build
npm --prefix ibdocs-pastpapers run install:local -- "/path/to/plugins"

npm --prefix xtremepapers-ib test
npm --prefix xtremepapers-ib run build
npm --prefix xtremepapers-ib run install:local -- "/path/to/plugins"

npm --prefix session-notes test
npm --prefix session-notes run build
npm --prefix session-notes run install:local -- "/path/to/plugins"
```

## Releases

Each GitHub release contains a ready-to-install `.zip` of that extension's
folder. Download the zip, extract it into your LearnHarness plugins directory,
and restart LearnHarness (or refresh Community plugins).

- **IB Docs Past Papers v0.1.0** — public ibdocs.re topic search, font-aware PDF decoding, and 2D math reconstruction.
- **XtremePapers IB Past Papers v0.1.0** — public papers.xtremepape.rs directory search, bounded PDF scan with mark-scheme links, font-aware decoding, and 2D math reconstruction.
- **Session Notes v0.1.21** — fixes a `markdown is not a function` error that prevented the export preview and PDF print from rendering; PDF export prints a detached copy of the rendered note with diagrams/tables/text in their chosen positions. Per-block delete/edit/copy/reorder, note duplicate, Markdown export, editable tags, saved sort order and full-text search are retained.

See each folder's `README.md` for setup and limitations.
