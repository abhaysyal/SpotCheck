# Feature 2 — Capture Engine — plan.md

Implementation plan for an AI coding agent (e.g. Claude Code). Follow the steps in order; each step should be independently testable before moving to the next.

## Scope reminder

This feature starts the instant Feature 1 hands off a locked element and ends the instant a structured capture object exists. It does **not**:
- show any UI at all — no overlay changes, no popup, no sidebar (Feature 3)
- let the user pick a tag or write a note (Feature 3)
- queue, serialize, or copy anything to the clipboard (Feature 4)
- attempt any live verification loop back into the page (that's Phase 2 in `PROJECT.md` §8, not v1)

Its only job is: given the element `spotcheck:element-selected` handed off, compute a CSS selector path, a curated set of computed styles, and a best-effort component name, then hand all of it off to whatever listens next.

## Architecture decision

- **One new file, `content/capture.js`, self-contained.** It listens for `spotcheck:element-selected` on `document` independently — it does not read or write anything in `content/state.js`, `content/overlay.js`, or `content/picker.js`, and none of those files need to know it exists. This matches the convention in `CLAUDE.md`: features communicate only via `CustomEvent`s on `document`.
- **No bundler, no ES modules** — same classic-script-in-one-isolated-world model as Feature 1. Wrap in an IIFE with an `if (spotcheck.capture) return` guard, same reasoning as Feature 1: re-injection (e.g. after the `background.js` reload-recovery path) must not throw on redeclaration.
- **The only touch to an existing file is `background.js`'s injection list** — `CONTENT_FILES` needs `content/capture.js` appended so it actually gets injected. This is bootstrap plumbing, not feature coupling: `capture.js` still only talks to the DOM and to `document`-level events once running.
- **Synchronous, best-effort, defensive.** All capture work happens on the main thread inside the `spotcheck:element-selected` handler — no debouncing needed since it only runs once per lock (a click), not per mouse-move. Each of the three sub-captures (selector, styles, component) is wrapped in its own `try/catch` so a failure in one (e.g. an SVG element with no `className` string) never blocks the other two or throws out of the event handler entirely.

## Files to create / touch

1. **Create** `content/capture.js`.
2. **Touch** `background.js` — add `"content/capture.js"` to the end of the `CONTENT_FILES` array.

## Step-by-step

### Step 1 — Selector path

Implement `getSelectorPath(el)`:
- Walk from `el` up through `el.parentElement` until `document.documentElement` is reached.
- At each node, if it has a non-empty `id` **and** `document.querySelectorAll('#' + CSS.escape(id)).length === 1`, use `#id` as that segment and **stop climbing** — an id verified unique in the current document is sufficient to anchor the whole path.
- Otherwise, use the lowercased tag name, and if the node has more than one same-tag sibling under its parent, disambiguate with `:nth-of-type(n)` (1-indexed among same-tag siblings only, not all children — keeps the selector shorter and more readable than a raw `:nth-child` chain while staying unique).
- Join collected segments with `" > "`.
- Use `CSS.escape` (available in all target Chrome versions) for any id/class value inserted into the selector string — don't hand-roll escaping.
- This is guaranteed unique for the exact node clicked (full ancestor chain + positional disambiguation), so no separate runtime "verify it's unique" check is needed — confirm uniqueness instead as a test criterion (Step 5).

### Step 2 — Relevant computed styles

Implement `getRelevantStyles(el)` using `window.getComputedStyle(el)`. Capture a **fixed, curated property list** — not the full `CSSStyleDeclaration` (~300+ properties) — grouped for readability in the code:

```js
const BASE_PROPERTIES = [
  // box model
  "display", "position", "boxSizing", "width", "height",
  "marginTop", "marginRight", "marginBottom", "marginLeft",
  "paddingTop", "paddingRight", "paddingBottom", "paddingLeft",
  "borderTopWidth", "borderRightWidth", "borderBottomWidth", "borderLeftWidth",
  "borderStyle", "borderColor", "borderRadius",
  // typography
  "fontFamily", "fontSize", "fontWeight", "fontStyle", "lineHeight",
  "letterSpacing", "textAlign", "textTransform", "textDecorationLine",
  // color & appearance
  "color", "backgroundColor", "backgroundImage", "opacity", "boxShadow",
  // position/layering
  "top", "right", "bottom", "left", "zIndex", "overflow",
];

const FLEX_PROPERTIES = ["flexDirection", "justifyContent", "alignItems", "flexWrap", "gap"];
const GRID_PROPERTIES = ["gridTemplateColumns", "gridTemplateRows", "gap"];
```

- Always capture `BASE_PROPERTIES`.
- Additionally capture `FLEX_PROPERTIES` only if `computed.display.includes("flex")`, and `GRID_PROPERTIES` only if `computed.display.includes("grid")` — keeps the payload focused instead of dumping irrelevant flex/grid noise onto a block element.
- Store raw string values exactly as `getComputedStyle` returns them (e.g. `"16px"`, `"rgb(17, 24, 39)"`) — **no unit conversion, no rem/px math, no color-space normalization.** That kind of interpretation is exactly the "known hard problem" `PROJECT.md` §8 flags for the Phase 3 Figma-token-mapping work — don't reach for it here.

### Step 3 — Best-effort component name

Implement `getComponentInfo(el)`, trying each method in order and stopping at the first hit. Return `{ name: string | null, source: "react" | "vue" | "data-attribute" | "none" }` — **always include `source`** so downstream consumers (and the exported bundle, eventually) can show how confident the guess is instead of presenting a guess as fact.

1. **React fiber walk.** DOM nodes React attaches to carry an own-property key starting with `__reactFiber$` or `__reactInternalInstance$`. Find it, then walk `fiber.return` upward; at each fiber, if `fiber.type` is a function, use `fiber.type.displayName || fiber.type.name`; if `fiber.type` is an object with a `displayName` (memo/forwardRef), use that. Skip fibers whose `type` is a plain string (host DOM elements like `"div"`) and keep walking. First named hit wins, `source: "react"`.
2. **Vue.** Check `el.__vueParentComponent` (Vue 3) → `.type.name` or `.type.__name`. If absent, check `el.__vue__` (Vue 2) → `.$options.name` or `.$options._componentTag`. `source: "vue"` on a hit.
3. **Data attributes.** Starting at `el` and walking up at most 5 ancestors (inclusive of `el`), check for `data-testid`, `data-component`, `data-cy`, `data-component-name` in that priority order at each level; first non-empty value found wins, `source: "data-attribute"`.
4. **Fallback.** If nothing matched, return `{ name: null, source: "none" }` — do **not** fabricate a name from a nearest ancestor id or class; an honest "unknown" is more useful to the agent than a misleading guess.

### Step 4 — Wire it together and dispatch

```js
function captureElement(el) {
  let selector = null;
  let styles = null;
  let component = { name: null, source: "none" };

  try { selector = getSelectorPath(el); } catch (err) { console.warn("SpotCheck: selector capture failed", err); }
  try { styles = getRelevantStyles(el); } catch (err) { console.warn("SpotCheck: style capture failed", err); }
  try { component = getComponentInfo(el); } catch (err) { console.warn("SpotCheck: component capture failed", err); }

  return {
    element: el,
    tagName: el.tagName.toLowerCase(),
    id: el.id || null,
    classNames: typeof el.className === "string" ? el.className.trim() || null : null,
    selector,
    styles,
    component,
  };
}

document.addEventListener("spotcheck:element-selected", (e) => {
  const el = e.detail && e.detail.element;
  if (!el) return;
  document.dispatchEvent(
    new CustomEvent("spotcheck:element-captured", { detail: captureElement(el) })
  );
});
```

- Note the `typeof el.className === "string"` guard: on SVG elements `className` is an `SVGAnimatedString` object, not a string — this deliberately falls back to `null` rather than throwing or capturing `[object SVGAnimatedString]`.
- `spotcheck.capture = { captureElement }` at the end, hung off the shared namespace, same pattern as `overlay`/`picker` in Feature 1.

### Step 5 — Update `background.js`

Change:
```js
const CONTENT_FILES = ["content/state.js", "content/overlay.js", "content/picker.js"];
```
to:
```js
const CONTENT_FILES = ["content/state.js", "content/overlay.js", "content/picker.js", "content/capture.js"];
```
Order doesn't functionally matter for `capture.js` (it only depends on `document` and the DOM, not on `state`/`overlay`/`picker`), but append it last for readability — it's the last stage in the current pipeline.

**A `captureGap(gap)` companion function briefly existed here, for Feature 1's now-removed gap-selection mode.** Removed along with it — `captureElement(el)` below is once again the only capture path. See Feature 1's `spec.md` for why gap-selection was tried and dropped.

## Known limitation to leave a comment about (not fixed in v1)

- **Component name detection is best-effort against undocumented framework internals** (`__reactFiber$*`, `__vueParentComponent`, etc.). These are private implementation details that can change between React/Vue versions, and minified production builds often strip `displayName`/function names, degrading `fiber.type.name` to a single letter or empty string. Leave a `// TODO` noting this is expected to be imperfect, not a bug to chase.
- **SVG element class names are not captured** (`className` is an `SVGAnimatedString`, not a string, on SVG elements) — `classNames` comes back `null` for those nodes. Leave a `// TODO`.

## Test criteria before calling this feature done

- [ ] Selecting an element with a page-unique `id` fires `spotcheck:element-captured` with `selector === "#that-id"`.
- [ ] Selecting a deeply nested element with no id and repeated sibling tags yields a selector that resolves to exactly one node: verify with `document.querySelectorAll(selector).length === 1` in the console.
- [ ] On a real React app (any site with React DevTools able to inspect it), selecting an element under a named component returns `component.source === "react"` and a non-null `component.name` for at least one ancestor level.
- [ ] On a real Vue app, selecting an element returns `component.source === "vue"` similarly.
- [ ] On a plain static HTML page (no framework), selecting any element returns `component: { name: null, source: "none" }` — no thrown errors, no console errors.
- [ ] `styles` includes `FLEX_PROPERTIES` only when selecting a flex container (`display: flex`), and `GRID_PROPERTIES` only when selecting a grid container — verify both by comparing against a plain block `<div>` selection, which should have neither.
- [ ] Selecting an SVG element, a `<table>` cell, and an element with no `id`/`class` at all all complete without throwing — confirms the `try/catch` isolation in Step 4 actually works, not just that the happy path works.
- [ ] Toggling inspection mode off and back on (per the Feature 1 reload-recovery fix in `background.js`), then selecting again, still fires a correct `spotcheck:element-captured` — confirms `capture.js` survives the same re-injection path `picker.js` does.
- [ ] Opening the Network tab and repeating all of the above produces zero network requests — this feature is pure synchronous DOM reads, same guardrail as Feature 1.
