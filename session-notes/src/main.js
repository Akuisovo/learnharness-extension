// Session Notes frontend. Uses only public LearnHarness plugin API v1.
// The host owns the native transcript; capture happens in a plugin-owned overlay.

const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};
const message = error => error instanceof Error ? error.message : String(error);
const notesIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 4h11l3 3v13H5z"/><path d="M8 9h8M8 13h8M8 17h5"/></svg>';
const addNoteIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 4h11l3 3v5"/><path d="M5 4v16h8"/><path d="M17 14v7M13.5 17.5h7"/></svg>';
const trashIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7"/></svg>';

/** Combine caller lifetimes so every UI widget is scoped to the shortest owner. */
function lifetime(...parents) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  for (const parent of parents) {
    if (parent.aborted) abort();
    else parent.addEventListener('abort', abort, { once: true });
  }
  controller.signal.addEventListener('abort', () => {
    for (const parent of parents) parent.removeEventListener('abort', abort);
  }, { once: true });
  return controller;
}

const DIAGRAM_LANGS = new Set(['mermaid', 'graph', 'flowchart', 'sequence', 'class', 'gantt', 'pie', 'state', 'er', 'timeline', 'mindmap']);
const TEXT_KEYS = new Set(['text', 'markdown', 'content', 'output', 'data', 'result', 'details', 'source', 'chart', 'code', 'value', 'answer', 'question', 'statement', 'partial', 'message', 'mermaid', 'errorText', 'input', 'arguments']);
const SKIP_KEYS = new Set(['id', 'type', 'role', 'state', 'toolCallId', 'sourceMessageId', 'sourceContentIndex', 'mimeType', 'snapshotId', 'path', 'url', 'name']);

/** Flatten prose into text blocks and consecutive pipe/grid/ASCII table rows into table blocks. */
function splitProse(chunk) {
  const lines = String(chunk || '').replace(/\r\n?/g, '\n').split('\n');
  const blocks = [];
  let buffer = [], mode = 'text';
  const isSeparator = line => /^\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line) || /^\s*[+=]={2,}[+=](\s*[+=])*$/.test(line);
  const isTableLine = line => (line.match(/\|/g) || []).length >= 1 || /^\s*[+][-=+]+[+]/.test(line) || isSeparator(line);
  const flush = () => {
    const markdown = buffer.join('\n').trim();
    buffer = [];
    if (markdown) blocks.push({ type: mode, markdown: markdown.slice(0, 12000), caption: '' });
  };
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (!line.trim()) { flush(); mode = 'text'; continue; }
    const tableLine = isTableLine(line) || (isSeparator(lines[index + 1] || '') && (line.match(/\|/g) || []).length >= 1);
    if (tableLine) {
      if (mode !== 'table') { flush(); mode = 'table'; }
      buffer.push(line);
      continue;
    }
    if (mode === 'table') { flush(); mode = 'text'; }
    buffer.push(line);
  }
  flush();
  return blocks;
}

/** Split Markdown into capturable blocks: text, tables, diagrams and code.
 * Handles backtick/tilde fences, HTML tables and LaTeX tabular/array blocks. */
export function splitMarkdown(input) {
  const text = String(input || '').replace(/\r\n?/g, '\n');
  const special = /```([^\n`]*)\n([\s\S]*?)```|~~~([^\n~]*)\n([\s\S]*?)~~~|<table\b[\s\S]*?<\/table>|\\begin\{(?:tabular|array|longtable)\*?\}[\s\S]*?\\end\{(?:tabular|array|longtable)\*?\}/gi;
  const blocks = [];
  let cursor = 0, match;
  while ((match = special.exec(text))) {
    blocks.push(...splitProse(text.slice(cursor, match.index)));
    const raw = match[0];
    let type = 'text';
    if (/^<table/i.test(raw) || /^\\begin/i.test(raw)) type = 'table';
    else {
      const lang = (match[1] ?? match[3] ?? '').trim().split(/\s+/)[0].toLowerCase();
      type = DIAGRAM_LANGS.has(lang) ? 'diagram' : lang ? 'code' : 'text';
    }
    blocks.push({ type, markdown: raw.slice(0, 12000), caption: '' });
    cursor = match.index + raw.length;
  }
  blocks.push(...splitProse(text.slice(cursor)));
  return blocks.filter(block => block.markdown).slice(0, 80);
}

/** Recursively collect Markdown-bearing strings from a transcript part's payload.
 * Tool outputs and structured `data` fields often hold tables/diagrams that are
 * not present in `part.text`, so they must be scanned too. */
export function collectSources(part, out = [], depth = 0) {
  if (!part || depth > 6 || out.length > 40) return out;
  if (typeof part === 'string') {
    if (part.trim()) out.push(part);
    return out;
  }
  if (Array.isArray(part)) {
    for (const item of part) collectSources(item, out, depth + 1);
    return out;
  }
  if (typeof part !== 'object') return out;
  for (const [key, value] of Object.entries(part)) {
    if (SKIP_KEYS.has(key)) continue;
    if (TEXT_KEYS.has(key)) {
      if (typeof value === 'string') { if (value.trim()) out.push(value); continue; }
      if (value && typeof value === 'object') { collectSources(value, out, depth + 1); continue; }
    }
    if (key === 'parts' || key === 'messages' || key === 'message' || key === 'result' || key === 'output'
      || key === 'data' || key === 'arguments' || key === 'input' || key === 'details' || key === 'content') {
      collectSources(value, out, depth + 1);
    }
  }
  return out;
}

/** Build capture sources from the detached session view supplied to a top-bar action. */
export function sourceStrings(view) {
  const sources = [];
  const add = value => {
    const collected = collectSources(value);
    for (const item of collected) if (!sources.includes(item)) sources.push(item);
  };
  const transcript = Array.isArray(view?.transcript) ? view.transcript : [];
  for (const msg of transcript) {
    const parts = Array.isArray(msg?.parts) ? msg.parts : [];
    for (const part of parts) add(part);
  }
  const messages = Array.isArray(view?.messages) ? view.messages : [];
  for (const msg of messages) add(msg);
  return sources.slice(0, 60);
}

/** Mermaid sources in transcript order, used to reproduce rendered diagrams. */
export function diagramSources(view) {
  const found = [];
  const add = value => {
    if (!found.includes(value)) found.push(value);
  };
  for (const source of sourceStrings(view)) {
    for (const pick of fenceSources(source, true)) add(pick.markdown);
    const trimmed = source.trim();
    if (/^(?:graph|flowchart|sequenceDiagram|classDiagram|stateDiagram|erDiagram|gantt|pie|timeline|mindmap)\b/i.test(trimmed)) {
      add(`\`\`\`mermaid\n${trimmed}\n\`\`\``);
    }
  }
  return found;
}

export function blocksFromView(view) {
  const blocks = [];
  for (const source of sourceStrings(view)) blocks.push(...splitMarkdown(source));
  return blocks.slice(0, 120);
}

/** Convert a rendered host table into Markdown so it renders as a table in a note. */
export function tableToMarkdown(table) {
  const rows = [...(table.querySelectorAll?.('tr') ?? [])];
  if (!rows.length) return table.outerHTML || '';
  const cells = row => [...(row.querySelectorAll?.('th,td') ?? [])]
    .map(cell => String(cell.textContent || '').replace(/\s*\n\s*/g, ' ').replace(/\|/g, '\\|').trim());
  const headerRow = table.querySelector?.('thead tr') || rows[0];
  const header = cells(headerRow);
  const width = Math.max(header.length, ...rows.map(row => cells(row).length));
  const pad = row => { const padded = [...row]; while (padded.length < width) padded.push(''); return padded; };
  const lines = [`| ${pad(header).join(' | ')} |`, `| ${header.map(() => '---').join(' | ')} |`];
  for (const row of rows) {
    if (row === headerRow) continue;
    const values = cells(row);
    if (values.every(value => !value)) continue;
    lines.push(`| ${pad(values).join(' | ')} |`);
  }
  return lines.join('\n');
}

/** Elements the host Markdown renderer actually produces for tables/diagrams/code. */
export const CAPTURE_SELECTOR = 'table, [data-testid="md-mermaid"], [data-streamdown="mermaid"], [data-streamdown="code-block"], pre, svg, img[data-streamdown="image"]';

