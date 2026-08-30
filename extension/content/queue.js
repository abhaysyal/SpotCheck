// Durable, swappable data layer for the annotation queue — the same store
// Feature 7's local MCP server will read from directly. Deliberately
// independent of annotations.js's own live, DOM-bound WeakMap store: that
// one needs a real Element reference for positioning/hover-fill and cannot
// survive a toggle-off; this one is a serializable mirror, keyed by a
// stable id, that does survive one (see feature-6-annotation-capture-edit/
// spec.md's storage decision).

window.__spotcheck = window.__spotcheck || {};

(function (spotcheck) {
  if (spotcheck.queue) return;

  const STORAGE_KEY = "spotcheck_annotations";

  async function readAll() {
    const result = await chrome.storage.local.get(STORAGE_KEY);
    return Array.isArray(result[STORAGE_KEY]) ? result[STORAGE_KEY] : [];
  }

  async function writeAll(records) {
    await chrome.storage.local.set({ [STORAGE_KEY]: records });
  }

  async function upsert(record) {
    const all = await readAll();
    const idx = all.findIndex((r) => r.id === record.id);
    if (idx === -1) all.push(record);
    else all[idx] = record;
    await writeAll(all);
  }

  async function remove(id) {
    const all = await readAll();
    await writeAll(all.filter((r) => r.id !== id));
  }

  async function getAll() {
    return readAll();
  }

  async function clear() {
    await writeAll([]);
  }

  spotcheck.queue = { upsert, remove, getAll, clear };
})(window.__spotcheck);
