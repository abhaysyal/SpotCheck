# Feature 6 — Annotation Capture & Edit — plan.md

Implementation plan for an AI coding agent. Read `spec.md` first, especially the "Storage decision" section — the `chrome.storage.local` approach below was explicitly confirmed with the human reviewer, not assumed.

**Historical note:** this plan was written and executed against Feature 5 as originally shipped, which had a separate `draftState.causes` array (four multi-select cause chips) alongside `issueType`. Feature 5's dropdown was later merged (post-approval) into a single grouped `issueType`-only field with no chips — see Feature 5's spec.md. The code blocks below that reference `draftState.causes`/`record.causes` (Step 7's `saveNote`, Step 8's `sendGateDisabled`) are stale as literal copy-paste targets; the actual code has no `causes` field, and the mandatory gate is simply `issueType !== null`. Kept as-is below for the historical record of what was actually built, step by step, in this feature's own pass.

## Scope reminder

Do **not** implement in this pass:
- Rehydrating bubbles/outlines from `chrome.storage.local` when inspection mode is toggled back on.
- Any change to `content/export.js` or its Markdown format.
- Anything MCP-related (Feature 7) or component-name detection (Feature 8).
- Any change to `content/capture.js` — its lists are mirrored, not imported or modified.

## Files to touch

1. **Create** `extension/content/queue.js` — the new data layer.
2. **Touch** `extension/manifest.json` — add `"storage"` to `permissions`.
3. **Touch** `extension/background.js` — add `"content/queue.js"` to `CONTENT_FILES` (before `annotations.js`), add a `SPOTCHECK_CAPTURE_VISIBLE_TAB` message handler.
4. **Touch** `extension/content/annotations.js` — the bulk of this feature: tag-scoped capture, snapshot capture, hot-save, reopen-on-edit, wiring to `spotcheck.queue`.
5. **Touch** `CHROMEWEBSTORE.md` — correct the permissions and data-usage sections to reflect real, durable local storage.

## Step-by-step

### Step 1 — `extension/content/queue.js` (new file)

```js
// Durable, swappable data layer for the annotation queue — the same store
// Feature 7's local MCP server will read from directly. Deliberately
// independent of annotations.js's own live, DOM-bound WeakMap store: that
// one needs a real Element reference for positioning/hover-fill and cannot
// survive a toggle-off; this one is a serializable mirror, keyed by a
// stable id, that does survive one (see spec.md's storage decision).

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
```

- No `if (spotcheck.queue) return` bypass needed beyond the standard re-injection guard every other file already has — this file has no DOM/lifecycle to double-set-up.
- Every function is `async`; callers in `annotations.js` fire-and-forget with `.catch(err => console.warn(...))`, matching the try/catch-and-warn pattern `capture.js` already established — a failed storage write should never block the UI.

### Step 2 — `extension/manifest.json`

```diff
-  "permissions": ["activeTab", "scripting"],
+  "permissions": ["activeTab", "scripting", "storage"],
```

### Step 3 — `extension/background.js`

Add the new file to the injection list, before `annotations.js` (it depends on `spotcheck.queue` existing):

```diff
 const CONTENT_FILES = [
   "content/state.js",
   "content/overlay.js",
   "content/picker.js",
   "content/capture.js",
+  "content/queue.js",
   "content/annotations.js",
   "content/export.js",
 ];
```

Add a message handler for the screenshot request — `chrome.tabs.captureVisibleTab` is only callable from an extension page, never a content script:

```js
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.type !== "SPOTCHECK_CAPTURE_VISIBLE_TAB") return;
  (async () => {
    try {
      const dataUrl = await chrome.tabs.captureVisibleTab(sender.tab.windowId, { format: "png" });
      sendResponse({ dataUrl });
    } catch (err) {
      sendResponse({ error: String(err) });
    }
  })();
  return true; // keeps the channel open for the async response
});
```

- This is a **second**, independent `onMessage` listener in `background.js` — the existing toggle logic doesn't send messages *to* itself, so there's no risk of this new listener intercepting `SPOTCHECK_SET_ACTIVE` or vice versa (Chrome calls every matching listener).

### Step 4 — `extension/content/annotations.js`: record shape additions

Extend the object built in `saveNote()`'s "new record" branch (Feature 5 already added `issueType`/`causes`/`includeSnapshot`/`snapshot` here):

