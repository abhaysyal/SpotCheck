# Feature 9 — Hover Component Labels — plan.md

Implementation plan for an AI coding agent. Read `spec.md` first — it explains why the hover path uses coordinates instead of a selector, and the three independent guards that keep a label from describing the wrong element.

## Scope reminder

In scope:
- **`content/picker.js`** — dispatch `spotcheck:element-hovered` on hover change.
- **`content/capture.js`** — debounce it, reuse the existing probe channel, dispatch `spotcheck:hover-component`.
- **`content/component-probe.js`** — accept a `point: { x, y }` target alongside the existing `selector`.
- **`content/overlay.js`** — render the name badge in the existing Shadow DOM root.
- Docs: `PROJECT.md`, `CHROMEWEBSTORE.md`, a forward-pointer line in `docs/features/feature-8-component-name-extraction/spec.md`, and `extension/manifest.json`'s `version` (0.4.0 → 0.5.0).

**Not** in scope:
- Any change to the detection logic itself. Every framework probe, the noise-name filtering, the `confidence` heuristic, and the descriptor shape are Feature 8's and stay exactly as they are.
- Any change to `content/annotations.js`, `content/export.js`, `content/queue.js`, `content/state.js`, `background.js`, or `mcp-server/`. The component already reaches the popup, the Markdown bundle, and `list_annotations` via Feature 8 — none of that changes.
- Any change to `manifest.json` beyond the version string. No new permission; the probe was already being injected.
- Showing the source path, the confidence flag, or the ancestry on the badge — those stay in the popup and the export. See `spec.md`'s "Appearance."
- Persisting or capturing anything on hover. Hovering creates no annotation, no storage write, and therefore no Feature 7 push.

## Step-by-step

### Step 1 — `content/component-probe.js`: accept a point target

Above the `message` listener, add:

```js
function resolveTarget(d) {
  if (d.point && typeof d.point.x === "number" && typeof d.point.y === "number") {
    return document.elementFromPoint(d.point.x, d.point.y);
  }
  return d.selector ? document.querySelector(d.selector) : null;
}
```

In the listener, replace `const el = d.selector ? document.querySelector(d.selector) : null;` with `const el = resolveTarget(d);`. Leave the `tagName` guard and everything downstream untouched — it applies to both branches unchanged.

### Step 2 — `content/capture.js`: generalize the probe request

- Add `HOVER_PROBE_TIMEOUT_MS = 300` and `HOVER_DEBOUNCE_MS = 60` next to the existing `PROBE_TIMEOUT_MS`.
- Change `requestComponent(selector, tagName)` to `requestComponent(target, timeoutMs)`, where `target` is `{ selector, tagName }` or `{ point: { x, y }, tagName }` and is spread into the posted message via `Object.assign({ __spotcheck: "probe-request", nonce }, target)`. Guard with `if (!target || (!target.selector && !target.point)) return Promise.resolve(null);` and fall back to `PROBE_TIMEOUT_MS` when `timeoutMs` is omitted.
- Update the existing `spotcheck:element-selected` call site to the new signature: `requestComponent({ selector: detail.selector, tagName: detail.tagName }, PROBE_TIMEOUT_MS)`.

### Step 3 — `content/capture.js`: the hover listener

```js
let hoverTimer = null;
let hoverSeq = 0;

document.addEventListener("spotcheck:element-hovered", (e) => {
  const detail = e.detail;
  const el = detail && detail.element;
  if (!el) return;

  if (hoverTimer) clearTimeout(hoverTimer);
  hoverTimer = setTimeout(() => {
    hoverTimer = null;
    const seq = ++hoverSeq;
    requestComponent(
      { point: { x: detail.x, y: detail.y }, tagName: el.tagName.toLowerCase() },
      HOVER_PROBE_TIMEOUT_MS
    ).then((component) => {
      if (seq !== hoverSeq) return;                                  // superseded
      if (!component || !component.name || !el.isConnected) return;  // nothing worth showing
      document.dispatchEvent(
        new CustomEvent("spotcheck:hover-component", { detail: { element: el, component } })
      );
    });
  }, HOVER_DEBOUNCE_MS);
});
```

`hoverSeq` is a counter, not a timer id, and it matters: probe replies can arrive out of order, so a slow answer for an element the pointer has left must not overwrite the fast answer for the one it's on.

### Step 4 — `content/picker.js`: emit the hover

In `onMouseMove`, after the existing `spotcheck.overlay.showHighlight(hitEl, "hover")`:

```js
document.dispatchEvent(
  new CustomEvent("spotcheck:element-hovered", {
    detail: { element: hitEl, x: e.clientX, y: e.clientY },
  })
);
```

