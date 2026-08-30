# Feature 2 — Capture Engine — spec.md

## What it does

The instant Feature 1 locks an element, this feature computes everything an AI coding agent would need to locate and reason about that exact node without inspecting the page itself: a unique CSS selector path, a curated snapshot of its computed styles, and a best-effort guess at its source-level component name. It hands all three off together as one structured object — nothing about *what the user thinks is wrong* with the element (that's Feature 3's tag/note), and nothing about *exporting* it (Feature 4).

**A parallel "gap capture" (selectors for two bracketing siblings, parent selector, parent `display`/`gap`, both elements' margins) was built for Feature 1's now-removed gap-selection mode, then removed along with it.** Selecting the shared parent container directly — through Feature 1's single, unmodified click/hover, no separate mode — already captures its `display` and `gap` (see `getRelevantStyles` below), which turned out to be the actionable piece; see Feature 1's `spec.md` for the fuller reasoning behind dropping gap-selection as its own concept.

## How it works

- **Pure event subscriber, zero coupling to Feature 1's internals.** `content/capture.js` listens for `spotcheck:element-selected` on `document`, same as any other downstream feature would. It never reads `content/state.js`'s state object directly and never calls into `overlay.js` or `picker.js` — matching the `CLAUDE.md` convention that features only communicate via `CustomEvent`s.
- **New event: `spotcheck:element-captured`.** On every `spotcheck:element-selected`, this feature synchronously computes a capture object and dispatches:
  ```js
  document.dispatchEvent(new CustomEvent("spotcheck:element-captured", { detail: {
    element,       // same HTMLElement reference that was selected
    tagName,       // lowercased tag name, e.g. "button"
    id,            // string | null
    classNames,    // string | null (null for SVG elements — see limitations)
    selector,      // string | null — CSS selector path, unique in the current document
    styles,        // Record<string,string> | null — curated computed style snapshot
    component,     // { name: string | null, source: "react" | "vue" | "data-attribute" | "none" }
  }}));
  ```
  This is the hand-off contract downstream features build against — Feature 3 and Feature 4 should read from this event's `detail`, not recompute any of it themselves.
- **Selector generation favors structural uniqueness over semantic-looking-but-fragile class names.** The path is built from tag names plus `:nth-of-type` disambiguation (with an `#id` short-circuit when a verified-unique id is available partway up the tree) — never from raw class lists. Modern build tooling (CSS modules, styled-components, Tailwind's JIT, etc.) routinely produces class names that are hashed or regenerated per build; a selector that depends on them looks precise today and silently breaks tomorrow. Raw `classNames` is still captured and handed off separately as a *readability/context hint*, just never relied on for uniqueness.
- **Computed styles are a fixed, curated property list, not the full computed style object.** `getComputedStyle` exposes several hundred properties; capturing all of them would bury the handful actually relevant to design QA (box model, typography, color, layout) in noise the agent would have to filter itself. Flex/grid-specific properties — including `gap` — are included conditionally, based on the element's own computed `display` value, so a plain block element's capture doesn't carry irrelevant flex properties, and a flex/grid *container*'s capture always includes its own `gap` value directly. This is what makes selecting a spacing-bearing container (rather than a dedicated gap-selection mode) enough to answer "which parent has that spacing, and what's the mechanism."
- **Component name detection is explicitly best-effort and says so.** Rather than silently returning a guess, every capture includes a `source` field (`"react" | "vue" | "data-attribute" | "none"`) so anything reading this data — a future dashboard view, the exported bundle, the agent itself — can distinguish "confirmed via React's own fiber tree" from "no signal found." This mirrors the caution `PROJECT.md` §8 raises about the Figma-token-mapping problem: don't let an unreliable inference present itself as a fact.
  - **Superseded by Feature 8.** The `getComponentInfo` described here is Feature 2's first pass. Feature 8 rewrote it in place (same file, same `spotcheck:element-captured` event) into a modern-framework-aware extraction — `memo`/`forwardRef`/library-wrapper unwrapping, Svelte/Angular/Web Component/Astro coverage — and widened the `component` object to `{ name, source, confidence, sourcePath, sourceLine, ancestry }` (`source` also gains `"svelte" | "angular" | "web-component"`). See `docs/features/feature-8-component-name-extraction/spec.md` for the current shape and behavior; everything below about the *selector* and *styles* capture is unchanged.
- **Defensive per-field, not defensive overall.** Selector, styles, and component detection are each wrapped in their own `try/catch`. A failure in one (e.g. component detection throwing on some exotic custom element) still lets the other two fields populate normally, and `spotcheck:element-captured` still fires — a partial capture is more useful to downstream features than none at all.

## Guardrails specific to this feature

- **Still no new permissions.** Everything here is synchronous reads against the already-injected content script's DOM access (`getComputedStyle`, `querySelectorAll`, property lookups on DOM nodes) — no new Chrome API surface, so `manifest.json` permissions stay exactly `["activeTab", "scripting"]`, unchanged from Feature 1.
- **Still no network calls.** Nothing here ever constructs a `fetch`/`XMLHttpRequest` or talks to anything outside the current page's own DOM.
- **Still read-only.** This feature only ever reads DOM/style state; it does not set any style, attribute, or content on the page being inspected. Property lookups like `el.__reactFiber$...` are reads of properties the framework itself already attached — the extension doesn't attach anything to the host page's elements.
- **No raw framework internals leak into the exported/stored shape.** `component` exposes only a plain `{ name, source }` — never the raw fiber/vnode object itself (which holds live references into the app's internal render tree and would be both unsafe to retain and meaningless outside the page's own JS context).

## Known limitations

- **Component name detection relies on undocumented, version-fragile framework internals** (`__reactFiber$*` property naming, `__vueParentComponent`/`__vue__` shapes). These aren't public APIs — they've been stable in practice across recent React/Vue major versions but aren't guaranteed to stay that way, and minified production builds frequently strip the `displayName`/function names this depends on, degrading results to `source: "none"` even when a framework is genuinely present. Treated as an accepted best-effort limitation, not a bug to chase down.
- **SVG elements report `classNames: null`.** `Element.className` is an `SVGAnimatedString` object (not a plain string) on SVG nodes; rather than special-case `.baseVal` extraction for a corner case, this is left as a known gap.
- **`event.detail` on `spotcheck:element-captured` reads as `null` from a plain DevTools console listener** — same isolated-world/main-world cloning caveat documented in Feature 1's `spec.md`, and it applies here too since `detail.element` is a live DOM reference. Not a bug in this feature; see that note for how to verify manually.
- **No live re-verification.** A capture is a snapshot at the moment of selection — if the page's layout changes afterward (e.g. a responsive breakpoint, a re-render), the captured styles/selector are not refreshed. Re-selecting the same element recomputes from scratch; there's no subscription to keep a capture "live." Live verification against a proposed fix is explicitly Phase 2 scope (`PROJECT.md` §8), not this feature.

## Relevance / dependencies

- **Depends entirely on Feature 1.** Subscribes to `spotcheck:element-selected` and does all of its work against `event.detail.element`. Has no dependency on Feature 1's internal state, overlay, or picker lifecycle beyond that one event existing — and no dependency on Feature 1's `background.js` reload-recovery behavior either, beyond needing to actually be present in the injected file list (`CONTENT_FILES`) to receive the event at all.
- **Feature 3 (Annotation Layer)** depends on this feature for the actual data it attaches a tag/note to: it should listen for `spotcheck:element-captured` (not just `spotcheck:element-selected`) to get `selector`/`styles`/`component` before it can build a complete annotation. `spotcheck:element-captured` does fire synchronously right after `spotcheck:element-selected`, for the same selection — but Feature 3's own annotation *record* isn't necessarily created yet at that point (it's only created on commit, a separate and later user action: typing a note, clicking send). Feature 3 caches every capture independently of whether an annotation exists yet for exactly this reason — see that feature's `spec.md` for the fix; an earlier version of this note assumed "captured always follows selected for the same click" was enough on its own, which undersold the actual timing gap.
- **Feature 4 (Export Bundle)** never listens to this feature's events directly — it only ever serializes whatever Feature 3 has already queued, which by then includes this feature's output.
