# Feature 4 — Export Bundle — plan.md

Implementation plan for an AI coding agent (e.g. Claude Code). Follow the steps in order; each step should be independently testable before moving to the next.

## Scope reminder — simplest version, deliberately

- **Markdown only.** No JSON, no format picker. The whole workflow is "copy, paste into a chat" (Claude Code, ChatGPT, Cursor) — Markdown reads as a report there; JSON reads as data. If something ever needs machine-parseable output (the Phase 2 local MCP server in `PROJECT.md` §8), that's a new, separate concern to design then — not something to half-build into v1 as an unused JSON branch.
- **One button, one action.** No selective export, no per-annotation checkboxes, no preview-before-copy. Click it, the whole current queue is on the clipboard.
- **Clipboard only — `navigator.clipboard.writeText()`, nothing else.** No `fetch`, no download, no file write. Matches the `PROJECT.md` §6 guardrail directly.
- **No new permissions.** `navigator.clipboard.writeText()` from a content script, triggered by a genuine user click (satisfies the Clipboard API's user-gesture requirement), needs nothing added to `manifest.json` — still `["activeTab", "scripting"]`.

## Architecture decision

- **One new file, `content/export.js`, self-contained** — same pattern as `capture.js`/`annotations.js`: listens for events on `document`, never reads another feature's internals directly, tracks its own `SPOTCHECK_SET_ACTIVE` lifecycle independently.
- **Feature 3 needs two small extensions to make this possible without breaking the event-only convention:**
  1. **Store more on each record.** Right now `annotations.js`'s `spotcheck:element-captured` listener only copies `detail.selector` onto the record. Extend it to also store `detail.styles` and `detail.component` — Feature 4 needs both for a useful export, and the alternative (Feature 4 listening to `spotcheck:element-captured` itself and trying to correlate captures with annotations independently) would duplicate Feature 3's own matching logic for no reason.
  2. **Dispatch a full snapshot, not just the one changed item.** `spotcheck:annotation-saved`/`spotcheck:annotation-deleted` currently carry only the single record that changed. But numbers are positional (documented in Feature 3's own `spec.md`) — deleting annotation #2 renumbers #3 down to #2 *without* dispatching any event for #3's own change. A consumer that caches per-item data from these events alone will show a stale number for #3 after that delete. Fix: both events also carry `allAnnotations` — the complete current ordered list, freshly built from `annotationsInOrder` at dispatch time. Feature 4 does a full replace of its local copy on every event, never an incremental patch, so this class of bug can't happen on its side regardless of what changes upstream.
- **A shared UI-host registry, `spotcheck.uiHosts` (a `Set`), replaces the one-off `hitEl === spotcheck.annotations.hostEl` check in `picker.js`.** That check existed so Feature 3's own bubbles/popup wouldn't have their clicks hijacked by the picker's lock logic. Feature 4's export button needs the exact same exemption, and hardcoding a second `hitEl === spotcheck.exportBundle.hostEl` branch alongside the first would just be the same problem duplicated. Instead: `state.js` initializes `spotcheck.uiHosts = new Set()` once; any feature's `ensureHost()` adds its shadow host to it, `stop()` removes it; `picker.js` checks membership in the set instead of naming each feature's host individually. Scales to any future feature that renders its own clickable Shadow DOM UI without `picker.js` needing to know it exists.
- **The button is created eagerly in `start()`, not lazily like Feature 3's popup.** Feature 3's `ensureHost()` is lazy because the popup/bubbles have complex, conditional trigger points (a click, a bubble click, a re-open). The export button has exactly one job and one trigger (its own click) — creating it once when inspection mode turns on, and toggling its visibility via CSS based on the current annotation count, is simpler and avoids the "did ensureHost run yet" bookkeeping Feature 3 needs.

## Files to create / touch

1. **Create** `content/export.js`.
2. **Touch** `background.js` — append `"content/export.js"` to `CONTENT_FILES`.
3. **Touch** `content/state.js` — add the `spotcheck.uiHosts` registry.
4. **Touch** `content/picker.js` — swap the hardcoded `spotcheck.annotations.hostEl` check for a `spotcheck.uiHosts.has(hitEl)` check (both `onMouseMove` and `onClick`).
5. **Touch** `content/annotations.js` — store `styles`/`component` on each record; add `allAnnotations` to both dispatched events; register/unregister `hostEl` with `spotcheck.uiHosts`.

## Step-by-step

### Step 1 — `state.js`: shared UI-host registry

```js
spotcheck.uiHosts = new Set();
```

Added once, at module load, alongside the existing `spotcheck.state` object — `state.js` is always the first file injected, so every later feature can rely on `spotcheck.uiHosts` already existing by the time its own `ensureHost()` runs.

### Step 2 — `picker.js`: use the registry

Both `onMouseMove` and `onClick` currently do:

```js
const hitEl = document.elementFromPoint(e.clientX, e.clientY);
if (hitEl && spotcheck.annotations && hitEl === spotcheck.annotations.hostEl) return; // or the return-without-preventDefault version in onClick
```

Change the condition to:

```js
if (hitEl && spotcheck.uiHosts.has(hitEl)) return;
```

No other change to either function — this only swaps *which* check decides "is this our own UI," not what happens once it matches.

### Step 3 — `annotations.js`: store styles/component, register with `uiHosts`, dispatch snapshots

**A timing bug surfaced during live end-to-end verification of this feature, not caught by unit-testing capture.js or annotations.js in isolation**: `spotcheck:element-captured` fires immediately on *selection*, while a record isn't created until *commit* — a separate, later user action (type a note, click send), not the same click. A listener that only writes onto an existing `annotationsByElement` record (the version originally planned here) finds nothing there yet for a brand-new annotation and silently drops the capture — every first-time annotation would ship with `selector`/`styles`/`component` all `null`. Fixed with a small always-populated cache:

```js
// element -> { selector, styles, component } — the latest capture for any
// selected element, regardless of whether it ever becomes an annotation.
let latestCaptureByElement = new WeakMap();
```

In `saveNote`'s record-creation branch, read from the cache instead of leaving these `null`:

```js
const cached = latestCaptureByElement.get(el);
record = {
  number: annotationsInOrder.length + 1,
  element: el,
  selector: cached ? cached.selector : null,
  styles: cached ? cached.styles : null,
  component: cached ? cached.component : null,
  note: trimmed,
  // ...unchanged fields below
};
```

The `spotcheck:element-captured` listener always updates the cache, and separately keeps an *already-existing* record live too (covers re-selecting an already-annotated element, e.g. via its bubble, to edit it — that path doesn't go through `saveNote`'s cache read again):

```js
document.addEventListener("spotcheck:element-captured", (e) => {
  const el = e.detail && e.detail.element;
  if (!el) return;
  const data = { selector: e.detail.selector, styles: e.detail.styles, component: e.detail.component };
  latestCaptureByElement.set(el, data);
  const record = annotationsByElement.get(el);
  if (record) {
    record.selector = data.selector;
    record.styles = data.styles;
    record.component = data.component;
  }
});
```

Reset alongside `annotationsByElement` in `stop()`: `latestCaptureByElement = new WeakMap();`. Verified live end-to-end after this fix: a fresh element, annotated for the first time, correctly shows its real selector and styles in the exported Markdown — not "(selector unavailable)".

In `ensureHost()`, right after `document.documentElement.appendChild(hostEl)`:

```js
spotcheck.uiHosts.add(hostEl);
```

In `stop()`, right before `hostEl.remove()`:

```js
spotcheck.uiHosts.delete(hostEl);
```

A small snapshot builder, used by both dispatch sites below:

```js
function buildSnapshot() {
  return annotationsInOrder.map((r) => ({
    number: r.number,
    note: r.note,
    selector: r.selector,
    styles: r.styles,
    component: r.component,
    element: r.element,
  }));
}
```

`commit()`'s dispatch becomes:

```js
document.dispatchEvent(
  new CustomEvent("spotcheck:annotation-saved", {
    detail: {
      number: record.number,
      note: record.note,
      selector: record.selector,
      element: record.element,
      allAnnotations: buildSnapshot(),
    },
  })
);
```

`deleteAnnotation()`'s dispatch gets the same addition:

```js
document.dispatchEvent(
  new CustomEvent("spotcheck:annotation-deleted", {
    detail: { number: record.number, element: record.element, allAnnotations: buildSnapshot() },
  })
);
```

`buildSnapshot()` runs *after* `renumberAll()` in `deleteAnnotation`, so the numbers in the snapshot are always the current, post-renumber ones.

### Step 4 — `content/export.js`: the button, the formatter, the copy action

```js
window.__spotcheck = window.__spotcheck || {};

(function (spotcheck) {
  if (spotcheck.exportBundle) return;

  let active = false;
  let annotations = []; // always a full replace from the latest event, never patched incrementally

  let hostEl = null;
  let buttonEl = null;
  let copiedTimer = null;

  function ensureHost() {
    if (hostEl) return;
    hostEl = document.createElement("div");
    hostEl.style.all = "initial";
    hostEl.style.position = "fixed";
    hostEl.style.top = "0";
    hostEl.style.left = "0";
    hostEl.style.width = "0";
    hostEl.style.height = "0";
    hostEl.style.zIndex = "2147483647";
    document.documentElement.appendChild(hostEl);
    spotcheck.uiHosts.add(hostEl);

    const shadowRoot = hostEl.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = `
      .export-button {
        position: fixed;
        right: 16px;
        bottom: 16px;
        display: none;
        align-items: center;
        gap: 6px;
        padding: 8px 14px;
        border-radius: 999px;
        background: #0b0b0c;
        color: #f3f4f6;
        border: none;
        cursor: pointer;
        font-size: 13px;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        box-shadow: 0 8px 24px rgba(0,0,0,0.4);
        pointer-events: auto;
        z-index: 2147483647;
      }
      .export-button:hover { background: #1c1d21; }
      .export-button.copied { background: #22c55e; color: #ffffff; }
    `;
    shadowRoot.appendChild(style);

    buttonEl = document.createElement("button");
    buttonEl.className = "export-button";
    buttonEl.addEventListener("click", onCopyClick);
    shadowRoot.appendChild(buttonEl);

    renderButtonLabel();
  }

  function renderButtonLabel() {
    if (!buttonEl) return;
    buttonEl.textContent = `\u{1F4CB} Copy (${annotations.length})`; // 📋
    buttonEl.style.display = annotations.length > 0 ? "flex" : "none";
  }

  function camelToKebab(prop) {
    return prop.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
  }

  function formatMarkdown() {
    const lines = [
      "# SpotCheck Annotations",
      "",
      `**Page:** ${window.location.href}`,
      `**Title:** ${document.title}`,
      `**Count:** ${annotations.length}`,
      "",
      "---",
    ];

    for (const a of annotations) {
      lines.push("");
      lines.push(`## ${a.number}. \`${a.selector || "(selector unavailable)"}\``);
      lines.push("");
      lines.push(`**Note:** ${a.note}`);

      if (a.component && a.component.name) {
        lines.push("");
        lines.push(`**Component:** ${a.component.name} (${a.component.source})`);
      }

      if (a.styles) {
        lines.push("");
        lines.push("```css");
        for (const [prop, value] of Object.entries(a.styles)) {
          lines.push(`${camelToKebab(prop)}: ${value};`);
        }
        lines.push("```");
      }

      lines.push("");
      lines.push("---");
    }

    return lines.join("\n");
  }

  async function onCopyClick() {
    const markdown = formatMarkdown();
    try {
      await navigator.clipboard.writeText(markdown);
      showCopiedFeedback();
    } catch (err) {
      console.warn("SpotCheck: clipboard write failed", err);
    }
  }

  function showCopiedFeedback() {
    if (!buttonEl) return;
    if (copiedTimer) clearTimeout(copiedTimer);
    const previousLabel = buttonEl.textContent;
    buttonEl.textContent = "✓ Copied";
    buttonEl.classList.add("copied");
    copiedTimer = setTimeout(() => {
      buttonEl.classList.remove("copied");
      renderButtonLabel(); // re-derive rather than restore previousLabel — count may have changed meanwhile
    }, 1500);
  }

  function applySnapshot(detail) {
    if (!detail || !detail.allAnnotations) return;
    annotations = detail.allAnnotations;
    renderButtonLabel();
  }

  document.addEventListener("spotcheck:annotation-saved", (e) => applySnapshot(e.detail));
  document.addEventListener("spotcheck:annotation-deleted", (e) => applySnapshot(e.detail));

  function start() {
    ensureHost();
  }

  function stop() {
    if (copiedTimer) clearTimeout(copiedTimer);
    copiedTimer = null;
    if (hostEl) {
      spotcheck.uiHosts.delete(hostEl);
      hostEl.remove();
    }
    hostEl = null;
    buttonEl = null;
    annotations = [];
  }

  chrome.runtime.onMessage.addListener((message) => {
    if (!message || message.type !== "SPOTCHECK_SET_ACTIVE") return;
    active = message.active;
    if (active) start(); else stop();
  });

  spotcheck.exportBundle = {};
})(window.__spotcheck);
```

- `applySnapshot` is the *only* place `annotations` is ever assigned — always a full replace from the latest event's `allAnnotations`, never an incremental patch. This is what makes the renumber-after-delete problem a non-issue here: whatever Feature 3 says the current list is, right now, is what gets shown and exported.
- `camelToKebab` exists because `styles` keys come from `getComputedStyle` (camelCase JS property names, e.g. `backgroundColor`) — real CSS in a fenced ` ```css ` block should read as `background-color`, not `backgroundColor`.
- The "Copied" feedback re-derives the button's label from current `annotations.length` when it reverts, rather than restoring the exact string it had before — if the count changed while the 1.5s feedback was showing (another annotation saved/deleted in that window), the button shouldn't lie about the count once it reverts.