Note where this sits: *after* the `hitEl === spotcheck.state.hoveredElement` early return, so it fires on hover **change**, not on every `mousemove`. Nothing else in the file changes.

### Step 5 — `content/overlay.js`: the badge

- Declare `let labelEl = null;` and `let labelText = null;` beside `lastTarget` / `lastMode`.
- Add a `.label` rule to the shadow root's stylesheet (fixed, `display: none`, `pointer-events: none`, `max-width: 60vw` with ellipsis, monospace 11px, `background: #3b82f6`) plus `.label.locked { background: #22c55e; }`.
- In `ensureHost`, append a `<div class="label">` after `boxEl`.
- Add `positionLabel(rect)` — `top` is `rect.top - height - 4`, flipped to `Math.max(rect.top + 4, 0)` when that would be off-screen; `left` is `Math.max(rect.left, 0)`. Call it at the end of `applyPosition` so the badge tracks scrolling in the same per-frame pass as the box.
- Add `renderLabel()` — hides when `labelText` is null, otherwise sets the text, syncs the `locked`/`hover` class from `lastMode`, shows it, and repositions.
- In `applyPosition`'s detached-target branch, hide the label alongside the box.
- In `showHighlight`, clear `labelText` **only when `el !== lastTarget`**, then call `renderLabel()` at the end. Clearing on every call would blank the badge at the instant a hover becomes a lock.
- In `hideHighlight`, hide the label and null `labelText`. In `teardown`, null `labelEl` and `labelText` with the rest.
- Add the two listeners:

```js
function applyComponentLabel(el, component) {
  if (!el || el !== lastTarget) return;
  if (!component || !component.name) return;   // never let a placeholder clear a real name
  labelText = component.name;
  renderLabel();
}
document.addEventListener("spotcheck:hover-component", (e) => {
  if (!e.detail) return;
  applyComponentLabel(e.detail.element, e.detail.component);
});
document.addEventListener("spotcheck:element-captured", (e) => {
  if (!e.detail) return;
  applyComponentLabel(e.detail.element, e.detail.component);
});
```

The `element-captured` listener is what labels an element the user clicked without hovering long enough for the hover probe to fire.

### Step 6 — Docs

- **`PROJECT.md`** — add the feature-9 folder to the repo-layout tree, add a DONE entry to §8, and update the status line.
- **`CHROMEWEBSTORE.md`** — add a `0.5.0` version-history entry; note in the Data usage disclosure that the main-world probe now also runs on hover, still read-only, still storing nothing on hover, still no new permission.
- **`docs/features/feature-8-component-name-extraction/spec.md`** — one forward-pointer line noting the hover surface lives in Feature 9.
- **`extension/manifest.json`** — `version` 0.4.0 → 0.5.0, nothing else.

## Test criteria before calling this feature done

Verified against real running apps, not synthetic fixtures — a React 18 dev build (`memo(forwardRef(...))` wrapper, a `styled.div`-named noise wrapper in the tree) and a Vue 3 app using `__name`/`__file`, both driven through the real extension in a real browser:

- [x] **React dev build** — hovering a `memo(forwardRef(SubmitButton))` element shows a `SubmitButton` badge, not `Memo`, `ForwardRef`, or `Slot`.
- [x] **Noise wrapper skipped** — an element rendered inside a component whose `displayName` is `styled.div` labels as the nearest real component (`PriceLabel`), and that wrapper is absent from the ancestry.
- [x] **Vue 3** — hovering shows the SFC name (`SubmitButton`, `PriceLabel`, `App`) with `source: "vue"`.
- [x] **Plain static HTML** — no badge at all, box still highlights, no console errors.
- [x] **Hover → lock** — the badge survives the click, keeps the same name, and switches from the blue hover colour to the green locked colour.
- [x] **Popup agrees with the badge** — the popup's own component line shows the same component plus the source path (`⬡ SubmitButton · src/checkout/SubmitButton.jsx:24`).
- [x] **Reaches the prompt** — the saved record carries the full component object, and the Markdown export renders `**Component:** SubmitButton (react, high) — src/checkout/SubmitButton.jsx:24` plus a `**Component tree:**` breadcrumb.
- [x] **No page errors** on any fixture across the whole hover/click/save cycle.
- [ ] Sweep the pointer quickly across a large page and confirm only a handful of probes fire (the 60 ms debounce) and the badge never shows a name belonging to a previously hovered element.
- [ ] Scroll with the pointer stationary over a labelled element and confirm the badge tracks the box.
- [ ] Hover an element flush against the top of the viewport and confirm the badge flips inside instead of being clipped.
- [ ] Angular, Svelte, and Web Component apps — inherited from Feature 8's detection, still unverified live there.
