# RevisionHub Past Papers — LearnHarness extension

A LearnHarness community plugin that fetches IB past-paper questions and mark
schemes from [revisionhub.study](https://revisionhub.study) and registers them
as teaching questions the teacher agent can pose during a lesson.

## What it does

- Adds a `fetch_rh_pastpaper` tool to the **teacher** agent. It can:
  - **search by topic** (`{ search: true, topic: "...", subject: "..." }`) and
    optionally auto-fetch the top result's full question + mark scheme;
  - fetch a question from a `/question/:id` URL or bare question id;
  - list question links from a paper / questionbank page (`{ list: true }`);
  - save learner-pasted text locally (`{ add: true, question, markscheme? }`) as
    a no-auth fallback;
  - return a previously saved item (`{ useStored: true }`).
- Registers the `rh-pastpaper` question type with a host-built
  `ask_rh_pastpaper_question` posing tool and a custom renderer (question view,
  answer editor, and mark-scheme reveal after answering).
- Adds teacher instructions that describe when and how to use the tool, and
  require honest attribution (no invented sources).
- Provides a Settings page to store the RevisionHub session cookie, test a
  fetch, and manage saved items, plus a "Past papers" view in the sidebar.

**All fetched/saved content lives in this plugin's own `data/` directory. No
core learning records are written.**

## Important: authentication (no DevTools needed)

RevisionHub requires a logged-in Clerk session; there is no public question
API. The cookie policy is a little misleading here: the `__session` **cookie**
is persistent (about a year), but the JWT inside it only lasts about a minute
and Clerk rotates it constantly. That is why a cookie pasted once stops working
almost immediately. The longer-lived `__client` cookie (about 7 days) is what
Clerk uses to mint replacements.

**Recommended — automatic session renewal from Search.app (macOS)**

1. Log in to RevisionHub in **Search.app** (a WebKit browser) once, and keep it
   open while using the plugin.
2. In the plugin's Settings, leave **Auto-refresh cookie from Search.app** on.
3. Before each fetch the plugin reads Search.app's local WebKit cookie store,
   then calls Clerk's own token endpoint with your `__client` token to mint a
   fresh `__session` JWT. It caches that JWT until just before it expires and
   retries once if a request is redirected to sign-in. No cookie value is ever
   shown in chat or written to the plugin log.

You can click **Refresh from Search.app** in Settings to check the renewal, and
**Test topic search** to confirm end to end. If renewal fails, reload the
RevisionHub tab in Search.app so the browser refreshes its `__client` token,
then try again.

**Manual fallback — paste a cookie from DevTools**

If automatic renewal is unavailable (or you turned it off), grab a cookie while
logged in at <https://revisionhub.study>. Be aware that a pasted `__session`
expires in roughly a minute; include `__client` as well if you can, since the
plugin can use it to mint fresh sessions even in manual mode when auto-refresh
is enabled.

**Method A — DevTools Cookies panel**

1. Log in at <https://revisionhub.study> in your browser.
2. Open Developer Tools (`F12`, or `Cmd+Opt+I` on macOS).
3. Go to **Application → Storage → Cookies → https://revisionhub.study**.
4. Find the `__session` row and double-click its **Value** cell, then `Cmd+C` /
   `Ctrl+C` to copy it. Do the same for `__client_uat` if present.
5. Combine them into one string shaped like a `Cookie` header:
   ```
   __session=<paste value here>; __client_uat=<paste value here>
   ```
6. In LearnHarness open **Settings → this plugin → RevisionHub session cookie**,
   paste the string, and click **Save cookie**. Verify with **Test fetch** (a
   question URL/id) or **Test topic search** (a topic + optional subject).

**Method B — Copy as cURL (gets every cookie at once)**

1. While logged in, open DevTools → **Network** tab, then refresh the page.
2. Click the first request to `revisionhub.study` (the document request).
3. Right-click it → **Copy → Copy as cURL**.
4. In the pasted command find the `-H 'Cookie: ...'` (or `--cookie '...'`) part.
   Copy everything after `Cookie:` up to the closing quote — that whole string
   is what you paste into the Settings field. It is fine if it contains more
   than just `__session` / `__client_uat`.

> The single most important cookie is `__session` (Clerk's session token).
> `__client_uat` helps with signed-out detection. Include the whole Cookie
> header from Method B if you are unsure — extra cookies are harmless.

With auto-refresh on, short-lived session tokens are renewed automatically for
as long as the `__client` token in Search.app remains valid. Otherwise, if a
fetch reports a sign-in redirect, paste a fresh cookie. The cookie is stored
only in the plugin's local `data/settings.json` and is only sent to
`revisionhub.study` over HTTPS. You can turn auto-refresh off with the Settings
checkbox.

If you prefer not to provide a cookie, paste past-paper text directly via the
teacher tool (`add: true`) or ask the agent to use text you supply.

## Usage: topic-based search

The primary workflow is **search by topic**, not by URL/id. Ask the teacher, or
call the tool directly with:

```json
{ "search": true, "topic": "binomial theorem", "subject": "math aa", "autoFetch": true }
```

- `topic` — the concept to find (e.g. `"cell respiration"`, `"kinematics"`).
- `subject` — optional hint; supported slugs include `math aa`, `math ai`,
  `biology`, `chemistry`, `physics`, `economics`, `business management`.
- `autoFetch: true` — also fetch the full question text and mark scheme for the
  first result.

The tool tries the subject-scoped questionbank URLs first, then the general
`/search` page with common query parameter names, and returns
`{ results, fetched, searchUrl, attemptedUrls }`. The **`searchUrl`** tells you
which URL actually worked; if nothing matched, **`attemptedUrls`** lists every
candidate that was tried. Report either back so the URL patterns can be
tightened to the site's real format.

If topic search does not work, use **Settings → Diagnose search page (for
support)**: it fetches a RevisionHub page with your saved cookie and exports the
client-script list (never the cookie) as a JSON report. Send that report to the
author — it reveals which route chunk implements `/search` and therefore its
real query parameters. You can point it at `/search` or at any page you can
reach, such as `/ib`.

Other useful calls:

```json
{ "url": "<result url>" }                         // fetch one result in full
{ "list": true, "url": "<paper/questionbank url>" } // list /question/:id links
{ "add": true, "question": "...", "markscheme": "..." } // manual fallback, no cookie
{ "useStored": true }                             // retrieve a saved item
```

## Install

Find your plugins directory in **Settings → Community plugins**. Then either:

```sh
npm run build
npm run install:local -- "/path/to/plugins-directory"
```

Or copy this folder so the built files land at:

```
<plugins-directory>/revisionhub-pastpapers/
  dist/
    manifest.json
    main.js
    backend.cjs
    revisionhub.cjs
    styles.css
```

Then refresh the plugin list and enable **RevisionHub past papers**. Restart
LearnHarness after changing loaded code (refresh discovers, it does not
hot-reload). New plugins start disabled. Updates must preserve the sibling
`revisionhub-pastpapers/data/` directory.

## Development

```sh
npm run build    # copy src/ -> dist/
npm test         # offline unit tests (no network)
```

Layout:

```
src/contract.js        # ESM constants/schema shared with the frontend
src/revisionhub.cjs    # cookie-aware fetch + RSC/HTML extraction helpers
src/browsercookie.cjs  # optional auto-refresh from Search.app's WebKit cookie store
src/backend.cjs        # question type, teacher tool/instructions, ctx.handle ops
src/main.js            # settings UI, question renderer, saved-items view
src/styles.css
scripts/build.mjs
scripts/install-plugin-local.mjs
```

## How extraction works

RevisionHub is a Next.js App Router app. Question content is server-rendered,
including a "flight" payload streamed via
`self.__next_f.push([1, "..."])` scripts. The fetch helper:

- refreshes the session cookie from Search.app when auto-refresh is on, sends it
  with the request, and detects sign-in / Clerk-handshake redirects;
- decodes flight strings and looks for `questionMarkdown` / `answerMarkdown`
  (and related) fields;
- falls back to heuristic text scanning and then plain DOM text;
- reports the extraction confidence and never fabricates content.

Because the site markup can change, the renderer keeps the exam wording in the
`question` field (host fallback) and the mark scheme in the `markscheme` field
so posing still works even if custom extraction degrades.

## Limitations & terms

- No public API exists; fetching depends on your own valid session and the
  current page structure. If extraction is uncertain, paste the text manually.
- Only teacher sessions get the fetch tool by default.
- This is an unofficial personal-use integration and is not endorsed by IB or
  RevisionHub. Respect RevisionHub's Terms of Service and copyright; use
  retrieved material for personal study only and do not bulk-download or
  redistribute content.

## API surface used

Only public LearnHarness plugin APIs are used: `registerQuestionType`,
`registerTools`, `registerInstructions`, `registerSettings`,
`registerQuestionRenderer`, `registerView`, `registerAction`, `placeAction`,
`ctx.call`, `ctx.handle`, and `ctx.ui`-free plain DOM. Imports from
`learnharness-plugin-api` are not needed (plain JS).
