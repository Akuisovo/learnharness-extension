'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

/** Write a file atomically with private permissions. Node built-ins only. */
function atomicWrite(file, content) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  let fd;
  try {
    fd = fs.openSync(temporary, 'wx', 0o600);
    fs.writeFileSync(fd, content);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(temporary, file);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    try { fs.unlinkSync(temporary); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

const defaults = () => ({ organization: 'session', sort: 'updated-desc' });
const empty = () => ({ version: 1, revision: 0, notes: {}, settings: defaults() });

/** Open (or create) the plugin-owned JSON store in the host-provided data directory. */
function openStore(directory) {
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, 'notes.json');
  let state;
  try {
    state = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw new Error(`Could not read Notes data: ${error.message}`);
    state = empty();
    atomicWrite(file, JSON.stringify(state));
  }
  if (state.version !== 1 || !Number.isSafeInteger(state.revision) ||
      !state.notes || typeof state.notes !== 'object' || Array.isArray(state.notes) ||
      !state.settings || typeof state.settings !== 'object' || Array.isArray(state.settings)) {
    throw new Error('Unsupported or invalid Notes data. No data was changed.');
  }
  return {
    get: () => state,
    /** Clone, mutate, bump revision, then durably replace. Returns update's result. */
    change(update) {
      const next = structuredClone(state);
      const result = update(next);
      next.revision++;
      atomicWrite(file, JSON.stringify(next));
      state = next;
      return result;
    },
  };
}

module.exports = { openStore, defaults, atomicWrite };
