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

## The two-world problem — why there's a new MAIN-world file

Feature 2 put component detection inside `content/capture.js` and read `el.__reactFiber$*` / `el.__vue__` directly. **That never actually worked on a real page**, and building Feature 8 is what surfaced it: `capture.js` — like every other SpotCheck content script — is injected into Chrome's **ISOLATED world**, and in the isolated world the properties a framework attaches to DOM nodes (`__reactFiber$*`, `__vueParentComponent`, `__vue__`, `__svelte_meta`, `__ngContext__`) and the page globals that expose framework state (`window.__REACT_DEVTOOLS_GLOBAL_HOOK__`, `window.ng`) are **completely invisible** — each world gets its own JS wrapper per node, and those expandos live on the page's wrapper, not the extension's. Only `getAttribute`-based signals (`data-testid`, Astro's `data-astro-source-*`, `data-inspector-*`) survive in the isolated world, which is why Feature 2's React/Vue detection silently returned `source: "none"` on any normally-built app.

So Feature 8 splits component detection into a small **MAIN-world probe**, `content/component-probe.js`:

- `background.js` injects it with a second `chrome.scripting.executeScript({ world: "MAIN", files: [...] })` call (one call can't span both worlds). This is the **first time SpotCheck runs any code in the page's own world.** It is deliberately minimal: it adds one guard flag (`window.__spotcheckProbeInstalled`), never writes to the DOM, never calls a framework method that mutates, and answers exactly one message.
- **Communication is `window.postMessage`** — Chrome's own documented isolated↔main channel. `capture.js` (isolated) still computes the unique selector synchronously, then posts `{ __spotcheck: "probe-request", nonce, selector }`. The probe does `document.querySelector(selector)`, runs the framework walks, and posts back `{ __spotcheck: "probe-response", nonce, component }` — a plain-JSON descriptor. No element reference, no fiber, no framework instance ever crosses the channel.
- **`spotcheck:element-captured` now fires twice per selection.** First synchronously, with `component` set to the empty placeholder (`{ name: null, source: "none", … }`) — so `selector`/`styles` consumers are unblocked immediately. Then again ~a few ms later, once the probe answers, with `component` filled and the same `element` reference. `annotations.js`'s existing `element-captured` listener already re-reads and updates both its capture cache and any existing record, so a second dispatch for the same element is the intended delivery path, not a special case. If the probe times out (800 ms) or returns nothing, the second dispatch is skipped and the placeholder stands.

This is a real architecture change from "enhance Feature 2's function in place," which is where this spec's first draft landed before the isolated-world constraint was verified. `capture.js` keeps `getSelectorPath`/`getRelevantStyles` and the event orchestration; all framework-internals logic moved to the probe.

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

- **Backward compatible for existing readers.** `name` and `source` keep their Feature 2 meaning; `source` only gains new enum values. `export.js` and `mcp-tools.js` are updated in this feature to use the new fields; `queue.js` treats `component` as an opaque blob and needs no change. `annotations.js` copies `e.detail.component` onto the record and into `buildSnapshot()` — unchanged in principle, but it does gain a small guard so the first (placeholder) `element-captured` dispatch doesn't clobber a real `component` value a prior capture already stored, plus the popup-display wiring below.
- **`ancestry[0]` is normally equal to `name`.** They differ only when `name` had to fall back to a low-confidence source (a data attribute, a bare tag) that isn't part of the framework instance chain `ancestry` was built from — in that case `ancestry` may be `[]` while `name` is still set.
- **`sourcePath` normalization is deliberately minimal.** Dev tooling emits an absolute path from the *build* machine (e.g. `/Users/someone/proj/src/App.tsx`). This feature trims it to start at the last occurrence of a common project-root segment (`src/`, `app/`, `pages/`, `components/`, `lib/`) when one is present, otherwise stores it verbatim. It does **not** resolve, verify, or read the path — the extension has no filesystem access and this is not it acquiring any. The agent consuming it must treat it as a hint and fall back to the basename if the path doesn't exist in its checkout.

## How it works

Detection runs inside `content/component-probe.js` in the page's MAIN world (see above). Each probe is a synchronous own-property / attribute read on DOM nodes the frameworks themselves already annotated. Methods are tried in priority order; the first that yields a name wins its `source`, but `sourcePath`/`sourceLine` and `confidence` can still be filled from a lower-priority signal if the winner didn't provide them (e.g. a React name from the fiber tree + a source line from a `data-inspector-line` attribute).

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
5. Each framework probe is in its own `try/catch` — an exotic custom element throwing inside `customElements.get`, or an Angular dev hook throwing, must not stop the other probes or the probe's `postMessage` response.

### Popup display (`content/annotations.js`)

- The popup gains a **component line under the header** (`.popup-component`), styled to the same Figma dark palette: `⬡ SubmitButton · src/checkout/SubmitButton.tsx:24`, with the name in `#cecece`, the path in the `#77cff4` accent, and a ` · unverified` / ` · name unavailable` tail in muted italic when `confidence === "low"`. Hidden entirely (`display: none`) when there's no `name` and no `sourcePath`.
- Rendered by a single `renderComponentLine(component)` helper, called from two places: `openPopupFor` (from the record in edit mode, or the capture cache for a fresh draft — which may still be the empty placeholder), and the `spotcheck:element-captured` listener (which re-renders it in place the moment the probe's second dispatch lands, if the popup is still open for that element). So for a fresh selection the line appears/updates a beat after the popup opens; for an already-annotated element it's populated immediately from the stored record.
- **`element-captured` clobber guard.** Because the event now fires first with a placeholder `component`, `annotations.js`'s listener only overwrites the cached/record `component` when the incoming one is *meaningful* (`name || sourcePath || source !== "none"`) or the existing one isn't — so the synchronous placeholder can't wipe a real value a prior capture stored.

### Where the enriched object goes (no code change needed in the rest of the path)

- **`content/queue.js`** — unchanged. `JSON`-serializes the record as-is into `chrome.storage.local`; every new field is a plain string/number/array and survives.
- **Feature 7's `mcp-server`** — `get_annotation` returns the full record, so `sourcePath`/`ancestry`/`confidence` are exposed with no server change. `list_annotations`'s `summarize()` **is** updated (this feature) to include `component: { name, source, sourcePath }` so an agent can triage "which file does each open issue touch" without a `get_annotation` per item.
- **`content/export.js`** — updated (this feature). The Markdown `**Component:**` line becomes, when data is present:
  `**Component:** SubmitButton (react, high) — src/checkout/SubmitButton.tsx:24`
  with an ancestry breadcrumb line below it (`SubmitButton › CheckoutForm › CheckoutPage`) when `ancestry.length > 1`. A `low`-confidence result is still printed but tagged `(react, low — name may be minified)`.

## Guardrails specific to this feature

- **No new permissions. `manifest.json` gains only the `version` bump (0.3.0 → 0.4.0).** `world: "MAIN"` injection via `chrome.scripting.executeScript` needs no permission beyond the `scripting` + `activeTab` SpotCheck already has, and the injected file does **not** need a `web_accessible_resources` entry (that's only for page-initiated loads, not programmatic `executeScript`). Permissions stay `["activeTab", "scripting", "storage"]` + loopback `host_permissions`.
- **Running in the MAIN world is a real escalation of reach — scoped down deliberately.** `content/component-probe.js` is the only SpotCheck code that ever runs in the page's own JS world. It: adds exactly one global (`window.__spotcheckProbeInstalled`, a re-injection guard); registers exactly one `message` listener; writes nothing to the DOM; calls no framework method that mutates (`ng.getComponent` is a pure read — no `ng.applyChanges`, no Vue `$forceUpdate`); and returns only a plain-JSON descriptor, never a live object. It does not read cookies, `localStorage`, or any page variable other than the framework hooks it needs for detection. This is disclosed in `CHROMEWEBSTORE.md` (updated this feature) as "runs a script in the page context to read framework component metadata."
- **Read-only, and nothing is attached to host elements.** The probe reads `el.__reactFiber$*`, `el.__svelte_meta`, `el.__vue__`, `el.__ngContext__`, `el.getAttribute(...)` — all properties/attributes the page's own framework or build tooling created. It sets nothing on the page and calls no mutating method.
- **No raw framework internals leak into the stored/exported shape.** `component` remains a plain object of strings, numbers, and a string array. The fiber, the Vue `ComponentInternalInstance`, the Angular component instance, and any `customElements` constructor are read for their `.name` / `.loc` / `.type` and then dropped — never assigned onto `component`, never serialized. This is the same rule Feature 2's spec states; this feature touches more internals so it matters more.
- **`sourcePath` is a string the page volunteered, not filesystem access.** It comes from dev-mode metadata the target app's own build emitted into the DOM or the fiber tree. The extension does not read, stat, resolve, or open any file. It is disclosed as a captured/stored/exported string in `CHROMEWEBSTORE.md` (updated this feature), because it can contain a local directory path — but it introduces no new capability, only new content in an already-disclosed export.
- **The `postMessage` channel is not authenticated.** A page's own script can see the `nonce` in the `probe-request` and could send a forged `probe-response` (a wrong component name), or call the probe itself. Impact is bounded: the worst case is a misleading component name on an annotation the user deliberately created — the page cannot read the extension's storage, other annotations, or anything cross-tab through this channel, and cannot make the extension do anything. A shared-secret handshake was considered overkill for that risk on a local dev tool; noted, not built.
- **No network calls.** Nothing here constructs a `fetch`/`XMLHttpRequest`. (The queue this feeds is still pushed to the local `127.0.0.1` MCP server by Feature 7's `background.js` code — unchanged, not touched here.)
- **Still best-effort against undocumented internals** — `__reactFiber$*`, `_debugSource`, `__svelte_meta`, `__vueParentComponent`, `__ngContext__`, `window.ng` are all private / dev-only. This feature does not make them public or stable; it handles more of them and labels its own uncertainty via `confidence`.

## Known limitations

- **React 19 removed `fiber._debugSource`.** On a React 19 app, `sourcePath` for `source: "react"` comes back `null` unless the project uses a Babel/SWC JSX-source plugin that emits `data-inspector-*`-style attributes (picked up by the opportunistic fill). React 18 and earlier dev builds still populate it. Name/ancestry/confidence are unaffected.
- **Production builds lose most of this.** `_debugSource`, `__svelte_meta`, `__file`, `data-astro-source-*` are dev-only. Minifiers rename components to one or two characters (any case — `B`, `tR`, `n5` — the minified-name heuristic accounts for that). On a production bundle the React probe returns the first non-noise fiber name as `name` (so the agent knows *something* was there) but keeps `ancestry` to non-minified names only and marks `confidence: "low"` — an ancestry of `["B","tR","d","z"]` is worse than an empty one. Where a prod build ships *some* real names (many do — e.g. react.dev keeps `MaxWidth`, `YouWillLearn`), those still come through at `confidence: "high"`. Verified against react.dev directly. The realistic use case is still a dev build run locally, which is also where `sourcePath` exists.
- **React Server Components are invisible.** An RSC leaves no client-side fiber; only Client Components (`"use client"`) appear in the tree. Clicking inside a server-rendered region attributes to the nearest *client* component ancestor, or to nothing. There is no way to recover a server component's name from the browser.
- **Solid, Qwik, Alpine, htmx, vanilla JS** expose no per-element component handle. These fall through to a `data-*` attribute if one happens to match, else `source: "none"`. Not a bug — there is no signal to read.
- **Svelte gives a file, rarely a component stack.** `ancestry` is always `[]` for `source: "svelte"`; `name` is derived from the filename and can be wrong if the file isn't named after its component.
- **`sourcePath` can be stale / from another machine.** A build done in CI or by a teammate bakes in *their* absolute path. The normalization to a `src/`-relative fragment helps but isn't guaranteed; consumers must treat it as a hint.
- **Ancestry depth is capped at 8** and the walk stops at the document root — a very deeply nested component tree is truncated (nearest 8 kept, which is the useful end).
- **Web component constructor names are often minified too** — for those, `name` falls back to the tag, which is usually still meaningful for a design-system element (`<sl-button>`) but not for an app-specific anonymous one.
- **No reconciliation with the user's chosen Issue type.** If the user picks Issue type "Component Variant" but the detected `component` is `source: "none"`, nothing flags the mismatch — same non-goal Feature 5's spec recorded for its Structure options.
- **`export.js` still doesn't format `issueType`, `tagScopedStyles`, or `snapshot`.** This feature updates the export's *Component* line only; the broader Feature 6 export gap noted in that feature's spec remains open and is not in scope here.
- **`event.detail.component` reads as a partial/`null` object from a plain DevTools console listener on `spotcheck:element-captured`** — the same isolated-world structured-clone caveat Feature 1 and Feature 2 document. Verify via the extension's own code paths, not a pasted console `addEventListener`.
- **The component result is asynchronous now.** `spotcheck:element-captured` fires first with an empty `component` placeholder and again once the probe answers (~a few ms, or an 800 ms timeout). If a user selects an element and hits send *extremely* fast, the record could be created before the probe answers — `annotations.js` reads the cache at commit time and the probe result usually beats that, but there's no hard guarantee. A missed result just means an empty `component` on that one record; re-opening it to edit re-runs the probe.
- **Pages that block MAIN-world injection** (a few hardened sites, `chrome://`, the Web Store — most of which block the extension entirely anyway) get no component detection at all; `component` stays the empty placeholder and everything else works. `background.js` swallows the probe-injection failure so it never affects the rest of the injection.
- **The probe can't see into a different-origin iframe.** If the selected element lives in a cross-origin `<iframe>`, `document.querySelector` in the top-level probe won't find it. Same-origin iframes are also not walked (the probe only runs at top level). Out of scope.

## Future directions (explicitly NOT in this feature — captured so they aren't re-derived from scratch later)

- **Design-system awareness.** If the page's stack can be identified as a *known* design system — shadcn/ui (`data-slot` + Radix `data-*`), MUI (`Mui*` class prefixes + `MuiXxx-root`), Chakra (`chakra-*`), Ant Design (`ant-*`), Mantine (`mantine-*`), Radix bare, Headless UI, Bootstrap — then the detected element could be mapped to that system's *named component and variant* (e.g. "MUI `Button`, `variant=\"contained\"`, `size=\"small\"`", or "shadcn `Button` with `variant=\"destructive\"`") by reading the documented class/attribute contract, not framework internals. That's a richer, more stable signal than a minified fiber name and would survive production builds. It pairs naturally with **Phase 3 (Figma design QA)** in `PROJECT.md` §8 — knowing "this is a `Button/contained/small`" is exactly what you need to diff a live element against its design-system spec or Figma component. Deliberately left out of Feature 8: it's a per-design-system detector library, an open-ended maintenance surface, and it belongs with the Phase 3 work that actually consumes it, not bolted onto the capture pass.
- **Tailwind / utility-class intent.** When there's no component instance at all, the element's Tailwind/UnoCSS class string still encodes design intent (`px-4 py-2 rounded-lg bg-primary`). A future pass could surface a normalized summary of utility classes as a weak "what this element is trying to be" hint for the agent — distinct from `component`, since it's a style fingerprint, not an identity. Not done here; `component` stays strictly about component identity.
- **`props` / variant capture.** Reading a React fiber's `memoizedProps` or a Vue instance's `props` would tell the agent which *variant* of a component was clicked. Attractive, but it risks pulling arbitrary app data (user objects, callbacks, PII) into the stored/exported bundle — it would need a careful allowlist (string/number/boolean scalars only, known prop-name patterns) and its own guardrail review. Flagged, not attempted.

## Relevance / dependencies

- **Supersedes Feature 2's component detection.** `content/capture.js` keeps `getSelectorPath` / `getRelevantStyles` and now orchestrates the async probe round-trip; all framework-internals logic (`getReactComponentName`, `getVueComponentName`, `getDataAttributeName`, and everything new) moved to the new `content/component-probe.js` in the MAIN world. Feature 2's `spec.md` `component` shape line is superseded by the "Data shape" section above — a forward-pointer note is added to Feature 2's spec in this pass.
- **`content/annotations.js` gets a small change** — the popup component line + the `element-captured` clobber guard (see "Popup display" above). Its store, positioning loop, and event contract are otherwise untouched.
- **`content/queue.js` is not touched.** The record shape carries `component` opaquely; the enriched object is plain JSON and serializes fine.
- **`extension/background.js` gets the second `executeScript` call** for the MAIN-world probe, wrapped so its failure is non-fatal.
- **Feeds Feature 4 (`export.js`)** — updated here to surface `sourcePath` and `ancestry`. This is the first time since Feature 6 shipped that `export.js` is touched at all; the change is scoped strictly to the Component line.
- **Feeds Feature 7 (`mcp-server/mcp-tools.js`)** — `summarize()` gains `component` fields so `list_annotations` is useful for file-level triage. `get_annotation` needs no change (full record already flows). No change to `server.js`, `store.js`, or the extension-side push in `background.js`.
- **Sets up Phase 2 / Phase 3 without building toward them.** `sourcePath` is the field that makes an eventual live-verification or design-QA loop able to land an edit in the right file instead of re-deriving it from a selector — but this feature adds no loop, no write path, and no MCP tool beyond enriching the existing read tools' output.
