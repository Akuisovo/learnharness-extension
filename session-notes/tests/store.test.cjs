'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { openStore, defaults } = require('../src/store.cjs');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'session-notes-store-'));
}

test('openStore creates a valid empty store on first use', () => {
  const dir = tempDir();
  const store = openStore(dir);
  const state = store.get();
  assert.equal(state.version, 1);
  assert.equal(state.revision, 0);
  assert.deepEqual(state.notes, {});
  assert.deepEqual(state.settings, defaults());
  assert.ok(fs.existsSync(path.join(dir, 'notes.json')));
});

test('change clones, persists, and bumps the revision', () => {
  const dir = tempDir();
  const store = openStore(dir);
  const first = store.get();
  const returned = store.change(state => { state.notes.a = { id: 'a', title: 'A' }; return state.notes.a; });
  assert.equal(returned.title, 'A');
  assert.equal(first.notes.a, undefined, 'previous snapshot is not mutated');
  assert.equal(store.get().revision, 1);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'notes.json'), 'utf8')).notes.a.title, 'A');
  store.change(state => { delete state.notes.a; });
  assert.equal(store.get().revision, 2);
  assert.deepEqual(store.get().notes, {});
});

test('openStore rejects unrelated or corrupt JSON without changing it', () => {
  const dir = tempDir();
  const file = path.join(dir, 'notes.json');
  fs.writeFileSync(file, '{"version":9}');
  assert.throws(() => openStore(dir), /Unsupported or invalid Notes data/);
  assert.equal(fs.readFileSync(file, 'utf8'), '{"version":9}');
});

test('reopening a store preserves its data and revision', () => {
  const dir = tempDir();
  const store = openStore(dir);
  store.change(state => { state.notes.x = { id: 'x', title: 'X' }; });
  const reopened = openStore(dir);
  assert.equal(reopened.get().revision, 1);
  assert.equal(reopened.get().notes.x.title, 'X');
});
