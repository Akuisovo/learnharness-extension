# LearnHarness extensions

Independent LearnHarness community plugins live in this repository. Each folder
is self-contained and has its own source, tests, build output, and GitHub
release.

| Extension | Folder | Release | Authentication |
| --- | --- | --- | --- |
| **IB Docs past papers** | [`ibdocs-pastpapers/`](./ibdocs-pastpapers/) | [`ibdocs-pastpapers-v0.1.0`](https://github.com/Akuisovo/learnharness-extension/releases/tag/ibdocs-pastpapers-v0.1.0) | None — ibdocs.re is public |
| **XtremePapers IB past papers** | [`xtremepapers-ib/`](./xtremepapers-ib/) | [`xtremepapers-ib-v0.1.0`](https://github.com/Akuisovo/learnharness-extension/releases/tag/xtremepapers-ib-v0.1.0) | None — papers.xtremepape.rs is public |
| **College Board SAT Question Bank** | [`collegeboard-sat-questionbank/`](./collegeboard-sat-questionbank/) | `collegeboard-sat-questionbank-v0.2.5` (pending release) | None — public College Board question bank endpoints |
| **Session Notes** | [`session-notes/`](./session-notes/) | [`session-notes-v0.1.23`](https://github.com/Akuisovo/learnharness-extension/releases/tag/session-notes-v0.1.23) | None — notes are stored locally by the plugin |

All extensions target LearnHarness `0.6.1+` and plugin API v1.

## Repository commands

From the repository root:

```sh
npm test          # runs all extensions' offline test suites
npm run build     # rebuilds all extensions' dist/ folders
```

Per-extension commands:

```sh
npm run test:ibdocs        npm run build:ibdocs
npm run test:xtremepapers  npm run build:xtremepapers
npm run test:sat           npm run build:sat
npm run test:notes         npm run build:notes
```

## Releases

Each GitHub release contains a ready-to-install `.zip` of that extension's
folder. Download the zip, extract it into your LearnHarness plugins directory,
and restart LearnHarness (or refresh Community plugins).

- **IB Docs Past Papers v0.1.0** — public ibdocs.re topic search, font-aware PDF decoding, and 2D math reconstruction.
- **XtremePapers IB Past Papers v0.1.0** — public papers.xtremepape.rs directory search, bounded PDF scan with mark-scheme links, font-aware decoding, and 2D math reconstruction.
- **College Board SAT Question Bank v0.2.5** — official SAT Suite Question Bank search/fetch with IDs and rationale; automatic attempt capture and missed-skill spaced review; manual Bluebook/My Practice weakness import; fixes question renderer/answer-editor wiring so choice selection reliably reports ready state to LearnHarness submit.
- **Session Notes v0.1.23** — interactive PDF export GUI with global body/title/heading text sizing and per-element width/text sizing in live preview, detached rendered PDF export, placed-block positioning, note management, Markdown export, tags, sorting and knowledge-web organisation.

See each folder's `README.md` for setup and limitations.
or setup and limitations.
