'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { activate, normalizeBlock, noteMatches } = require('../src/backend.cjs');

function harness() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-notes-backend-'));
  const handlers = new Map();
  const emitted = [];
  const sessions = [{ id: 's1', title: 'Quadratics' }, { id: 's2', title: 'Thermodynamics' }];
  const graph = {
    propositions: [{ id: 'n1', name: 'Vertex form', statement: 'y = a(x-h)^2 + k' }],
    clusters: [{ id: 'c1', label: 'Algebra', members: ['n1'] }],
    chains: [], sessions: { s1: 'Quadratics', s2: 'Thermodynamics' },
  };
  const ctx = {
    dataDirectory: dir,
    manifest: { id: 'session-notes' },
    signal: new AbortController().signal,
    handle(name, handler) { handlers.set(name, handler); },
    events: { emit(topic) { emitted.push(topic); } },
    cleanup(dispose) { this.disposeHook = dispose; },
    learning: {
      listSessions: () => sessions,
      getSession: id => sessions.find(row => row.id === id) ?? null,
      graph: () => graph,
    },
  };
  activate(ctx);
  return { ctx, handlers, emitted, call: (name, input) => handlers.get(name)(input) };
}

test('activate registers every documented operation', () => {
  const { handlers } = harness();
  for (const name of ['get-state', 'get-catalog', 'get-note', 'create-note', 'save-note', 'add-block', 'add-blocks', 'delete-note', 'search-notes', 'save-settings', 'clear-notes']) {
    assert.equal(typeof handlers.get(name), 'function', `missing ${name}`);
  }
});

test('get-catalog exposes sessions, knowledge nodes and topic clusters', () => {
  const { call } = harness();
  const catalog = call('get-catalog');
  assert.deepEqual(catalog.sessions, [{ id: 's1', title: 'Quadratics' }, { id: 's2', title: 'Thermodynamics' }]);
  assert.deepEqual(catalog.nodes, [{ id: 'n1', label: 'Vertex form', statement: 'y = a(x-h)^2 + k' }]);
  assert.deepEqual(catalog.topics, [{ id: 'c1', label: 'Algebra', nodes: 1 }]);
});

test('create-note resolves the session title and normalizes blocks', () => {
  const { call, emitted } = harness();
  const { note } = call('create-note', {
    title: 'Exam recap', sessionId: 's1', nodeIds: ['n1'],
    topics: ['Algebra', 'Algebra', ''],
    blocks: [{ type: 'table', markdown: '| a | b |\n|---|---|\n| 1 | 2 |', caption: 'Marks' }],
  });
  assert.match(note.id, /^[0-9a-f-]{36}$/);
  assert.equal(note.sessionTitle, 'Quadratics');
  assert.equal(note.kind, 'manual');
  assert.deepEqual(note.topics, ['Algebra']);
  assert.deepEqual(note.nodes, [{ id: 'n1', label: 'Vertex form' }]);
  assert.equal(note.blocks.length, 1);
  assert.equal(note.blocks[0].type, 'table');
  assert.equal(note.blocks[0].caption, 'Marks');
  assert.ok(note.blocks[0].addedAt);
  assert.ok(emitted.includes('changed'));
  assert.equal(call('get-note', { id: note.id }).note.title, 'Exam recap');
});

test('add-block appends a captured block and emits a change', () => {
  const { call, emitted } = harness();
  const { note } = call('create-note', { title: 'Diagrams' });
  const before = emitted.length;
  const updated = call('add-block', { id: note.id, block: { type: 'diagram', markdown: '```mermaid\ngraph TD; A-->B\n```' } }).note;
  assert.equal(updated.blocks.length, 1);
  assert.equal(updated.blocks[0].type, 'diagram');
  assert.ok(emitted.length > before);
  assert.equal(call('get-note', { id: note.id }).note.blocks.length, 1);
});

test('add-blocks appends several blocks in one change and validates input', () => {
  const { call, emitted } = harness();
  const { note } = call('create-note', { title: 'Batch' });
  const before = emitted.length;
  const updated = call('add-blocks', {
    id: note.id,
    blocks: [
      { type: 'table', markdown: '| a | b |\n|---|---|' },
      { type: 'diagram', markdown: '```mermaid\ngraph LR; A-->B\n```' },
    ],
  }).note;
  assert.deepEqual(updated.blocks.map(block => block.type), ['table', 'diagram']);
  assert.equal(call('get-note', { id: note.id }).note.blocks.length, 2);
  assert.equal(emitted.length, before + 1);
  assert.throws(() => call('add-blocks', { id: note.id, blocks: [] }), /At least one block/);
});

test('save-note updates allowed fields and rejects unknown fields', () => {
  const { call } = harness();
  const { note } = call('create-note', { title: 'Old', text: 'body' });
  const saved = call('save-note', { id: note.id, title: 'New', text: 'updated', topics: ['X'], nodeIds: ['n1'] }).note;
  assert.equal(saved.title, 'New');
  assert.equal(saved.text, 'updated');
  assert.deepEqual(saved.topics, ['X']);
  assert.deepEqual(saved.nodes, [{ id: 'n1', label: 'Vertex form' }]);
  assert.throws(() => call('save-note', { id: note.id, blocks: [] }), /Unsupported note field/);
  assert.throws(() => call('save-note', { id: 'missing', title: 'x' }), /Note not found/);
});

test('search-notes matches titles, text, topics and captured blocks', () => {
  const { call } = harness();
  call('create-note', { title: 'Alpha', text: 'unique body text' });
  call('create-note', { title: 'Beta', topics: ['Algebra'], blocks: [{ type: 'table', markdown: '| unique | table |' }] });
  call('create-note', { title: 'Gamma', text: 'nothing relevant' });
  assert.equal(call('search-notes', { query: '' }).notes.length, 3);
  assert.deepEqual(call('search-notes', { query: 'alpha' }).notes.map(n => n.title), ['Alpha']);
  assert.deepEqual(call('search-notes', { query: 'unique' }).notes.map(n => n.title).sort(), ['Alpha', 'Beta']);
  assert.deepEqual(call('search-notes', { query: 'algebra' }).notes.map(n => n.title), ['Beta']);
  assert.equal(call('search-notes', { query: 'missing term' }).notes.length, 0);
});

test('settings and destructive operations are validated', () => {
  const { call } = harness();
  assert.deepEqual(call('save-settings', { patch: { organization: 'topic' } }).settings, { organization: 'topic' });
  assert.throws(() => call('save-settings', { patch: { organization: 'nope' } }), /Invalid organization/);
  assert.equal(call('get-state').settings.organization, 'topic');
  call('create-note', { title: 'to delete' });
  assert.equal(call('get-state').notes.length, 1);
  assert.equal(call('clear-notes').ok, true);
  assert.equal(call('get-state').notes.length, 0);
});

test('normalizeBlock and noteMatches enforce input contracts', () => {
  assert.throws(() => normalizeBlock({ type: 'table', markdown: '   ' }), /must not be empty/);
  assert.equal(normalizeBlock({ type: 'unknown', markdown: 'hello' }).type, 'text');
  assert.equal(noteMatches({ title: 'A', text: 'b' }, 'a b'), true);
  assert.equal(noteMatches({ title: 'A', text: 'b' }, 'a z'), false);
});