/** Ignore nested matches (e.g. an <svg> inside a mermaid block) so each capture gets one icon. */
export function topLevelCaptures(slot) {
  const nodes = [...(slot?.querySelectorAll?.(CAPTURE_SELECTOR) ?? [])];
  return nodes.filter(node => !nodes.some(other => other !== node && other.contains(node)));
}

export function fenceSources(source, wantDiagram) {
  const re = /```([^\n`]*)\n([\s\S]*?)```|~~~([^\n~]*)\n([\s\S]*?)~~~/g;
  const results = [];
  let match;
  while ((match = re.exec(String(source || '')))) {
    const lang = (match[1] ?? match[3] ?? '').trim().split(/\s+/)[0].toLowerCase();
    const isDiagram = DIAGRAM_LANGS.has(lang);
    if (wantDiagram ? isDiagram : !isDiagram && !!lang) results.push({ lang, markdown: match[0] });
  }
  return results;
}

function captureKind(node) {
  if (node.matches?.('table')) return 'table';
  if (node.matches?.('[data-testid="md-mermaid"], [data-streamdown="mermaid"]')) return 'diagram';
  if (node.matches?.('[data-streamdown="code-block"], pre')) return 'code';
  return 'image';
}

/** Capture content from a host-rendered element, preferring the original source. */
export function captureFromElement(node, source, nodes) {
  const kind = captureKind(node);
  const candidates = kind === 'diagram' || kind === 'code' ? fenceSources(source, kind === 'diagram') : [];
  const sameKind = nodes.filter(other => captureKind(other) === kind);
  const pick = candidates[Math.max(0, sameKind.indexOf(node))] ?? candidates[0];
  let markdown = pick?.markdown;
  if (!markdown) {
    if (kind === 'table') markdown = tableToMarkdown(node);
    else if (kind === 'image') markdown = `\`\`\`html\n${node.outerHTML || node.textContent || ''}\n\`\`\``;
    else markdown = `\`\`\`${pick?.lang || ''}\n${node.textContent || ''}\n\`\`\``;
  }
  const type = kind === 'table' ? 'table' : kind === 'image' ? 'diagram' : kind;
  const caption = kind === 'table' ? 'Table' : kind === 'diagram' ? 'Diagram' : kind === 'code' ? 'Code' : 'Image';
  return { type, markdown: String(markdown).slice(0, 12000), caption };
}

/** Read a selection from every relevant DOM scope, including shadow roots. */
export function readSelection(target, fallbackRoot) {
  const scopes = new Set();
  if (fallbackRoot) scopes.add(fallbackRoot.getRootNode?.() ?? fallbackRoot.ownerDocument ?? fallbackRoot);
  if (typeof Node !== 'undefined' && target instanceof Node) scopes.add(target.getRootNode?.());
  if (globalThis.document) scopes.add(globalThis.document);
  let best = '';
  for (const scope of scopes) {
    try {
      const selection = scope?.getSelection?.() ?? globalThis.getSelection?.();
      const value = (selection?.toString?.() || '').trim();
      if (value.length > best.length) best = value;
    } catch { /* ignore scopes that cannot expose a selection */ }
  }
  return best.slice(0, 8000);
}

