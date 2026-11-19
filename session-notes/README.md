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
  - tables, Mermaid diagrams, code blocks, images and prose paragraphs are
    detected automatically and outlined as labelled regions;
  - **click** a region to select it, or **drag** across the transcript to select
    every region the rectangle touches; use **Select all**, **Clear** and
    **Refresh**, and scroll the wheel to move through the transcript;
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
  `debug` line (scope, nodes found, clicks received) to help diagnose any change.
  Detection scans every transcript root (including question docks) and also
  hit-tests visible transcript content, so it works for both fresh and older
  settled sessions. Collapsed or off-screen content must be expanded or scrolled
  into view before it can be outlined.
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
