/**
 * College Board SAT Question Bank — plugin frontend (browser ES module).
 *
 * Provides:
 *   - Settings UI: search official questions by test/topic/skill/difficulty,
 *     option to exclude active questions, fetch official explanation, save items.
 *   - Question renderer: shows question, choices/answer input, and reveals the
 *     official College Board rationale after the learner answers.
 *   - A view listing locally saved questions.
 */

const QUESTION_TYPE_ID = "collegeboard-sat-question";

function el(container, tag, text, className) {
  const node = container.ownerDocument.createElement(tag);
  if (text !== undefined && text !== null) node.textContent = String(text);
  if (className) node.className = className;
  container.append(node);
  return node;
}

function button(container, label, onClick, variant) {
  const b = el(container, "button", label, variant ? `cb-btn cb-btn-${variant}` : "cb-btn");
  b.type = "button";
  b.addEventListener("click", onClick);
  return b;
}

function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }

function setNotice(node, text, tone) {
  node.textContent = text || "";
  node.className = tone === "error" ? "cb-notice cb-notice-error" : tone === "success" ? "cb-notice cb-notice-success" : "cb-notice";
}

function escapeHtml(str) {
  return String(str || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function renderMaybeHtml(container, html, fallbackText) {
  // Official content includes MathML/HTML. Render in a sandboxed-ish way by
  // assigning innerHTML only for trusted-source official fields; this is a
  // local study tool displaying College Board content fetched by the backend.
  if (typeof html === "string" && html.trim()) {
    const box = el(container, "div", null, "cb-rich");
    box.innerHTML = html;
    return box;
  }
  if (typeof fallbackText === "string" && fallbackText.trim()) {
    const pre = el(container, "pre", fallbackText, "cb-pre");
    return pre;
  }
  el(container, "p", "No content.", "cb-muted");
  return null;
}

function renderQuestion(container, question, options = {}) {
  clear(container);
  const q = question || {};
  const wrap = el(container, "div", null, "cb-question");
  const metaParts = [];
  if (q.test) metaParts.push(q.test);
  if (q.domain) metaParts.push(q.domain);
  if (q.skill) metaParts.push(q.skill);
  if (q.difficulty) metaParts.push(q.difficulty);
  if (q.active === true) metaParts.push("active");
  else if (q.active === false) metaParts.push("not active");
  if (metaParts.length) el(wrap, "div", metaParts.join(" · "), "cb-meta");

  const idParts = [];
  if (q.externalId) idParts.push(`externalId: ${q.externalId}`);
  if (q.questionId) idParts.push(`questionId: ${q.questionId}`);
  if (q.uId) idParts.push(`uId: ${q.uId}`);
  if (q.ibn) idParts.push(`IBN: ${q.ibn}`);
  if (idParts.length) el(wrap, "div", `IDs: ${idParts.join(" · ")}`, "cb-id cb-id-strong");

  renderMaybeHtml(wrap, q.promptHtml, q.question);

  const choices = Array.isArray(q.choices) ? q.choices : [];
  const showChoices = options.showChoices !== false;
  if (showChoices && choices.length) {
    const list = el(wrap, "div", null, "cb-choices");
    choices.forEach(ch => {
      const row = el(list, "div", null, "cb-choice");
      el(row, "span", `${ch.letter || ""}.`, "cb-choice-letter");
      const body = el(row, "span", null, "cb-choice-text");
      if (ch.html) body.innerHTML = ch.html; else body.textContent = ch.text || "";
    });
  }

  const showRationale = options.showRationale === true;
  const showAnswer = options.showAnswer === true;
  if (showAnswer) {
    const correct = q.correctAnswer;
    if (correct && (!Array.isArray(correct) || correct.length)) {
      const ans = Array.isArray(correct) ? correct.join(", ") : String(correct);
      if (ans) el(wrap, "div", `Correct answer: ${ans}`, "cb-answer-key");
    }
  }
  if (showRationale && (q.rationale || q.rationaleHtml)) {
    const details = el(wrap, "details", null, "cb-rationale");
    details.open = true;
    el(details, "summary", "Official explanation (College Board)");
    const body = el(details, "div", null, "cb-rationale-body");
    renderMaybeHtml(body, q.rationaleHtml, q.rationale);
  }

  if (q.source || q.sourceUrl) {
    const src = el(wrap, "div", null, "cb-source");
    src.append(document.createTextNode(`Official source: ${q.source || "College Board SAT Suite Question Bank"}`));
    if (q.sourceUrl) {
      src.append(document.createTextNode(" — "));
      const a = el(src, "a", q.sourceUrl);
      a.href = q.sourceUrl;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
    }
  }
  return wrap;
}

function createSettings(ctx) {
  return async (container) => {
    container.classList.add("cb-settings");
    clear(container);

    const header = el(container, "div", null, "cb-header");
    el(header, "h3", "College Board SAT Question Bank", "cb-title");
    el(header, "p", "Search official SAT Suite questions by test, topic/domain, skill, and difficulty. Optionally exclude active questions. Fetch official question text and College Board explanation/rationale. No login required; saved items are stored locally by the plugin.", "cb-desc");

    const notice = el(container, "div", "", "cb-notice");

    let options = { tests: [], domains: [], difficulties: [] };
    try { options = await ctx.call("getOptions", {}); } catch (e) { setNotice(notice, `Failed to load options: ${e && e.message || e}`, "error"); }

    const form = el(container, "div", null, "cb-form");
    const row1 = el(form, "div", null, "cb-row");
    const testLabel = el(row1, "label", "Test ", "cb-label");
    const testSel = el(testLabel, "select", null, "cb-select");
    (options.tests || [{ id: 99, name: "SAT" }]).forEach(t => {
      const opt = el(testSel, "option", t.name);
      opt.value = String(t.id);
    });
    testSel.value = "99";

    const diffBox = el(form, "div", null, "cb-field");
    el(diffBox, "div", "Difficulty", "cb-label-text");
    const diffChecks = {};
    (options.difficulties || [{ code: "E", name: "Easy" }, { code: "M", name: "Medium" }, { code: "H", name: "Hard" }]).forEach(d => {
      const lab = el(diffBox, "label", null, "cb-check");
      const input = document.createElement("input");
      input.type = "checkbox";
      input.value = d.code;
      input.checked = true;
      lab.append(input);
      lab.append(document.createTextNode(" " + d.name));
      diffChecks[d.code] = input;
    });

    const flags = el(form, "div", null, "cb-field cb-flags");
    const excludeLab = el(flags, "label", null, "cb-check");
    const excludeInput = document.createElement("input");
    excludeInput.type = "checkbox";
    excludeInput.checked = false;
    excludeLab.append(excludeInput);
    excludeLab.append(document.createTextNode(" Exclude active questions (College Board active assessments / non-empty IBN)"));
    const fetchDetailsLab = el(flags, "label", null, "cb-check");
    const fetchDetailsInput = document.createElement("input");
    fetchDetailsInput.type = "checkbox";
    fetchDetailsInput.checked = true;
    fetchDetailsLab.append(fetchDetailsInput);
    fetchDetailsLab.append(document.createTextNode(" Fetch official question text and explanation for results (slower, one request per question)"));

    const limitLab = el(form, "label", "Max results ", "cb-label");
    const limitInput = el(limitLab, "input", null, "cb-input cb-input-small");
    limitInput.type = "number"; limitInput.min = "1"; limitInput.max = "50"; limitInput.value = "10";

    const domainsWrap = el(form, "div", null, "cb-domains");
    el(domainsWrap, "div", "Topics / Domains & Skills", "cb-label-text");
    const domainChecks = {};
    const skillChecks = {};
    const domains = options.domains || [];
    domains.forEach(dom => {
      const section = el(domainsWrap, "details", null, "cb-domain");
      section.open = dom.section === "Math";
      const summary = el(section, "summary", `${dom.name} (${dom.section})`, "cb-domain-summary");
      const domLab = el(section, "label", null, "cb-check cb-domain-check");
      const domInput = document.createElement("input");
      domInput.type = "checkbox";
      domInput.value = dom.code;
      domLab.append(domInput);
      domLab.append(document.createTextNode(` Include all ${dom.name}`));
      domainChecks[dom.code] = domInput;
      const skills = el(section, "div", null, "cb-skills");
      (dom.skills || []).forEach(skill => {
        const lab = el(skills, "label", null, "cb-check cb-skill-check");
        const input = document.createElement("input");
        input.type = "checkbox";
        input.value = skill.code || skill.name;
        lab.append(input);
        lab.append(document.createTextNode(" " + skill.name));
        skillChecks[`${dom.code}:${skill.code || skill.name}`] = { input, domain: dom.code, code: skill.code, name: skill.name };
      });
    });

    const actions = el(form, "div", null, "cb-actions");
    const searchBtn = button(actions, "Search questions", null, "primary");
    const clearBtn = button(actions, "Clear selection", null);

    const resultsBox = el(container, "div", null, "cb-results");
    const savedBox = el(container, "div", null, "cb-saved");

    clearBtn.addEventListener("click", () => {
      excludeInput.checked = false;
      fetchDetailsInput.checked = true;
      Object.values(diffChecks).forEach(i => i.checked = true);
      Object.values(domainChecks).forEach(i => i.checked = false);
      Object.values(skillChecks).forEach(s => s.input.checked = false);
      setNotice(notice, "Selection cleared.", "");
    });

    async function loadSaved() {
      clear(savedBox);
      el(savedBox, "h4", "Saved questions", "cb-subtitle");
      try {
        const items = await ctx.call("listSaved", {});
        if (!items || !items.length) { el(savedBox, "p", "No saved questions yet.", "cb-muted"); return; }
        items.forEach(item => {
          const row = el(savedBox, "div", null, "cb-saved-item");
          const info = el(row, "div", null, "cb-saved-info");
          el(info, "div", [item.domain, item.skill, item.difficulty].filter(Boolean).join(" · ") || "(saved)", "cb-meta");
          el(info, "div", String(item.question || "").slice(0, 160), "cb-saved-preview");
          const acts = el(row, "div", null, "cb-saved-actions");
          button(acts, "Open", async () => {
            try {
              const res = await ctx.call("testFetch", { useStored: true, id: item.id });
              showSingleResult(res.item || res);
            } catch (e) { setNotice(notice, e && e.message || String(e), "error"); }
          });
          button(acts, "Delete", async () => {
            try { await ctx.call("deleteSaved", { id: item.id }); await loadSaved(); }
            catch (e) { setNotice(notice, e && e.message || String(e), "error"); }
          });
        });
      } catch (e) { el(savedBox, "p", `Failed to load saved questions: ${e && e.message || e}`, "cb-muted"); }
    }

    function showSingleResult(item) {
      if (!item) return;
      clear(resultsBox);
      el(resultsBox, "h4", "Question", "cb-subtitle");
      renderQuestion(resultsBox, item, { showRationale: true, showAnswer: true });
      const acts = el(resultsBox, "div", null, "cb-actions");
      button(acts, "Save locally", async () => {
        try {
          await ctx.call("saveQuestion", { item });
          setNotice(notice, "Saved locally.", "success");
          await loadSaved();
        } catch (e) { setNotice(notice, e && e.message || String(e), "error"); }
      }, "primary");
      button(acts, "Mark incorrect (review)", async () => {
        try {
          await ctx.call("recordAttempt", { ...item, result: "incorrect", manual: true });
          setNotice(notice, "Recorded incorrect attempt for review.", "success");
          await loadReview();
        } catch (e) { setNotice(notice, e && e.message || String(e), "error"); }
      });
      button(acts, "Mark correct", async () => {
        try {
          await ctx.call("recordAttempt", { ...item, result: "correct", manual: true });
          setNotice(notice, "Recorded correct attempt.", "success");
          await loadReview();
        } catch (e) { setNotice(notice, e && e.message || String(e), "error"); }
      });
    }

    // --- Plan 2: Missed-skill tracker + spaced review ---
    const reviewBox = el(container, "div", null, "cb-review");
    el(reviewBox, "h4", "Missed-skill review (spaced, simple)", "cb-subtitle");
    el(reviewBox, "p", "Automatically captures question attempts from the SAT question renderer. You can also record manually. Stores IDs/progress locally; official question/rationale are re-fetched on demand.", "cb-muted");
    const reviewNotice = el(reviewBox, "div", "", "cb-notice");
    const reviewStats = el(reviewBox, "div", null, "cb-review-stats");
    const reviewActions = el(reviewBox, "div", null, "cb-actions");
    const reviewList = el(reviewBox, "div", null, "cb-review-list");

    async function loadReview() {
      clear(reviewStats); clear(reviewList);
      try {
        const res = await ctx.call("listReview", { dueOnly: false, limit: 50 });
        const stats = res.stats || {};
        el(reviewStats, "div", `Total tracked: ${stats.total || 0} · Due: ${stats.due || 0} · Correct: ${stats.correct || 0} · Incorrect/partial: ${stats.incorrect || 0} · Unknown: ${stats.unknown || 0}`, "cb-meta");
        const weak = Array.isArray(stats.weakSkills) ? stats.weakSkills.slice(0, 8) : [];
        if (weak.length) {
          el(reviewStats, "div", `Weak skills: ${weak.map(w => `${w.domainCode || w.domain || ""} ${w.skillCode || w.skill || ""} (${w.incorrect} miss, ${w.due} due)`).join(" | ")}`, "cb-muted");
        }
        const attempts = Array.isArray(res.attempts) ? res.attempts : [];
        if (!attempts.length) { el(reviewList, "p", "No review records yet. Answer questions or import weaknesses.", "cb-muted"); return; }
        attempts.forEach(a => {
          const card = el(reviewList, "div", null, "cb-card");
          el(card, "div", [a.test, a.domain || a.domainCode, a.skill || a.skillCode, a.difficulty, a.result].filter(Boolean).join(" · "), "cb-meta");
          const ids = [a.externalId ? `externalId: ${a.externalId}` : "", a.questionId ? `questionId: ${a.questionId}` : "", a.uId ? `uId: ${a.uId}` : ""].filter(Boolean).join(" · ");
          el(card, "div", `${ids || "no question id"} · next: ${a.nextReviewAt || ""} · reps: ${a.reps || 0}`, "cb-id");
          if (a.prompt) el(card, "div", String(a.prompt).slice(0, 180), "cb-saved-preview");
          const acts = el(card, "div", null, "cb-actions");
          if (a.externalId) {
            button(acts, "Re-fetch & practice", async () => {
              try {
                const q = await ctx.call("fetchQuestion", { fetch: true, externalId: a.externalId, testId: a.testId || 99 });
                showSingleResult(q.item || q);
                setNotice(reviewNotice, "Fetched official question for review.", "success");
              } catch (e) { setNotice(reviewNotice, e && e.message || String(e), "error"); }
            }, "primary");
          }
          button(acts, "Mark reviewed (correct)", async () => {
            try { await ctx.call("markReviewed", { key: a.key, result: "correct" }); await loadReview(); }
            catch (e) { setNotice(reviewNotice, e && e.message || String(e), "error"); }
          });
          button(acts, "Mark reviewed (incorrect)", async () => {
            try { await ctx.call("markReviewed", { key: a.key, result: "incorrect" }); await loadReview(); }
            catch (e) { setNotice(reviewNotice, e && e.message || String(e), "error"); }
          });
        });
      } catch (e) { setNotice(reviewNotice, e && e.message || String(e), "error"); }
    }

    button(reviewActions, "Refresh review", () => loadReview());
    button(reviewActions, "Show due only", async () => {
      try {
        const res = await ctx.call("listReview", { dueOnly: true, limit: 50 });
        clear(reviewList);
        const attempts = Array.isArray(res.attempts) ? res.attempts : [];
        setNotice(reviewNotice, `${attempts.length} due item(s).`, attempts.length ? "success" : "");
        if (!attempts.length) { el(reviewList, "p", "No due review items.", "cb-muted"); return; }
        for (const a of attempts) {
          const card = el(reviewList, "div", null, "cb-card");
          el(card, "div", [a.domain || a.domainCode, a.skill || a.skillCode, a.difficulty, a.result].filter(Boolean).join(" · "), "cb-meta");
          el(card, "div", [a.externalId ? `externalId: ${a.externalId}` : "no externalId", `next: ${a.nextReviewAt || ""}`].join(" · "), "cb-id");
          if (a.externalId) button(card, "Re-fetch & practice", async () => {
            try { const q = await ctx.call("fetchQuestion", { fetch: true, externalId: a.externalId, testId: a.testId || 99 }); showSingleResult(q.item || q); }
            catch (e) { setNotice(reviewNotice, e && e.message || String(e), "error"); }
          }, "primary");
        }
      } catch (e) { setNotice(reviewNotice, e && e.message || String(e), "error"); }
    });

    // --- Plan 3: Manual Bluebook/My Practice weakness import ---
    const importBox = el(container, "div", null, "cb-import");
    el(importBox, "h4", "Import Bluebook/My Practice weaknesses (manual)", "cb-subtitle");
    el(importBox, "p", "No account scraping. Paste weaknesses from your own Bluebook/My Practice report or enter them manually. Imported targets map to College Board domain/skill codes and can be drilled with official QBank questions.", "cb-muted");
    const importNotice = el(importBox, "div", "", "cb-notice");
    const importForm = el(importBox, "div", null, "cb-form");
    const srcLab = el(importForm, "label", "Source label ", "cb-label");
    const srcInput = el(srcLab, "input", null, "cb-input");
    srcInput.type = "text"; srcInput.placeholder = "e.g. Bluebook Practice Test 4"; srcInput.value = "";
    const textLab = el(importForm, "label", "Paste CSV/TSV/JSON or lines (Domain | Skill | Difficulty | Missed | Notes)", "cb-label");
    const textArea = el(textLab, "textarea", null, "cb-textarea");
    textArea.rows = 6; textArea.placeholder = "domainCode,skillCode,difficulty,missedCount,notes\nH,H.C.,M,2,Missed linear equations in two variables";
    const confirmLab = el(importForm, "label", null, "cb-check");
    const confirmInput = document.createElement("input"); confirmInput.type = "checkbox"; confirmInput.checked = false;
    confirmLab.append(confirmInput); confirmLab.append(document.createTextNode(" Confirm mapped targets (unconfirmed ambiguous targets remain pending)"));

    const manualRow = el(importForm, "div", null, "cb-row");
    const manualDomLab = el(manualRow, "label", "Manual domain ", "cb-label");
    const manualDom = el(manualDomLab, "select", null, "cb-select");
    el(manualDom, "option", "Select domain").value = "";
    domains.forEach(d => { const o = el(manualDom, "option", `${d.code} - ${d.name}`); o.value = d.code; });
    const manualSkillLab = el(manualRow, "label", "Skill ", "cb-label");
    const manualSkill = el(manualSkillLab, "select", null, "cb-select");
    el(manualSkill, "option", "Any skill in domain").value = "";
    manualDom.addEventListener("change", () => {
      clear(manualSkill); el(manualSkill, "option", "Any skill in domain").value = "";
      const d = domains.find(x => x.code === manualDom.value);
      (d && d.skills || []).forEach(s => { const o = el(manualSkill, "option", `${s.code || s.id} - ${s.name}`); o.value = s.code || s.id || ""; });
    });
    const manualDiffLab = el(manualRow, "label", "Difficulty ", "cb-label");
    const manualDiff = el(manualDiffLab, "select", null, "cb-select");
    [["", "Any"], ["E", "Easy"], ["M", "Medium"], ["H", "Hard"]].forEach(([v, n]) => { const o = el(manualDiff, "option", n); o.value = v; });
    const manualNotesLab = el(importForm, "label", "Notes ", "cb-label");
    const manualNotes = el(manualNotesLab, "input", null, "cb-input");
    manualNotes.type = "text"; manualNotes.placeholder = "What was missed / why";
    const importActions = el(importForm, "div", null, "cb-actions");
    button(importActions, "Import pasted weaknesses", async () => {
      try {
        const res = await ctx.call("importWeaknesses", { sourceLabel: srcInput.value || "Manual import", text: textArea.value, confirm: confirmInput.checked, testId: Number(testSel.value) || 99 });
        const imp = res.import || {};
        setNotice(importNotice, `Imported ${imp.acceptedCount || 0} accepted, ${imp.pendingCount || 0} pending.`, "success");
        await loadImports();
      } catch (e) { setNotice(importNotice, e && e.message || String(e), "error"); }
    }, "primary");
    button(importActions, "Add checked manual weakness", async () => {
      try {
        if (!manualDom.value) throw new Error("Select a domain.");
        const res = await ctx.call("addManualWeakness", { sourceLabel: srcInput.value || "Manual weakness", domainCode: manualDom.value, skillCode: manualSkill.value, difficulty: manualDiff.value, notes: manualNotes.value, confirm: true, testId: Number(testSel.value) || 99 });
        const imp = res.import || {};
        setNotice(importNotice, `Added manual weakness (${imp.acceptedCount || 0} accepted).`, "success");
        await loadImports();
      } catch (e) { setNotice(importNotice, e && e.message || String(e), "error"); }
    });

    const importList = el(importBox, "div", null, "cb-import-list");
    async function loadImports() {
      clear(importList);
      try {
        const res = await ctx.call("listImports", { limit: 20, onlyAccepted: false });
        const imports = Array.isArray(res.imports) ? res.imports : [];
        if (!imports.length) { el(importList, "p", "No imports yet.", "cb-muted"); return; }
        imports.forEach(imp => {
          const card = el(importList, "div", null, "cb-card");
          el(card, "div", `${imp.sourceLabel || "Import"} · accepted ${imp.acceptedCount || 0} · pending ${imp.pendingCount || 0}`, "cb-meta");
          el(card, "div", new Date(imp.createdAt || Date.now()).toLocaleString(), "cb-id");
          (imp.targets || []).slice(0, 12).forEach(t => {
            const line = el(card, "div", `${t.domainCode || t.domain || ""} ${t.skillCode || t.skill || ""} ${t.difficulty || ""} · missed ${t.missedCount || 1} ${t.mapped ? "" : "· UNMAPPED"} ${t.needsReview ? "· needs review" : ""}`, "cb-muted");
            if (t.warnings && t.warnings.length) el(line, "div", t.warnings.join("; "), "cb-id");
          });
        });
      } catch (e) { setNotice(importNotice, e && e.message || String(e), "error"); }
    }
    button(importActions, "Refresh imports", () => loadImports());

    searchBtn.addEventListener("click", async () => {
      clear(resultsBox);
      setNotice(notice, "Searching College Board question bank...", "");
      const difficulties = Object.entries(diffChecks).filter(([, i]) => i.checked).map(([c]) => c);
      const selectedDomains = Object.entries(domainChecks).filter(([, i]) => i.checked).map(([c]) => c);
      const selectedSkills = Object.values(skillChecks).filter(s => s.input.checked);
      const skillDomains = [...new Set(selectedSkills.map(s => s.domain))];
      const domains = [...new Set([...selectedDomains, ...skillDomains])];
      const skills = selectedSkills.map(s => s.code || s.name);
      const limit = Math.max(1, Math.min(50, Number(limitInput.value) || 10));
      try {
        const search = await ctx.call("searchQuestions", {
          search: true, testId: Number(testSel.value) || 99,
          domains: domains.length ? domains : undefined,
          difficulties, skills: skills.length ? skills : undefined,
          excludeActive: excludeInput.checked, limit,
        });
        const results = Array.isArray(search.results) ? search.results : [];
        setNotice(notice, `Found ${search.totalMatched || 0} matching question(s); showing ${results.length}. ${search.excludeActive ? "Active questions excluded." : ""}`, results.length ? "success" : "");
        if (!results.length) { el(resultsBox, "p", search.message || "No results.", "cb-muted"); return; }
        const list = el(resultsBox, "div", null, "cb-list");
        for (const r of results) {
          const card = el(list, "div", null, "cb-card");
          const head = el(card, "div", null, "cb-card-head");
          el(head, "div", [r.test, r.domainName, r.skill, r.difficultyName].filter(Boolean).join(" · "), "cb-meta");
          const ids = [r.externalId ? `externalId: ${r.externalId}` : "no externalId", r.questionId ? `questionId: ${r.questionId}` : "", r.uId ? `uId: ${r.uId}` : "", r.ibn ? `IBN: ${r.ibn}` : ""].filter(Boolean).join(" · ");
          el(head, "div", `${r.active ? "Active" : "Not active"} · ${ids}`, "cb-id");
          const acts = el(card, "div", null, "cb-actions");
          const fetchBtn = button(acts, "Fetch question & official explanation", async () => {
            if (!r.externalId) { setNotice(notice, "This result has no external id; full question/explanation cannot be fetched.", "error"); return; }
            fetchBtn.disabled = true; fetchBtn.textContent = "Fetching...";
            try {
              const res = await ctx.call("fetchQuestion", { fetch: true, externalId: r.externalId, testId: Number(testSel.value) || 99, meta: r });
              showSingleResult(res.item || res);
              setNotice(notice, "Fetched official question and explanation.", "success");
            } catch (e) { setNotice(notice, e && e.message || String(e), "error"); }
            finally { fetchBtn.disabled = false; fetchBtn.textContent = "Fetch question & official explanation"; }
          }, "primary");
          button(acts, "Save metadata only", async () => {
            try {
              await ctx.call("saveQuestion", { item: { question: `(metadata only) ${r.domainName} · ${r.skill} · ${r.difficultyName}`, externalId: r.externalId, questionId: r.questionId, test: r.test, testId: r.testId, domain: r.domainName, domainCode: r.domain, skill: r.skill, skillCode: r.skillCode, difficulty: r.difficultyName, difficultyCode: r.difficulty, active: r.active, source: "College Board SAT Suite Question Bank" } });
              setNotice(notice, "Saved metadata.", "success"); await loadSaved();
            } catch (e) { setNotice(notice, e && e.message || String(e), "error"); }
          });
          if (fetchDetailsInput.checked && r.externalId) {
            const detailBox = el(card, "div", "Loading...", "cb-inline-detail cb-muted");
            try {
              const res = await ctx.call("fetchQuestion", { fetch: true, externalId: r.externalId, testId: Number(testSel.value) || 99, meta: r });
              clear(detailBox);
              renderQuestion(detailBox, res.item || res, { showRationale: true, showAnswer: true });
              button(detailBox, "Save this question", async () => {
                try { await ctx.call("saveQuestion", { item: res.item || res }); setNotice(notice, "Saved locally.", "success"); await loadSaved(); }
                catch (e) { setNotice(notice, e && e.message || String(e), "error"); }
              }, "primary");
            } catch (e) { detailBox.textContent = `Failed to fetch details: ${e && e.message || e}`; detailBox.className = "cb-inline-detail cb-notice cb-notice-error"; }
          }
        }
      } catch (e) {
        setNotice(notice, e && e.message || String(e), "error");
      }
    });

    await loadSaved();
    await loadReview();
    await loadImports();
  };
}

function renderAnswerResult(container, result) {
  const box = el(container, "div", null, "cb-result");
  if (!result) { el(box, "p", "No result.", "cb-muted"); return; }
  const payload = result.payload || result.question || result;
  if (payload && (payload.rationale || payload.rationaleHtml)) {
    el(box, "h4", "Official explanation (College Board)", "cb-subtitle");
    renderMaybeHtml(box, payload.rationaleHtml, payload.rationale);
  }
  if (result.feedback || result.message) el(box, "p", String(result.feedback || result.message), "cb-feedback");
}

export function activate(ctx) {
    const disposers = [];

    try {
      disposers.push(ctx.registerQuestionRenderer({
        id: QUESTION_TYPE_ID,
        supportedContractVersions: [1],

        mountQuestion(container, mountContext) {
          if (mountContext.signal && mountContext.signal.aborted) return;
          const payload = (mountContext.input && mountContext.input.payload) ? mountContext.input.payload : (mountContext.input || {});
          const questionText = (mountContext.input && mountContext.input.question) || payload.question || "";
          const view = { ...payload, question: questionText };
          const wrap = el(container, "div", null, "cb-renderer cb-question-mount");
          const hasChoices = Array.isArray(payload.choices) && payload.choices.length > 0;
          renderQuestion(wrap, view, { showRationale: false, showAnswer: false, showChoices: !hasChoices });
          if (hasChoices) {
            el(wrap, "div", "Select your answer below in the answer editor.", "cb-muted");
          }
          return () => wrap.replaceChildren();
        },

        mountAnswerEditor(container, props) {
          let current = props || {};
          const payload = (current.input && current.input.payload) ? current.input.payload : ((current.question && current.question.payload) || {});
          const choices = Array.isArray(payload.choices) ? payload.choices : [];
          const wrap = el(container, "div", null, "cb-answer-wrap cb-editor");
          const group = `cbq-${Math.random().toString(36).slice(2)}`;
          let textarea = null;
          let inputs = [];
          let disposed = false;
          const isActive = () => current.active !== false;

          const currentValue = () => {
            const ans = current && current.answer;
            if (ans && typeof ans === "object" && typeof ans.value === "string") return ans.value;
            if (typeof ans === "string") return ans;
            return "";
          };

          const statusEl = el(wrap, "div", "", "cb-muted cb-editor-status");
          const publish = (value) => {
            if (disposed) return;
            const v = String(value == null ? "" : value);
            const cb = current && current.onChange;
            const state = v.trim() ? { status: "ready", value: v } : { status: "empty" };
            // Visible debug/status to help diagnose host submit state.
            statusEl.textContent = state.status === "ready" ? "Answer ready to submit." : "Enter an answer to enable submit.";
            statusEl.dataset.cbState = state.status;
            wrap.dataset.cbAnswerState = state.status;
            debugEl.textContent = `active=${String(isActive())} onChange=${typeof current?.onChange} valueLen=${v.trim().length}`;
            if (typeof cb !== "function") {
              console.warn("[collegeboard-sat-questionbank] onChange unavailable", { hasCurrent: !!current, state });
              return;
            }
            try {
              cb(state);
            } catch (e) {
              console.error("[collegeboard-sat-questionbank] onChange failed", e, state);
            }
          };

          const renderInputs = () => {
            inputHost.replaceChildren();
            inputs = [];
            if (choices.length) {
              const list = el(inputHost, "div", null, "cb-choices-input");
              const val = currentValue();
              choices.forEach(ch => {
                const lab = el(list, "label", null, "cb-choice-option");
                const input = document.createElement("input");
                input.type = "radio";
                input.name = group;
                input.value = ch.letter || ch.id || "";
                if (val && input.value === val) input.checked = true;
                input.disabled = !isActive();
                input.addEventListener("change", () => { if (input.checked) publish(input.value); });
                input.addEventListener("click", () => { if (input.checked) publish(input.value); });
                lab.append(input);
                const span = el(lab, "span", null);
                span.innerHTML = `<strong>${escapeHtml(ch.letter || "")}.</strong> ${ch.html || escapeHtml(ch.text || "")}`;
                list.append(lab);
                inputs.push(input);
              });
            } else {
              const label = el(inputHost, "label", "Your answer", "cb-label");
              textarea = el(inputHost, "textarea", null, "cb-textarea");
              textarea.rows = 8;
              textarea.placeholder = "Type your answer...";
              textarea.setAttribute("aria-label", "Your answer");
              textarea.value = currentValue();
              textarea.disabled = !isActive();
              textarea.addEventListener("input", () => publish(textarea.value));
              textarea.addEventListener("change", () => publish(textarea.value));
              textarea.addEventListener("keyup", () => publish(textarea.value));
              label.append(textarea);
            }
          };

          renderInputs();
          // Publish current state after mount so host knows editor is ready/empty.
          publish(currentValue());
          setTimeout(() => { try { publish(textarea ? textarea.value : currentValue()); } catch {} }, 0);
          setTimeout(() => { try { publish(textarea ? textarea.value : currentValue()); } catch {} }, 80);

          return {
            update(next) {
              if (disposed || !next) return;
              current = next;
              const val = currentValue();
              const active = isActive();
              if (textarea) {
                if (textarea.value !== val) textarea.value = val;
                textarea.disabled = !active;
              }
              inputs.forEach(i => {
                i.checked = i.value === val;
                i.disabled = !active;
              });
              publish(textarea ? textarea.value : val);
            },
            focus() {
              if (disposed) return;
              try { if (textarea) textarea.focus(); else if (inputs[0]) inputs[0].focus(); } catch {}
            },
            handleKeyDown(_key) {
              // Keep host submit behavior, but ensure latest text is published.
              if (textarea) publish(textarea.value);
              return "pass";
            },
            appendTranscript(text) {
              if (disposed || !textarea) return;
              const t = String(text || "");
              if (!t) return;
              textarea.value = (textarea.value ? textarea.value + " " : "") + t;
              publish(textarea.value);
            },
            dispose() {
              disposed = true;
              wrap.replaceChildren();
            },
          };
        },

        mountAnswered(container, mountContext) {
          if (mountContext.signal && mountContext.signal.aborted) return;
          const payload = (mountContext.input && mountContext.input.payload) ? mountContext.input.payload : (mountContext.input || {});
          const wrap = el(container, "div", null, "cb-answered");
          el(wrap, "h3", "Your answer", "cb-subtitle");
          const ans = mountContext.answer;
          const ansText = typeof ans === "string" ? ans : (ans && typeof ans.value === "string" ? ans.value : (ans == null ? "" : JSON.stringify(ans)));
          el(wrap, "pre", ansText || "(no answer)", "cb-pre");

          if (payload.correctAnswer && (!Array.isArray(payload.correctAnswer) || payload.correctAnswer.length)) {
            const correct = Array.isArray(payload.correctAnswer) ? payload.correctAnswer.join(", ") : String(payload.correctAnswer);
            if (correct) el(wrap, "div", `Correct answer: ${correct}`, "cb-answer-key");
          }
          if (payload.rationale || payload.rationaleHtml) {
            const details = el(wrap, "details", null, "cb-rationale");
            details.open = true;
            el(details, "summary", "Official explanation (College Board)");
            const body = el(details, "div", null, "cb-rationale-body");
            renderMaybeHtml(body, payload.rationaleHtml, payload.rationale);
          }
          const idParts = [];
          if (payload.externalId) idParts.push(`externalId: ${payload.externalId}`);
          if (payload.questionId) idParts.push(`questionId: ${payload.questionId}`);
          if (payload.uId) idParts.push(`uId: ${payload.uId}`);
          if (payload.ibn) idParts.push(`IBN: ${payload.ibn}`);
          if (idParts.length) el(wrap, "div", `IDs: ${idParts.join(" · ")}`, "cb-id cb-id-strong");
          if (payload.sourceUrl || payload.source) {
            const src = el(wrap, "div", null, "cb-source");
            src.append(document.createTextNode(`Official source: ${payload.source || "College Board SAT Suite Question Bank"}`));
            if (payload.sourceUrl) {
              src.append(document.createTextNode(" — "));
              const a = el(src, "a", payload.sourceUrl);
              a.href = payload.sourceUrl;
              a.target = "_blank";
              a.rel = "noopener noreferrer";
            }
          }
          return () => wrap.replaceChildren();
        },
      }));
    } catch {}

    try {
      const unregisterSettings = ctx.registerSettings(async (container, signal) => {
        await createSettings(ctx)(container);
        if (signal && signal.aborted) container.replaceChildren();
      });
      if (typeof unregisterSettings === "function") disposers.push(unregisterSettings);
    } catch {}

    try {
      disposers.push(ctx.registerView({
        id: "collegeboard-sat-questionbank-saved",
        name: "SAT Review & Saved",
        mount: async (container, signal) => {
          clear(container);
          container.classList.add("cb-view");
          el(container, "h3", "SAT Review & Saved", "cb-title");
          const notice = el(container, "div", "", "cb-notice");
          try {
            const review = await ctx.call("listReview", { dueOnly: true, limit: 20 });
            if (signal && signal.aborted) return;
            const stats = review.stats || {};
            el(container, "div", `Due: ${stats.due || 0} · Total tracked: ${stats.total || 0} · Incorrect/partial: ${stats.incorrect || 0}`, "cb-meta");
            const due = Array.isArray(review.attempts) ? review.attempts : [];
            if (due.length) {
              el(container, "h4", "Due review", "cb-subtitle");
              due.slice(0, 10).forEach(a => {
                const card = el(container, "div", null, "cb-card");
                el(card, "div", [a.domain || a.domainCode, a.skill || a.skillCode, a.difficulty, a.result].filter(Boolean).join(" · "), "cb-meta");
                el(card, "div", a.externalId ? `externalId: ${a.externalId}` : "No externalId (metadata only)", "cb-id");
                if (a.externalId) button(card, "Re-fetch official question", async () => {
                  try { const res = await ctx.call("fetchQuestion", { fetch: true, externalId: a.externalId, testId: a.testId || 99 }); if (signal && signal.aborted) return; clear(card); renderQuestion(card, res.item || res, { showRationale: true, showAnswer: true }); }
                  catch (e) { if (!(signal && signal.aborted)) setNotice(notice, e && e.message || String(e), "error"); }
                }, "primary");
              });
            }
          } catch (e) { if (!(signal && signal.aborted)) setNotice(notice, `Review load failed: ${e && e.message || String(e)}`, "error"); }

          el(container, "h4", "Saved questions", "cb-subtitle");
          try {
            const items = await ctx.call("listSaved", {});
            if (signal && signal.aborted) return;
            if (!items || !items.length) { el(container, "p", "No saved questions yet. Use plugin settings to search and save.", "cb-muted"); return; }
            for (const item of items) {
              const card = el(container, "div", null, "cb-card");
              el(card, "div", [item.test, item.domain, item.skill, item.difficulty].filter(Boolean).join(" · "), "cb-meta");
              const idLine = [item.externalId ? `externalId: ${item.externalId}` : "", item.questionId ? `questionId: ${item.questionId}` : "", item.uId ? `uId: ${item.uId}` : "", item.ibn ? `IBN: ${item.ibn}` : ""].filter(Boolean).join(" · ");
              if (idLine) el(card, "div", idLine, "cb-id");
              el(card, "div", String(item.question || "").slice(0, 240), "cb-saved-preview");
              button(card, "Open", async () => {
                try {
                  const res = await ctx.call("testFetch", { useStored: true, id: item.id });
                  if (signal && signal.aborted) return;
                  clear(card);
                  renderQuestion(card, res.item || res, { showRationale: true, showAnswer: true });
                } catch (e) { if (!(signal && signal.aborted)) setNotice(notice, e && e.message || String(e), "error"); }
              });
            }
          } catch (e) { if (!(signal && signal.aborted)) setNotice(notice, e && e.message || String(e), "error"); }
          return () => { clear(container); };
        },
      }));
    } catch {}

  return () => { for (const d of disposers) try { d && d(); } catch {} };
}

