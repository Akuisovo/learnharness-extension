'use strict';
const { randomUUID } = require('node:crypto');
const { openStore } = require('./store.cjs');

const ORGANIZATIONS = new Set(['session', 'topic', 'node']);
const BLOCK_TYPES = new Set(['text', 'table', 'diagram', 'code']);
const fail = message => { throw new Error(message); };
const stamp = () => new Date().toISOString();
const text = (value, label, max = 20000) => {
  if (typeof value !== 'string') fail(`${label} must be a string.`);
  if (value.length > max) fail(`${label} is too long (maximum ${max} characters).`);
  return value;
};
const short = (value, label, max = 300) => text(value, label, max).trim();
const stringList = (value, label, max = 40) => {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) fail(`${label} must be an array.`);
  return [...new Set(value.map(item => short(item, label)).filter(Boolean))].slice(0, max);
};

/** Normalize a captured block (text, table, diagram, code) for durable storage. */
function normalizeBlock(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('Invalid block.');
  const type = BLOCK_TYPES.has(input.type) ? input.type : 'text';
  const markdown = text(input.markdown, 'Block content', 40000);
  if (!markdown.trim()) fail('Block content must not be empty.');
  return {
    id: randomUUID(),
    type,
    markdown,
    caption: short(input.caption ?? '', 'Block caption', 500),
    addedAt: stamp(),
  };
}

/** Case-insensitive search across note fields and captured blocks. */
function noteMatches(note, query) {
  if (!query) return true;
  const haystack = [
    note.title, note.text, note.kind, note.sessionTitle,
    ...(note.topics ?? []), ...(note.nodes ?? []).map(node => node.label ?? node.id ?? node),
    ...(note.blocks ?? []).flatMap(block => [block.caption, block.markdown]),
  ].filter(Boolean).join('\n').toLocaleLowerCase();
  return query.toLocaleLowerCase().split(/\s+/).filter(Boolean).every(term => haystack.includes(term));
}

