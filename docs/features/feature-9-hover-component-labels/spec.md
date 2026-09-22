# Feature 9 — Hover Component Labels — spec.md

## What it does

Shows the detected component name **on the hover highlight, while the user is still pointing at the page** — the small name badge the React and Vue devtools inspectors put on their highlight box — instead of only after a click.

Feature 8 already detects the component (React, Vue 2/3, Svelte, Angular, Web Components, Astro islands) and already threads it into the annotation popup, the Markdown export, and the MCP `list_annotations` summary. What it did *not* do is surface it before selection: `content/component-probe.js` only ever ran on `spotcheck:element-selected`, so the user had to commit to an element to find out what it was. That is backwards for the picking task itself — knowing you're hovering `SubmitButton` and not `Primitive.button` is exactly what tells you whether to click here or one level up.

This feature adds **no new detection logic**. Same probe, same `{ name, source, confidence, sourcePath, sourceLine, ancestry }` descriptor, same MAIN-world file. Only the trigger and the rendering surface are new.

## Why it's a separate feature from 8

Feature 8's scope note says it is "component *identity* only." Its plan deliberately left `content/picker.js` and `content/overlay.js` untouched, and its whole two-world design was built around the click path's timing budget (an 800 ms probe deadline, a second `spotcheck:element-captured` dispatch to deliver a late answer). Hover has a different budget and a different failure mode — a label that arrives after the pointer has moved on is not late, it is *wrong* — so it gets its own timeout, its own debounce, and its own staleness rule. Keeping that in one place rather than smearing it through Feature 8's click path is why this is Feature 9 and not an edit to Feature 8's spec.

## How it works

```
picker.js  ──spotcheck:element-hovered──►  capture.js  ──postMessage──►  component-probe.js
(ISOLATED)   { element, x, y }              (ISOLATED)   probe-request      (MAIN)
                                                 ▲                            │
overlay.js ◄──spotcheck:hover-component──────────┴──────probe-response───────┘
(ISOLATED)   { element, component }
```

Four small changes, all on the existing rails:

1. **`content/picker.js`** dispatches `spotcheck:element-hovered` with `{ element, x, y }` — fired only when the hovered element actually *changes*, not on every `mousemove` (the existing early-return in `onMouseMove` already provided that gate). Per the repo's cross-feature convention, it dispatches a `CustomEvent` rather than calling into capture.js.

2. **`content/capture.js`** listens, debounces, and reuses its existing probe channel. It dispatches `spotcheck:hover-component` with `{ element, component }` when an answer comes back with a name.

3. **`content/component-probe.js`** gains a second way to name the element to probe: a `point: { x, y }` alongside the existing `selector`. See "Point, not selector" below.

4. **`content/overlay.js`** renders the name as a badge on the highlight box, in the same Shadow DOM root as the box, repositioned in the same per-frame `applyPosition` pass so it tracks scrolling exactly like the box does.

### Point, not selector

The click path hands the probe a CSS selector because `capture.js` has already computed one for the locked element — it is free to reuse. Hover has no such selector, and computing a full selector path for every element the pointer crosses, purely so it can be handed back through `document.querySelector`, is round-trip work for nothing.

Instead the hover path passes the pointer coordinates `picker.js` already has, and the probe resolves them with `document.elementFromPoint` — the same call the picker itself used to decide what is hovered. Both worlds share one DOM and one viewport, and `clientX`/`clientY` are viewport-relative, so the coordinates resolve in the MAIN world to exactly the node the user is pointing at. `component-probe.js`'s `resolveTarget(d)` picks the branch; everything downstream of it is unchanged.

### Three guards against a stale or wrong label

A hover label is only useful if it describes the element under the pointer *right now*. Three independent things enforce that:

- **`tagName` check (in the probe).** Already used by the click path for DOM reflow; it applies just as well to a page that moves something out from under a stationary pointer. A mismatch reports nothing rather than a wrong component.
- **`hoverSeq` (in `capture.js`).** A monotonic counter, incremented per probe. Replies can arrive out of order — a deep fiber tree takes longer to walk than a shallow one — so a slow answer for an element the pointer has already left must not overwrite the faster answer for the one it is on now. Only the newest request's reply is dispatched.
- **`el !== lastTarget` (in `overlay.js`).** The final gate: a descriptor that does not describe the currently highlighted element is dropped, whatever produced it.

