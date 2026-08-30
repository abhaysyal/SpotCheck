// The two read-only MCP tools this feature exposes — deliberately scoped
// down, no resolve/reopen/filtering/watch tools, see spec.md.

import { readAnnotations } from "./store.js";

// Lightweight — deliberately excludes snapshot (a base64 image, potentially
// large) and tagScopedStyles (verbose): an agent triaging "what needs
// fixing" doesn't need either just to decide what to look at next.
function summarize(a) {
  return {
    id: a.id,
    number: a.number,
    selector: a.selector,
    issueType: a.issueType,
    note: a.note,
    status: a.status,
    createdAt: a.createdAt,
    updatedAt: a.updatedAt,
  };
}

export async function listAnnotations() {
  const all = await readAnnotations();
  return all.map(summarize);
}

// Full record — every field Feature 6 captured (tagScopedStyles, snapshot,
// component, resolutionSummary, history included), see spec.md.
export async function getAnnotation(id) {
  const all = await readAnnotations();
  const found = all.find((a) => a.id === id);
  if (!found) throw new Error(`No annotation with id ${id}`);
  return found;
}
