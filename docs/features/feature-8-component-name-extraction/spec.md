# Feature 8 — Component Name Extraction — spec.md

## What it does

Turns Feature 2's single best-effort `component: { name, source }` guess into a **modern-framework-aware** extraction: it unwraps the wrapper components that today's component libraries bury real names under (`React.memo`, `forwardRef`, Radix `Slot`/`Primitive.*`, styled-components/emotion, Vue `<script setup>`, etc.), climbs to the nearest *meaningful* user component instead of stopping at the first framework artifact, records the **source file path and line** when the page's own dev build exposes one, and returns the full **component ancestry** rather than just the innermost name. It also widens coverage beyond React/Vue to Svelte, Angular, Astro islands, and native Web Components.

The point is the downstream agent loop: "the spacing on `div:nth-of-type(2) > button` is off" is far more actionable as "`SubmitButton` in `src/checkout/SubmitButton.tsx:24`, rendered inside `CheckoutForm`." That file path is the single most useful thing this feature adds — it's what lets Claude Code open the right file instead of grepping for a selector.

### Framework coverage

The intent is that **every mainstream modern component framework produces a usable answer**, not just React. Concretely, this feature ships probes for:

| Stack | Name from | Source path from | Ancestry |
|---|---|---|---|
| React (incl. Next.js app/pages router, CRA, Vite, Remix) | fiber tree, `memo`/`forwardRef` unwrapped, library wrappers filtered | `fiber._debugSource` (dev) | fiber `.return` chain |
| Vue 3 (incl. `<script setup>`, Nuxt) | `type.__name` / `type.name` | `type.__file` (dev) | `.parent` chain |
| Vue 2 | `$options.name` | `$options.__file` (dev) | `$parent` chain |
| Svelte / SvelteKit | filename basename | `el.__svelte_meta.loc` (dev) | not available (`[]`) |
| Angular | `constructor.name` via `window.ng.getComponent` (dev) | not exposed by Angular | `getOwningComponent` walk |
| Web Components / Lit / Stencil / FAST | custom element tag or constructor name | not exposed | tag |
| Astro islands | file basename | `data-astro-source-file` + `-loc` (dev) | not available |
| Anything with `react-dev-inspector`-style attributes | (name from framework) | `data-inspector-file` + `-line` | (from framework) |

Frameworks with **no per-DOM-node instance handle** — Solid, Qwik, Alpine, htmx, and hand-written vanilla — are out of reach by design; they fall through to a `data-*` hint or `source: "none"`. Utility-first CSS (Tailwind, UnoCSS) is *not* a component signal and is not read here — see "Future directions."

**Still best-effort, and still says so.** This feature widens the set of situations that produce a confident answer; it does not make component detection guaranteed. Minified production builds, React Server Components, and frameworks with no per-DOM-node instance handle (Solid, Qwik, htmx) still degrade — now to an explicit `confidence: "low"` or `source: "none"` rather than a misleading name.

## Why this is enhanced in place, not a new module + new event

`CLAUDE.md`'s cross-feature convention (features talk via `CustomEvent`s on `document`, never direct calls) is about not coupling *separate* features' internals. Component detection has lived inside `content/capture.js` since Feature 2, and every consumer — `annotations.js`, `export.js`, the persisted queue, Feature 7's MCP `get_annotation` — already reads it off the existing `spotcheck:element-captured` event's `detail.component`. Splitting the richer logic into a new `content/component.js` firing a new `spotcheck:component-resolved` event would:

