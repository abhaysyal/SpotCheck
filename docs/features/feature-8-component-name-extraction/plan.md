# Feature 8 — Component Name Extraction — plan.md

Implementation plan for an AI coding agent. Read `spec.md` first — it explains the two-world architecture, the enriched `component` shape, and which modern-library wrappers have to be unwrapped/filtered.

> **Revised after building.** This plan's first draft assumed component detection could stay an in-place rewrite of `content/capture.js`'s `getComponentInfo`. That's wrong: `capture.js` runs in Chrome's **ISOLATED world**, where `el.__reactFiber$*` / `el.__vue__` / `window.__REACT_DEVTOOLS_GLOBAL_HOOK__` and every other framework internal are **invisible** — so Feature 2's React/Vue detection never actually worked on a real page. The detection logic below is correct, but it lives in a **new MAIN-world file, `content/component-probe.js`**, which `capture.js` talks to over `window.postMessage`. `spec.md`'s "The two-world problem" section is the full rationale. The step numbers below are kept; the code just lands in the probe, not `capture.js`.

## Scope reminder

In scope:
- **New file `content/component-probe.js`** (MAIN world) holding all framework detection: React (memo/forwardRef/library-wrapper unwrapping), Vue 2/3 `<script setup>`, Svelte, Angular, Web Components, Astro islands — returning `{ name, source, confidence, sourcePath, sourceLine, ancestry }`.
- **`content/capture.js`**: drop the framework logic, keep `getSelectorPath`/`getRelevantStyles`, add the `postMessage` round-trip and the second (enriched) `spotcheck:element-captured` dispatch.
- **`extension/background.js`**: second `executeScript` call with `world: "MAIN"` for the probe (non-fatal on failure).
- **`content/annotations.js`**: popup component line + the `element-captured` clobber guard.
- **`content/export.js`** Markdown Component line + **`mcp-server/mcp-tools.js`** `list_annotations` summary.
- Docs: `PROJECT.md`, `CHROMEWEBSTORE.md`, a forward-pointer line in `docs/features/feature-2-capture-engine/spec.md`.

**Not** in scope:
- Any change to `manifest.json` beyond the `version` bump (0.3.0 → 0.4.0). `world: "MAIN"` injection needs no permission and no `web_accessible_resources` entry.
- Any change to `content/queue.js`, `content/picker.js`, `content/overlay.js`, `content/state.js` — `component` still rides through opaquely.
- Any new MCP tool, any write path, any resolve/reopen logic — Phase 2.
- Reconciling the detected component against the user's chosen Issue type.
- Design-system detection (shadcn/MUI/Chakra/Ant → named component + variant), Tailwind/utility-class intent summaries, and reading component `props`/variants — all deferred to Phase 3 / a later pass; see `spec.md`'s "Future directions." This feature is component *identity* only.
- Extending `export.js` to also format `issueType` / `tagScopedStyles` / `snapshot` — that Feature 6 gap stays open; only the Component line changes here.
- Reading the filesystem to verify `sourcePath` — the extension can't and doesn't. `sourcePath` is only ever a string the page's own dev build already put in the DOM/fiber tree.

## Architecture decision