### Timing

| Constant | Value | Why |
|---|---|---|
| `HOVER_DEBOUNCE_MS` | 60 | Sweeping the pointer across a page crosses dozens of elements. Without a debounce each one costs a `postMessage` round trip and a fiber-tree walk for a label nobody sees. 60 ms collapses a sweep to a single probe and stays below the threshold where the badge reads as laggy. |
| `HOVER_PROBE_TIMEOUT_MS` | 300 | The click path's 800 ms is far too long here: a label that lands a second late is describing the wrong element. Give up quietly instead. |

### Label lifecycle

- Cleared when the highlight moves to a **different** element — not when it merely changes mode. Clicking to lock re-highlights the *same* element as `locked`, and dropping the name there would flicker it off at the exact moment the user commits.
- A **nameless** component never clears an existing label. The click path deliberately dispatches an empty placeholder first and fills it a beat later (Feature 8's two-dispatch design); that placeholder must not wipe a name hover already resolved.
- `overlay.js` also listens to `spotcheck:element-captured`, so the locked element gets labelled even if the pointer never rested on it long enough for the hover probe to run.
- Hidden with the box on Escape, on toggle-off, and when the tracked element leaves the DOM.

### Appearance

A compact monospace badge above the box's top-left corner, colour-matched to the box it belongs to (`#3b82f6` hover / `#22c55e` locked), flipping to just inside the top edge when the element is hard against the viewport top. Truncated with an ellipsis past `60vw`. `pointer-events: none`, so it can never intercept a click meant for the page — and because it lives in overlay.js's existing Shadow DOM host (a 0×0 fixed host that is already in `spotcheck.uiHosts`), it introduces no new hit-testing surface for `picker.js` to have to reason about.

**The badge shows the name only.** Not the source path, not the confidence flag, not the ancestry — those stay in the popup and the export, where there is room to read them and time to act on them. The hover badge answers one question, the one the devtools inspectors answer: *what am I pointing at?*

## Guardrails

Unchanged from Feature 8, and worth stating explicitly because this feature makes the probe run much more often:

- **No new permission, no manifest change beyond the version string.** Same `activeTab` + `scripting` + `storage` + loopback `host_permissions` baseline.
- **Still read-only.** Every added path is a property/attribute read plus a same-frame `postMessage`. Nothing is written to the page, nothing is captured or persisted on hover — hovering an element creates no annotation, no storage write, and therefore no Feature 7 push.
- **Zero network calls.** As before.
- **Still inert until the user acts.** The hover path only exists while inspection mode is on; `picker.js` is the only thing that fires `spotcheck:element-hovered`, and it only has listeners attached between `start()` and `stop()`.

## Relationship to other features

- **Feature 1 (Inspection Mode)** — `picker.js` gains one dispatch, `overlay.js` gains the badge. The picker's own hit-testing, the `uiHosts` check, and the Escape behaviour are untouched.
- **Feature 8 (Component Name Extraction)** — supplies all detection. This feature adds a second trigger for it and nothing else. Any improvement to the probe's framework coverage improves the hover badge for free.
- **Features 3/5/6 (Annotation Layer)** — untouched. `annotations.js`'s own component line still comes from `spotcheck:element-captured`, exactly as Feature 8 built it.
- **Features 4 and 7 (Export / MCP)** — untouched. The component already reaches the Markdown bundle and `list_annotations` via Feature 8; nothing about the exported payload changes here.

## Known limitations

- **Cross-origin iframes.** Inherited from `picker.js` — `elementFromPoint` cannot see into them, so hovering one labels the `<iframe>` element itself. Out of scope, same as it was for Feature 1.
- **Production builds.** A minified React bundle yields minified names or none at all; the badge shows whatever Feature 8's `looksMinified` heuristic lets through, and nothing when there is no usable name. This is the honest outcome, not a regression.
- **No badge for a nameless framework hit.** When the probe knows a framework is present but cannot name the node (`{ name: null, source: "react" }`), no badge is shown. Showing "react" alone would be noise on a picker that is already visibly highlighting the element.
