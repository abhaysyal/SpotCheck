# Feature 1 — Inspection Mode / Element Picker — plan.md

Implementation plan for an AI coding agent (e.g. Claude Code). Follow the steps in order; each step should be independently testable before moving to the next.

## Scope reminder

This feature ends at "the user has locked onto one DOM element." It does **not**:
- compute a CSS selector path, computed styles, or component name (Feature 2)
- show any annotation UI, tags, or notes (Feature 3)
- export or copy anything (Feature 4)

Its only job is to let the user toggle a picker on, hover to preview, click to lock a single element, and hand that element off to whatever listens for it next.

## Architecture decision

- **No bundler, no ES modules in the content script.** Use plain classic scripts, injected in sequence via `chrome.scripting.executeScript`'s `files` array (see Step 1 below — not a static `manifest.json` `content_scripts` entry, which this extension deliberately never has). They share the same isolated-world global scope, so use a single namespaced object (`window.__spotcheck`) instead of imports/exports to avoid MV3 content-script module-loading complexity.
- **Overlay rendered in a Shadow DOM root**, not directly in page markup — isolates the picker's own styles from arbitrary host-page CSS in both directions.

## Files to create

1. `manifest.json` — MV3 manifest.
2. `background.js` — service worker, handles the toolbar icon click and injection.
3. `content/state.js` — tiny shared state module (namespaced global, not ES module).
4. `content/overlay.js` — draws/updates/removes the highlight box, inside a Shadow DOM root.
5. `content/picker.js` — wires up hover, click, and Escape-to-cancel; owns the on/off lifecycle.

## Step-by-step

### Step 1 — `manifest.json`
- `manifest_version: 3`.
- `permissions: ["activeTab", "scripting"]` only. No `host_permissions`, no `<all_urls>` — the extension should only ever touch the tab the user explicitly toggled it on for (matches the "no persistent DOM access" guardrail).
- `action` block with a toolbar icon (this is the toggle control for v1 — no popup UI needed yet).
- Do **not** list the content scripts under `content_scripts` in the manifest for static injection. Instead, inject on demand from `background.js` via `chrome.scripting.executeScript` when the icon is clicked. This keeps the extension fully inert on pages until the user acts.

### Step 2 — `background.js`
- Track picker state per tab in a `Map<tabId, boolean>` (in-memory only, resets on browser restart — no `chrome.storage` needed for this feature).
- On `chrome.action.onClicked`:
  - If not yet injected for that tab, `chrome.scripting.executeScript` the three content files in order: `state.js`, `overlay.js`, `picker.js`.
  - Send a `{ type: "SPOTCHECK_SET_ACTIVE", active: boolean }` message to the tab via `chrome.tabs.sendMessage` either way (first injection should self-start in the "on" state; subsequent clicks send the inverse of what `background.js` currently believes). **Revised after Feature 3**: this started as a flip-only `SPOTCHECK_TOGGLE` message with no payload, but once a second content script (`annotations.js`) also needed to track its own on/off lifecycle independently, a flip protocol meant any transient desync between listeners compounded instead of self-correcting — surfaced as "sometimes needs two clicks to turn back on." Sending the absolute next state instead makes every listener converge on the next message regardless of what it currently thinks. See Feature 3's `plan.md` for the fuller story.
- Update the action icon (e.g. swap badge text "ON"/off) to reflect state — gives the user unambiguous feedback that inspection mode is live.