- **Detection runs in the page's MAIN world** (`content/component-probe.js`), the only place `el.__reactFiber$*` etc. are readable. It's a plain IIFE (no `window.__spotcheck` — that namespace is the isolated world's), guarded by `if (window.__spotcheckProbeInstalled) return`, and does exactly one thing: answer a `window.postMessage({ __spotcheck: "probe-request", nonce, selector })` with `{ __spotcheck: "probe-response", nonce, component }`.
- **`capture.js` (ISOLATED) orchestrates.** On `spotcheck:element-selected` it computes selector + styles, dispatches `spotcheck:element-captured` synchronously with an **empty `component` placeholder**, then `postMessage`s the selector to the probe and, on the reply (or an 800 ms timeout), dispatches `spotcheck:element-captured` a **second time** with `component` filled. Same event, same field name — only the timing is new.
- **`background.js` injects the probe with a second `executeScript` call** (`world: "MAIN"`), wrapped in its own `try/catch` so a page that blocks MAIN-world injection doesn't break the rest.
- **Per-framework probes are each `try/catch`-wrapped** inside a best-effort orchestrator; a throw in one never stops the others or the `postMessage` reply.
- **`confidence` is computed by the orchestrator**, and any `name` matching the minified-identifier heuristic is force-downgraded to `"low"`.

## Files to create / touch

1. **Create** `extension/content/component-probe.js` — all framework detection (Steps 1–7 land here, not in `capture.js`).
2. **Rewrite** `extension/content/capture.js` — keep selector/styles, add the probe round-trip (Step 7b).
3. **Touch** `extension/background.js` — MAIN-world injection (Step 7c).
4. **Touch** `extension/content/annotations.js` — popup line + clobber guard (Step 7d).
5. **Touch** `extension/content/export.js` — Step 8.
6. **Touch** `mcp-server/mcp-tools.js` — Step 9.
7. **Touch** `PROJECT.md`, `CHROMEWEBSTORE.md`, `docs/features/feature-2-capture-engine/spec.md`, `extension/manifest.json` (version only) — Step 10.

## Step-by-step

### Step 1 — Constants: noise names, minified-name heuristic, data-attribute list

At the top of `content/component-probe.js`'s IIFE (see Step 7 for the wrapper):

```js
// Component names that are library/tooling wrappers, never what a user means
// by "this component." Case-sensitive exact match unless noted.
const NOISE_COMPONENT_NAMES = new Set([
  "Slot", "SlotClone", "Provider", "Consumer", "Router", "Routes", "Route",
  "Outlet", "Suspense", "SuspenseList", "ErrorBoundary", "Profiler",
  "StrictMode", "Fragment", "EmotionCssPropInternal", "Anonymous",
  "Transition", "TransitionGroup", "KeepAlive", "RouterView", "RouterLink",
]);

// Prefix / pattern noise: styled-components, MUI HOCs, unnamed wrappers, Radix primitives.
const NOISE_COMPONENT_PATTERNS = [
  /^Styled\(/, /^styled\./, /^WithStyles\(/, /^With[A-Z]/,
  /^Primitive\./, /^Context\./, /^ForwardRef\(\)?$/, /^Memo\(\)?$/,
];

// A name that looks like a minifier output rather than a real identifier.
// Any case (minifiers produce `B`, `tR`, `n5`, etc., not just lowercase).
const MINIFIED_NAME_RE = /^[$_A-Za-z][$_A-Za-z0-9]?$|[a-f0-9]{6,}$/;

const DATA_ATTRIBUTES = [
  "data-testid", "data-component", "data-component-name", "data-cy", "data-slot",
];
const SOURCE_ATTR_PAIRS = [
  ["data-astro-source-file", "data-astro-source-loc"],
  ["data-inspector-file", "data-inspector-line"],
];
const DATA_ATTRIBUTE_MAX_DEPTH = 5;
const ANCESTRY_CAP = 8;
const PROJECT_ROOT_SEGMENTS = ["src/", "app/", "pages/", "components/", "lib/"];
```

### Step 2 — Helpers: name classification + path normalization

```js
function isNoiseName(name) {
  if (!name || typeof name !== "string") return true;
  if (NOISE_COMPONENT_NAMES.has(name)) return true;
  return NOISE_COMPONENT_PATTERNS.some((re) => re.test(name));
}

function looksMinified(name) {
  return typeof name === "string" && MINIFIED_NAME_RE.test(name);
}

// Trim a build-machine absolute path to start at the last recognizable
// project-root segment. Read-only string work — no fs access.
function normalizeSourcePath(fileName) {
  if (!fileName || typeof fileName !== "string") return null;
  for (const seg of PROJECT_ROOT_SEGMENTS) {
    // A match only counts at a real path boundary (start of string, or
    // preceded by a slash) — otherwise a folder that merely ends in one of
    // these segments (e.g. "my-app/") would falsely match "app/" mid-name.
    let searchFrom = fileName.length;
    while (true) {
      const idx = fileName.lastIndexOf(seg, searchFrom - 1);
      if (idx === -1) break;
      const boundaryChar = fileName[idx - 1];
      if (idx === 0 || boundaryChar === "/" || boundaryChar === "\\") {
        return fileName.slice(idx);
      }
      searchFrom = idx;
    }
  }
  return fileName;
}

function basenameComponent(fileName) {
  if (!fileName) return null;
  const base = fileName.split(/[\\/]/).pop() || "";
  return base.replace(/\.(jsx?|tsx?|vue|svelte|astro)$/i, "") || null;
}
```

### Step 3 — React probe (modern)

Replace `getReactFiber` (keep it, unchanged) and `getReactComponentName` with:

```js
function unwrapReactType(type, guard = 0) {
  if (!type || guard > 5) return type;
  if (typeof type === "function") return type;
  // React.memo -> { $$typeof, type }, forwardRef -> { $$typeof, render }
  if (type.type) return unwrapReactType(type.type, guard + 1);
  if (type.render) return unwrapReactType(type.render, guard + 1);
  return type;
}

function reactDisplayName(type) {
  const t = unwrapReactType(type);
  if (typeof t === "function") return t.displayName || t.name || null;
  if (t && typeof t === "object" && t.displayName) return t.displayName;
  return null;
}

function reactIsPresent() {
  try {
    const hook = window.__REACT_DEVTOOLS_GLOBAL_HOOK__;
    return !!(hook && hook.renderers && hook.renderers.size > 0);
  } catch { return false; }
}

function getReactComponent(el) {
  let fiber = getReactFiber(el);
  if (!fiber) {
    return reactIsPresent()
      ? { name: null, source: "react", confidence: "low", sourcePath: null, sourceLine: null, ancestry: [] }
      : null;
  }
  const ancestry = [];
  let sourcePath = null;
  let sourceLine = null;
  let steps = 0;

  while (fiber && steps < 200) {
    steps += 1;
    const type = fiber.type;
    if (type && typeof type !== "string") {
      const name = reactDisplayName(type);
      if (name && !isNoiseName(name)) {
        if (ancestry[ancestry.length - 1] !== name) ancestry.push(name);
        if (!sourcePath) {
          const dbg = fiber._debugSource || (fiber._debugOwner && fiber._debugOwner._debugSource);
          if (dbg && dbg.fileName) {
            sourcePath = normalizeSourcePath(dbg.fileName);
            sourceLine = dbg.lineNumber || null;
          }
        }
      }
    }
    if (ancestry.length >= ANCESTRY_CAP) break;
    fiber = fiber.return;
  }

  const name = ancestry[0] || null;
  const confidence = name && !looksMinified(name) ? "high" : "low";
  return { name, source: "react", confidence, sourcePath, sourceLine, ancestry };
}
```

### Step 4 — Vue, Angular, Svelte, Web Component probes

```js
function getVueComponent(el) {
  const ancestry = [];
  let sourcePath = null, sourceLine = null;

  let inst = el.__vueParentComponent; // Vue 3
  while (inst) {
    const t = inst.type || {};
    const name = t.__name || t.name || null;
    if (name && !isNoiseName(name)) {
      if (ancestry[ancestry.length - 1] !== name) ancestry.push(name);
      if (!sourcePath && t.__file) sourcePath = normalizeSourcePath(t.__file);
    }
    if (ancestry.length >= ANCESTRY_CAP) break;
    inst = inst.parent;
  }
  if (!ancestry.length) {
    const v2 = el.__vue__; // Vue 2
    let node = v2;
    while (node && node.$options) {
      const name = node.$options.name || node.$options._componentTag || null;
      if (name && !isNoiseName(name)) {
        if (ancestry[ancestry.length - 1] !== name) ancestry.push(name);
        if (!sourcePath && node.$options.__file) sourcePath = normalizeSourcePath(node.$options.__file);
      }
      if (ancestry.length >= ANCESTRY_CAP) break;
      node = node.$parent;
    }
  }
  if (!ancestry.length) return null;
  const name = ancestry[0];
  return {
    name, source: "vue",
    confidence: sourcePath && !looksMinified(name) ? "high" : "low",
    sourcePath, sourceLine, ancestry,
  };
}

function getAngularComponent(el) {
  const ng = window.ng;
  if (!ng || typeof ng.getComponent !== "function") return null;
  const ancestry = [];
  let node = el, steps = 0;
  while (node && node.nodeType === 1 && steps < 50) {
    steps += 1;
    let cmp = null;
    try { cmp = ng.getComponent(node) || (ng.getOwningComponent && ng.getOwningComponent(node)); } catch {}
    const name = cmp && cmp.constructor && cmp.constructor.name;
    if (name && !isNoiseName(name) && ancestry[ancestry.length - 1] !== name) {
      ancestry.push(name);
      if (ancestry.length >= ANCESTRY_CAP) break;
    }
    node = node.parentElement;
  }
  if (!ancestry.length) return null;
  const name = ancestry[0];
  return {
    name, source: "angular",
    confidence: looksMinified(name) ? "low" : "high",
    sourcePath: null, sourceLine: null, ancestry,
  };
}

function getSvelteComponent(el) {
  let node = el, steps = 0;
  while (node && node.nodeType === 1 && steps < 50) {
    steps += 1;
    const meta = node.__svelte_meta;
    if (meta && meta.loc && meta.loc.file) {
      const name = basenameComponent(meta.loc.file);
      return {
        name, source: "svelte",
        confidence: name && /^[A-Z][A-Za-z0-9]*$/.test(name) ? "high" : "low",
        sourcePath: normalizeSourcePath(meta.loc.file),
        sourceLine: meta.loc.line || null,
        ancestry: [],
      };
    }
    node = node.parentElement;
  }
  return null;
}

function getWebComponent(el) {
  let node = el, steps = 0;
  while (node && node.nodeType === 1 && steps < 50) {
    steps += 1;
    const tag = node.tagName.toLowerCase();
    if (tag.includes("-")) {
      let name = tag;
      try {
        const ctor = customElements.get(tag);
        if (ctor && ctor.name && !looksMinified(ctor.name)) name = ctor.name;
      } catch {}
      return {
        name, source: "web-component",
        confidence: looksMinified(name) ? "low" : "high",
        sourcePath: null, sourceLine: null, ancestry: [tag],
      };
    }
    node = node.parentElement;
  }
  return null;
}
```

### Step 5 — Source-attribute + generic data-attribute probe

```js
function getSourceFromAttributes(el) {
  let node = el, depth = 0;
  while (node && node.nodeType === 1 && depth < DATA_ATTRIBUTE_MAX_DEPTH) {
    for (const [fileAttr, lineAttr] of SOURCE_ATTR_PAIRS) {
      const file = node.getAttribute(fileAttr);
      if (file) {
        const loc = node.getAttribute(lineAttr) || "";
        const line = parseInt(String(loc).split(":")[0], 10);
        return {
          name: basenameComponent(file),
          source: "data-attribute",
          confidence: "high", // Astro / dev-inspector attributes are unambiguous
          sourcePath: normalizeSourcePath(file),
          sourceLine: Number.isFinite(line) ? line : null,
          ancestry: [],
        };
      }
    }
    node = node.parentElement;
    depth += 1;
  }
  return null;
}

function getDataAttributeName(el) {
  let node = el, depth = 0;
  while (node && node.nodeType === 1 && depth < DATA_ATTRIBUTE_MAX_DEPTH) {
    for (const attr of DATA_ATTRIBUTES) {
      const value = node.getAttribute(attr);
      if (value) {
        return {
          name: value, source: "data-attribute", confidence: "low",
          sourcePath: null, sourceLine: null, ancestry: [],
        };
      }
    }
    node = node.parentElement;
    depth += 1;
  }
  return null;
}
```

### Step 6 — Orchestrator

```js
// A function, not a shared object constant — `ancestry` is an array, and a
// shared instance would let a future push() onto any one "empty" component
// corrupt every other one.
function emptyComponent() {
  return {
    name: null, source: "none", confidence: "low",
    sourcePath: null, sourceLine: null, ancestry: [],
  };
}

function getComponentInfo(el) {
  const probes = [
    getReactComponent, getVueComponent, getAngularComponent,
    getSvelteComponent, getWebComponent, getSourceFromAttributes, getDataAttributeName,
  ];

  // getReactComponent's "React is on this page but this node has no fiber"
  // result is the weakest possible signal — hold it aside and only fall
  // back to it if no later probe finds something better.
  let result = null;
  let reactPresentFallback = null;
  for (const probe of probes) {
    try {
      const hit = probe(el);
      if (!hit) continue;
      if (hit.name) { result = hit; break; }
      if (probe === getReactComponent && hit.source === "react") {
        if (!reactPresentFallback) reactPresentFallback = hit;
        continue;
      }
      if (hit.source !== "none") { result = hit; break; }
    } catch (err) {
      console.warn(`SpotCheck: component probe ${probe.name} failed`, err);
    }
  }
  if (!result) result = reactPresentFallback;
  if (!result) return emptyComponent();

  // Opportunistically fill a missing source path from dev-inspector / Astro
  // attributes even when the name came from a framework instance tree.
  if (!result.sourcePath) {
    try {
      const src = getSourceFromAttributes(el);
      if (src && src.sourcePath) {
        result.sourcePath = src.sourcePath;
        result.sourceLine = src.sourceLine;
      }
    } catch {}
  }

  if (result.name && looksMinified(result.name)) result.confidence = "low";
  return result;
}
```

Steps 1–6 above are the body of `content/component-probe.js`. Wrap them in `(function () { if (window.__spotcheckProbeInstalled) return; window.__spotcheckProbeInstalled = true; … })()` and end with the message listener:

```js
window.addEventListener("message", (ev) => {
  if (ev.source !== window) return;
  const d = ev.data;
  if (!d || d.__spotcheck !== "probe-request" || typeof d.nonce !== "string") return;
  let component = null;
  try {
    const el = d.selector ? document.querySelector(d.selector) : null;
    // Guard against the DOM having reflowed between capture and this message:
    // an :nth-of-type-based selector can silently start matching a different
    // element (e.g. a sibling re-render reordered the tree). A tagName
    // mismatch means the resolved node isn't the one the user selected.
    const matches = el && (!d.tagName || el.tagName.toLowerCase() === d.tagName);
    if (matches) component = getComponentInfo(el);
  } catch (err) { component = null; }
  try { window.postMessage({ __spotcheck: "probe-response", nonce: d.nonce, component }, "*"); } catch (err) {}
});
```

### Step 7b — `content/capture.js`: drop the framework logic, add the probe round-trip

- Keep `getSelectorPath`, `getRelevantStyles`, the IIFE + `if (spotcheck.capture) return` guard, and `emptyComponent()` (still needed as the placeholder factory — kept in sync with component-probe.js's identically-shaped one so a shared object instance can't have its `ancestry` array corrupted by a future mutation).
- `captureElement` no longer calls any `getComponentInfo` — it sets `component: emptyComponent()`.
- Add the channel: a `pendingProbes` `Map<nonce, resolve>`, a `window` `message` listener for `__spotcheck === "probe-response"`, and `requestComponent(selector, tagName)` returning a `Promise` that posts `{ __spotcheck: "probe-request", nonce, selector, tagName }` and resolves `null` after `PROBE_TIMEOUT_MS` (800). `tagName` lets the probe reject a selector that, by the time it runs, now resolves to a different element than the one the user clicked.
- The `spotcheck:element-selected` handler dispatches `spotcheck:element-captured` synchronously, then `requestComponent(detail.selector, detail.tagName).then((component) => { if (!component || !el.isConnected) return; dispatch again with Object.assign({}, detail, { element: el, component }); })`.

### Step 7c — `extension/background.js`: MAIN-world injection

- Add `const MAIN_WORLD_FILES = ["content/component-probe.js"];` (NOT in `CONTENT_FILES`).
- In `inject()`, after the existing `executeScript`, a second `await chrome.scripting.executeScript({ target: { tabId }, world: "MAIN", files: MAIN_WORLD_FILES })` wrapped in its own `try/catch` that only `console.warn`s — the isolated injection succeeding is what `inject()` returns on.

### Step 7d — `content/annotations.js`: popup component line + clobber guard

- CSS: a `.popup-component` rule (hidden by default, `.visible` shows it), with `.name` (`#cecece`), `.path` (`#77cff4`), `.unverified` (muted italic). Matches the Figma dark palette already in the file.
- Markup: a `componentEl` `<div class="popup-component">` appended right after `headerEl`; declare `let componentEl = null;` with the other popup element vars and null it in the teardown block.
- `renderComponentLine(component)`: builds `⬡ <name> · <sourcePath>:<line>` + a ` · unverified` / ` · name unavailable` tail when `confidence === "low"`; hides the element when there's no `name` and no `sourcePath`.
- Call it from `openPopupFor` (`activeRecord ? activeRecord.component : cached && cached.component`) and from the `spotcheck:element-captured` listener (`if (draftElement === el) renderComponentLine(...)`).
- Clobber guard in that same listener: only overwrite the cached/record `component` when the incoming one is meaningful (`name || sourcePath || source !== "none"`) or the existing one isn't — so the synchronous placeholder can't wipe a real prior value.

### Step 8 — `export.js`: Component line

In `formatMarkdown`, replace the current block:

```js
if (a.component && a.component.name) {
  lines.push("");
  lines.push(`**Component:** ${a.component.name} (${a.component.source})`);
}
```

with:

```js
if (a.component && (a.component.name || a.component.sourcePath)) {
  const c = a.component;
  lines.push("");
  let tag = `${c.name || "(unnamed)"} (${c.source}${c.confidence ? ", " + c.confidence : ""}`;
  tag += c.confidence === "low" ? " — name may be minified)" : ")";
  let line = `**Component:** ${tag}`;
  if (c.sourcePath) line += ` — ${c.sourcePath}${c.sourceLine ? ":" + c.sourceLine : ""}`;
  lines.push(line);
  if (Array.isArray(c.ancestry) && c.ancestry.length > 1) {
    lines.push("");
    lines.push(`**Component tree:** ${c.ancestry.join(" › ")}`); // ›
  }
}
```

### Step 9 — `mcp-server/mcp-tools.js`: include component in the list summary

In `summarize(a)`, add:

```js
component: a.component
  ? { name: a.component.name, source: a.component.source, sourcePath: a.component.sourcePath || null }
  : null,
```

Leave `getAnnotation` untouched — it already returns the full record, so `confidence` / `sourceLine` / `ancestry` come through there.

### Step 10 — Docs

- **`PROJECT.md`**: add `feature-8-component-name-extraction/ { plan.md, spec.md }` to the repo-layout tree; update the status line at the bottom from "Feature 8 … queued next, not yet started" to done + "each verified with live browser testing"; update §8's "Not yet started — Component Name Extraction (Feature 8)" paragraph to a DONE entry; refine §4's Feature 2 bullet to note the modern-framework extraction now lives in Feature 8.
- **`CHROMEWEBSTORE.md`**: add a `0.4.0` version-history entry; in "Data usage disclosure", note (a) the **source file path string** now captured/stored/exported, read from the target app's own dev-build metadata — still local + clipboard/loopback only, no new permission, no filesystem access; and (b) that SpotCheck now **runs one script in the page's own JS context** (`content/component-probe.js`, MAIN world) to read framework component metadata — read-only, no page data touched beyond framework hooks, no new permission.
- **`docs/features/feature-2-capture-engine/spec.md`**: add one line under the `component` shape bullet — "Superseded by Feature 8 — see `docs/features/feature-8-component-name-extraction/spec.md` for the enriched shape (`confidence`, `sourcePath`, `sourceLine`, `ancestry`) and modern-framework coverage."

## Test criteria before calling this feature done

Run each against a real running app, not a synthetic fixture:

- [ ] **React dev build** (CRA/Next dev/Vite React): selecting an element inside a named component returns `source: "react"`, `confidence: "high"`, a non-null `name`, an `ancestry` of length ≥ 1, and — because it's a dev build — a non-null `sourcePath` ending in a `.jsx/.tsx` file plus a `sourceLine`.
- [ ] **A component wrapped in `React.memo` and/or `forwardRef`** (e.g. any Radix or shadcn/ui primitive): `name` is the real component, not `"ForwardRef"`, `"Memo"`, `"Slot"`, `"SlotClone"`, or `"Primitive.button"`.
- [ ] **styled-components / emotion element**: `name` is the nearest real component above it, not `"styled.div"` / `"EmotionCssPropInternal"`.
- [ ] **React production build** (minified): `source: "react"`; `confidence: "low"` and `ancestry: []` for elements whose fiber names are all mangled; `confidence: "high"` only where a real name survived minification. No throw, never a confident wrong multi-word name. (Verified against react.dev during implementation.)
- [ ] **Vue 3 `<script setup>` app**: `source: "vue"`, `name` from the SFC filename, `sourcePath` from `__file` in dev, `ancestry` reflects the `.parent` chain.
- [ ] **Svelte dev app**: `source: "svelte"`, `sourcePath`/`sourceLine` from `__svelte_meta`, `ancestry` is `[]`.
- [ ] **Angular dev app**: `source: "angular"`, `name` is a clean class name, `sourcePath` is `null`.
- [ ] **A design-system Web Component** (`<sl-button>`, `<md-*>`, any custom element with a `-`): `source: "web-component"`, `name` is the tag or a clean constructor name, `confidence: "high"`.
- [ ] **Astro dev site**: an island element returns `source: "data-attribute"`, `confidence: "high"`, `sourcePath` from `data-astro-source-file`, `sourceLine` from `data-astro-source-loc`.
- [ ] **Plain static HTML, no framework**: `{ name: null, source: "none", confidence: "low", sourcePath: null, sourceLine: null, ancestry: [] }` — no thrown errors, no console errors.
- [ ] **`react-dev-inspector` on a React app**: `sourcePath`/`sourceLine` get filled from `data-inspector-*` even though `name`/`source` came from the fiber tree (the opportunistic fill in Step 6).
- [ ] Selecting an SVG node, a `<table>` cell, a Shadow DOM host, and a `contenteditable` all complete without throwing — the per-probe `try/catch` isolation holds.
- [ ] **Two-world round trip**: on a React dev app, `spotcheck:element-captured` fires twice — once with an empty `component`, once (within ~a few ms) with it filled — and the popup's component line appears/updates a beat after the popup opens.
- [ ] **Popup shows it**: the detected component + `sourcePath:line` render under the popup header; a `confidence: "low"` result shows the ` · unverified` tail; a `source: "none"` element shows no component line at all.
- [ ] **Probe absent**: with `content/component-probe.js` removed from `MAIN_WORLD_FILES` (or on a page that blocks MAIN-world injection), everything else works and `component` stays empty — no hang, no console error beyond the swallowed warning.
- [ ] **Page can't break it**: a page script posting a forged `{ __spotcheck: "probe-response", nonce: "x", component: {...} }` at most changes a component label; it can't reach storage or other tabs.
- [ ] Export a queue with a detected component: the Markdown `**Component:**` line shows `name (source, confidence)` and, when present, `— path:line`, plus a `**Component tree:**` breadcrumb when `ancestry.length > 1`.
- [ ] `list_annotations` over MCP now includes a `component: { name, source, sourcePath }` object per item; `get_annotation` still returns the full record including `confidence`, `sourceLine`, `ancestry`.
- [ ] Network tab across all of the above: **zero** requests — every probe is a synchronous property/attribute read.
- [ ] `manifest.json`'s `permissions` and `host_permissions` are unchanged; only `version` moves (0.3.0 → 0.4.0). No `web_accessible_resources` added.
- [ ] Toggle inspection mode off and back on, re-select: still fires a correct enriched `spotcheck:element-captured`. Both the isolated `if (spotcheck.capture) return` and the MAIN-world `if (window.__spotcheckProbeInstalled) return` guards hold across re-injection.