### Step 5 — `background.js`

```js
const CONTENT_FILES = [
  "content/state.js",
  "content/overlay.js",
  "content/picker.js",
  "content/capture.js",
  "content/annotations.js",
  "content/export.js",
];
```

## Known limitations to leave comments about (not fixed in v1)

- **No format choice.** Markdown only. If a machine-parseable format is ever needed (the Phase 2 local MCP server in `PROJECT.md` §8), design that as its own thing rather than bolting a JSON toggle onto this button.
- **No partial/selective export.** Every annotation currently in the queue goes into the bundle; there's no way to exclude one without deleting it first.
- **No confirmation on copy failure beyond a console warning.** `navigator.clipboard.writeText()` can reject (e.g. the page lost focus at the exact moment of the click, or a permissions-policy edge case) — handled with a `try/catch` and a `console.warn`, not a user-facing error state. Acceptable for v1; revisit if this turns out to be a real occurrence, not just a theoretical one.
- **The button's fixed bottom-right position isn't collision-aware** — on a page that already has something fixed-positioned in that exact corner (a chat widget, a "back to top" button), the two could overlap. Not solved here; same category of tradeoff as the rest of this extension's fixed-position UI.

## Test criteria before calling this feature done

- [ ] With zero annotations, the export button is not visible anywhere on the page.
- [ ] Saving one annotation makes the button appear, showing "📋 Copy (1)".
- [ ] That first, brand-new annotation's exported Markdown shows its **real selector and real styles**, not "(selector unavailable)" and a missing styles block — this is the specific case the `latestCaptureByElement` cache fix (Step 3) exists for; confirmed live once, worth re-confirming here since it's easy to accidentally regress by reverting to the more obvious-looking "just write onto the record" listener.
- [ ] Clicking the button copies text to the clipboard; pasting it elsewhere shows a Markdown document starting with `# SpotCheck Annotations`, the page URL, title, and count.
- [ ] Each annotation appears as its own `##` section with its selector as inline code, its note, and (when present) a component line and a fenced ` ```css ` block of its captured styles in real kebab-case CSS property names (not camelCase).
- [ ] After clicking, the button briefly shows "✓ Copied" with a green background, then reverts to the normal "📋 Copy (N)" label after ~1.5s.
- [ ] Save a second and third annotation, then delete the *first* one (#1) — confirm the export button's count drops to 2, and the copied Markdown shows the surviving two annotations renumbered #1 and #2 (not #2 and #3) — this is the specific case that would break without the `allAnnotations` snapshot fix.
- [ ] Clicking the export button itself does **not** trigger `picker.js`'s lock/select behavior on whatever page element happens to be underneath it — confirms the `spotcheck.uiHosts` registry works for this feature too, not just Feature 3's bubbles.
- [ ] Toggling inspection mode off removes the export button's shadow host entirely — confirm via DevTools Elements panel — and toggling back on starts with the button hidden again (zero annotations, fresh state, matching the reset-on-toggle-off behavior every other feature already has).
- [ ] Opening the Network tab and repeating all of the above produces zero network requests — `navigator.clipboard.writeText()` is a local browser API, not a network call, but worth confirming directly since this is the feature whose entire job is "get data out of the browser."
