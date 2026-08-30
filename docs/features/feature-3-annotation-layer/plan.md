# Feature 3 — Annotation Layer — plan.md

Implementation plan for an AI coding agent (e.g. Claude Code). Follow the steps in order; each step should be independently testable before moving to the next.

**Historical note:** two of the deferrals below were later built. Preset tag categories became v2's Feature 5 (a grouped Issue-type dropdown, not the spacing/color/wrong-token/broken-interaction/other list guessed here — see that feature's spec.md). Persistence became v2's Feature 6 (`chrome.storage.local`, a new `storage` permission — see that feature's "Storage decision"), which also removed the empty-note guard this plan builds in Step 2/interaction-model below, since it started silently dropping valid issue-type-only submissions once the mandatory-fields model changed. Kept below as the historical record of what this feature's own pass actually built.

## Scope reminder — simplest version, deliberately

This is the v1-simplest cut, per an explicit decision to defer two things rather than design them now:
- **No preset tag categories.** Free-text note only. (Preset tags — spacing/color/wrong-token/broken-interaction/other — are recorded as a Phase 2 roadmap item in `PROJECT.md` §8, not built here. Later built differently in v2's Feature 5 — see historical note above.)
- **No fix for the Escape-while-typing conflict.** `picker.js`'s existing Escape handler can still clear the current lock while focus is inside this feature's note textarea, discarding an in-progress (unsaved) draft. Leave a `// TODO` noting this; explicitly deferred, not fixed in this pass. (Still not fixed as of Feature 7 — this gap has outlived multiple features, not just this one.)

Also explicitly out of scope for this feature:
- **No separate queue/list review UI.** The numbered bubbles scattered across the page *are* the queue — there is no additional panel or sidebar listing them. (If that's ever wanted, it's a Feature 4/export-adjacent concern, not this one.)
- **No export, no clipboard, nothing serialized.** Feature 4's job entirely.
- **No persistence.** Annotations live in memory only, same as every other feature's state — toggling inspection mode off discards everything tagged so far, same in-memory-only tradeoff Feature 1 already made for its own state. This is a real, known rough edge until Feature 4 exists to export before you'd ever toggle off — call it out plainly in testing, don't paper over it. (Superseded by v2's Feature 6 — see historical note above.)

## Interaction model (confirmed)

1. Hover → blue preview highlight (Feature 1, unchanged).
2. Click → locks the element, green highlight (Feature 1, unchanged) **and**, in the same motion, opens a dark anchored popup near the element with a note textarea, focused and ready to type.
3. Enter (no Shift) or the send icon → submits the note if it's non-empty. Empty/whitespace-only text is a no-op — it neither creates nor updates anything. On a successful submit, the popup collapses into a small numbered bubble (like a Figma comment pin) pinned to that element's position on the page. Shift+Enter inserts a newline instead of submitting.
4. Clicking an existing numbered bubble later reopens the popup, pre-filled with its note, editable. Saving again just updates that same record — the number never changes from editing.
5. A delete icon sits next to the send icon in the popup. On an existing (already-saved) annotation, it removes that record and its bubble entirely, then **renumbers every remaining bubble sequentially** so numbers never skip — deleting #2 out of #1/#2/#3 leaves #1/#2, not #1/#3. On a fresh, never-saved draft, delete just discards the draft and closes the popup (same effect as clicking elsewhere, but explicit) — it doubles as a cancel button.
6. Clicking a *different* page element while a popup is open abandons any unsaved draft in the current popup (no confirmation) and opens a fresh popup for the newly-clicked element instead — consistent with how Feature 1 already treats every click as "select this one now," no undo dance.
7. Numbers are assigned sequentially in the order a note is first *saved* (not in the order elements are merely clicked/previewed) — so an element you opened, looked at, and abandoned without typing anything never consumes a number or leaves a stray empty bubble behind. Numbers also shift down when an earlier annotation is deleted (point 5) — they always reflect "current position in the live queue," not a permanent id.
8. Both icons are icon-only, no visible text labels — send is an up arrow (↑), delete is a trash icon (🗑). Each still carries an `aria-label` for accessibility; that's not a visible label.
9. **Revised based on early testing**: once a note is saved, a persistent green outline is traced around that exact element and stays visible the whole time inspection mode is on — not just while it's the "currently selected" one (that's Feature 1's separate, transient hover/lock highlight, which still only ever shows one element at a time). Without this, a small numbered bubble alone doesn't make it unambiguous which exact node — especially a deeply nested child inside a similarly-sized parent — a given comment belongs to. Any number of outlines can be visible simultaneously.
10. **Also revised based on early testing**: bubbles never overlap each other, even when their elements are nested parent/child with the same (or a near-identical) top-left corner — a colliding bubble cascades to the nearest free spot instead of stacking exactly on top of another one, which would otherwise make whichever bubble ends up underneath both indistinguishable and unclickable.