/** Short plain-text preview for the lightweight picker. No Markdown rendering. */
export function previewBlock(block) {
  let value = String(block?.markdown || '');
  if (block?.type === 'diagram' || block?.type === 'code') {
    value = value.replace(/^\s*[`~]{3,}[^\n]*\n?/, '').replace(/\n?[`~]{3,}\s*$/, '');
  }
  value = value
    .replace(/<[^>]+>/g, ' ')
    .replace(/^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)+\|?\s*$/gm, ' ')
    .replace(/[|`*_#]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return value.slice(0, 220) || (block?.caption || block?.type || 'Empty block');
}

/** Native transcript elements that can be turned into note blocks.
 * Kept deliberately broad: settled/older sessions contain more tool cards,
 * plain user prose, submitted images and collapsed content than fresh ones. */
export const REGION_SELECTOR = [
  // Structured blocks.
  'table', '[data-testid="md-table"]', '[data-streamdown="table-wrapper"]',
  '[data-testid="md-mermaid"]', '[data-streamdown="mermaid"]', '[data-streamdown="mermaid-error"]',
  '[data-streamdown="code-block"]', '[data-testid="md-code"]',
  '[data-streamdown="image-wrapper"]', 'img[data-streamdown="image"]',
  '[data-testid="submitted-images"] img',
  // Message and card rows.
  '[data-source-message-id]', '.lh-source-passage', '[data-testid="user-message"]',
  '[data-testid="tool-call-card"]', '[data-tool]', '[data-testid="answered-card"]',
  '[data-testid="tucked-explanation"]', '[data-testid="practice-next-line"]',
  // Prose (assistant paragraphs are plain <p>; user prose is .lh-prose).
  '.lh-prose', 'p', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  '[data-streamdown^="heading-"]', '[data-streamdown="list-item"]',
  '[data-testid="md-math"]', '[data-streamdown="blockquote"]', 'pre',
].join(', ');

const regionMatches = {
  table: 'table',
  mermaid: '[data-testid="md-mermaid"], [data-streamdown="mermaid"], [data-streamdown="mermaid-error"]',
  code: '[data-streamdown="code-block"]',
  image: '[data-streamdown="image-wrapper"], img[data-streamdown="image"], [data-testid="submitted-images"] img',
};

export function regionType(node) {
  if (node.matches?.('table')) return 'table';
  if (node.matches?.(regionMatches.mermaid)) return 'diagram';
  if (node.matches?.(regionMatches.code)) return 'code';
  if (node.matches?.(regionMatches.image)) return 'diagram';
  return 'text';
}

const HIGH_PRIORITY = [
  'table', regionMatches.mermaid, regionMatches.code, regionMatches.image,
  '[data-testid="md-math"]', 'pre',
].join(', ');
const MEDIUM_PRIORITY = 'p, li, h1, h2, h3, h4, h5, h6, [data-streamdown^="heading-"], [data-streamdown="list-item"], [data-streamdown="blockquote"]';
const WRAPPER_SELECTOR = '[data-source-message-id], [role="log"], [data-session-find-root], [data-session-body], [data-testid="tool-call-card"], [data-testid="user-message"]';

/** Extract readable text. innerText splits stacked MathML glyphs onto separate
 * lines ("𝑧\nˉ\n=…"); in that case textContent is the faithful source. */
function cleanNodeText(node) {
  const raw = String(node?.innerText ?? node?.textContent ?? '');
  const lines = raw.split(/\r?\n/).map(line => line.trim());
  const glyphLines = lines.filter(line => line.length > 0 && line.length <= 2).length;
  if (glyphLines >= 3) return String(node?.textContent ?? '').replace(/\s+/g, ' ').trim();
  return raw.replace(/\u00A0/g, ' ').trim();
}

/** Prefer an individual content block over a whole-session wrapper. */
function preferRegionNode(target, point) {
  const hit = node => {
    const rect = node.getBoundingClientRect?.();
    return rect && (!point || (point.clientX >= rect.left && point.clientX <= rect.right
      && point.clientY >= rect.top && point.clientY <= rect.bottom));
  };
  const candidates = [...(target?.querySelectorAll?.(MEDIUM_PRIORITY + ', ' + HIGH_PRIORITY) ?? [])]
    .filter(node => hit(node) && !node.closest?.('[data-plugin-session-surface]'))
    .filter(node => {
      const text = cleanNodeText(node);
      return text.length >= 3 && text.length <= 600;
    });
  if (candidates.length) {
    candidates.sort((a, b) => {
      const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
      return (ra.width * ra.height) - (rb.width * rb.height);
    });
    return candidates[0];
  }
  let node = target;
  while (node && node !== document.body) {
    const text = cleanNodeText(node);
    const rect = node.getBoundingClientRect?.();
    if (text.length >= 3 && text.length <= 600 && rect && rect.width < 1000 && rect.height < 500
        && !node.matches?.(WRAPPER_SELECTOR)
        && !node.closest?.('[data-plugin-session-surface]')) return node;
    node = node.parentElement;
  }
  return null;
}

/** Higher priority wins when boxes overlap, so a table is not hidden by its wrapper. */
function regionPriority(node) {
  if (node.matches?.(HIGH_PRIORITY)) return 3;
  if (node.matches?.(MEDIUM_PRIORITY)) return 2;
  return 1;
}

/** Skip hidden/collapsed nodes so they never become zero-size, unclickable boxes. */
function regionVisible(node) {
  if (node.matches?.('[data-session-find-root], [role="log"], [data-session-body]')) return false;
  const rect = node.getBoundingClientRect?.();
  if (rect && (rect.width < 2 || rect.height < 2)) return false;
  const style = globalThis.getComputedStyle?.(node);
  if (style && (style.display === 'none' || style.visibility === 'hidden'
    || style.visibility === 'collapse' || style.contentVisibility === 'hidden')) return false;
  if (node.closest?.('[hidden], [data-session-find-exclude], [role="dialog"], .sr-only')) return false;
  const closed = node.closest?.('details:not([open])');
  if (closed && closed !== node) return false;
  return true;
}

/** Detect selectable element regions inside the native transcript DOM.
 * `scope` may be an Element, a { querySelectorAll } object, or an array of nodes. */
export function findRegions(...scopes) {
  const nodes = [];
  for (const scope of scopes) {
    if (Array.isArray(scope)) { nodes.push(...scope); continue; }
    nodes.push(...(scope?.querySelectorAll?.(REGION_SELECTOR) ?? []));
  }
  const unique = [...new Set(nodes)]
    .filter(node => !node.closest?.('[data-plugin-session-surface], [data-session-surface-mounts]'))
    .filter(regionVisible)
    .filter(node => {
      if (node.matches?.(HIGH_PRIORITY)) return true;
      // Never select whole-session wrappers or tool/message cards as one block.
      if (node.matches?.(WRAPPER_SELECTOR)) return false;
      const text = cleanNodeText(node);
      if (text.length > 800) return false;
      const rect = node.getBoundingClientRect?.();
      const viewport = (globalThis.innerWidth || 1200) * (globalThis.innerHeight || 800);
      if (rect && rect.width * rect.height > viewport * 0.3) return false;
      const count = node.querySelectorAll?.('[data-source-message-id], [data-testid="user-message"], [data-testid="md-mermaid"], [data-streamdown="mermaid"], table, [data-streamdown="code-block"], [data-testid="tool-call-card"]').length || 0;
      return count < 3;
    });
  const info = unique.map(node => ({ node, type: regionType(node), priority: regionPriority(node) }));
  const kept = info.filter(({ node, priority }) => !info.some(other =>
    other.node !== node && (
      // Another element wraps this one and is a better/more specific capture.
      (other.priority > priority && other.node.contains?.(node))
      // Prefer the more specific child when a wrapper contains it.
      || (other.priority >= priority && node.contains?.(other.node))
      // A structured child (table/diagram/code) should replace its text wrapper.
      || (priority < 3 && other.priority === 3 && node.contains?.(other.node))
    )));
  const seenText = new Set();
  const deduped = kept.filter(({ node, type }) => {
    if (type !== 'text') return true;
    const key = cleanNodeText(node).slice(0, 200);
    if (key && seenText.has(key)) return false;
    if (key) seenText.add(key);
    return true;
  });
  let diagramIndex = -1;
  return deduped.map(({ node, type }) => {
    const isMermaid = node.matches?.(regionMatches.mermaid);
    const isImage = node.matches?.(regionMatches.image);
    return {
      node, type,
      isImage,
      label: isImage ? 'Image' : type === 'table' ? 'Table' : type === 'diagram' ? 'Diagram' : type === 'code' ? 'Code' : 'Text',
      diagramIndex: isMermaid ? ++diagramIndex : -1,
    };
  }).slice(0, 150);
}

/** Turn a selected DOM region into a note block. Diagrams keep their Mermaid source. */
export function regionToBlock(region, mermaidSources = []) {
  const node = region.node;
  const type = region.type || regionType(node);
  if (type === 'table') {
    const inner = !node.matches?.('table') && node.tagName !== 'TABLE' ? node.querySelector?.('table') : null;
    const table = inner || node;
    return { type: 'table', markdown: tableToMarkdown(table), caption: 'Table' };
  }
  if (type === 'diagram') {
    if (region.isImage || node.matches?.('[data-streamdown="image-wrapper"], img[data-streamdown="image"], [data-testid="submitted-images"] img')) {
      const img = node.matches?.('img') ? node : node.querySelector?.('img');
      const src = img?.getAttribute?.('src') || img?.src || '';
      const alt = img?.getAttribute?.('alt') || 'Image';
      if (src && !src.startsWith('data:')) {
        return { type: 'diagram', markdown: `![${alt}](${src})`, caption: 'Image' };
      }
      return { type: 'diagram', markdown: `\`\`\`html\n${node.outerHTML || img?.outerHTML || ''}\n\`\`\``, caption: 'Image' };
    }
    const index = region.diagramIndex ?? 0;
    const source = index >= 0 ? mermaidSources[index] : '';
    const fallback = String(node.querySelector?.('pre')?.textContent || node.innerText || node.textContent || '').trim();
    const markdown = source || `\`\`\`mermaid\n${fallback}\n\`\`\``;
    return { type: 'diagram', markdown, caption: 'Diagram' };
  }
  if (type === 'code') {
    const language = node.getAttribute?.('data-language')
      || node.querySelector?.('[data-language]')?.getAttribute?.('data-language') || '';
    const code = node.querySelector?.('code')?.textContent || node.textContent || '';
    return { type: 'code', markdown: `\`\`\`${language}\n${String(code).trim()}\n\`\`\``, caption: 'Code' };
  }
  const markdown = cleanNodeText(node);
  return { type: 'text', markdown, caption: 'Text' };
}

export function rectsOverlap(a, b) {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}

const localMatch = (note, query) => {
  if (!query) return true;
  const haystack = [note.title, note.text, note.sessionTitle, ...(note.topics || []),
    ...(note.nodes || []).map(node => node.label || node.id || node),
    ...(note.blocks || []).flatMap(block => [block.caption, block.markdown])]
    .filter(Boolean).join('\n').toLocaleLowerCase();
  return query.toLocaleLowerCase().split(/\s+/).filter(Boolean).every(term => haystack.includes(term));
};

