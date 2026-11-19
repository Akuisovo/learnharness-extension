/**
 * RevisionHub Past Papers — plugin frontend (browser ES module).
 *
 * Provides:
 *   - Settings UI: paste/update the RevisionHub session cookie, test a fetch,
 *     and manage locally saved past-paper items.
 *   - Question renderer: shows the exam question, an answer editor, and the
 *     mark scheme after the learner answers.
 *   - A small view listing locally saved past-paper items.
 */

const QUESTION_TYPE_ID = "rh-pastpaper";

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
  pre.className = "rh-pp-markdown";
}

export function activate(ctx) {
  // -------------------------------------------------------------------------
  // Settings: session cookie + local past-paper store management.
  // -------------------------------------------------------------------------
  const unregisterSettings = ctx.registerSettings((container, signal) => {
    const root = el(container, "div", undefined, "rh-pp-settings");
    el(root, "h2", "RevisionHub past papers");
    el(
      root,
      "p",
      "The teacher agent reads RevisionHub past-paper questions using your own session. Keep revisionhub.study open and logged in in Search.app and the plugin refreshes the short-lived session cookie automatically — no DevTools needed. The cookie is stored only in this plugin's local data directory."
    );

    const status = el(root, "p");
    status.setAttribute("role", "status");

    const autoRow = el(root, "div");
    autoRow.className = "rh-pp-auto";
    const autoCheck = el(autoRow, "input");
    autoCheck.type = "checkbox";
    autoCheck.id = "rh-pp-auto-refresh";
    autoCheck.checked = true;
    const autoLabel = el(autoRow, "label", "Auto-refresh cookie from Search.app (recommended)");
    autoLabel.setAttribute("for", "rh-pp-auto-refresh");
    const autoNotice = el(root, "p");
    autoNotice.setAttribute("role", "status");
    autoCheck.addEventListener("change", async () => {
      autoNotice.textContent = "Saving…";
      try {
        await ctx.call("setAutoRefreshCookie", { enabled: autoCheck.checked });
        autoNotice.textContent = autoCheck.checked ? "Auto-refresh on." : "Auto-refresh off — paste a cookie manually below.";
      } catch (e) {
        autoNotice.textContent = `Update failed: ${e instanceof Error ? e.message : String(e)}`;
      }
    });

    const details = el(root, "details");
    el(details, "summary", "How to find the cookie (manual fallback)");
    const ol = el(details, "ol");
    [
      "Normally you do not need this — keep RevisionHub open in Search.app and auto-refresh handles it.",
      "If auto-refresh is unavailable, log in at https://revisionhub.study in your browser.",
      "Open Developer Tools (F12 or Cmd+Opt+I) and go to Application → Storage → Cookies → https://revisionhub.study.",
      "Copy the value of the __session cookie (and __client_uat if present), formatted as: __session=<value>; __client_uat=<value>.",
      "Paste the combined string below and click Save.",
    ].forEach((line) => el(ol, "li", line));

    const cookieLabel = el(root, "label", "RevisionHub session cookie");
    cookieLabel.className = "rh-pp-label";
    const input = el(root, "textarea");
    input.rows = 4;
    input.placeholder = "__session=eyJ...; __client_uat=1700000000";
    input.setAttribute("aria-label", "RevisionHub session cookie");
    cookieLabel.append(input);

    const actions = el(root, "div");
    actions.className = "rh-pp-actions";
    const saveNotice = el(root, "p");
    saveNotice.setAttribute("role", "status");

    const refreshStatus = async () => {
      try {
        const s = await ctx.call("getStatus");
        const mode = s.autoRefreshCookie
          ? s.browserCookieAvailable
            ? "Auto-refresh from Search.app is on (Clerk session renewal)."
            : "Auto-refresh is on, but no Search.app cookie store was found."
          : "Auto-refresh is off (manual cookie only).";
        const freshness = s.sessionExpiresAt
          ? ` Session valid until ${new Date(s.sessionExpiresAt).toLocaleTimeString()}${s.sessionMethod === "clerk-token" ? " (renewed)" : ""}.`
          : "";
        status.textContent = `${mode} ${s.configured ? "Session available" : "No session configured"}.${freshness} ${s.storedCount} saved item(s).`;
        autoCheck.checked = s.autoRefreshCookie !== false;
        if (s.cookiePreview && !input.value) input.value = s.cookiePreview;
      } catch (e) {
        status.textContent = `Status unavailable: ${e instanceof Error ? e.message : String(e)}`;
      }
    };

    const save = button(actions, "Save cookie", async () => {
      saveNotice.textContent = "Saving…";
      try {
        await ctx.call("setCookie", { cookie: input.value });
        saveNotice.textContent = "Saved.";
        await refreshStatus();
      } catch (e) {
        saveNotice.textContent = `Save failed: ${e instanceof Error ? e.message : String(e)}`;
      }
    });

    const clear = button(actions, "Clear cookie", async () => {
      try {
        await ctx.call("clearCookie");
        input.value = "";
        saveNotice.textContent = "Cookie cleared.";
        await refreshStatus();
      } catch (e) {
        saveNotice.textContent = `Clear failed: ${e instanceof Error ? e.message : String(e)}`;
      }
    });

    button(actions, "Refresh from Search.app", async () => {
      saveNotice.textContent = "Refreshing…";
      try {
        const result = await ctx.call("refreshCookie");
        const how = result.method === "clerk-token" ? "Fresh session minted via Clerk" : "Cookie read from Search.app";
        saveNotice.textContent = result.changed ? `${how}.` : `${how}; no change needed.`;
        input.value = "";
        await refreshStatus();
      } catch (e) {
        saveNotice.textContent = `Refresh failed: ${e instanceof Error ? e.message : String(e)}`;
      }
    });

    const testRow = el(root, "div");
    testRow.className = "rh-pp-test";
    const testInput = el(testRow, "input");
    testInput.type = "text";
    testInput.placeholder = "Question URL or id, e.g. https://revisionhub.study/question/123";
    testInput.setAttribute("aria-label", "RevisionHub question URL or id");
    const testNotice = el(root, "p");
    testNotice.setAttribute("role", "status");
    button(testRow, "Test fetch", async () => {
      const raw = testInput.value.trim();
      if (!raw) {
        testNotice.textContent = "Enter a question URL or id first.";
        return;
      }
      testNotice.textContent = "Fetching…";
      try {
        const payload = /^\d+$/.test(raw) ? { questionId: raw } : { url: raw };
        const result = await ctx.call("testFetch", payload);
        testNotice.textContent = result.ok
          ? `OK (${result.kind}): ${result.preview}${result.message ? " — " + result.message : ""}`
          : "Fetch failed.";
      } catch (e) {
        testNotice.textContent = `Fetch failed: ${e instanceof Error ? e.message : String(e)}`;
      }
    });

    const searchRow = el(root, "div");
    searchRow.className = "rh-pp-test";
    const topicInput = el(searchRow, "input");
    topicInput.type = "text";
    topicInput.placeholder = "Search by topic, e.g. 'binomial theorem'";
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
      searchNotice.textContent = "Searching…";
      try {
        const result = await ctx.call("testFetch", {
          search: true,
          topic,
          subject: subjectInput.value.trim(),
          autoFetch: true,
        });
        const urlInfo = result.searchUrl
          ? `\nUsed URL: ${result.searchUrl}`
          : result.attemptedUrls && result.attemptedUrls.length
            ? `\nTried URLs (none matched):\n - ${result.attemptedUrls.join("\n - ")}`
            : "";
        searchNotice.textContent = result.ok
          ? `${result.preview}${urlInfo}${result.message ? " — " + result.message : ""}`
          : "Search failed.";
      } catch (e) {
        searchNotice.textContent = `Search failed: ${e instanceof Error ? e.message : String(e)}`;
      }
    });

    // Diagnostic report: lets the user share the site's real /search page
    // structure without revealing their cookie in chat.
    const diagSection = el(root, "section");
    el(diagSection, "h3", "Diagnose search page (for support)");
    el(
      diagSection,
      "p",
      "Uses your saved cookie to inspect the RevisionHub page and reports which client scripts it loads. Copy the report and send it to the plugin author — it never includes your cookie."
    );
    const diagRow = el(diagSection, "div");
    diagRow.className = "rh-pp-test";
    const diagInput = el(diagRow, "input");
    diagInput.type = "text";
    diagInput.value = "https://revisionhub.study/search";
    diagInput.setAttribute("aria-label", "URL to diagnose");
    const diagNotice = el(diagRow, "p");
    diagNotice.setAttribute("role", "status");
    const diagOutput = el(diagSection, "textarea");
    diagOutput.rows = 12;
    diagOutput.readOnly = true;
    diagOutput.className = "rh-pp-diag-output";
    diagOutput.setAttribute("aria-label", "Diagnostic report");
    button(diagRow, "Run diagnosis", async () => {
      const url = diagInput.value.trim() || "https://revisionhub.study/search";
      diagNotice.textContent = "Diagnosing…";
      try {
        const report = await ctx.call("diagnosePage", { url });
        diagOutput.value = JSON.stringify(report, null, 2);
        diagNotice.textContent = report.redirectedToSignIn
          ? "Redirected to sign-in — your cookie is missing or expired."
          : `Done. ${report.appChunks.length} app chunk(s), ${report.allChunks.length} total.`;
      } catch (e) {
        diagNotice.textContent = `Diagnosis failed: ${e instanceof Error ? e.message : String(e)}`;
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
          const meta = el(li, "small", [item.subject, item.paper, item.sourceUrl].filter(Boolean).join(" · "));
          button(li, "Delete", async () => {
            try {
              await ctx.call("deletePaper", { id: item.id });
              await refreshSaved();
              await refreshStatus();
            } catch (e) {
              saveNotice.textContent = `Delete failed: ${e instanceof Error ? e.message : String(e)}`;
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

    return () => {
      // Widgets inside a settings mount are owned by the host; clearing the root is enough.
      root.replaceChildren();
    };
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
      const wrap = el(container, "div", undefined, "rh-pp-question");
      const metaBits = [payload.subject, payload.paper, payload.topic].filter(Boolean);
      if (metaBits.length) el(wrap, "p", metaBits.join(" · "), "rh-pp-meta");
      appendMarkdown(wrap, mountContext.input.question || payload.question || "");
      if (payload.sourceUrl) {
        const a = el(wrap, "a", payload.sourceUrl, "rh-pp-source");
        a.href = payload.sourceUrl;
        a.target = "_blank";
        a.rel = "noopener noreferrer";
      }
      return () => wrap.replaceChildren();
    },

    mountAnswerEditor(container, props) {
      let current = props;
      const wrap = el(container, "div", undefined, "rh-pp-editor");
      const label = el(wrap, "label", "Your answer", "rh-pp-label");
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
      const wrap = el(container, "div", undefined, "rh-pp-answered");

      el(wrap, "h3", "Your answer");
      appendMarkdown(wrap, typeof mountContext.answer === "string" ? mountContext.answer : JSON.stringify(mountContext.answer));

      const scheme = payload.markscheme;
      if (typeof scheme === "string" && scheme.trim()) {
        el(wrap, "h3", "Mark scheme");
        appendMarkdown(wrap, scheme);
      }

      if (payload.sourceUrl) {
        const a = el(wrap, "a", "View on RevisionHub", "rh-pp-source");
        a.href = payload.sourceUrl;
        a.target = "_blank";
        a.rel = "noopener noreferrer";
      }

      if (mountContext.grading !== undefined) {
        el(wrap, "details", "Saved grading observation", "rh-pp-grading");
      }

      return () => wrap.replaceChildren();
    },
  });

  // -------------------------------------------------------------------------
  // Saved-items view (optional convenience).
  // -------------------------------------------------------------------------
  const unregisterView = ctx.registerView({
    id: "rh-pastpapers",
    name: "Past papers",
    mount(container, signal) {
      const root = el(container, "div", undefined, "rh-pp-view");
      el(root, "h1", "RevisionHub past papers");
      el(
        root,
        "p",
        "Questions you fetch or save appear here. Use the teacher agent's fetch tool to retrieve a question, then pose it in the lesson."
      );
      const refresh = button(root, "Refresh", async () => {
        list.replaceChildren();
        try {
          const items = await ctx.call("listPapers");
          for (const item of items) {
            const card = el(list, "article", undefined, "rh-pp-card");
            el(card, "h2", item.subject || item.paper || "Past-paper item");
            appendMarkdown(card, item.question);
            if (item.markscheme) {
              el(card, "h3", "Mark scheme");
              appendMarkdown(card, item.markscheme);
            }
            if (item.sourceUrl) {
              const a = el(card, "a", item.sourceUrl, "rh-pp-source");
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
      const list = el(root, "div", undefined, "rh-pp-list");
      void refresh.click();
      return () => root.replaceChildren();
    },
  });

  const unregisterAction = ctx.registerAction({
    id: "open-rh-pastpapers",
    name: "Open past papers",
    run: () => ctx.app.openView("rh-pastpapers"),
  });
  const unregisterPlacement = ctx.placeAction({
    id: "rh-pastpapers-sidebar",
    actionId: "open-rh-pastpapers",
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
