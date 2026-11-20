# Session Notes

A LearnHarness community plugin (API v1, app `0.6.1+`) that keeps notes taken
from your learning sessions. It has a sidebar place like the official
Flashcards plugin, captures text/tables/diagrams from sessions, organises notes
by session or by knowledge-web topic/node, and supports full-text search.

## Features

- **Sidebar place.** The **Notes** action is placed in the sidebar. Click it to
  open the Notes view: a grouped list on the left and an editor on the right.
- **Add from a session.** In a teaching or practice session, use the top-bar
  **Add to notes** action. It opens a screenshot-style **region picker** over
  the live transcript:
  - tables, Mermaid diagrams, code blocks, images and prose paragraphs in the
    visible canvas are detected automatically and outlined as labelled regions;
  - **click** a region to select it, or **drag** across the transcript to select
    every visible region the rectangle touches; scroll to bring more of the
    transcript into view. Selected regions stay selected after they scroll out
    of view; use **Select all**, **Clear** and **Refresh**, or the wheel to scroll;
  - **Pick element** is a manual fallback: click it, then click any element in
    the transcript to add it to the selection (press **Escape** to cancel). Use
    this if automatic detection misses something.
  - **Add selected to notes** converts the selection into note blocks: text is
    transcribed from the rendered element, tables are rebuilt as Markdown
    tables, code keeps its language, and diagrams keep their original Mermaid
    source so the host's diagram renderer recreates them in the note.
  This avoids re-rendering the session, so it stays responsive on long sessions.
  It does use the host transcript's DOM structure, which may change in a future
  LearnHarness update. The status line shows the detected/selected counts and a
  `debug` line (scope, candidates, clicks received) to help diagnose any change.
  Detection collects transcript candidates once, then uses cached geometry and
  `IntersectionObserver` to outline only what enters the visible canvas. It does
  not hit-test the transcript, which the host marks `inert` while the picker is
  open, and it does not run a text/style scan over the whole session. That keeps
  long, settled sessions responsive and stops boxes from vanishing after the
  surface registers. Collapsed or off-screen content must be expanded or
  scrolled into view before it can be outlined. Selected regions stay cached
  while scrolling. Whole-session wrapper elements are skipped so a session is
  no longer detected as one unpickable block. Scroll-time classification uses
  `textContent` instead of forced-layout `innerText`, host widget updates only fire
  when counts change, and diagnostic refresh events are throttled. Picker controls
  and status lines use the host background colour so they stay readable over the
  live transcript. Rebuilt tables use a separator sized to the widest row.

  **Debug log.** Every action and error is appended to
  `session-notes-debug.log` in the plugin's data directory (next to `notes.json`,
  usually under `~/Library/Application Support/LearnHarness/data/plugins/...`).
  The overlay's `debug` line shows the filename. It records detection counts and
  samples, region picks, drags, add/save results and errors as JSON lines — send
  this file when reporting a problem.
- **Note management.** Every captured block has top-right controls to **delete**,
  **edit**, **copy**, **place in note**, or move it **up/down**. **Place in note**
  inserts a marker at the text cursor; when exported, the real table, code or
  Mermaid diagram renders at that exact position. The note header can
  **duplicate** the note or **export** it. Export opens a rendered preview and a
  Markdown source: choose **Print / Save PDF** to save the preview as a PDF, or
  **Copy Markdown** for the source. Tags are editable comma-separated fields,
  and the sorted list can be ordered by newest, oldest, or title; the choice is
  saved with the other note settings.
- **Organisation.** Switch between **By session**, **By topic**, and **By
  knowledge node**. Topics can be typed (with suggestions from the knowledge
  web's clusters); nodes are chosen with the native knowledge picker and map to
  knowledge-web propositions.
- **Search.** The search box filters notes by title, body text, session, topics,
  nodes, tags, and captured block content.
- **Local storage.** Notes live in the plugin's own `data/notes.json` under the
  host-provided plugin data directory, written atomically.

## Install

1. Download the release zip and extract it into your LearnHarness plugins
   directory as `session-notes/`.
2. Restart LearnHarness (or refresh Community plugins) and enable **Session
   Notes**.

From a checkout you can build and install locally:

```sh
npm --prefix session-notes run build
npm --prefix session-notes run install:local -- "/path/to/plugins"
```

## API boundary / limitations

LearnHarness plugin API v1 does **not** expose a screenshot service, an OCR
service, a region-selection hook, or a way to invoke the host's diagram tool.
It also has no public hook for right-click items or icons in the *native*
transcript. Session Notes therefore draws its own region picker inside a
plugin-owned page overlay opened from a top-bar action.

The picker detects regions by reading the transcript's rendered DOM (host data
attributes such as `data-session-find-root`, `data-streamdown="table"`,
`data-testid="md-mermaid"` and `data-source-message-id`). Those selectors are
private host implementation details, not public API, so they may need updating
after a LearnHarness upgrade. Content is transcribed from the rendered elements
and matched to original Mermaid source from the detached session view
(`context.view.transcript` / `messages`). The backend may read native sessions
and the graph read-only via `ctx.learning`, but it never writes native data.
Nothing is sent to a model or a network service.

## Development

```sh
npm --prefix session-notes test    # offline Node test suite
npm --prefix session-notes run build
```

The build is a plain copy of `src/` into `dist/` — no third-party packages.