function activate(ctx) {
  if (typeof ctx.handle !== 'function' || !ctx.learning?.graph || !ctx.learning?.listSessions ||
      !ctx.learning?.getSession || !ctx.events?.emit || typeof ctx.dataDirectory !== 'string') {
    fail('This app build does not provide the plugin capabilities required by Notes.');
  }
  const store = openStore(ctx.dataDirectory);
  let disposed = false;
  const alive = () => { if (disposed || ctx.signal?.aborted) fail('Notes is disabled.'); };
  const notify = (topic = 'changed') => { if (!disposed && !ctx.signal?.aborted) ctx.events.emit(topic); };
  const change = update => { alive(); const result = store.change(update); notify(); return result; };

  /** Fresh, read-only view of native sessions and the knowledge web. */
  function catalog() {
    alive();
    let sessions = [];
    let nodes = [];
    let topics = [];
    try {
      sessions = (ctx.learning.listSessions() ?? []).map(row => ({ id: row.id, title: row.title || 'Untitled session' }));
    } catch { /* learning data may be unavailable; keep an empty catalog */ }
    try {
      const graph = ctx.learning.graph() ?? {};
      nodes = (Array.isArray(graph.propositions) ? graph.propositions : []).map(node => ({
        id: node.id, label: node.name || node.statement || node.id, statement: node.statement || '',
      }));
      topics = (Array.isArray(graph.clusters) ? graph.clusters : [])
        .map(cluster => ({ id: cluster.id, label: cluster.label || cluster.id, nodes: (cluster.members || []).length }))
        .filter(topic => topic.label);
    } catch { /* knowledge graph may be empty */ }
    return { sessions, nodes, topics };
  }

  const note = (s, id) => {
    if (typeof id !== 'string' || !Object.hasOwn(s.notes, id)) fail('Note not found.');
    return s.notes[id];
  };

  function resolveNodeList(ids, labels = []) {
    const resolved = [];
    const known = new Map(catalog().nodes.map(node => [node.id, node.label]));
    for (let index = 0; index < ids.length; index++) {
      const id = ids[index];
      resolved.push({ id, label: short(String(labels[index] ?? known.get(id) ?? id), 'Node label') });
    }
    return resolved;
  }

  function register(name, handler) {
    ctx.handle(name, input => {
      alive();
      if (input !== undefined && (!input || typeof input !== 'object' || Array.isArray(input))) fail('Invalid operation input.');
      return handler(input ?? {});
    });
  }

  register('get-state', () => {
    const s = store.get();
    return { revision: s.revision, settings: { ...s.settings }, notes: Object.values(s.notes) };
  });
  register('get-catalog', () => catalog());
  register('get-note', input => ({ note: note(store.get(), input.id) }));

  register('create-note', input => {
    const s = store.get();
    const title = short(input.title ?? '', 'Title', 300) || 'Untitled note';
    const sessionId = typeof input.sessionId === 'string' ? input.sessionId : '';
    let sessionTitle = short(input.sessionTitle ?? '', 'Session title', 300);
    if (sessionId && !sessionTitle) {
      try { sessionTitle = catalog().sessions.find(row => row.id === sessionId)?.title ?? sessionId; }
      catch { sessionTitle = sessionId; }
    }
    const nodeIds = stringList(input.nodeIds, 'Node ids', 40);
    const nodeLabels = Array.isArray(input.nodeLabels) ? input.nodeLabels : [];
    const created = {
      id: randomUUID(),
      title,
      text: text(input.text ?? '', 'Note text', 40000),
      createdAt: stamp(),
      updatedAt: stamp(),
      kind: input.kind === 'practice' || input.kind === 'teaching' ? input.kind : 'manual',
      sessionId,
      sessionTitle,
      topics: stringList(input.topics, 'Topics'),
      nodes: resolveNodeList(nodeIds, nodeLabels),
      tags: stringList(input.tags, 'Tags'),
      blocks: (Array.isArray(input.blocks) ? input.blocks : []).slice(0, 200).map(normalizeBlock),
    };
    return { note: change(state => { state.notes[created.id] = created; return created; }) };
  });

  register('save-note', input => {
    const id = input.id;
    const allowed = new Set(['title', 'text', 'topics', 'topicsText', 'nodeIds', 'nodeLabels', 'tags', 'sessionId', 'sessionTitle', 'kind']);
    for (const key of Object.keys(input)) if (!allowed.has(key) && key !== 'id') fail(`Unsupported note field: ${key}`);
    return { note: change(s => {
      const target = note(s, id);
      if (input.title !== undefined) target.title = short(input.title, 'Title', 300) || 'Untitled note';
      if (input.text !== undefined) target.text = text(input.text, 'Note text', 40000);
      if (input.topics !== undefined) target.topics = stringList(input.topics, 'Topics');
      if (input.tags !== undefined) target.tags = stringList(input.tags, 'Tags');
      if (input.nodeIds !== undefined) target.nodes = resolveNodeList(stringList(input.nodeIds, 'Node ids'), Array.isArray(input.nodeLabels) ? input.nodeLabels : []);
      if (input.sessionId !== undefined) target.sessionId = typeof input.sessionId === 'string' ? input.sessionId : '';
      if (input.sessionTitle !== undefined) target.sessionTitle = short(input.sessionTitle, 'Session title', 300);
      if (input.kind !== undefined) target.kind = input.kind === 'practice' || input.kind === 'teaching' ? input.kind : 'manual';
      target.updatedAt = stamp();
      return target;
    }) };
  });

  register('add-block', input => {
    const block = normalizeBlock(input.block);
    return { note: change(s => {
      const target = note(s, input.id);
      target.blocks = target.blocks ?? [];
      if (target.blocks.length >= 200) fail('This note already has the maximum number of blocks (200).');
      target.blocks.push(block);
      target.updatedAt = stamp();
      return target;
    }) };
  });

  /** Append several captured blocks in one atomic change (used by the block picker). */
  register('add-blocks', input => {
    if (!Array.isArray(input.blocks) || !input.blocks.length) fail('At least one block is required.');
    if (input.blocks.length > 200) fail('Too many blocks (maximum 200).');
    const blocks = input.blocks.map(normalizeBlock);
    return { note: change(s => {
      const target = note(s, input.id);
      target.blocks = target.blocks ?? [];
      if (target.blocks.length + blocks.length > 200) fail('This note cannot hold more than 200 blocks.');
      target.blocks.push(...blocks);
      target.updatedAt = stamp();
      return target;
    }) };
  });

  register('delete-note', input => {
    change(s => { note(s, input.id); delete s.notes[input.id]; });
    return { ok: true };
  });

  register('search-notes', input => {
    const query = typeof input.query === 'string' ? input.query.trim() : '';
    return { notes: Object.values(store.get().notes).filter(note => noteMatches(note, query)) };
  });

  register('save-settings', input => {
    const patch = input.patch ?? input;
    return { settings: change(s => {
      if (patch.organization !== undefined) {
        if (!ORGANIZATIONS.has(patch.organization)) fail('Invalid organization mode.');
        s.settings.organization = patch.organization;
      }
      return { ...s.settings };
    }) };
  });

  register('clear-notes', () => {
    change(s => { s.notes = {}; });
    return { ok: true };
  });

  ctx.cleanup(() => { disposed = true; });
}

module.exports = { activate, normalizeBlock, noteMatches };