## Architecture decision

- **One new file, `content/annotations.js`, self-contained** — same pattern as `capture.js`: listens for `spotcheck:element-selected` (to open the popup) and `spotcheck:element-captured` (to attach the element's selector once available) independently. Never reads `content/state.js`'s internals directly.
- **Independently tracks its own on/off lifecycle.** Rather than reaching into `picker.js`'s internal `active` flag, `annotations.js` registers its own `chrome.runtime.onMessage` listener for the same broadcast `background.js` already sends, and maintains its own `active` boolean. This keeps it decoupled from `picker.js`'s internals (per the cross-feature convention) while still correctly starting/stopping alongside inspection mode. On stop: remove the shadow host, remove the `scroll`/`resize` listeners this feature added, cancel any pending `requestAnimationFrame`, and reset all annotation data — mirrors Feature 1's own "nothing survives toggle-off" guardrail exactly.
- **The toggle broadcast had to change from a flip message to an absolute one because of this second listener.** `background.js` originally sent a bare `{ type: "SPOTCHECK_TOGGLE" }` and every listener inverted its own local `active` boolean on receipt. With only `picker.js` listening that was fine; adding `annotations.js` as a second, independently-toggling listener meant any transient desync between `background.js`'s own bookkeeping and either listener's local state would compound instead of self-correct — this is what caused the "sometimes needs two clicks, sometimes needs a reload" bug reported once this feature landed. Fixed by sending the absolute next state instead: `{ type: "SPOTCHECK_SET_ACTIVE", active: boolean }`. Every listener just sets itself to that value rather than flipping, so the very next message always drives every listener to the correct state regardless of what it currently believes. `content/picker.js` and `background.js` were both updated for this — see Feature 1's `plan.md` for the other side of it.
- **One shared Shadow DOM host** (`__spotcheck-annotations-host`), holding an outlines layer, a bubbles layer, and the single reusable popup — same isolation rationale as Feature 1's highlight overlay. Dark theme (near-black background, light text) for the popup specifically, since that's the visual call made for this feature — not necessarily the rest of the extension's chrome. Outlines appended before bubbles in DOM order, so bubbles stack visually on top at equal z-index.
- **Two touches to existing files, both plumbing, not feature coupling:**
  1. `background.js` — append `"content/annotations.js"` to `CONTENT_FILES`.
  2. `content/picker.js` — the click handler currently intercepts *every* click on the page (that's its job). A bubble needs to be clickable to reopen for editing, but a document-level capture-phase listener (which is what `picker.js`'s click handler is) always fires before the click ever reaches something inside a Shadow DOM tree, so without a change, `picker.js` would swallow every bubble click before this feature ever sees it. Add one early-return check (Step 5 below) so `picker.js` steps aside for clicks landing on this feature's own UI, instead of treating them as a page-element selection.

## Files to create / touch

1. **Create** `content/annotations.js`.
2. **Touch** `background.js` — add `"content/annotations.js"` to the end of `CONTENT_FILES`.
3. **Touch** `content/picker.js` — add the own-UI early-return check to `onClick` (Step 5).

## Step-by-step

### Step 1 — Annotation store

```js
let annotationsByElement = new WeakMap(); // element -> record
let annotationsInOrder = [];              // same record objects, creation order
let activeRecord = null;                  // record currently open in the popup, or null
let draftElement = null;                  // element the popup is open for but not yet saved

function getExistingRecord(el) {
  return annotationsByElement.get(el) || null;
}

function saveNote(el, text) {
  const trimmed = text.trim();
  if (!trimmed) return null; // empty/whitespace-only is always a no-op

  let record = annotationsByElement.get(el);
  if (record) {
    record.note = trimmed;
    record.updatedAt = Date.now();
  } else {
    record = {
      number: annotationsInOrder.length + 1,
      element: el,
      selector: null, // filled in by the spotcheck:element-captured listener, Step 4
      note: trimmed,
      bubbleEl: null,  // set once by renderBubble(), Step 4 — carried on the record so
                        // deleting/renumbering never needs a separate number -> element lookup
      outlineEl: null, // set once by renderOutline(), Step 4 — persistent, stays lit for as
                        // long as the annotation exists, independent of "currently selected"
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    annotationsByElement.set(el, record);
    annotationsInOrder.push(record);
  }
  return record;
}

function deleteAnnotation(record) {
  annotationsByElement.delete(record.element);
  const idx = annotationsInOrder.indexOf(record);
  if (idx !== -1) annotationsInOrder.splice(idx, 1);
  if (record.bubbleEl) record.bubbleEl.remove();
  if (record.outlineEl) record.outlineEl.remove();
  renumberAll();
  positionAllBubbles(); // let any bubble that had cascaded away (Step 3) reflow back toward its ideal spot
  document.dispatchEvent(
    new CustomEvent("spotcheck:annotation-deleted", { detail: { number: record.number, element: record.element } })
  );
}

function renumberAll() {
  annotationsInOrder.forEach((record, i) => {
    record.number = i + 1;
    if (record.bubbleEl) record.bubbleEl.textContent = String(record.number);
  });
}
```

- `WeakMap` keyed directly on the live element reference — no need to invent a synthetic id, and entries stop pinning memory once an element is genuinely gone (garbage-collected) rather than needing manual cleanup.
- `annotationsInOrder` holds the *same* record objects (not copies), so updating a record found via the WeakMap is automatically reflected in the array too — one source of truth, two lookup paths.
- Numbers are **positional, not permanent ids** — `renumberAll()` re-derives every record's `number` from its current index after any deletion, and pushes the new digit straight into that record's own `bubbleEl`. Carrying `bubbleEl` directly on the record (rather than a separate `Map<number, bubbleEl>`) is what makes this cheap and correct: there's no stale number-keyed lookup to invalidate when numbers shift.

### Step 2 — Shadow host, dark-themed popup + bubble markup

Same technique as `content/overlay.js`: one host `<div>` appended to `document.documentElement`, `attachShadow({ mode: "open" })`, a `<style>` tag, then the actual markup. Structure inside the shadow root:

```html
<div class="outlines-layer"></div>
<div class="bubbles-layer"></div>
<div class="popup" style="display:none;">
  <textarea class="popup-note" placeholder="Add a note…"></textarea>
  <div class="popup-actions">
    <button class="popup-delete" aria-label="Delete annotation">🗑</button>
    <button class="popup-send" aria-label="Save note">↑</button>
  </div>
</div>
```

Both buttons are icon-only — no visible text, ever. `aria-label` is there for screen readers, not as a fallback visible label. Send is an up arrow (↑); delete is a trash icon (🗑).

CSS notes (dark theme, this feature specifically):
- `.popup`: `position: fixed; background: #0b0b0c; color: #f3f4f6; border-radius: 8px; padding: 10px; min-width: 220px; box-shadow: 0 8px 24px rgba(0,0,0,0.4); z-index: 2147483647;`
- `.popup-note`: dark textarea — `background: #16171a; color: inherit; border: 1px solid #2a2b2f; border-radius: 6px; resize: vertical;` — no default browser white background left showing.
- `.popup-actions`: small flex row, icons right-aligned under the textarea, e.g. `display: flex; justify-content: flex-end; gap: 6px; margin-top: 6px;`
- `.popup-send` / `.popup-delete`: plain icon buttons — `width: 26px; height: 26px; border-radius: 6px; border: none; color: inherit; cursor: pointer; display: flex; align-items: center; justify-content: center; font-size: 13px;`. `.popup-delete` keeps the dark `background: #1c1d21`, `:hover` leaning toward a red-tinted background (`#3a1d1d`) as a subtle "this one removes something" cue. `.popup-send` is filled solid green (`background: #22c55e; color: #ffffff;`) — the same green as the locked-element highlight, reusing that "confirmed" association — with a darker green (`#16a34a`) on hover.
- `.bubble`: small circular pin — `position: fixed; width: 22px; height: 22px; border-radius: 50%; background: #000; color: #fff; font-size: 11px; display: flex; align-items: center; justify-content: center; cursor: pointer; pointer-events: auto; box-shadow: 0 0 0 2px rgba(255,255,255,0.15); z-index: 2147483647;`
- `.outline`: persistent per-annotation border traced around the element itself — `position: fixed; box-sizing: border-box; border: 2px solid #22c55e; border-radius: 2px; pointer-events: none; z-index: 2147483646;`. Deliberately border-only, no fill — a translucent fill (like Feature 1's transient highlight has) would visually compound where multiple outlines overlap, which happens constantly with nested parent/child elements, the exact case this exists to disambiguate. One z-index step below `.bubble` so the bubble reads as "on top of" its outline, though `pointer-events: none` already means it can't intercept anything regardless of stacking.
- Everything else (the outline included) keeps `pointer-events: none` as established in Feature 1 — `.bubble` and the two popup buttons are the deliberate exceptions, since they must be clickable.

### Step 3 — Positioning (outlines + bubbles + popup), continuous rAF loop

**Revised after real-usage feedback**: this originally scheduled a reposition only in response to `scroll`/`resize` events. Removed — a `scroll` event only reaches a content script's main-thread listener *after* the browser has already painted the new scroll offset on its own compositor thread, so anything triggered by that event is structurally always a step behind, no matter how the listener itself is tuned (`passive: true` helps the browser, not this gap). Replaced with an unconditional loop that just re-reads live rects every animation frame, for as long as inspection mode is on — not triggered by any particular event, so it doesn't matter *why* something moved. Verified directly: after a real scroll, an outline's position matches its element's `getBoundingClientRect()` to the pixel, with zero scroll listeners registered anywhere in the test.

```js
let rafId = null;
let repositionLoopActive = false;

function repositionLoop() {
  if (!repositionLoopActive) return;
  repositionAll();
  rafId = requestAnimationFrame(repositionLoop);
}

function repositionAll() {
  positionAllBubbles();
  for (const record of annotationsInOrder) positionOutline(record);
  if (activeRecord || draftElement) positionPopup(activeRecord ? activeRecord.element : draftElement);
}

function positionOutline(record) {
  if (!record.outlineEl) return;
  if (!document.body.contains(record.element)) {
    record.outlineEl.style.display = "none"; // annotated element no longer in the DOM — Known limitation
    return;
  }
  // Traces the element's real bounding box — deliberately NOT clamped to the
  // viewport the way the bubble is: this outlines exactly where the element
  // is (including partially off-screen), it doesn't need to stay usable as a
  // fixed-size clickable marker the way the bubble does.
  const rect = record.element.getBoundingClientRect();
  record.outlineEl.style.display = "block";
  record.outlineEl.style.left = `${rect.left}px`;
  record.outlineEl.style.top = `${rect.top}px`;
  record.outlineEl.style.width = `${rect.width}px`;
  record.outlineEl.style.height = `${rect.height}px`;
}

const BUBBLE_SIZE = 22;
const BUBBLE_MARGIN = 4;
const BUBBLE_GAP = 4; // minimum clearance enforced between two bubbles' edges

// Positions every bubble together as one pass, not independently. Nested
// parent/child elements very often share the same (or a near-identical)
// top-left corner — a child that fills its parent with no padding, for
// instance — which would otherwise stack their bubbles exactly on top of
// each other: visually indistinguishable, and whichever one ends up
// underneath becomes unclickable. A colliding bubble cascades straight down
// in fixed steps until it finds a free spot, wrapping into a new column if
// it runs out of vertical room. Processed in annotationsInOrder (creation
// order, which also matches numbering), so earlier annotations keep their
// ideal corner-anchored spot and later ones cascade away from it — a
// stable, deterministic tie-break, not an arbitrary one.
function positionAllBubbles() {
  const placed = [];

  for (const record of annotationsInOrder) {
    if (!record.bubbleEl) continue;
    if (!document.body.contains(record.element)) {
      record.bubbleEl.style.display = "none"; // annotated element no longer in the DOM — Known limitation
      continue;
    }

    const rect = record.element.getBoundingClientRect();
    let left = Math.min(Math.max(BUBBLE_MARGIN, rect.left - 10), window.innerWidth - BUBBLE_SIZE - BUBBLE_MARGIN);
    let top = Math.min(Math.max(BUBBLE_MARGIN, rect.top - 10), window.innerHeight - BUBBLE_SIZE - BUBBLE_MARGIN);

    let attempts = 0;
    while (
      attempts < 200 &&
      placed.some(
        (p) => Math.abs(p.left - left) < BUBBLE_SIZE + BUBBLE_GAP && Math.abs(p.top - top) < BUBBLE_SIZE + BUBBLE_GAP
      )
    ) {
      top += BUBBLE_SIZE + BUBBLE_GAP;
      if (top > window.innerHeight - BUBBLE_SIZE - BUBBLE_MARGIN) {
        top = BUBBLE_MARGIN; // ran out of vertical room — wrap to a new column
        left += BUBBLE_SIZE + BUBBLE_GAP;
      }
      attempts += 1;
    }

    record.bubbleEl.style.display = "flex";
    record.bubbleEl.style.left = `${left}px`;
    record.bubbleEl.style.top = `${top}px`;
    placed.push({ left, top });
  }
}

function positionPopup(el) {
  const rect = el.getBoundingClientRect();
  popupEl.style.left = "0px";
  popupEl.style.top = "0px";
  popupEl.style.display = "block"; // must be visible+rendered before measuring its own size
  const popupRect = popupEl.getBoundingClientRect();
  const left = Math.min(Math.max(8, rect.left), window.innerWidth - popupRect.width - 8);
  const top = Math.min(Math.max(8, rect.bottom + 8), window.innerHeight - popupRect.height - 8);
  popupEl.style.left = `${left}px`;
  popupEl.style.top = `${top}px`;
}
```

- `repositionLoopActive = true; rafId = requestAnimationFrame(repositionLoop);` — registered in `start()`, `repositionLoopActive = false; cancelAnimationFrame(rafId);` in `stop()`. No `scroll`/`resize` listeners at all — the loop runs continuously, independent of what causes something to move, for as long as inspection mode is on.
- The popup is measured *after* being shown (basic clamp-to-viewport, not a smart edge-flip) — good enough for "simplest possible"; a smarter placement algorithm is a nice-to-have, not required here.
- **On scroll smoothness**: an earlier version used `scroll`/`resize` event listeners with `passive: true` and accepted the residual lag as an unavoidable tradeoff of any JS-driven `position: fixed` tracking. That framing was wrong — the lag wasn't inherent to *tracking*, it was inherent to *waiting for an event* that only reaches a content script's main thread after the browser has already painted the new scroll position on its own compositor thread. A continuous rAF loop, which reads live rects every frame regardless of the trigger, doesn't have that gap. The "hide during active scroll, fade back in once it settles" alternative considered earlier is no longer necessary — there's no lag left to hide.

### Step 4 — Wiring: open on select, attach selector on capture, save/cancel

```js
document.addEventListener("spotcheck:element-selected", (e) => {
  const el = e.detail && e.detail.element;
  if (!el) return;
  openPopupFor(el);
});

document.addEventListener("spotcheck:element-captured", (e) => {
  const el = e.detail && e.detail.element;
  const record = el && annotationsByElement.get(el);
  if (record) record.selector = e.detail.selector;
});

function openPopupFor(el) {
  draftElement = el;
  activeRecord = getExistingRecord(el);
  noteTextarea.value = activeRecord ? activeRecord.note : "";
  positionPopup(el);
  noteTextarea.focus();
  const len = noteTextarea.value.length;
  noteTextarea.setSelectionRange(len, len);
}

function closePopup() {
  popupEl.style.display = "none";
  activeRecord = null;
  draftElement = null;
}

function renderBubble(record) {
  if (record.bubbleEl) {
    record.bubbleEl.textContent = String(record.number); // already exists — just keep the label in sync
    return;
  }
  const bubbleEl = document.createElement("div");
  bubbleEl.className = "bubble";
  bubbleEl.textContent = String(record.number);
  // Route through setSelectedElement, not openPopupFor directly — this is
  // what makes clicking a bubble show the green locked highlight too, the
  // same as clicking the underlying element would (setSelectedElement shows
  // it internally; see the Feature 1 plan.md note on state.js).
  bubbleEl.addEventListener("click", () => spotcheck.setSelectedElement(record.element));
  bubblesLayer.appendChild(bubbleEl);
  record.bubbleEl = bubbleEl;
  // Full re-pass, not a single-record position — a new bubble might land
  // exactly where an existing one already is (see positionAllBubbles).
  positionAllBubbles();
}

function renderOutline(record) {
  if (record.outlineEl) return; // already exists, position tracking (Step 3) handles the rest
  const outlineEl = document.createElement("div");
  outlineEl.className = "outline";
  outlinesLayer.appendChild(outlineEl);
  record.outlineEl = outlineEl;
  positionOutline(record);
}

function commit() {
  if (!draftElement) return;
  const record = saveNote(draftElement, noteTextarea.value);
  if (record) {
    renderBubble(record);
    // Created once a note is actually saved ("logged"), not while just
    // previewing/drafting — and stays lit for as long as the annotation
    // exists, not just while it's the "currently selected" one. See the
    // Interaction model note above for why.
    renderOutline(record);
    document.dispatchEvent(
      new CustomEvent("spotcheck:annotation-saved", {
        detail: { number: record.number, note: record.note, selector: record.selector, element: record.element },
      })
    );
  }
  closePopup();
}

function onDeleteClick() {
  if (activeRecord) deleteAnnotation(activeRecord); // no-op path (fresh, never-saved draft) just falls through to closePopup()
  closePopup();
}

sendButton.addEventListener("click", commit);
deleteButton.addEventListener("click", onDeleteClick);
noteTextarea.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    commit();
  }
});
```

- `spotcheck:annotation-saved` is dispatched on every successful save (new or edit); `spotcheck:annotation-deleted` (Step 1) on every delete of an existing record — these are the two hand-off points Feature 4 will eventually consume; neither is otherwise used within this feature.
- `renderBubble` doubles as "create if missing, refresh label if not" — this is what makes `renumberAll()` (Step 1) safe to call after any delete: every surviving record's bubble just gets its `textContent` overwritten to match its new position, no DOM node ever gets rebuilt.
- Clicking a bubble calls `spotcheck.setSelectedElement(record.element)` — the *same* canonical selection path a fresh page click uses, not a separate shortcut straight to `openPopupFor`. That single change is what makes clicking a bubble show the green locked highlight too: `setSelectedElement` shows it internally (moved there after this feature exposed the asymmetry — see Feature 1's `plan.md`), and dispatching `spotcheck:element-selected` is what this feature's own listener below is already watching for, so the popup opens from there rather than needing a second code path. (Step 5 still stops `picker.js`'s own click handler from treating the bubble click as a *fresh* page-element click in the first place — this is what happens once that's out of the way.)
- Note this listener setup lives inside this feature's own shadow root / elements, registered normally (no `capture: true`) — it only receives events once Step 5's change to `picker.js` stops swallowing them upstream.

### Step 5 — Touch `content/picker.js`: let clicks on this feature's UI through

In `onClick`, before the existing lock logic:

```js
function onClick(e) {
  const hitEl = document.elementFromPoint(e.clientX, e.clientY);
  if (hitEl && spotcheck.annotations && hitEl === spotcheck.annotations.hostEl) {
    // Click landed on SpotCheck's own annotation UI (a bubble, the popup, etc) —
    // not a page-element selection. Don't preventDefault/stopPropagation here;
    // let the click continue so this feature's own listeners can handle it.
    return;
  }
  e.preventDefault();
  e.stopPropagation();
  // ...existing lock logic, unchanged...
}
```

- `document.elementFromPoint` at a point covered by a Shadow DOM host returns the *host* element itself (shadow trees are encapsulated from outside DOM queries) — so this single equality check is enough to detect "this click is on our own UI," without needing to pierce into the shadow tree from `picker.js`.
- `spotcheck.annotations` is guarded with `&&` since `annotations.js` might not be the last-loaded file in some future reordering — defensive, not load-bearing today given the fixed `CONTENT_FILES` order.
- `annotations.js` must expose `hostEl` on `spotcheck.annotations` for this check to work — add it alongside whatever else gets exposed there.

### Step 6 — Toggle lifecycle

```js
chrome.runtime.onMessage.addListener((message) => {
  if (!message || message.type !== "SPOTCHECK_SET_ACTIVE") return;
  active = message.active; // absolute state, not a flip — see the note above
  if (active) start(); else stop();
});

function start() {
  repositionLoopActive = true;
  rafId = requestAnimationFrame(repositionLoop);
}

function stop() {
  repositionLoopActive = false;
  if (rafId) cancelAnimationFrame(rafId);
  rafId = null;
  if (hostEl) hostEl.remove();
  hostEl = null;
  outlinesLayer = null;
  bubblesLayer = null;
  annotationsByElement = new WeakMap();
  annotationsInOrder = [];
  activeRecord = null;
  draftElement = null;
}
```

- Matches Feature 1's own "toggle off removes everything, in-memory state resets" behavior exactly — intentional consistency, not an oversight.

**A `target`/`kind` generalization briefly existed here — `draftElement` became `draftTarget`, a second `gapAnnotationsByBeforeElement` WeakMap sat alongside `annotationsByElement`, and every store/positioning/render function branched on `record.kind`/`target.kind` — to support Feature 1's gap-selection mode.** All of it was removed along with that mode; `draftElement`, `annotationsByElement`, and the plain per-element functions below are once again the whole store. See Feature 1's `spec.md` for why gap-selection was tried and dropped.

**Revised after real-usage feedback**: `positionPopup(el)` in Step 3/4 above took the element's own rect as its anchor unconditionally — but `positionAllBubbles` can cascade a bubble away from that same rect's corner to avoid overlapping another one, so the two could genuinely disagree about where "here" is. Reopening an already-annotated element (via its bubble, or by clicking the element directly) now anchors the popup to `record.bubbleEl.getBoundingClientRect()` instead, via a new `getPopupAnchorRect(el, record)` helper — falling back to the element's own rect only for a fresh draft that has no bubble yet. Verified against a live three-bubble cascade: the popup lands at the bubble's exact `left`/`bottom + 8`, to the pixel, regardless of how far the cascade pushed that bubble from its "ideal" spot. Full rationale in `spec.md`.

## Known limitations to leave comments about (not fixed in v1)

- **Escape can still discard an unsaved draft.** `picker.js`'s Escape handler clears the current lock unconditionally; it doesn't yet check whether keyboard focus is inside this feature's note textarea. Leave a `// TODO` in `picker.js` near the Escape handler. Explicitly deferred per project decision — not fixed here.
- **No preset tag categories in v1** — free-text note only. Tracked as a Phase 2 roadmap item in `PROJECT.md` §8, not this feature.
- **Annotated element removed from the DOM** (e.g. a re-render or SPA navigation removes it) leaves that bubble *and* its outline hidden with no way to recover or reassign it in v1 — acceptable, not fixed here.
- **The outline isn't clamped to the viewport** (unlike the bubble) — an annotated element that's partially or fully scrolled off-screen shows a partially/fully off-screen outline, by design (it's meant to trace the element's real position, not stay usable the way a fixed-size clickable marker needs to).
- **No confirmation before abandoning an unsaved draft** when clicking a different element — matches Feature 1's existing "every click commits immediately" model, but worth being aware of when testing.
- **Toggling inspection mode off discards all annotations made so far** — same in-memory-only tradeoff as the rest of the extension, but worth calling out explicitly here since, unlike Feature 1's selection state, this one represents real work a user might not want to lose. There is no persistence path until Feature 4 (export) exists.
- **Numbers are positional, not stable identifiers.** Deleting annotation #2 shifts everything after it down by one — correct and intentional for keeping the visible sequence gapless, but means "annotation #3" doesn't refer to a fixed thing across the session if deletions happen before it. Not a concern for this feature in isolation, but worth Feature 4 being aware of if it ever caches numbers anywhere before export.

## Test criteria before calling this feature done

- [ ] Clicking an unannotated element locks it (green highlight, unchanged) and immediately opens the dark popup, focused and ready to type, positioned near the element and fully inside the viewport even when the element is near a screen edge.
- [ ] Typing a note and pressing Enter (no Shift) submits it, the popup closes, a small numbered bubble (starting at 1) appears pinned near the element's top-left corner, **and a green outline appears traced around the element's actual bounding box**.
- [ ] Clicking a *different*, unannotated element afterward moves Feature 1's transient highlight to the new element (unchanged, single-highlight behavior) — but the first element's persistent outline **stays visible**, not tied to "currently selected." With three elements annotated, all three outlines should be visible simultaneously.
- [ ] Annotate two elements where one is nested inside the other (e.g. a button inside a card, both annotated) — both outlines should be visible at once without one obscuring which is which; this is the actual scenario the outline exists to disambiguate.
- [ ] Annotate a parent and a child that share (or nearly share) the same top-left corner, e.g. a full-bleed child with no padding inside its parent — the two bubbles must **not** overlap; both numbers should be individually visible and independently clickable.
- [ ] Annotate three or more elements all sharing a similar corner (e.g. a deeply nested chain, each one filling the last) — bubbles should cascade into a readable stack, not pile up.
- [ ] Delete the top bubble in a cascaded stack — the remaining bubbles should reflow back toward their ideal corner-anchored spot, not stay cascaded away from a bubble that's no longer there.
- [ ] Typing a note, pressing Shift+Enter, confirms a newline is inserted and the popup stays open (does not submit).
- [ ] Clicking a *different*, unannotated element while a popup with unsaved text is open abandons that draft (no error, no confirmation dialog) and opens a fresh empty popup for the new element.
- [ ] Clicking that first element's bubble again reopens the popup pre-filled with its saved note; editing and re-submitting updates the same bubble number (does not create a second bubble or change the number).
- [ ] Hitting Enter or the send button with an empty or whitespace-only textarea does nothing — no bubble is created, no record exists for that element.
- [ ] Annotating three or more elements produces bubbles numbered sequentially in the order each was *saved* (not the order elements were merely clicked/previewed if a draft was abandoned in between).
- [ ] With three saved annotations (#1/#2/#3), clicking bubble #2's popup and hitting delete removes bubble #2 **and its outline** entirely and **renumbers the former #3 down to #2** — no gap, no duplicate numbers, and no leftover DOM node for either the deleted bubble or its outline (check the Elements panel).
- [ ] Opening a fresh, never-saved draft (a brand-new element you just clicked, haven't typed anything into yet) and hitting delete just closes the popup — no error, no bubble created, no record added.
- [ ] `spotcheck:annotation-deleted` fires with the correct `{ number, element }` on every delete — verify with a temporary listener, same technique as verifying `spotcheck:annotation-saved`.
- [ ] Both popup buttons render as icons only (↑ for send, 🗑 for delete) with no visible text label next to them.
- [ ] Scrolling the page keeps every bubble, outline, and any open popup correctly anchored to their elements — no lag/detachment, verified by scrolling with at least one annotation near the top and one near the bottom of a long page.
- [ ] Toggling inspection mode off removes the shadow host, all bubbles, all outlines, and the popup entirely — confirm via DevTools Elements panel that no annotation-related nodes remain, same verification approach as Feature 1's own toggle-off test.
- [ ] Toggling inspection mode back on after a toggle-off starts a fresh, empty annotation set (numbering restarts at 1) — confirms the intentional reset-on-toggle-off behavior, not a bug.
- [ ] Clicking directly on a bubble does **not** trigger `picker.js`'s normal lock/select behavior on whatever page element happens to be underneath it — confirms the Step 5 routing fix actually works, not just that the happy path works.
- [ ] Opening the Network tab and repeating all of the above produces zero network requests — same guardrail as every other feature.