- strand the existing `detail.component` field as a half-answer every consumer would still have to read, then wait for a second event to override;
- add a second capture-timing hop to reason about (Feature 2's spec already documents the `selected` → `captured` → `record-created` timing gap `annotations.js` works around — a third event widens that);
- give Feature 8 no actual isolation benefit, since it reads the same DOM the same way at the same moment.

So Feature 8 **rewrites `getComponentInfo` and its helpers inside `capture.js`**, keeps the `spotcheck:element-captured` event and the `component` field name unchanged, and only enriches the shape of that object. This is a deliberate call, flagged here the same way Feature 6 flagged enhancing its own capture path rather than inventing new surface. It is not a precedent for one feature reaching into another's module — `capture.js` is Feature 2's and Feature 8's shared home for exactly one concern.

## Data shape — the enriched `component` object

`spotcheck:element-captured`'s `detail.component`, superseding Feature 2's `{ name, source }`:

```js
component: {
  name: string | null,          // nearest MEANINGFUL component name (wrapper/library artifacts filtered out)
  source: "react" | "vue" | "svelte" | "angular" | "web-component" | "data-attribute" | "none",
  confidence: "high" | "low",    // "high": a named user component from a live framework instance tree, or a dev-only source attribute. "low": name is present but suspect — mangled/single-char, a bare generic tag, or only a data-* value with no framework confirmation.
  sourcePath: string | null,     // file path, when the page's dev build exposed one (React _debugSource, Vue/Svelte __file / __svelte_meta, Astro data-astro-source-file). Lightly normalized (see below); null in production builds.
  sourceLine: number | null,     // 1-indexed line from the same source, or null
  ancestry: string[],            // meaningful component names, NEAREST FIRST, consecutive-deduped, capped at 8 — e.g. ["SubmitButton", "CheckoutForm", "CheckoutPage"]. [] when nothing meaningful was found.
}
```

- **Backward compatible for existing readers.** `name` and `source` keep their Feature 2 meaning; `source` only gains new enum values. `export.js` and `mcp-tools.js` are updated in this feature to use the new fields; nothing else that reads `component` needs to change, because `annotations.js` and `queue.js` treat it as an opaque blob (they copy `e.detail.component` onto the record and serialize it — verified, `annotations.js:1120`, `:764`, `:848`, `:1131`).
- **`ancestry[0]` is normally equal to `name`.** They differ only when `name` had to fall back to a low-confidence source (a data attribute, a bare tag) that isn't part of the framework instance chain `ancestry` was built from — in that case `ancestry` may be `[]` while `name` is still set.
- **`sourcePath` normalization is deliberately minimal.** Dev tooling emits an absolute path from the *build* machine (e.g. `/Users/someone/proj/src/App.tsx`). This feature trims it to start at the last occurrence of a common project-root segment (`src/`, `app/`, `pages/`, `components/`, `lib/`) when one is present, otherwise stores it verbatim. It does **not** resolve, verify, or read the path — the extension has no filesystem access and this is not it acquiring any. The agent consuming it must treat it as a hint and fall back to the basename if the path doesn't exist in its checkout.

## How it works

All detection is synchronous own-property / attribute reads on DOM nodes the frameworks themselves already annotated — the same technique and the same guardrail posture as Feature 2. Methods are tried in priority order; the first that yields a name wins its `source`, but `sourcePath`/`sourceLine` and `confidence` can still be filled from a lower-priority signal if the winner didn't provide them (e.g. a React name from the fiber tree + a source line from a `data-inspector-line` attribute).

### React (modern) — `source: "react"`

- **Find the fiber**: own key starting `__reactFiber$` / `__reactInternalInstance$` (unchanged from Feature 2). Additionally, presence of `window.__REACT_DEVTOOLS_GLOBAL_HOOK__.renderers` (size > 0) is treated as "React is on this page" even when no fiber key is found on the clicked node — enough to set `confidence: "low"` with `name: null` rather than `source: "none"`, which tells the agent "React app, name was stripped" vs. "not React."
- **Walk `fiber.return` upward**, and at each fiber **unwrap `fiber.type`** before judging it:
  - function / class with a usable `.displayName || .name` → candidate
  - `React.memo` object → `type.type` (recurse the unwrap)
  - `forwardRef` object → `type.render`
  - `Symbol(react.*)` (Fragment, Suspense, Profiler, StrictMode, context Provider/Consumer) → skip, keep walking
  - plain string (`"div"`, `"button"` — host component) → skip, keep walking
- **Filter noise names** (case-sensitive, these are library/tooling artifacts, not user components): `Slot`, `SlotClone`, `Primitive.*`, `Styled(*)` / `styled.*`, `EmotionCssPropInternal`, `WithStyles(*)`, `Provider`, `Consumer`, `Context.*`, `Router`, `Routes`, `Route`, `Outlet`, `Suspense`, `ErrorBoundary`, `_c` / single-character names, names matching `/^(ForwardRef|Memo|Anonymous)\(?\)?$/`, and anything wrapped as `ForwardRef(Styled(...))` where the inner unwrap is itself noise. A fiber whose name is filtered is added to nothing and the walk continues.
- **`name`** = first non-noise candidate. **`ancestry`** = every non-noise candidate up the chain, nearest first, consecutive duplicates collapsed (React re-enters the same component type across host boundaries), capped at 8.
- **`sourcePath` / `sourceLine`** = `fiber._debugSource` (`{ fileName, lineNumber }`) on the fiber that produced `name`, else on its `_debugOwner`. Present only in dev builds (`@babel/plugin-transform-react-jsx-source`, default under CRA / Next dev / Vite React). `null` otherwise.
- **`confidence`**: `"high"` if `name` is a multi-character non-noise name from an actual fiber; `"low"` if the only thing found was a single/two-char name (minified) or React-presence-without-a-name.

### Vue 3 / Vue 2 — `source: "vue"`

- Vue 3: `el.__vueParentComponent`; walk `.parent`. Name from `type.__name` (set from the SFC filename by `<script setup>`), then `type.name`. `sourcePath` from `type.__file` (dev only). `ancestry` from the `.parent` chain's names.
- Vue 2: `el.__vue__`; `$options.name` / `$options._componentTag`; `$options.__file`; `$parent` chain.
- Noise filter: skip `Anonymous`, `Transition`, `TransitionGroup`, `KeepAlive`, `RouterView`, `RouterLink`, and single-char names.
- `confidence: "high"` on a real SFC name (`__name`/`__file` present), `"low"` on a bare `name` with no file and no parent chain.

### Svelte — `source: "svelte"`

- Svelte does not expose a component instance on DOM nodes. The one reliable signal is **`el.__svelte_meta`** (Svelte dev mode: `{ loc: { file, line, column }, ... }`), walked up ancestors until found.
- `sourcePath` = `loc.file`, `sourceLine` = `loc.line`. `name` = the basename of `loc.file` without extension (e.g. `SubmitButton.svelte` → `SubmitButton`) — this is a derived name, so `confidence: "low"` unless the file basename is a clean PascalCase identifier, in which case `"high"`.
- `ancestry` is left `[]` — Svelte 5's component boundaries don't map 1:1 to DOM subtrees and walking `__svelte_meta` up ancestors gives source locations, not a component stack that can be trusted as ancestry.

### Angular — `source: "angular"`

- `window.ng?.getComponent?.(el)` (Angular dev mode global) → the component instance; `instance.constructor.name`. If `null` on the clicked node, walk ancestors calling `ng.getComponent` until one returns.
- `ng.getOwningComponent?.(el)` as a secondary.
- `name` from `constructor.name`; skip if it's minified (matches `/^[a-z0-9_$]{1,3}$/` or ends in a webpack-style hash). No source path (Angular doesn't expose one on the instance). `ancestry` via repeated `getOwningComponent` up the tree.
- `confidence: "high"` on a clean class name, `"low"` on a mangled one.

