# LearnHarness extensions

Two independent LearnHarness community plugins live in this repository. Each
folder is self-contained and has its own source, tests, build output, and GitHub
release.

| Extension | Folder | Release | Authentication |
| --- | --- | --- | --- |
| **RevisionHub past papers** | [`revisionhub-pastpapers/`](./revisionhub-pastpapers/) | [`revisionhub-pastpapers-v0.1.0`](https://github.com/Akuisovo/learnharness-extension/releases/tag/revisionhub-pastpapers-v0.1.0) | Your own RevisionHub/Clerk session; renewal from Search.app on macOS |
| **IB Docs past papers** | [`ibdocs-pastpapers/`](./ibdocs-pastpapers/) | [`ibdocs-pastpapers-v0.1.0`](https://github.com/Akuisovo/learnharness-extension/releases/tag/ibdocs-pastpapers-v0.1.0) | None — ibdocs.re is public |

Both target LearnHarness `0.6.1+` and plugin API v1.

## Repository commands

From the repository root:

```sh
npm test          # runs both extensions' offline test suites
npm run build     # rebuilds both extensions' dist/ folders
```

Per-extension commands:

```sh
npm --prefix revisionhub-pastpapers test
npm --prefix revisionhub-pastpapers run build
npm --prefix revisionhub-pastpapers run install:local -- "/path/to/plugins"

npm --prefix ibdocs-pastpapers test
npm --prefix ibdocs-pastpapers run build
npm --prefix ibdocs-pastpapers run install:local -- "/path/to/plugins"
```

## Releases

Each GitHub release contains a ready-to-install `.zip` of that extension's
folder. Download the zip, extract it into your LearnHarness plugins directory,
and restart LearnHarness (or refresh Community plugins).

- **RevisionHub Past Papers v0.1.0** — topic search, authenticated question/mark-scheme fetch, and automatic Clerk session renewal.
- **IB Docs Past Papers v0.1.0** — public ibdocs.re topic search, font-aware PDF decoding, and 2D math reconstruction.

See each folder's `README.md` for setup and limitations.