export function activate(ctx) {
  for (const capability of ['mountMarkdown', 'mountTree', 'mountButton', 'openMenu', 'openSurface', 'openDialog']) {
    if (typeof ctx.ui?.[capability] !== 'function') {
      throw new Error(`Session Notes requires a newer LearnHarness host with ctx.ui.${capability}. Please update LearnHarness.`);
    }
  }
  let snapshot = null, catalogCache = null, refreshing = null, refreshAgain = false, logPath = '';
  const observers = new Set(), registrations = [];
  const safeData = value => {
    try { return JSON.parse(JSON.stringify(value)); } catch { return { note: 'unserializable' }; }
  };
  const logEvent = (event, data = {}, level = 'info') => {
    const payload = { level, event, data: safeData(data) };
    try { console.debug('[session-notes]', event, payload.data); } catch {}
    try { void ctx.call('append-log', payload).then(result => { if (result?.path) logPath = result.path; }); } catch {}
  };
  void ctx.call('get-log-info').then(result => { logPath = result?.path || ''; logEvent('frontend-ready', { logPath }); }).catch(() => {});
  if (typeof globalThis.addEventListener === 'function') {
    globalThis.addEventListener('error', event => logEvent('window-error', { message: String(event?.message || event?.error || 'error') }, 'error'), { signal: ctx.signal });
    globalThis.addEventListener('unhandledrejection', event => logEvent('unhandledrejection', { message: String(event?.reason?.message || event?.reason || 'rejection') }, 'error'), { signal: ctx.signal });
  }
  const publish = value => {
    if (!value || ctx.signal.aborted || (snapshot && value.revision < snapshot.revision)) return;
    snapshot = value;
    for (const observer of observers) observer(value);
  };
  const loadState = async () => { publish(await ctx.call('get-state')); };
  const refresh = () => {
    if (!observers.size || ctx.signal.aborted) return Promise.resolve();
    if (refreshing) { refreshAgain = true; return refreshing; }
    refreshing = (async () => {
      do {
        refreshAgain = false;
        try { await loadState(); }
        catch (error) { for (const observer of observers) observer(null, message(error)); }
      } while (refreshAgain && observers.size && !ctx.signal.aborted);
    })().finally(() => { refreshing = null; });
    return refreshing;
  };
  const observe = (fn, signal) => {
    observers.add(fn);
    signal.addEventListener('abort', () => observers.delete(fn), { once: true });
    if (snapshot) fn(snapshot);
    void refresh();
  };
  const ensureCatalog = async () => {
    if (catalogCache || ctx.signal.aborted) return catalogCache;
    try { catalogCache = await ctx.call('get-catalog'); }
    catch { catalogCache = { sessions: [], nodes: [], topics: [] }; }
    return catalogCache;
  };
  const widget = (handle, signal) => {
    if (signal.aborted) handle.dispose();
    else signal.addEventListener('abort', () => handle.dispose(), { once: true });
    return handle;
  };
  const button = (parent, label, action, signal, options = {}) => {
    const slot = el('span', 'sn-button-slot');
    parent.append(slot);
    let pending = false;
    const handle = widget(ctx.ui.mountButton(slot, {
      label, size: 'sm', variant: 'outline', ...options,
      onClick: async () => {
        if (pending || signal.aborted) return;
        pending = true;
        handle.update({ disabled: true });
        try { await action(); }
        finally { pending = false; if (!signal.aborted) handle.update({ disabled: false }); }
      },
    }, { signal }), signal);
    return handle;
  };
  const markdown = (parent, content, signal) => {
    const slot = el('div', 'sn-markdown');
    parent.append(slot);
    return widget(ctx.ui.mountMarkdown(slot, { text: content || '' }, { signal }), signal);
  };
  const mutate = async (operation, input, signal) => {
    const result = await ctx.call(operation, input);
    if (signal?.aborted) return result;
    await loadState();
    return result;
  };
  const relativeTime = value => {
    if (!value) return '';
    const delta = Date.now() - Date.parse(value);
    if (!Number.isFinite(delta)) return '';
    const minutes = Math.round(delta / 60000);
    if (minutes < 1) return 'just now';
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.round(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    return `${Math.round(hours / 24)}d ago`;
  };

  /** Menu to append one or many captured blocks to an existing note or a new one. */
  async function addBlocksFlow(anchor, blocks, signal, session = {}, options = {}) {
    const picked = (Array.isArray(blocks) ? blocks : [blocks]).filter(Boolean);
    if (signal.aborted || !picked.length) return;
    const count = picked.length;
    const single = options.single && count === 1;
    const noun = count === 1 ? 'block' : 'blocks';
    try {
      if (!snapshot) await loadState();
      const notes = [...(snapshot?.notes || [])].sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
      const items = notes.slice(0, 12).map(note => ({
        key: `note:${note.id}`,
        label: single ? `Add to ${note.title || 'Untitled note'}` : `Add ${count} ${noun} to ${note.title || 'Untitled note'}`,
        onSelect: async () => {
          try {
            if (single) await mutate('add-block', { id: note.id, block: picked[0] }, signal);
            else await mutate('add-blocks', { id: note.id, blocks: picked }, signal);
            options.onSaved?.(count, note.title || 'note');
            options.onDone?.();
          } catch (error) {
            options.onError?.(message(error));
          }
        },
      }));
      const typeTitle = { table: 'Table note', diagram: 'Diagram note', code: 'Code note' }[picked[0]?.type] || 'Session note';
      items.push({
        key: 'new',
        label: single ? 'New note with this' : `New note with ${count} ${noun}`,
        onSelect: async () => {
          try {
            await mutate('create-note', {
              title: single ? typeTitle : `Session — ${session.sessionTitle || 'Untitled'}`,
              text: '', sessionId: session.sessionId || '', sessionTitle: session.sessionTitle || '',
              kind: session.kind || 'teaching', blocks: picked,
            }, signal);
            options.onSaved?.(count, single ? typeTitle : 'new note');
            options.onDone?.();
          } catch (error) {
            options.onError?.(message(error));
          }
        },
      });
      if (!signal.aborted) ctx.ui.openMenu(anchor, { label: 'Add to note', items }, { signal });
    } catch (error) {
      if (!signal.aborted) {
        console.error('[session-notes] add to note failed:', message(error));
        options.onError?.(message(error));
      }
    }
  }

  const addToNoteFlow = (anchor, block, signal, session = {}) =>
    addBlocksFlow(anchor, [block], signal, session, { single: true });

  /** Full transcript view: mirrors the session with host Markdown for selection capture.
   * Kept as an opt-in because rendering every message is expensive in long sessions. */
  function openFullSessionOverlay(context) {
    if (context?.surface !== 'session' || ctx.signal.aborted) return;
    const session = {
      sessionId: context.sessionId || '', sessionTitle: context.view?.title || context.sessionId || '',
      kind: context.view?.kind || 'teaching',
    };
    const sources = sourceStrings(context.view);
    const blocks = blocksFromView(context.view);
    const scope = lifetime(ctx.signal);

    /** Mount a small note icon that adds a captured block via the shared menu. */
    function noteIcon(parent, block, signal, label) {
      const slot = el('span', 'sn-capture-icon');
      parent.append(slot);
      return widget(ctx.ui.mountButton(slot, {
        label, icon: addNoteIcon, iconOnly: true, size: 'icon-sm', variant: 'ghost', title: label,
        onClick: () => addToNoteFlow(slot, block, signal, session),
      }, { signal }), signal);
    }

    /** Put an icon beside every table/diagram/code element the host actually renders.
     * We never move host-rendered nodes: React owns them. Icons are absolutely
     * positioned siblings, recomputed as async diagrams finish rendering. */
    function decorateCaptures(slot, source, signal) {
      const icons = new Map();
      const place = () => {
        const slotRect = slot.getBoundingClientRect();
        for (const [node, icon] of icons) {
          if (!node.isConnected) { icon.remove(); icons.delete(node); continue; }
          const rect = node.getBoundingClientRect();
          icon.style.top = `${Math.max(0, rect.top - slotRect.top + 2)}px`;
        }
      };
      const scan = () => {
        if (signal.aborted) return;
        if (slot.style.position !== 'relative') {
          slot.style.position = 'relative';
          slot.style.paddingLeft = '2.1rem';
        }
        const nodes = topLevelCaptures(slot);
        for (const node of nodes) {
          if (icons.has(node)) continue;
          const block = captureFromElement(node, source, nodes);
          if (!block?.markdown) continue;
          const icon = el('button', 'sn-inline-note-icon');
          icon.type = 'button';
          icon.title = `Add ${block.caption} to note`;
          icon.setAttribute('aria-label', icon.title);
          icon.innerHTML = addNoteIcon;
          icon.addEventListener('click', event => {
            event.stopPropagation();
            void addToNoteFlow(icon, block, signal, session);
          }, { signal });
          slot.append(icon);
          icons.set(node, icon);
        }
        place();
        globalThis.requestAnimationFrame?.(place);
      };
      scan();
      if (typeof MutationObserver !== 'undefined') {
        const observer = new MutationObserver(scan);
        observer.observe(slot, { childList: true, subtree: true, attributes: true, attributeFilter: ['src', 'class', 'data-testid'] });
        signal.addEventListener('abort', () => observer.disconnect(), { once: true });
      }
      globalThis.addEventListener?.('resize', place, { signal });
    }

    const props = {
      title: 'Add to notes',
      background: 'opaque',
      content: (container, hostSignal) => {
        const signal = lifetime(scope.signal, hostSignal).signal;
        const root = el('div', 'sn-overlay');
        container.append(root);
        const head = el('div', 'sn-overlay-head');
        head.append(el('h2', 'sn-title', `Add to notes — ${session.sessionTitle || 'Session'}`));
        head.append(el('span', 'sn-hint', sources.length
          ? 'Select text here, then right-click → Add to note (or use “Add selection to note” above). Every table and diagram has its own note icon on its left.'
          : 'No capturable content was found in this session.'));
        button(head, 'Save whole session', async () => {
          await mutate('create-note', {
            title: `Session — ${session.sessionTitle || 'Untitled'}`,
            text: '', sessionId: session.sessionId, sessionTitle: session.sessionTitle,
            kind: context.view?.kind === 'practice' ? 'practice' : 'teaching', blocks,
          }, signal);
        }, signal);

        // Always-available fallback for selection capture if a right-click is intercepted.
        let lastSelection = '';
        const selectionButton = button(head, 'Add selection to note', async () => {
          const selected = readSelection(root, root) || lastSelection;
          if (!selected) return;
          await addToNoteFlow(head, { type: 'text', markdown: selected, caption: 'Selected text' }, signal, session);
        }, signal, { disabled: true });
        root.append(head);

        const scroll = el('div', 'sn-overlay-scroll');
        root.append(scroll);
        for (const [index, source] of sources.entries()) {
          const row = el('div', 'sn-source-row');
          const sourceHead = el('div', 'sn-source-head');
          sourceHead.append(el('span', 'sn-capture-kind', `Message ${index + 1}`));
          row.append(sourceHead);
          const body = el('div', 'sn-capture-body');
          markdown(body, source, signal);
          row.append(body);
          scroll.append(row);
          noteIcon(sourceHead, { type: 'text', markdown: source.slice(0, 12000), caption: 'Message' }, signal, `Add message ${index + 1} to note`);
          decorateCaptures(body, source, signal);
        }

        const rememberSelection = () => {
          if (signal.aborted) return;
          const selected = readSelection(root, root);
          if (selected) lastSelection = selected;
          selectionButton.update({ disabled: !selected });
        };
        document.addEventListener('mouseup', rememberSelection, { capture: true, signal });
        document.addEventListener('keyup', rememberSelection, { capture: true, signal });
        document.addEventListener('selectionchange', rememberSelection, { signal });

        // Capture-phase listener so the host's own handlers cannot swallow the event.
        document.addEventListener('contextmenu', event => {
          if (signal.aborted) return;
          const path = event.composedPath?.() ?? [];
          if (!path.includes(root) && !root.contains(event.target)) return;
          const selected = readSelection(event.target, root) || lastSelection;
          if (!selected) return; // leave the native menu alone unless text is selected
          event.preventDefault();
          event.stopPropagation();
          const anchor = path.find(node => node instanceof HTMLElement && root.contains(node))
            || (event.target instanceof HTMLElement ? event.target : root);
          void addToNoteFlow(anchor, { type: 'text', markdown: selected, caption: 'Selected text' }, signal, session);
        }, { capture: true, signal });
      },
    };
    const options = { signal: ctx.signal };
    if (context.surfaceTarget) ctx.ui.openSurface(context.surfaceTarget, props, options);
    else ctx.ui.openSurface(props, options);
    void ensureCatalog();
  }

  /** Screenshot-style region picker: auto-detect transcript elements, then click
   * a highlighted region or drag across several to add them to a note. */
  function openSessionOverlay(context) {
    if (context?.surface !== 'session' || ctx.signal.aborted) return;
    const session = {
      sessionId: context.sessionId || '', sessionTitle: context.view?.title || context.sessionId || '',
      kind: context.view?.kind || 'teaching',
    };
    const mermaidSources = diagramSources(context.view);
    const scope = lifetime(ctx.signal);
    const props = {
      title: 'Add to notes',
      background: 'dimmed',
      content: (container, hostSignal) => {
        const signal = lifetime(scope.signal, hostSignal).signal;
        // The host's surface frame is 80% opaque and blurred. Opt this overlay out
        // so the live transcript underneath stays visible for region selection.
        container.closest?.('[data-plugin-session-surface-frame]')?.setAttribute('data-sn-transparent', '1');
        const root = el('div', 'sn-region-picker');
        container.append(root);
        const head = el('div', 'sn-region-head');
        head.append(el('h2', 'sn-title', `Add to notes — ${session.sessionTitle || 'Session'}`));
        head.append(el('span', 'sn-hint', 'Click a region or drag across several. Text is transcribed, tables are rebuilt, diagrams keep their Mermaid source.'));
        head.append(el('span', 'sn-spacer'));
        const refresh = el('button', 'sn-pick-action', 'Refresh');
        refresh.type = 'button';
        const selectAll = el('button', 'sn-pick-action', 'Select all');
        selectAll.type = 'button';
        const clear = el('button', 'sn-pick-action', 'Clear');
        clear.type = 'button';
        const pick = el('button', 'sn-pick-action', 'Pick element');
        pick.type = 'button';
        pick.title = 'Click any element in the transcript to add it to the selection';
        const addSlot = el('span', 'sn-button-slot');
        head.append(refresh, selectAll, clear, pick, addSlot);
        root.append(head);
        const status = el('div', 'sn-region-status', 'Detecting regions…');
        root.append(status);
        const debug = el('div', 'sn-region-debug', '');
        root.append(debug);
        const canvas = el('div', 'sn-region-canvas');
        const dragBox = el('div', 'sn-region-drag');
        dragBox.hidden = true;
        canvas.append(dragBox);
        root.append(canvas);

        let regions = [], boxes = new Map(), selected = new Set(), layoutQueued = false, dragMoved = false;
        let start = null, canvasBase = null, lastDragRect = null;
        let rawHits = 0, clickCount = 0, scopeLabel = '?', detectError = '', notice = '';

        const setSelected = (region, on) => {
          if (on) selected.add(region);
          else selected.delete(region);
          boxes.get(region)?.classList.toggle('is-selected', on);
        };
        const updateStatus = () => {
          status.textContent = `v0.1.10 · ${selected.size} of ${regions.length} regions selected — click a box or drag over the transcript.`;
          const logHint = logPath ? ` · log=${logPath.split('/').pop()}` : '';
          debug.textContent = `debug · scope=${scopeLabel} found=${rawHits} clicks=${clickCount}`
            + (detectError ? ` · error: ${detectError}` : '')
            + (notice ? ` · ${notice}` : '')
            + logHint;
          addHandle.update({ disabled: !selected.size });
        };
        const layout = () => {
          layoutQueued = false;
          if (signal.aborted) return;
          canvasBase = canvas.getBoundingClientRect();
          for (const [region, box] of boxes) {
            if (!region.node.isConnected) { box.remove(); boxes.delete(region); selected.delete(region); continue; }
            const rect = region.node.getBoundingClientRect();
            region.rect = {
              left: rect.left - canvasBase.left, top: rect.top - canvasBase.top,
              right: rect.right - canvasBase.left, bottom: rect.bottom - canvasBase.top,
            };
            box.style.left = `${region.rect.left}px`;
            box.style.top = `${region.rect.top}px`;
            box.style.width = `${Math.max(0, region.rect.right - region.rect.left)}px`;
            box.style.height = `${Math.max(0, region.rect.bottom - region.rect.top)}px`;
            box.hidden = !region.rect.right || !region.rect.bottom;
          }
          updateStatus();
        };
        const queueLayout = () => {
          if (layoutQueued || signal.aborted) return;
          layoutQueued = true;
          globalThis.requestAnimationFrame?.(layout);
        };
        /** Find real transcript elements under the overlay by temporarily making
         * the surface transparent to hit-testing. Works even if host selectors change. */
        const hitTestRegions = roots => {
          const frame = canvas.closest('[data-plugin-session-surface-frame]');
          const base = canvas.getBoundingClientRect();
          const oldFrame = frame?.style.pointerEvents;
          const oldCanvas = canvas.style.pointerEvents;
          const found = new Set();
          try {
            if (frame) frame.style.pointerEvents = 'none';
            canvas.style.pointerEvents = 'none';
            for (let y = base.top + 4; y < base.bottom - 4; y += 28) {
              for (let x = base.left + 4; x < base.right - 4; x += 56) {
                let node = document.elementFromPoint?.(x, y);
                let matched = null;
                let probe = node;
                while (probe) {
                  if (probe.matches?.(REGION_SELECTOR)) { matched = probe; break; }
                  probe = probe.parentElement;
                }
                // Fallback: prefer the smallest real content block at this point.
                if (!matched && node) {
                  const preferred = preferRegionNode(node, { clientX: x, clientY: y });
                  if (preferred && roots.some(root => root === preferred || root.contains(preferred))) matched = preferred;
                }
                if (matched && roots.some(root => root === matched || root.contains(matched))) found.add(matched);
              }
            }
          } catch (error) {
            detectError = String(error?.message || error);
          } finally {
            if (frame) frame.style.pointerEvents = oldFrame;
            canvas.style.pointerEvents = oldCanvas;
          }
          return [...found];
        };

        const addBox = region => {
          if (boxes.has(region)) return;
          const box = el('button', `sn-region-box sn-region-${region.type}`);
          box.type = 'button';
          box.title = `${region.label} — click to select, or drag across regions`;
          box.setAttribute('aria-label', box.title);
          box.append(el('span', 'sn-region-tag', region.label));
          // Native click is the most reliable selection path.
          box.addEventListener('click', event => {
            event.stopPropagation();
            clickCount += 1;
            const on = !selected.has(region);
            setSelected(region, on);
            logEvent('region-click', { on, type: region.type, label: region.label, tag: region.node?.tagName?.toLowerCase?.() || '', preview: cleanNodeText(region.node).slice(0, 120) });
            updateStatus();
          }, { signal });
          canvas.append(box);
          boxes.set(region, box);
        };

        const detect = () => {
          if (signal.aborted) return;
          selected = new Set();
          clickCount = 0;
          detectError = '';
          for (const box of boxes.values()) box.remove();
          boxes = new Map();
          // The main transcript is usually [role="log"] with one or more
          // [data-session-find-root] descendants. Some sessions expose question
          // docks or alternate layouts, so include every plausible root.
          const log = document.querySelector('[role="log"]');
          const allFindRoots = [...document.querySelectorAll('[data-session-find-root]')];
          const logRoots = log ? allFindRoots.filter(root => log.contains(root)) : [];
          const bodyRoot = document.querySelector('[data-session-body]');
          let roots = [];
          if (logRoots.length) roots.push(...logRoots);
          else if (log) roots.push(log);
          for (const root of allFindRoots) if (!roots.includes(root)) roots.push(root);
          if (bodyRoot && !roots.includes(bodyRoot)) roots.push(bodyRoot);
          scopeLabel = roots.length
            ? `${log ? 'log' : 'doc'}/roots×${roots.length}`
            : 'no-transcript';
          const selectorNodes = [];
          for (const root of roots) selectorNodes.push(...root.querySelectorAll(REGION_SELECTOR));
          let hitNodes = [];
          try {
            hitNodes = hitTestRegions(roots);
          } catch (error) {
            detectError = String(error?.message || error);
            logEvent('hit-test-error', { message: detectError }, 'error');
          }
          rawHits = new Set([...selectorNodes, ...hitNodes]).size;
          regions = findRegions(...roots, hitNodes);
          for (const region of regions) addBox(region);
          layout();
          logEvent('detect', {
            sessionId: session.sessionId, scope: scopeLabel, roots: roots.length,
            selectorNodes: selectorNodes.length, hitNodes: hitNodes.length, rawHits, regions: regions.length,
            sample: regions.slice(0, 8).map(r => ({ type: r.type, label: r.label, tag: r.node?.tagName?.toLowerCase?.() || '', text: cleanNodeText(r.node).slice(0, 80) })),
          });
          // The frame can still be sizing when content mounts. Always re-layout,
          // even when regions were found, because boxes may be positioned wrongly.
          globalThis.requestAnimationFrame?.(queueLayout);
          globalThis.setTimeout?.(() => { if (!signal.aborted) { layout(); if (!regions.length) detect(); } }, 350);
        };

        const addHandle = widget(ctx.ui.mountButton(addSlot, {
          label: 'Add selected to notes', size: 'sm', variant: 'outline', disabled: true,
          onClick: async () => {
            notice = '';
            const prepared = [...selected].map(region => ({ region, block: regionToBlock(region, mermaidSources) }));
            const chosen = prepared.map(item => item.block).filter(block => block.markdown && block.markdown.trim());
            logEvent('add-click', {
              selected: selected.size, prepared: prepared.length, chosen: chosen.length,
              blocks: prepared.map(({ region, block }) => ({
                type: region.type, label: region.label, ok: !!(block.markdown && block.markdown.trim()),
                len: String(block.markdown || '').length, preview: String(block.markdown || '').slice(0, 120),
              })),
            });
            if (signal.aborted) return;
            if (!chosen.length) {
              notice = 'nothing capturable in selection (empty text)';
              updateStatus();
              return;
            }
            notice = `prepared ${chosen.length} block(s)… choose a note`;
            updateStatus();
            await addBlocksFlow(addSlot, chosen, signal, session, {
              onSaved: (count, title) => {
                notice = `saved ${count} block(s) to ${title}`;
                logEvent('add-saved', { count, title });
                updateStatus();
              },
              onError: err => {
                notice = `save failed: ${err}`;
                logEvent('add-error', { message: String(err) }, 'error');
                updateStatus();
              },
              onDone: () => {
                for (const region of selected) boxes.get(region)?.classList.remove('is-selected');
                selected = new Set();
                updateStatus();
              },
            });
          },
        }, { signal }), signal);

        // Drag is compared in viewport coordinates against live element rects:
        // canvas-relative coordinates drift when the transcript scrolls.
        canvas.addEventListener('pointerdown', event => {
          if (signal.aborted || event.target.closest?.('.sn-region-box')) return;
          event.preventDefault();
          canvasBase = canvas.getBoundingClientRect();
          start = { x: event.clientX, y: event.clientY };
          dragMoved = false;
          lastDragRect = null;
        }, { signal });
        document.addEventListener('pointermove', event => {
          if (!start || signal.aborted) return;
          const current = { x: event.clientX, y: event.clientY };
          if (Math.abs(current.x - start.x) + Math.abs(current.y - start.y) > 5) dragMoved = true;
          if (!dragMoved) return;
          const rect = {
            left: Math.min(start.x, current.x), right: Math.max(start.x, current.x),
            top: Math.min(start.y, current.y), bottom: Math.max(start.y, current.y),
          };
          lastDragRect = { ...rect };
          const local = {
            left: rect.left - canvasBase.left, top: rect.top - canvasBase.top,
            right: rect.right - canvasBase.left, bottom: rect.bottom - canvasBase.top,
          };
          dragBox.hidden = false;
          dragBox.style.left = `${local.left}px`;
          dragBox.style.top = `${local.top}px`;
          dragBox.style.width = `${local.right - local.left}px`;
          dragBox.style.height = `${local.bottom - local.top}px`;
          for (const [region, box] of boxes) {
            const nodeRect = region.node.getBoundingClientRect?.();
            if (nodeRect && rectsOverlap(nodeRect, rect)) {
              setSelected(region, true);
              box.classList.add('is-drag');
            } else box.classList.remove('is-drag');
          }
          updateStatus();
        }, { signal });
        const finishDrag = () => {
          if (!start) return;
          if (dragMoved) logEvent('drag-select', {
            selected: selected.size, regions: regions.length,
            rect: lastDragRect, scrollTop: document.querySelector('[role="log"] > div')?.scrollTop ?? null,
          });
          for (const box of boxes.values()) box.classList.remove('is-drag');
          dragBox.hidden = true;
          dragBox.style.width = '0px';
          dragBox.style.height = '0px';
          start = null;
          updateStatus();
        };
        document.addEventListener('pointerup', finishDrag, { signal });
        document.addEventListener('pointercancel', finishDrag, { signal });

        const scroller = document.querySelector('[role="log"] > div[style*="scrollbar-gutter"]')
          || document.querySelector('[role="log"] > div');
        canvas.addEventListener('wheel', event => {
          if (!scroller) return;
          event.preventDefault();
          scroller.scrollTop += event.deltaY;
          queueLayout();
        }, { signal, passive: false });
        globalThis.addEventListener?.('resize', queueLayout, { signal });
        document.addEventListener('scroll', queueLayout, { capture: true, signal });

        refresh.addEventListener('click', () => { logEvent('refresh-click', {}); detect(); }, { signal });
        selectAll.addEventListener('click', () => {
          for (const region of regions) setSelected(region, true);
          updateStatus();
        }, { signal });
        clear.addEventListener('click', () => {
          for (const region of [...selected]) setSelected(region, false);
          updateStatus();
        }, { signal });

        // Manual fallback: make the surface transparent to clicks so the next
        // click lands on the real transcript element, then register it as a region.
        let pickMode = false;
        const setPickMode = on => {
          const frame = canvas.closest('[data-plugin-session-surface-frame]');
          if (frame) frame.style.pointerEvents = on ? 'none' : '';
          canvas.style.pointerEvents = on ? 'none' : '';
          pickMode = on;
          pick.classList.toggle('is-active', on);
          pick.textContent = on ? 'Click transcript…' : 'Pick element';
          logEvent('pick-mode', { on });
        };
        document.addEventListener('click', event => {
          if (!pickMode || signal.aborted) return;
          event.preventDefault();
          event.stopPropagation();
          if (event.target.closest?.('[data-plugin-session-surface]')) {
            logEvent('pick-cancelled', { reason: 'surface' });
            setPickMode(false);
            return;
          }
          const clicked = event.target;
          let node = clicked;
          while (node && node !== document.body && !node.matches?.(REGION_SELECTOR)) node = node.parentElement;
          if (!node || node === document.body || node.matches?.(WRAPPER_SELECTOR)
              || node.closest?.('[data-plugin-session-surface]')) {
            // Avoid whole-session wrappers: choose the smallest block under the click.
            node = preferRegionNode(clicked, event);
          }
          if (node && node !== document.body && !node.closest?.('[data-plugin-session-surface]')) {
            const region = findRegions([node])[0] || {
              node, type: regionType(node), isImage: false, label: 'Text', diagramIndex: -1,
            };
            if (!boxes.has(region)) { regions.push(region); addBox(region); }
            setSelected(region, true);
            clickCount += 1;
            layout();
            logEvent('pick-selected', { type: region.type, label: region.label, tag: node.tagName?.toLowerCase?.() || '', preview: cleanNodeText(node).slice(0, 120) });
            updateStatus();
          } else {
            logEvent('pick-missed', { tag: clicked?.tagName?.toLowerCase?.() || '' }, 'warn');
          }
          setPickMode(false);
        }, { capture: true, signal });
        document.addEventListener('keydown', event => {
          if (event.key === 'Escape' && pickMode) {
            event.stopPropagation();
            setPickMode(false);
          }
        }, { capture: true, signal });
        pick.addEventListener('click', event => {
          event.stopPropagation();
          setPickMode(!pickMode);
        }, { signal });

        logEvent('overlay-open', { sessionId: session.sessionId, sessionTitle: session.sessionTitle, kind: session.kind, mermaidSources: mermaidSources.length, logPath });
        detect();
      },
    };
    const options = { signal: ctx.signal };
    if (context.surfaceTarget) ctx.ui.openSurface(context.surfaceTarget, props, options);
    else ctx.ui.openSurface(props, options);
    void ensureCatalog();
  }

  /** Sidebar view: grouped notes, search, detail editor, organisation mode. */
  function mountNotesView(container, signal) {
    const scope = lifetime(ctx.signal, signal);
    const viewSignal = scope.signal;
    const root = el('div', 'sn-root');
    container.append(root);
    const error = el('p', 'sn-error');
    error.setAttribute('role', 'alert');
    error.hidden = true;
    const showError = cause => { if (!viewSignal.aborted) { error.hidden = false; error.textContent = message(cause); } };
    const clearError = () => { if (!viewSignal.aborted) { error.hidden = true; error.textContent = ''; } };

    const toolbar = el('div', 'sn-toolbar');
    toolbar.append(el('h2', 'sn-title', 'Session Notes'));
    const newSlot = el('span');
    toolbar.append(newSlot);
    const search = el('input', 'sn-search');
    search.type = 'search';
    search.placeholder = 'Search notes';
    search.setAttribute('aria-label', 'Search notes');
    const org = el('select', 'sn-select');
    org.setAttribute('aria-label', 'Organise notes by');
    for (const [value, label] of [['session', 'By session'], ['topic', 'By topic'], ['node', 'By knowledge node']]) {
      const option = el('option', '', label);
      option.value = value;
      org.append(option);
    }
    org.value = snapshot?.settings?.organization || 'session';
    toolbar.append(el('span', 'sn-spacer'), search, org);
    root.append(toolbar, error);

    const body = el('div', 'sn-body');
    const listPane = el('div', 'sn-list');
    const detailPane = el('div', 'sn-detail');
    body.append(listPane, detailPane);
    root.append(body);
    const empty = el('p', 'sn-empty', 'No notes yet. Use “Add to notes” in a session, or create one above.');
    root.append(empty);

    let organization = org.value, selectedId = null, filtered = null, searchSeq = 0;
    const expandedGroups = new Set();
    let tree;

    const notes = () => [...(filtered ?? snapshot?.notes ?? [])]
      .sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));

    function groupLabels(noteRecord) {
      if (organization === 'session') return [noteRecord.sessionTitle || 'Manual notes'];
      if (organization === 'topic') return noteRecord.topics?.length ? noteRecord.topics : ['Uncategorised'];
      return noteRecord.nodes?.length ? noteRecord.nodes.map(node => node.label || node.id || node) : ['Uncategorised'];
    }
    function renderTree() {
      if (viewSignal.aborted) return;
      const grouped = new Map();
      for (const noteRecord of notes()) {
        for (const label of groupLabels(noteRecord)) {
          if (!grouped.has(label)) grouped.set(label, []);
          grouped.get(label).push(noteRecord);
        }
      }
      const rows = [];
      for (const [label, items] of grouped) {
        const key = `group:${organization}:${label}`;
        const children = items.map(noteRecord => {
          const rowKey = `${key}:note:${noteRecord.id}`;
          return {
            key: rowKey,
            content: (slot, mountSignal) => {
              const row = el('div', 'sn-note-row');
              const trigger = el('button', 'sn-note-label', noteRecord.title || 'Untitled note');
              trigger.type = 'button';
              trigger.title = noteRecord.sessionTitle || noteRecord.title || '';
              trigger.addEventListener('click', () => { selectedId = noteRecord.id; renderDetail(); }, { signal: mountSignal });
              row.append(trigger, el('span', 'sn-note-meta', `${noteRecord.blocks?.length || 0}`));
              slot.append(row);
            },
            cells: { updated: relativeTime(noteRecord.updatedAt) },
          };
        });
        if (expandedGroups.has(key)) rows.push({ key, content: `${label} (${items.length})`, children,
          disclosure: { label: `Toggle ${label}`, expanded: true, onChange() { expandedGroups.delete(key); renderTree(); } } });
        else rows.push({ key, content: `${label} (${items.length})`, children,
          disclosure: { label: `Toggle ${label}`, expanded: false, onChange() { expandedGroups.add(key); renderTree(); } } });
      }
      tree.update({ rows, columns: [{ key: 'updated', header: 'Updated', width: '4.5rem', align: 'right' }] });
      empty.hidden = rows.length > 0;
    }

    function renderDetail() {
      if (viewSignal.aborted) return;
      detailPane.replaceChildren();
      const noteRecord = (snapshot?.notes || []).find(n => n.id === selectedId);
      if (!noteRecord) {
        detailPane.append(el('p', 'sn-empty', 'Select a note to read and edit it, or create a new one.'));
        return;
      }
      const head = el('div', 'sn-detail-head');
      head.append(el('h3', 'sn-title', noteRecord.title || 'Untitled note'));
      button(head, 'Delete', () => {
        const dialog = ctx.ui.openDialog({
          title: 'Delete note',
          content: (host, dialogSignal) => {
            const pane = el('div', 'sn-settings');
            host.append(pane);
            pane.append(el('p', '', `Delete “${noteRecord.title || 'Untitled note'}”? This cannot be undone.`));
            const actions = el('div', 'sn-toolbar');
            pane.append(actions);
            button(actions, 'Cancel', () => dialog.dispose(), dialogSignal);
            button(actions, 'Delete', async () => {
              await mutate('delete-note', { id: noteRecord.id }, dialogSignal);
              selectedId = null;
              dialog.dispose();
              renderTree();
              renderDetail();
            }, dialogSignal, { variant: 'destructive' });
          },
        }, { signal: viewSignal });
      }, viewSignal, { icon: trashIcon, iconOnly: true, variant: 'ghost', title: 'Delete note', size: 'icon-sm' });
      detailPane.append(head);

      const detailError = el('p', 'sn-error');
      detailError.setAttribute('role', 'alert');
      detailError.hidden = true;
      detailPane.append(detailError);
      const report = cause => { if (!viewSignal.aborted) { detailError.hidden = false; detailError.textContent = message(cause); } };

      const titleField = el('label', 'sn-field');
      const titleInput = el('input', 'sn-input');
      titleInput.type = 'text';
      titleInput.value = noteRecord.title || '';
      titleField.append(el('span', 'sn-label', 'Title'), titleInput);
      detailPane.append(titleField);

      if (noteRecord.sessionTitle) {
        const sessionField = el('div', 'sn-field');
        sessionField.append(el('span', 'sn-label', 'From session'), el('span', '', noteRecord.sessionTitle));
        detailPane.append(sessionField);
      }

      const topicField = el('label', 'sn-field');
      const topicInput = el('input', 'sn-input');
      topicInput.type = 'text';
      topicInput.value = (noteRecord.topics || []).join(', ');
      topicInput.setAttribute('list', 'sn-topics-list');
      const datalist = el('datalist');
      datalist.id = 'sn-topics-list';
      for (const topic of catalogCache?.topics || []) {
        const option = el('option');
        option.value = topic.label;
        datalist.append(option);
      }
      topicField.append(el('span', 'sn-label', 'Topics (comma separated)'), topicInput, datalist);
      detailPane.append(topicField);

      let nodeIds = (noteRecord.nodes || []).map(node => node.id || node);
      if (typeof ctx.ui.mountKnowledgePicker === 'function') {
        const nodeField = el('label', 'sn-field');
        nodeField.append(el('span', 'sn-label', 'Knowledge-web nodes'));
        const pickerSlot = el('div');
        nodeField.append(pickerSlot);
        detailPane.append(nodeField);
        const picker = widget(ctx.ui.mountKnowledgePicker(pickerSlot, {
          value: nodeIds,
          onChange: ids => { nodeIds = [...ids]; picker.update({ value: nodeIds }); },
        }, { signal: viewSignal }), viewSignal);
      }

      const textField = el('label', 'sn-field');
      const textArea = el('textarea', 'sn-textarea');
      textArea.value = noteRecord.text || '';
      textArea.placeholder = 'Write your note here…';
      textField.append(el('span', 'sn-label', 'Note'), textArea);
      detailPane.append(textField);

      const actions = el('div', 'sn-toolbar');
      button(actions, 'Save', async () => {
        try {
          const labels = nodeIds.map(id => {
            const fromCatalog = catalogCache?.nodes?.find(node => node.id === id)?.label;
            const existing = (noteRecord.nodes || []).find(node => (node.id || node) === id);
            return fromCatalog || existing?.label || id;
          });
          await mutate('save-note', {
            id: noteRecord.id,
            title: titleInput.value,
            text: textArea.value,
            topics: topicInput.value.split(','),
            nodeIds, nodeLabels: labels,
          }, viewSignal);
          clearError();
        } catch (cause) { report(cause); }
      }, viewSignal, { variant: 'default' });
      detailPane.append(actions);

      if (noteRecord.blocks?.length) {
        const blocks = el('div', 'sn-blocks');
        blocks.append(el('div', 'sn-label', 'Captured blocks'));
        for (const block of noteRecord.blocks) {
          const card = el('div', 'sn-block');
          const cardHead = el('div', 'sn-block-head');
          cardHead.append(el('span', 'sn-block-badge', block.type || 'text'));
          if (block.caption) cardHead.append(el('span', '', block.caption));
          card.append(cardHead);
          markdown(card, block.markdown, viewSignal);
          blocks.append(card);
        }
        detailPane.append(blocks);
      }
    }

    tree = widget(ctx.ui.mountTree(listPane, {
      label: 'Notes',
      header: 'Notes',
      rows: [],
      columns: [{ key: 'updated', header: 'Updated', width: '4.5rem', align: 'right' }],
    }, { signal: viewSignal }), viewSignal);

    button(newSlot, 'New note', async () => {
      try {
        const { note: created } = await mutate('create-note', { title: 'Untitled note', text: '' }, viewSignal);
        selectedId = created.id;
        renderTree();
        renderDetail();
      } catch (cause) { showError(cause); }
    }, viewSignal, { icon: addNoteIcon });

    search.addEventListener('input', async () => {
      const seq = ++searchSeq;
      const query = search.value.trim();
      try {
        if (!query) { filtered = null; renderTree(); return; }
        const result = await ctx.call('search-notes', { query });
        if (seq !== searchSeq || viewSignal.aborted) return;
        filtered = result.notes || [];
        renderTree();
      } catch (cause) { showError(cause); }
    }, { signal: viewSignal });

    org.addEventListener('change', async () => {
      organization = org.value;
      renderTree();
      try { await mutate('save-settings', { patch: { organization } }, viewSignal); clearError(); }
      catch (cause) { showError(cause); }
    }, { signal: viewSignal });

    void ensureCatalog().then(() => { if (!viewSignal.aborted) renderDetail(); });
    observe(value => {
      if (!value) return;
      if (selectedId && !(value.notes || []).some(note => note.id === selectedId)) selectedId = null;
      renderTree();
      renderDetail();
    }, viewSignal);
  }

  /** Settings: default organisation and a guarded destructive reset. */
  function mountSettings(container, signal) {
    const scope = lifetime(ctx.signal, signal);
    const root = el('div', 'sn-settings');
    container.append(root);
    root.append(el('h2', 'sn-title', 'Session Notes'));
    root.append(el('p', 'sn-hint', 'Notes are stored locally by this plugin. Use “Add to notes” from a teaching or practice session to capture text, tables and diagrams through the plugin overlay, then organise them by session, topic or knowledge node.'));

    const orgField = el('label', 'sn-field');
    const org = el('select', 'sn-select');
    for (const [value, label] of [['session', 'By session'], ['topic', 'By topic'], ['node', 'By knowledge node']]) {
      const option = el('option', '', label);
      option.value = value;
      org.append(option);
    }
    org.value = snapshot?.settings?.organization || 'session';
    orgField.append(el('span', 'sn-label', 'Default organisation'), org);
    root.append(orgField);
    const error = el('p', 'sn-error');
    error.setAttribute('role', 'alert');
    error.hidden = true;
    root.append(error);
    org.addEventListener('change', async () => {
      try { await mutate('save-settings', { patch: { organization: org.value } }, scope.signal); error.hidden = true; }
      catch (cause) { error.hidden = false; error.textContent = message(cause); }
    }, { signal: scope.signal });

    const clearSlot = el('span');
    root.append(clearSlot);
    button(clearSlot, 'Clear all notes', () => {
      const dialog = ctx.ui.openDialog({
        title: 'Clear all notes',
        content: (host, dialogSignal) => {
          const pane = el('div', 'sn-settings');
          host.append(pane);
          pane.append(el('p', '', 'Delete every stored note? This cannot be undone.'));
          const actions = el('div', 'sn-toolbar');
          pane.append(actions);
          button(actions, 'Cancel', () => dialog.dispose(), dialogSignal);
          button(actions, 'Delete all', async () => {
            await mutate('clear-notes', {}, dialogSignal);
            dialog.dispose();
          }, dialogSignal, { variant: 'destructive' });
        },
      }, { signal: scope.signal });
    }, scope.signal, { variant: 'destructive', icon: trashIcon });
    observe(value => { if (value?.settings?.organization) org.value = value.settings.organization; }, scope.signal);
  }

  registrations.push(ctx.registerView({ id: 'notes', name: 'Notes', mount: mountNotesView }));
  registrations.push(ctx.registerAction({ id: 'open', name: 'Notes', icon: notesIcon, run: () => ctx.app.openView('notes') }));
  registrations.push(ctx.placeAction({ id: 'open-sidebar', actionId: 'open', location: 'sidebar' }));
  registrations.push(ctx.registerAction({
    id: 'add-from-session', name: 'Add to notes', icon: addNoteIcon,
    disabled: context => context.surface !== 'session',
    run: context => openSessionOverlay(context),
  }));
  registrations.push(ctx.placeAction({
    id: 'add-from-session-topbar', actionId: 'add-from-session',
    location: 'top-bar', sessions: ['teaching', 'practice'],
  }));
  registrations.push(ctx.registerSettings(mountSettings));
  registrations.push(ctx.onNotification(event => {
    if ((!event.pluginId || event.pluginId === ctx.manifest.id) && event.topic === 'changed') void refresh();
  }));
  registrations.push(ctx.onResync(() => { catalogCache = null; void ensureCatalog(); void refresh(); }));
  registrations.push(ctx.onAppEvent(event => {
    if (['chats-changed', 'activity-changed', 'sources-changed'].includes(event.type)) {
      catalogCache = null;
      void ensureCatalog();
      void refresh();
    }
  }));

  ctx.cleanup(() => {
    for (const registration of registrations) {
      try { if (typeof registration === 'function') registration(); else registration?.dispose?.(); }
      catch { /* cleanup is best effort */ }
    }
  });
  void ensureCatalog();
  void loadState().catch(() => {});
}