### Step 3 — `content/state.js`
- Define `window.__spotcheck = window.__spotcheck || {}` and hang everything off it to avoid re-declaring on re-injection.
- State to hold: `active` (bool), `hoveredElement`, `selectedElement`, `shadowRoot` reference.
- Two functions: `setSelectedElement(el)` — stores it, shows the locked highlight (`overlay.showHighlight(el, "locked")` — added after Feature 3, see that feature's docs), and dispatches a `CustomEvent('spotcheck:element-selected', { detail: { element: el } })` on `document` — and `clearSelection()`.
- Downstream features (Feature 2, Feature 3) hook in purely by listening for `spotcheck:element-selected`; they should never need to read `background.js` or know how selection happened.

### Step 4 — `content/overlay.js`
- On first run, create one `<div>` host element attached to `document.documentElement`, call `.attachShadow({ mode: 'open' })` on it, and build the highlight box (an absolutely-positioned `<div>`) inside that shadow root.
- `showHighlight(el, mode)` — `mode` is `"hover"` or `"locked"`, each with a distinct outline color (e.g. blue for hover, green for locked) — position the box via `el.getBoundingClientRect()` plus `window.scrollX/scrollY`, matched to viewport coordinates since the box uses `position: fixed`. **Revised after real-usage feedback**: this only repositioned the box when `showHighlight` itself was called, so scrolling without moving the mouse left it visually detached from its element. Fixed with a continuous `requestAnimationFrame` loop (started when the host is first created, stopped in `teardown()`) that re-applies the last target's live rect every frame — see `spec.md` for the fuller reasoning and why a `scroll` listener wouldn't have actually closed the gap.
- `hideHighlight()` — hides the box without removing the shadow host, so toggling stays cheap.
- `teardown()` — fully removes the shadow host from the DOM. Called when inspection mode is turned off.
- Give the shadow host a very high `z-index` and `pointer-events: none` on the box itself so it never intercepts the click meant for the page underneath.

### Step 5 — `content/picker.js`
- Listen for the `SPOTCHECK_SET_ACTIVE` message from `background.js`; set `state.active` to the message's `active` value (not a flip — see the note in Step 2) and either start or stop listening.
- **When turning on:**
  - Attach a `mousemove` listener on `document` (capture phase) that calls `document.elementFromPoint(x, y)` and, if it differs from the currently hovered element, calls `overlay.showHighlight(el, "hover")`.
  - Attach a `click` listener on `document` (capture phase, with `event.preventDefault()` + `event.stopPropagation()`) that locks the hovered element as the selected one: `state.setSelectedElement(el)`. **Revised after Feature 3**: `setSelectedElement` itself now calls `overlay.showHighlight(el, "locked")` internally (moved out of `picker.js`), so every path that selects an element — a fresh page click here, or Feature 3 re-selecting an already-annotated element via its bubble — shows the same highlight without duplicating that call at each call site. See Feature 3's `plan.md`/`spec.md`.
  - Attach a `keydown` listener for `Escape` that clears the current lock and returns to hover mode (does not fully exit inspection mode — that's the toolbar icon's job).
- **When turning off:** remove all three listeners, call `overlay.teardown()`, call `state.clearSelection()`. No listeners or DOM nodes should remain — verify this explicitly in testing (Step 6).
- `elementFromPoint` naturally returns the innermost element under the cursor, which is what gives the DevTools-style "drill down to the precise child" behavior — no extra ancestor-walking logic is needed for that part.

**A "select the space between two elements" mode was tried here and removed.** Briefly added a `detectGapAt`/`detectTarget` pair in `picker.js` plus a `getGapRect` utility, `setSelectedGap`, and new highlight modes elsewhere, then removed all of it after it turned out selecting the shared parent container (which Feature 2 already captures the `display`/`gap` of normally) gives the same actionable information without a second selection mode or a modifier key to learn — see `spec.md`'s "What it does" note for the fuller reasoning. Step 5 above is, once again, the complete, current picker: plain `elementFromPoint`, no branching, no modifier keys.

## Known limitation to leave a comment about (not fixed in v1)

`elementFromPoint` cannot see inside cross-origin `<iframe>`s — the picker will select the iframe element itself, not its internal content. Leave a `// TODO` noting this; it's out of scope for v1.

## Test criteria before calling this feature done

- [ ] Clicking the toolbar icon toggles the badge and starts/stops hover highlighting — verify no console errors on toggle.
- [ ] Hovering over deeply nested elements highlights the innermost element under the cursor, not a parent container.
- [ ] Clicking locks the element (highlight box changes color/style) and does **not** trigger the underlying page's own click handler (e.g. clicking a link or button should not navigate/fire).
- [ ] Pressing `Escape` clears the lock and returns to hover-tracking mode without exiting inspection mode entirely.
- [ ] Toggling the icon off removes the shadow-DOM overlay entirely — confirm via DevTools Elements panel that no `spotcheck`-related nodes remain, and no listeners remain attached (spot-check by hovering after toggle-off and confirming nothing highlights).
- [ ] Opening the Network tab and repeating all of the above produces zero network requests.
- [ ] A `spotcheck:element-selected` custom event fires on `document` with the correct element in `event.detail.element` on every lock — verify with a temporary `document.addEventListener` in the console.
