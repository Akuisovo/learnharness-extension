# Session Notes

A LearnHarness community plugin (API v1, app `0.6.1+`) that keeps notes taken
from your learning sessions. It has a sidebar place like the official
Flashcards plugin, captures text/tables/diagrams from sessions, organises notes
by session or by knowledge-web topic/node, and supports full-text search.

## Features

- **Sidebar place.** The **Notes** action is placed in the sidebar. Click it to
  open the Notes view: a grouped list on the left and an editor on the right.
- **Add from a session.** In a teaching or practice session, use the top-bar
  **Add to notes** action. It opens a plugin-owned overlay that mirrors the
  current session's content:
  - highlight text and **right-click → Add to note** to capture the selection, or
  - click the small note icon beside any rendered block (text, table, diagram,
    or code) to add that whole block.
  A captured block can be appended to an existing note or used to create a new
  one. **Save whole session** stores every block in one note.
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

LearnHarness plugin API v1 does **not** expose a hook to add right-click items
or icons to the *native* transcript DOM, and does not let a community plugin
decorate host-rendered tables or Mermaid diagrams in place. The official
Flashcards plugin has the same limitation. Session Notes therefore uses the
**only supported route**: a plugin-owned overlay opened from a top-bar action,
rendered with the host's `mountMarkdown` so tables and diagrams still look
native, with plugin-owned note icons and context menu inside that overlay.

Session content is read from the detached session view supplied to the action
(`context.view.transcript` / `messages`). The backend may read native sessions
and the graph read-only via `ctx.learning`, but it never writes native data.
Nothing is sent to a model or a network service.

## Development

```sh
npm --prefix session-notes test    # offline Node test suite
npm --prefix session-notes run build
```

The build is a plain copy of `src/` into `dist/` — no third-party packages.