```js
record = {
  // ...all Feature 3/5 fields unchanged...
  id: crypto.randomUUID(),          // new — stable identity for the persisted queue
  tagScopedStyles: null,            // new — filled by captureTagScopedStyles() below, every save
  status: "open",                   // new — "open" | "agent-resolved" | "verified"
  resolutionSummary: null,          // new — written only by a future Feature 7 tool
  history: [],                      // new — append-only reopen log
  // snapshot: already added by Feature 5, now actually populated (Step 6)
};
```

### Step 5 — Tag-scoped capture

```js
const LAYOUT_BASE_PROPERTIES = ["display", "position", "top", "right", "bottom", "left", "zIndex"];
// Mirrors capture.js's own FLEX_PROPERTIES/GRID_PROPERTIES exactly — kept as
// a separate copy rather than exported from Feature 2, see spec.md. Keep
// these two in sync with capture.js by hand if either ever changes.
const LAYOUT_FLEX_PROPERTIES = ["flexDirection", "justifyContent", "alignItems", "flexWrap", "gap"];
const LAYOUT_GRID_PROPERTIES = ["gridTemplateColumns", "gridTemplateRows", "gap"];

const TAG_SCOPED_PROPERTIES = {
  color: ["color", "backgroundColor", "borderColor"],
  typography: ["fontFamily", "fontSize", "fontWeight", "lineHeight", "letterSpacing"],
  spacing: [
    "marginTop", "marginRight", "marginBottom", "marginLeft",
    "paddingTop", "paddingRight", "paddingBottom", "paddingLeft",
    "gap", "width", "height",
  ],
  // layout and other are handled specially below, not via a flat list
};

function captureTagScopedStyles(el, issueType) {
  const computed = window.getComputedStyle(el);

  if (issueType === "other") {
    const result = {};
    for (let i = 0; i < computed.length; i++) {
      const prop = computed[i];
      result[prop] = computed.getPropertyValue(prop);
    }
    return result;
  }

  if (issueType === "layout") {
    const result = {};
    for (const prop of LAYOUT_BASE_PROPERTIES) result[prop] = computed[prop];
    if (computed.display.includes("flex")) for (const prop of LAYOUT_FLEX_PROPERTIES) result[prop] = computed[prop];
    if (computed.display.includes("grid")) for (const prop of LAYOUT_GRID_PROPERTIES) result[prop] = computed[prop];
    return result;
  }

  const props = TAG_SCOPED_PROPERTIES[issueType];
  if (!props) return null; // no issueType chosen yet — shouldn't normally be reachable at save time, gate prevents it
  const result = {};
  for (const prop of props) result[prop] = computed[prop];
  return result;
}
```

### Step 6 — Snapshot capture, triggered from `toggleSnapshotCheckbox`

```js
async function toggleSnapshotCheckbox() {
  draftState.includeSnapshot = !draftState.includeSnapshot;
  snapshotCheckboxEl.classList.toggle("checked", draftState.includeSnapshot);

  if (!draftState.includeSnapshot) {
    draftState.snapshot = null; // unchecked — drop whatever was captured, re-check re-captures fresh
    return;
  }

  const el = activeRecord ? activeRecord.element : draftElement;
  try {
    draftState.snapshot = await captureAndCropSnapshot(el);
  } catch (err) {
    console.warn("SpotCheck: snapshot capture failed", err);
    draftState.snapshot = null; // fails silently — the rest of the annotation is unaffected, see spec.md
  }

  if (activeRecord) scheduleHotSave(); // capturing a snapshot on an existing annotation should itself count as an edit
}

async function captureAndCropSnapshot(el) {
  const wasVisible = popupEl.style.display !== "none";
  if (wasVisible) popupEl.style.display = "none";
  await new Promise((resolve) => requestAnimationFrame(resolve)); // let the hide actually paint before capturing

  let dataUrl;
  try {
    const response = await chrome.runtime.sendMessage({ type: "SPOTCHECK_CAPTURE_VISIBLE_TAB" });
    if (!response || response.error) throw new Error(response && response.error);
    dataUrl = response.dataUrl;
  } finally {
    if (wasVisible) popupEl.style.display = "flex";
  }

  const rect = el.getBoundingClientRect();
  const scale = window.devicePixelRatio || 1;
  const img = await new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = reject;
    image.src = dataUrl;
  });

  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(rect.width * scale));
  canvas.height = Math.max(1, Math.round(rect.height * scale));
  const ctx = canvas.getContext("2d");
  ctx.drawImage(
    img,
    rect.left * scale, rect.top * scale, canvas.width, canvas.height,
    0, 0, canvas.width, canvas.height
  );
  return canvas.toDataURL("image/png");
}
```