### Web Components / Lit / Stencil — `source: "web-component"`

- Nearest ancestor (inclusive) whose `tagName` contains `-` (custom element). `name` = that tag name lowercased (e.g. `sl-button`, `md-outlined-button`) — for design-system web components the tag name *is* the component identity and is almost always meaningful.
- If `customElements.get(tag)` returns a constructor with a non-minified `.name`, prefer that as `name` and keep the tag in `ancestry`.
- `confidence: "high"` (a registered custom element tag is an unambiguous signal), unless the constructor name is minified and the tag is a generic single word.
- No source path.

### Astro islands & dev-inspector attributes — `source: "data-attribute"`

- **Astro**: `data-astro-source-file` + `data-astro-source-loc` (dev only) on the nearest ancestor that has them → `sourcePath` / `sourceLine`, `name` from the file basename, `confidence: "high"` (Astro's attribute is unambiguous).
- **react-dev-inspector** / similar: `data-inspector-file`, `data-inspector-line`, `data-inspector-column` → same treatment.
- **Generic component hints** (existing Feature 2 list, extended): `data-testid`, `data-component`, `data-component-name`, `data-cy`, and now **`data-slot`** (shadcn/ui 2024+ emits this — semantic role, not a component name, so `confidence: "low"`). Walk up to 5 ancestors, first hit wins, priority in list order.
- A bare data-attribute value with no framework confirmation is always `confidence: "low"`.

### Orchestration — `getComponentInfo(el)`

1. Try React → Vue → Angular → Svelte → Web Component → Astro/dev-inspector → generic data-attribute, in that order, for `name` + `source`.
2. Regardless of which won, opportunistically fill any still-empty `sourcePath`/`sourceLine` from `__svelte_meta` / `data-astro-source-*` / `data-inspector-*` on the element or its ancestors (a React app using `react-dev-inspector` is the common case).
3. Compute `confidence` per the per-framework rules above; if `name` is non-null but matches the minified-name heuristic (`/^[$_a-z]{1,2}$/` or `/[a-f0-9]{6,}$/`), force `"low"`.
4. If nothing produced a name and no framework was even detected → `{ name: null, source: "none", confidence: "low", sourcePath: null, sourceLine: null, ancestry: [] }`.
5. Each framework probe is in its own `try/catch` (matching Feature 2) — an exotic custom element throwing inside `customElements.get`, or an Angular dev hook throwing, must not stop the other probes or the `spotcheck:element-captured` dispatch.

### Where the enriched object goes (no code change needed in most of the path)

- **`content/annotations.js`** — unchanged. It copies `e.detail.component` onto the record (`saveNote` at creation, the `element-captured` listener on re-selection) and includes it in `buildSnapshot()`. The enriched object rides through opaquely.
- **`content/queue.js`** — unchanged. `JSON`-serializes the record as-is into `chrome.storage.local`; every new field is a plain string/number/array and survives.
- **Feature 7's `mcp-server`** — `get_annotation` returns the full record, so `sourcePath`/`ancestry`/`confidence` are exposed with no server change. `list_annotations`'s `summarize()` **is** updated (this feature) to include `component: { name, source, sourcePath }` so an agent can triage "which file does each open issue touch" without a `get_annotation` per item.
- **`content/export.js`** — updated (this feature). The Markdown `**Component:**` line becomes, when data is present:
  `**Component:** SubmitButton (react, high) — src/checkout/SubmitButton.tsx:24`
  with an ancestry breadcrumb line below it (`SubmitButton › CheckoutForm › CheckoutPage`) when `ancestry.length > 1`. A `low`-confidence result is still printed but tagged `(react, low — name may be minified)`.

## Guardrails specific to this feature

- **No new permissions. `manifest.json` is not touched.** Every probe is a synchronous property/attribute read on a DOM node the framework itself annotated, plus `customElements.get` and reads of `window.__REACT_DEVTOOLS_GLOBAL_HOOK__` / `window.ng` — all already reachable from the injected content script with the current `["activeTab", "scripting", "storage"]` + loopback `host_permissions`. Same conclusion Feature 2 reached, re-verified for the new probes.
- **Read-only, and nothing is attached to host elements.** The extension reads `el.__reactFiber$*`, `el.__svelte_meta`, `el.__vue__`, `el.__ngContext__`, `el.getAttribute(...)` — all properties/attributes the page's own framework or build tooling created. The extension sets nothing on the page, reads no computed styles it didn't already read in Feature 2, and calls no framework method that mutates (`ng.getComponent` is a pure read; no `ng.applyChanges`, no Vue `$forceUpdate`, etc.).
- **No raw framework internals leak into the stored/exported shape.** `component` remains a plain object of strings, numbers, and a string array. The fiber, the Vue `ComponentInternalInstance`, the Angular component instance, and any `customElements` constructor are read for their `.name` / `.loc` / `.type` and then dropped — never assigned onto `component`, never serialized. This is the same rule Feature 2's spec states; this feature touches more internals so it matters more.
- **`sourcePath` is a string the page volunteered, not filesystem access.** It comes from dev-mode metadata the target app's own build emitted into the DOM or the fiber tree. The extension does not read, stat, resolve, or open any file. It is disclosed as a captured/stored/exported string in `CHROMEWEBSTORE.md` (updated this feature), because it can contain a local directory path — but it introduces no new capability, only new content in an already-disclosed export.
- **No network calls.** Nothing here constructs a `fetch`/`XMLHttpRequest`. (The queue this feeds is still pushed to the local `127.0.0.1` MCP server by Feature 7's `background.js` code — unchanged, not touched here.)
- **Still best-effort against undocumented internals** — `__reactFiber$*`, `_debugSource`, `__svelte_meta`, `__vueParentComponent`, `__ngContext__`, `window.ng` are all private / dev-only. This feature does not make them public or stable; it handles more of them and labels its own uncertainty via `confidence`.

## Known limitations

- **React 19 removed `fiber._debugSource`.** On a React 19 app, `sourcePath` for `source: "react"` comes back `null` unless the project uses a Babel/SWC JSX-source plugin that emits `data-inspector-*`-style attributes (picked up by the opportunistic fill). React 18 and earlier dev builds still populate it. Name/ancestry/confidence are unaffected.
- **Production builds lose most of this.** `_debugSource`, `__svelte_meta`, `__file`, `data-astro-source-*` are dev-only. Minifiers rename components to one or two characters. In a production bundle this feature typically returns `name: <mangled or null>`, `confidence: "low"`, `sourcePath: null` — better-labeled than Feature 2's silent bad guess, but not more informative. The realistic use case is a developer running their app in `dev` mode locally, which is also the case where `sourcePath` is most useful.
- **React Server Components are invisible.** An RSC leaves no client-side fiber; only Client Components (`"use client"`) appear in the tree. Clicking inside a server-rendered region attributes to the nearest *client* component ancestor, or to nothing. There is no way to recover a server component's name from the browser.
- **Solid, Qwik, Alpine, htmx, vanilla JS** expose no per-element component handle. These fall through to a `data-*` attribute if one happens to match, else `source: "none"`. Not a bug — there is no signal to read.
- **Svelte gives a file, rarely a component stack.** `ancestry` is always `[]` for `source: "svelte"`; `name` is derived from the filename and can be wrong if the file isn't named after its component.
- **`sourcePath` can be stale / from another machine.** A build done in CI or by a teammate bakes in *their* absolute path. The normalization to a `src/`-relative fragment helps but isn't guaranteed; consumers must treat it as a hint.
- **Ancestry depth is capped at 8** and the walk stops at the document root — a very deeply nested component tree is truncated (nearest 8 kept, which is the useful end).
- **Web component constructor names are often minified too** — for those, `name` falls back to the tag, which is usually still meaningful for a design-system element (`<sl-button>`) but not for an app-specific anonymous one.
- **No reconciliation with the user's chosen Issue type.** If the user picks Issue type "Component Variant" but the detected `component` is `source: "none"`, nothing flags the mismatch — same non-goal Feature 5's spec recorded for its Structure options.
- **`export.js` still doesn't format `issueType`, `tagScopedStyles`, or `snapshot`.** This feature updates the export's *Component* line only; the broader Feature 6 export gap noted in that feature's spec remains open and is not in scope here.
- **`event.detail.component` reads as a partial/`null` object from a plain DevTools console listener on `spotcheck:element-captured`** — the same isolated-world structured-clone caveat Feature 1 and Feature 2 document. Verify via the extension's own code paths, not a pasted console `addEventListener`.

## Future directions (explicitly NOT in this feature — captured so they aren't re-derived from scratch later)

- **Design-system awareness.** If the page's stack can be identified as a *known* design system — shadcn/ui (`data-slot` + Radix `data-*`), MUI (`Mui*` class prefixes + `MuiXxx-root`), Chakra (`chakra-*`), Ant Design (`ant-*`), Mantine (`mantine-*`), Radix bare, Headless UI, Bootstrap — then the detected element could be mapped to that system's *named component and variant* (e.g. "MUI `Button`, `variant=\"contained\"`, `size=\"small\"`", or "shadcn `Button` with `variant=\"destructive\"`") by reading the documented class/attribute contract, not framework internals. That's a richer, more stable signal than a minified fiber name and would survive production builds. It pairs naturally with **Phase 3 (Figma design QA)** in `PROJECT.md` §8 — knowing "this is a `Button/contained/small`" is exactly what you need to diff a live element against its design-system spec or Figma component. Deliberately left out of Feature 8: it's a per-design-system detector library, an open-ended maintenance surface, and it belongs with the Phase 3 work that actually consumes it, not bolted onto the capture pass.
- **Tailwind / utility-class intent.** When there's no component instance at all, the element's Tailwind/UnoCSS class string still encodes design intent (`px-4 py-2 rounded-lg bg-primary`). A future pass could surface a normalized summary of utility classes as a weak "what this element is trying to be" hint for the agent — distinct from `component`, since it's a style fingerprint, not an identity. Not done here; `component` stays strictly about component identity.
- **`props` / variant capture.** Reading a React fiber's `memoizedProps` or a Vue instance's `props` would tell the agent which *variant* of a component was clicked. Attractive, but it risks pulling arbitrary app data (user objects, callbacks, PII) into the stored/exported bundle — it would need a careful allowlist (string/number/boolean scalars only, known prop-name patterns) and its own guardrail review. Flagged, not attempted.

## Relevance / dependencies

- **Extends Feature 2 directly, in Feature 2's own file.** `content/capture.js`'s `getComponentInfo`, `getReactComponentName`, `getVueComponentName`, `getDataAttributeName` are rewritten/expanded; `getSelectorPath` and `getRelevantStyles` are untouched. Feature 2's `spec.md` `component` shape line is superseded by the "Data shape" section above — a forward-pointer note is added to Feature 2's spec in this pass.
- **No dependency on, and no change to, Features 5 or 6.** The record shape they defined carries `component` opaquely; the enriched object needs none of their capture/hot-save logic and touches none of it. `annotations.js` and `queue.js` are not modified.
- **Feeds Feature 4 (`export.js`)** — updated here to surface `sourcePath` and `ancestry`. This is the first time since Feature 6 shipped that `export.js` is touched at all; the change is scoped strictly to the Component line.
- **Feeds Feature 7 (`mcp-server/mcp-tools.js`)** — `summarize()` gains `component` fields so `list_annotations` is useful for file-level triage. `get_annotation` needs no change (full record already flows). No change to `server.js`, `store.js`, or the extension-side push in `background.js`.
- **Sets up Phase 2 / Phase 3 without building toward them.** `sourcePath` is the field that makes an eventual live-verification or design-QA loop able to land an edit in the right file instead of re-deriving it from a selector — but this feature adds no loop, no write path, and no MCP tool beyond enriching the existing read tools' output.
