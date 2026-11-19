/**
 * IB Documents past papers — plugin frontend (browser ES module).
 *
 * Provides:
 *   - Settings UI: test topic search / document fetch and manage saved items.
 *   - Question renderer: shows the exam excerpt, an answer editor and the
 *     mark scheme after the learner answers.
 *   - A small view listing locally saved past-paper items.
 */

const QUESTION_TYPE_ID = "ibdocs-pastpaper";

function el(container, tag, text, className) {
  const node = container.ownerDocument.createElement(tag);
  if (text !== undefined && text !== null) node.textContent = String(text);
  if (className) node.className = className;
  container.append(node);
  return node;
}

function button(container, label, onClick) {
  const b = el(container, "button", label);
  b.type = "button";
  b.addEventListener("click", onClick);
  return b;
}

/** Render Markdown-ish text safely using plain text (no innerHTML). */
function appendMarkdown(container, text) {
  if (typeof text !== "string" || !text.trim()) {
    el(container, "p", "No content supplied.");
    return;
  }
  const pre = el(container, "pre", text);
  pre.className = "ib-pp-markdown";
}

export function activate(ctx) {
  // -------------------------------------------------------------------------
  // Settings: topic search testing + local past-paper store management.
  // -------------------------------------------------------------------------
  const unregisterSettings = ctx.registerSettings((container, signal) => {
    const root = el(container, "div", undefined, "ib-pp-settings");
    el(root, "h2", "IB Docs past papers");
    el(
      root,
      "p",
      "Search the public ibdocs.re archive of IB past papers by topic. The plugin downloads a small, bounded set of real past-paper PDFs, finds matching text and returns excerpts with source links. No login or cookie is needed."
    );

    const status = el(root, "p");
    status.setAttribute("role", "status");

    const refreshStatus = async () => {
      try {
        const s = await ctx.call("getStatus");
        status.textContent = `ibdocs.re is public — no session needed. ${s.storedCount || 0} saved item(s).`;
      } catch (e) {
        status.textContent = `Status unavailable: ${e instanceof Error ? e.message : String(e)}`;
      }
    };

    const searchRow = el(root, "div");
    searchRow.className = "ib-pp-test";
    const topicInput = el(searchRow, "input");
    topicInput.type = "text";
    topicInput.placeholder = "Topic, e.g. 'binomial theorem'";
    topicInput.setAttribute("aria-label", "Topic to search");
    const subjectInput = el(searchRow, "input");
    subjectInput.type = "text";
    subjectInput.placeholder = "Subject (optional), e.g. math aa";
    subjectInput.setAttribute("aria-label", "Subject hint");
    const searchNotice = el(root, "p");
    searchNotice.setAttribute("role", "status");
    searchNotice.style.whiteSpace = "pre-wrap";
    button(searchRow, "Test topic search", async () => {
      const topic = topicInput.value.trim();
      if (!topic) {
        searchNotice.textContent = "Enter a topic first.";
        return;
      }
      searchNotice.textContent = "Searching PDFs (this can take a moment)…";
      try {
        const result = await ctx.call("testFetch", {
          search: true,
          topic,
          subject: subjectInput.value.trim(),
          maxDocuments: 8,
          autoFetch: true,
        });
        const subjects = (result.searchedSubjects || []).join(", ");
        searchNotice.textContent = result.ok
          ? `${result.preview}\nSubjects: ${subjects || "(common subjects)"}${result.message ? "\n" + result.message : ""}`
          : "Search failed.";
      } catch (e) {
        searchNotice.textContent = `Search failed: ${e instanceof Error ? e.message : String(e)}`;
      }
    });

    const testRow = el(root, "div");
    testRow.className = "ib-pp-test";
    const testInput = el(testRow, "input");
    testInput.type = "text";
    testInput.placeholder = "Document URL/id, or a folder URL with list";
    testInput.setAttribute("aria-label", "ibdocs.re document URL or id");
    const testNotice = el(root, "p");
    testNotice.setAttribute("role", "status");
    button(testRow, "Test fetch", async () => {
      const raw = testInput.value.trim();
      if (!raw) {
        testNotice.textContent = "Enter a document URL or id first.";
        return;
      }
      testNotice.textContent = "Fetching…";
      try {
        const result = await ctx.call("testFetch", /^https?:\/\//.test(raw) ? { url: raw } : { documentId: raw });
        testNotice.textContent = result.ok ? `OK (${result.kind}): ${result.preview}` : "Fetch failed.";
      } catch (e) {
        testNotice.textContent = `Fetch failed: ${e instanceof Error ? e.message : String(e)}`;
      }
    });

    // Diagnostic report for support; ibdocs.re is public so nothing is secret.
    const diagSection = el(root, "section");
    el(diagSection, "h3", "Diagnose page (for support)");
    const diagRow = el(diagSection, "div");
    diagRow.className = "ib-pp-test";
    const diagInput = el(diagRow, "input");
    diagInput.type = "text";
    diagInput.value = "https://ibdocs.re/past-papers-by-subject/mathematics-analysis-and-approaches";
    diagInput.setAttribute("aria-label", "URL to diagnose");
    const diagOutput = el(diagSection, "textarea");
    diagOutput.rows = 10;
    diagOutput.readOnly = true;
    diagOutput.className = "ib-pp-diag-output";
    diagOutput.setAttribute("aria-label", "Diagnostic report");
    button(diagRow, "Run diagnosis", async () => {
      diagOutput.value = "Diagnosing…";
      try {
        const report = await ctx.call("diagnosePage", { url: diagInput.value.trim() });
        diagOutput.value = JSON.stringify(report, null, 2);
      } catch (e) {
        diagOutput.value = `Diagnosis failed: ${e instanceof Error ? e.message : String(e)}`;
      }
    });

    const savedSection = el(root, "section");
    el(savedSection, "h3", "Saved past-paper items");
    const savedList = el(savedSection, "ul");
    const refreshSaved = async () => {
      try {
        const items = await ctx.call("listPapers");
        savedList.replaceChildren();
        if (!items.length) {
          el(savedList, "li", "No saved items.");
          return;
        }
        for (const item of items) {
          const li = el(savedList, "li");
          el(li, "div", item.question || "(no question text)");
          el(li, "small", [item.subject, item.paper, item.sourceUrl].filter(Boolean).join(" · "));
          button(li, "Delete", async () => {
            try {
              await ctx.call("deletePaper", { id: item.id });
              await refreshSaved();
            } catch (e) {
              status.textContent = `Delete failed: ${e instanceof Error ? e.message : String(e)}`;
            }
          });
        }
      } catch (e) {
        savedList.replaceChildren();
        el(savedList, "li", `Unable to list saved items: ${e instanceof Error ? e.message : String(e)}`);
      }
    };

    void refreshStatus();
    void refreshSaved();

    return () => root.replaceChildren();
  });

  // -------------------------------------------------------------------------
  // Question renderer.
  // -------------------------------------------------------------------------
  const unregisterRenderer = ctx.registerQuestionRenderer({
    id: QUESTION_TYPE_ID,
    supportedContractVersions: [1],

    mountQuestion(container, mountContext) {
      if (mountContext.signal.aborted) return;
      const payload = mountContext.input && mountContext.input.payload ? mountContext.input.payload : {};
      const wrap = el(container, "div", undefined, "ib-pp-question");
      const metaBits = [payload.subject, payload.paper, payload.topic].filter(Boolean);
      if (metaBits.length) el(wrap, "p", metaBits.join(" · "), "ib-pp-meta");
      appendMarkdown(wrap, mountContext.input.question || payload.question || "");
      if (payload.sourceUrl) {
        const a = el(wrap, "a", "View source on ibdocs.re", "ib-pp-source");
        a.href = payload.sourceUrl;
        a.target = "_blank";
        a.rel = "noopener noreferrer";
      }
      return () => wrap.replaceChildren();
    },

    mountAnswerEditor(container, props) {
      let current = props;
      const wrap = el(container, "div", undefined, "ib-pp-editor");
      const label = el(wrap, "label", "Your answer", "ib-pp-label");
      const textarea = el(wrap, "textarea");
      textarea.rows = 10;
      textarea.setAttribute("aria-label", "Your answer");
      label.append(textarea);

      const publish = () => {
        const value = textarea.value;
        current.onChange(value.trim() ? { status: "ready", value } : { status: "empty" });
      };
      textarea.addEventListener("input", publish);

      if (current.answer && typeof current.answer.value === "string") {
        textarea.value = current.answer.value;
      }
      textarea.disabled = !current.active;

      return {
        update(next) {
          if (next && typeof next.answer === "object") {
            if (typeof next.answer.value === "string" && next.answer.value !== textarea.value) {
              textarea.value = next.answer.value;
            }
          }
          if (next && typeof next.active === "boolean") textarea.disabled = !next.active;
        },
        focus() {
          textarea.focus();
        },
        dispose() {
          textarea.removeEventListener("input", publish);
          wrap.replaceChildren();
        },
      };
    },

    mountAnswered(container, mountContext) {
      if (mountContext.signal.aborted) return;
      const payload = mountContext.input && mountContext.input.payload ? mountContext.input.payload : {};
      const wrap = el(container, "div", undefined, "ib-pp-answered");

      el(wrap, "h3", "Your answer");
      appendMarkdown(wrap, typeof mountContext.answer === "string" ? mountContext.answer : JSON.stringify(mountContext.answer));

      const scheme = payload.markscheme;
      if (typeof scheme === "string" && scheme.trim()) {
        el(wrap, "h3", "Mark scheme");
        appendMarkdown(wrap, scheme);
      }

      if (payload.sourceUrl) {
        const a = el(wrap, "a", "View source on ibdocs.re", "ib-pp-source");
        a.href = payload.sourceUrl;
        a.target = "_blank";
        a.rel = "noopener noreferrer";
      }

      if (mountContext.grading !== undefined) {
        el(wrap, "details", "Saved grading observation", "ib-pp-grading");
      }

      return () => wrap.replaceChildren();
    },
  });

  // -------------------------------------------------------------------------
  // Saved-items view (optional convenience).
  // -------------------------------------------------------------------------
  const unregisterView = ctx.registerView({
    id: "ib-pastpapers",
    name: "IB Docs papers",
    mount(container, signal) {
      const root = el(container, "div", undefined, "ib-pp-view");
      el(root, "h1", "IB Docs past papers");
      el(root, "p", "Questions you fetch or save appear here. Use the teacher agent's fetch tool to retrieve a question, then pose it in the lesson.");
      const list = el(root, "div", undefined, "ib-pp-list");
      const refresh = button(root, "Refresh", async () => {
        list.replaceChildren();
        try {
          const items = await ctx.call("listPapers");
          for (const item of items) {
            const card = el(list, "article", undefined, "ib-pp-card");
            el(card, "h2", item.subject || item.paper || "Past-paper item");
            appendMarkdown(card, item.question);
            if (item.markscheme) {
              el(card, "h3", "Mark scheme");
              appendMarkdown(card, item.markscheme);
            }
            if (item.sourceUrl) {
              const a = el(card, "a", item.sourceUrl, "ib-pp-source");
              a.href = item.sourceUrl;
              a.target = "_blank";
              a.rel = "noopener noreferrer";
            }
            if (signal.aborted) return;
          }
        } catch (e) {
          el(list, "p", `Unable to load: ${e instanceof Error ? e.message : String(e)}`);
        }
      });
      void refresh.click();
      return () => root.replaceChildren();
    },
  });

  const unregisterAction = ctx.registerAction({
    id: "open-ib-pastpapers",
    name: "Open IB Docs papers",
    run: () => ctx.app.openView("ib-pastpapers"),
  });
  const unregisterPlacement = ctx.placeAction({
    id: "ib-pastpapers-sidebar",
    actionId: "open-ib-pastpapers",
    location: "sidebar",
  });

  return () => {
    unregisterPlacement();
    unregisterAction();
    unregisterView();
    unregisterRenderer();
    unregisterSettings();
  };
}