- `draftState.snapshot` is read by `saveNote` (Step 7) exactly like the other draft fields — no separate write path into the record.
- Wrapped in `try`/`finally` so the popup is always restored even if the capture message or the image decode fails partway through.

### Step 7 — `saveNote()` becomes the single shared "apply" step

Extend both branches (existing-record update, and new-record creation) to also: capture tag-scoped styles fresh, handle the reopen-on-edit rule, and push to the queue. This is now the one function both `commit()` (add mode) and `performHotSave()` (edit mode) call through:

```js
function saveNote(el, text) {
  const trimmed = text.trim();

  let record = annotationsByElement.get(el);
  const isNewRecord = !record;

  if (!record) {
    const cached = latestCaptureByElement.get(el);
    record = {
      number: annotationsInOrder.length + 1,
      element: el,
      selector: cached ? cached.selector : null,
      styles: cached ? cached.styles : null,
      component: cached ? cached.component : null,
      id: crypto.randomUUID(),
      status: "open",
      resolutionSummary: null,
      history: [],
      bubbleEl: null,
      outlineEl: null,
      createdAt: Date.now(),
    };
    annotationsByElement.set(el, record);
    annotationsInOrder.push(record);
  }

  // Reopen-on-edit — before anything else about this save is applied.
  if (record.status !== "open") {
    record.history.push(`previously resolved: ${record.resolutionSummary}, reopened after edit`);
    record.resolutionSummary = null;
    record.status = "open";
  }

  record.note = trimmed;
  record.issueType = draftState.issueType;
  record.causes = [...draftState.causes];
  record.includeSnapshot = draftState.includeSnapshot;
  record.snapshot = draftState.snapshot;
  record.tagScopedStyles = captureTagScopedStyles(el, draftState.issueType);
  record.updatedAt = Date.now();

  const serializable = { ...record };
  delete serializable.element;
  delete serializable.bubbleEl;
  delete serializable.outlineEl;
  spotcheck.queue.upsert(serializable).catch((err) => console.warn("SpotCheck: queue upsert failed", err));

  return isNewRecord ? record : record; // always returns the record now — see note below
}
```

