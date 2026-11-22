# College Board SAT Question Bank (LearnHarness plugin)

A LearnHarness community plugin that searches and fetches **official SAT Suite Question Bank** questions directly from College Board's public digital question bank endpoints (no login required).

## What it can do

- **Search official questions** by:
  - **Test:** SAT, PSAT/NMSQT & PSAT 10, PSAT 8/9
  - **Topic/domain:** Algebra, Advanced Math, Problem-Solving and Data Analysis, Geometry and Trigonometry, Information and Ideas, Craft and Structure, Expression of Ideas, Standard English Conventions
  - **Skill:** fine-grained skills within each domain
  - **Difficulty:** Easy / Medium / Hard
- **Exclude active questions:** option to filter out questions marked as active assessments by College Board (metadata items with a non-empty IBN), useful when you want practice not drawn from active tests.
- **Serial/IDs included:** each result/fetched question includes College Board identifiers (**externalId**, **questionId**, **uId**, **IBN** when present) for manual validation and for the agent to fetch/show the exact question in sessions. Posed/fetched question text includes these IDs and the official source.
- **Official explanations:** fetches the full question and College Board's official **rationale/explanation** via the question detail endpoint.
- **Teaching integration:** provides a teacher tool and question type so the agent can find and pose official questions (with IDs/source stated) with explanations revealed after the learner answers.
- **Local saved items:** save questions/explanations locally in plugin data (no external account, no redistribution).

## How it works (data source)

Questions are sourced from official College Board SAT Suite Question Bank resources (e.g. [SAT Suite Educator Question Bank](https://satsuiteeducatorquestionbank.collegeboard.org/digital/search)) and fetched via College Board's public digital question bank endpoints:

- `POST https://qbank-api.collegeboard.org/msreportingquestionbank-prod/questionbank/digital/get-questions` with `{"asmtEventId", "domain"}` to retrieve question metadata (id, domain, skill, difficulty, active/IBN flags).
- `POST https://qbank-api.collegeboard.org/msreportingquestionbank-prod/questionbank/digital/get-question` with `{"external_id"}` to retrieve the official question content (`stem`, answer options/keys, and **`rationale`** explanation, including MathML/HTML).

The available filters (test, categories/skills, difficulty, exclude active questions) are aligned with community interfaces such as [satquestionbank.org](https://satquestionbank.org/) for UX reference; this plugin fetches content directly from the official College Board endpoints/resources rather than depending on that site.

## Privacy & usage

- No College Board login/cookies are required.
- No Bluebook/My Practice account scraping/automation. Plan 3 imports are manual-first (user-provided paste/CSV/JSON or manually checked targets).
- Questions and rationales are official College Board content intended for personal study/practice. Do not bulk-download or redistribute the archive/content.
- Review/import data stores IDs, skill mapping, and progress locally in the plugin data directory; official question/rationale content is re-fetched on demand.

## Install

1. Download the release zip and extract it.
2. Copy the `collegeboard-sat-questionbank/dist` folder into your LearnHarness plugins directory as `collegeboard-sat-questionbank/dist` (or use `npm run install:local -- "<plugins-directory>"` from this folder after building).
3. Restart LearnHarness, then enable **College Board SAT Question Bank**.

## Development

```sh
npm test
npm run build
npm run install:local -- "/path/to/LearnHarness/data/plugins"
```

Targets LearnHarness `0.6.1+` and plugin API v1. Node built-ins only.
directory>"` from this folder after building).
3. Restart LearnHarness, then enable **College Board SAT Question Bank**.

## Development

```sh
npm test
npm run build
npm run install:local -- "/path/to/LearnHarness/data/plugins"
```

Targets LearnHarness `0.6.1+` and plugin API v1. Node built-ins only.