- **Behavior change from Feature 3/5**: `saveNote` no longer returns `null` for an empty/whitespace note. The mandatory-fields gate (`updateSendEnabled`/`onSendClick`) is the only thing deciding whether this function is ever reached at all now — see Feature 5's `spec.md` "Figma pull" note and this feature's own `spec.md` for why a second, independent guard here was actively harmful (it silently ate valid issueType-plus-chip, no-note submissions).
- `commit()` itself is otherwise unchanged — it still calls `saveNote`, then `renderBubble`/`renderOutline`/dispatches `spotcheck:annotation-saved`/`closePopup()`. Those steps are correct for a first-time creation and harmless to repeat if `commit()` is ever reached for an edit (it currently isn't, since edit mode has no send button — see Step 8).

### Step 8 — Hot-save wiring

```js
let hotSaveTimer = null;
const HOT_SAVE_DEBOUNCE_MS = 500;

function scheduleHotSave() {
  if (!activeRecord) return; // add mode has no hot-save — explicit send only
  clearTimeout(hotSaveTimer);
  hotSaveTimer = setTimeout(performHotSave, HOT_SAVE_DEBOUNCE_MS);
}

function performHotSave() {
  if (sendGateDisabled()) return; // mandatory fields no longer satisfied — skip silently, see spec.md
  saveNote(activeRecord.element, noteTextarea.value);
  showSavedIndicator();
  document.dispatchEvent(
    new CustomEvent("spotcheck:annotation-saved", {
      detail: { number: activeRecord.number, note: activeRecord.note, selector: activeRecord.selector, element: activeRecord.element, allAnnotations: buildSnapshot() },
    })
  );
}

// Factored out of updateSendEnabled so performHotSave can reuse the exact
// same condition without duplicating it.
function sendGateDisabled() {
  const hasCauseOrNote = draftState.causes.length > 0 || noteTextarea.value.trim().length > 0;
  return !(draftState.issueType !== null && hasCauseOrNote);
}
function updateSendEnabled() {
  sendButton.classList.toggle("disabled", sendGateDisabled());
}

function showSavedIndicator() {
  savedIndicatorEl.classList.add("visible");
  clearTimeout(showSavedIndicator._timer);
  showSavedIndicator._timer = setTimeout(() => savedIndicatorEl.classList.remove("visible"), 1500);
}
```

Call `scheduleHotSave()` (guarded by `if (activeRecord)`, since add mode should keep doing nothing until an explicit send) from:
- `setIssueType`, at the end, after `updateSendEnabled()`.
- `toggleCause`, at the end, after `updateSendEnabled()`.
- the note `input` listener, alongside the existing `updateSendEnabled` call.
- `toggleSnapshotCheckbox`, already shown inline in Step 6.

### Step 9 — Markup/CSS: saved indicator, edit-mode send-button removal

In `ensureHost()`, alongside `sendButton`'s creation, add one sibling element:

```js
savedIndicatorEl = document.createElement("span");
savedIndicatorEl.className = "saved-indicator";
savedIndicatorEl.textContent = "✓ Saved";
actions.appendChild(savedIndicatorEl);
```

```css
.saved-indicator {
  display: none;
  align-items: center;
  color: #77cff4;
  font-size: 12px;
  padding: 0 4px;
}
.saved-indicator.visible { display: flex; }
```

In `openPopupFor`, alongside the existing `deleteButton.style.display = activeRecord ? "flex" : "none";` line, add the mirrored rule for send:

```js
sendButton.style.display = activeRecord ? "none" : "flex"; // edit mode: hot-save + saved-indicator instead, per spec.md
savedIndicatorEl.classList.remove("visible"); // never start a freshly-opened popup mid-flash
```

### Step 10 — `stop()`: queue survives, live state doesn't

No change to what already gets reset (`annotationsByElement`, `annotationsInOrder`, all DOM nodes, `draftState`) — just make sure nothing in this feature adds a `spotcheck.queue.clear()` call to that function. The queue's persistence is the entire point; toggling off must not wipe it.

## Test criteria before calling this feature done

- [ ] Selecting "Color" as Issue type and saving an annotation records `tagScopedStyles` containing exactly `color`/`backgroundColor`/`borderColor` — verify via a temporary `spotcheck.queue.getAll()` call in the console.
- [ ] Same for Typography, Spacing, and Layout — each produces only its own property set (Layout also includes flex or grid properties only when the element is actually a flex/grid container, matching Feature 2's existing conditional).
- [ ] "Other" produces a large, unfiltered, kebab-case-keyed style dump, visibly different in shape from the curated Issue types.
- [ ] Checking "Include Snapshot" on a real, visible element produces a non-null `snapshot` data URL; opening that URL shows an image cropped to roughly that element's own bounding box, not the full page.
- [ ] Unchecking and rechecking "Include Snapshot" replaces the stored image (verify the two data URLs differ, or force a visible page change between captures).
- [ ] Checking "Include Snapshot" while the `activeTab` grant has plausibly expired (e.g. after a long idle period) does not throw or break the popup — the box stays checked, `snapshot` stays `null`, everything else about the annotation still saves normally.
- [ ] Add mode: creating a fresh annotation still requires an explicit send click, exactly as Feature 5 left it — no hot-save fires before the first save.
- [ ] Edit mode: reopening a saved annotation shows no send button, shows the delete button, and typing in the note (or toggling a chip, or changing Issue type) triggers a "✓ Saved" flash roughly 500ms after the last change, which fades back out after ~1.5s.
- [ ] Edit mode: removing the only selected chip and clearing the note together produces **no** "Saved" flash and does not overwrite the record — reopening again still shows the last valid saved state, not the invalid in-between one.
- [ ] Manually set a record's `status` to `"agent-resolved"` and `resolutionSummary` to some string via `spotcheck.queue.upsert()` in the console (simulating what Feature 7 will eventually do), then edit that annotation's note — confirm `status` flips back to `"open"`, `resolutionSummary` becomes `null`, and `history` gains one `"previously resolved: ..., reopened after edit"` entry.
- [ ] Toggling inspection mode off, then back on, then calling `spotcheck.queue.getAll()` in the console still shows every previously saved annotation — the queue survives even though the page's bubbles/outlines do not reappear (expected, see spec.md's known limitations).
- [ ] Closing and reopening the tab (or the browser) and re-checking `chrome.storage.local` (via the console on any extension page, or `spotcheck.queue.getAll()` after re-toggling inspection mode on the same page) shows the annotations are still there.
- [ ] Deleting an annotation removes it from `spotcheck.queue.getAll()`, not just from the page.
- [ ] Opening the Network tab and repeating all of the above produces zero network requests — screenshot capture and storage are both local-only.
