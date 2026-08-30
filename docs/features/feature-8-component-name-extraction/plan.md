# Feature 8 — Component Name Extraction — plan.md

Implementation plan for an AI coding agent. Read `spec.md` first — it explains *why* this is an in-place rewrite of Feature 2's component detection rather than a new module, what the enriched `component` shape is, and which modern-library wrappers have to be unwrapped/filtered. This plan is the concrete order of operations.

## Scope reminder

In scope:
- Rewrite component detection inside `content/capture.js` to be modern-framework-aware (React with memo/forwardRef/library-wrapper unwrapping, Vue 3 `<script setup>`, Svelte, Angular, Web Components, Astro islands), and to also return **source file path/line**, a **confidence** flag, and the **component ancestry**.
- Surface the new fields in `content/export.js`'s Markdown (Component line only) and in `mcp-server/mcp-tools.js`'s `list_annotations` summary.
- Update `PROJECT.md` (repo layout, status, the Feature 2 bullet) and `CHROMEWEBSTORE.md` (version history + data-usage note), and add one forward-pointer line to `docs/features/feature-2-capture-engine/spec.md`.

**Not** in scope:
- Any change to `manifest.json` — no new permissions (all probes are synchronous DOM/attribute reads, same as Feature 2).
- Any change to `content/annotations.js`, `content/queue.js`, `content/picker.js`, `content/overlay.js`, `content/state.js`, or `background.js` — they all pass `component` through opaquely (verified: `annotations.js:1120`, `:764`, `:848`, `:1131`).
- Any new MCP tool, any write path, any resolve/reopen logic — Phase 2.
- Reconciling the detected component against the user's chosen Issue type.
- Design-system detection (shadcn/MUI/Chakra/Ant → named component + variant), Tailwind/utility-class intent summaries, and reading component `props`/variants — all deferred to Phase 3 / a later pass; see `spec.md`'s "Future directions." This feature is component *identity* only.
- Extending `export.js` to also format `issueType` / `tagScopedStyles` / `snapshot` — that Feature 6 gap stays open; only the Component line changes here.
- Reading the filesystem to verify `sourcePath` — the extension can't and doesn't. `sourcePath` is only ever a string the page's own dev build already put in the DOM/fiber tree.

## Architecture decision

- **All work lands in `content/capture.js`.** `getComponentInfo` and its helpers (`getReactComponentName`, `getVueComponentName`, `getDataAttributeName`) are rewritten/expanded. `getSelectorPath` and `getRelevantStyles` are not touched. The `spotcheck:element-captured` event name and the `component` field name stay exactly as they are — only the object's shape grows. `spec.md`'s "Why this is enhanced in place" section is the rationale; do not create a `content/component.js` or a new event.
- **Same file conventions as the rest of the content scripts**: no bundler, no ES modules, IIFE with the `if (spotcheck.capture) return` re-injection guard, everything hung off `window.__spotcheck`. This feature adds no new file to `CONTENT_FILES` in `background.js`.
- **Per-framework probes are each independently `try/catch`-wrapped**, inside an overall best-effort orchestrator — a throw inside the Angular hook or `customElements.get` must not prevent the React result or the event dispatch. Matches Feature 2's "defensive per-field, not defensive overall" note.
- **`confidence` is computed, not guessed by the caller.** Every probe returns enough for the orchestrator to label the result; a name that matches the minified-identifier heuristic is force-downgraded to `"low"` no matter its source.

## Files to create / touch

1. **Touch** `extension/content/capture.js` — the bulk of the feature (Steps 1–7).
2. **Touch** `extension/content/export.js` — Step 8.
3. **Touch** `mcp-server/mcp-tools.js` — Step 9.
4. **Touch** `PROJECT.md`, `CHROMEWEBSTORE.md`, `docs/features/feature-2-capture-engine/spec.md` — Step 10.
5. **Create** nothing in `extension/` — no new content script, no manifest change.

## Step-by-step

### Step 1 — Constants: noise names, minified-name heuristic, data-attribute list

At the top of `capture.js`'s IIFE, alongside the existing `BASE_PROPERTIES` etc.:

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
const MINIFIED_NAME_RE = /^[$_a-z]{1,2}$|[a-f0-9]{6,}$/;

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
  let best = fileName;
  for (const seg of PROJECT_ROOT_SEGMENTS) {
    const idx = fileName.lastIndexOf(seg);
    if (idx > -1 && (best === fileName || idx < best.length)) {
      best = fileName.slice(idx);
      break;
    }
  }
  return best;
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
const EMPTY_COMPONENT = {
  name: null, source: "none", confidence: "low",
  sourcePath: null, sourceLine: null, ancestry: [],
};

function getComponentInfo(el) {
  const probes = [
    getReactComponent, getVueComponent, getAngularComponent,
    getSvelteComponent, getWebComponent, getSourceFromAttributes, getDataAttributeName,
  ];

  let result = null;
  for (const probe of probes) {
    try {
      const hit = probe(el);
      if (hit && (hit.name || hit.source !== "none")) { result = hit; break; }
    } catch (err) {
      console.warn(`SpotCheck: component probe ${probe.name} failed`, err);
    }
  }
  if (!result) return { ...EMPTY_COMPONENT };

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

### Step 7 — `captureElement` stays the same shape

`captureElement` already calls `getComponentInfo(el)` inside its own `try/catch` and assigns the result to `component` (`capture.js:168-172`, `:183`). No change needed there — the fallback default already assigned at the top of `captureElement` should be updated to the new empty shape:

```js
let component = { name: null, source: "none", confidence: "low", sourcePath: null, sourceLine: null, ancestry: [] };
```

Leave the existing `// TODO` about best-effort framework internals; expand it to note this now covers React/Vue/Angular/Svelte/Web Components and is still dev-build-dependent for `sourcePath`.

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
- **`CHROMEWEBSTORE.md`**: add a `0.4.0` version-history entry; in "Data usage disclosure", note that captured/stored/exported component data may now include a **source file path string** read from the target app's own dev-build metadata (DOM attributes / framework dev hooks) — still local + clipboard/loopback only, no new permission, no filesystem access by the extension.
- **`docs/features/feature-2-capture-engine/spec.md`**: add one line under the `component` shape bullet — "Superseded by Feature 8 — see `docs/features/feature-8-component-name-extraction/spec.md` for the enriched shape (`confidence`, `sourcePath`, `sourceLine`, `ancestry`) and modern-framework coverage."

## Test criteria before calling this feature done

Run each against a real running app, not a synthetic fixture:

- [ ] **React dev build** (CRA/Next dev/Vite React): selecting an element inside a named component returns `source: "react"`, `confidence: "high"`, a non-null `name`, an `ancestry` of length ≥ 1, and — because it's a dev build — a non-null `sourcePath` ending in a `.jsx/.tsx` file plus a `sourceLine`.
- [ ] **A component wrapped in `React.memo` and/or `forwardRef`** (e.g. any Radix or shadcn/ui primitive): `name` is the real component, not `"ForwardRef"`, `"Memo"`, `"Slot"`, `"SlotClone"`, or `"Primitive.button"`.
- [ ] **styled-components / emotion element**: `name` is the nearest real component above it, not `"styled.div"` / `"EmotionCssPropInternal"`.
- [ ] **React production build** (minified): returns `source: "react"`, `confidence: "low"`, no throw, no misleading multi-word name — either `null` or a clearly-minified token, never a confident wrong answer.
- [ ] **Vue 3 `<script setup>` app**: `source: "vue"`, `name` from the SFC filename, `sourcePath` from `__file` in dev, `ancestry` reflects the `.parent` chain.
- [ ] **Svelte dev app**: `source: "svelte"`, `sourcePath`/`sourceLine` from `__svelte_meta`, `ancestry` is `[]`.
- [ ] **Angular dev app**: `source: "angular"`, `name` is a clean class name, `sourcePath` is `null`.
- [ ] **A design-system Web Component** (`<sl-button>`, `<md-*>`, any custom element with a `-`): `source: "web-component"`, `name` is the tag or a clean constructor name, `confidence: "high"`.
- [ ] **Astro dev site**: an island element returns `source: "data-attribute"`, `confidence: "high"`, `sourcePath` from `data-astro-source-file`, `sourceLine` from `data-astro-source-loc`.
- [ ] **Plain static HTML, no framework**: `{ name: null, source: "none", confidence: "low", sourcePath: null, sourceLine: null, ancestry: [] }` — no thrown errors, no console errors.
- [ ] **`react-dev-inspector` on a React app**: `sourcePath`/`sourceLine` get filled from `data-inspector-*` even though `name`/`source` came from the fiber tree (the opportunistic fill in Step 6).
- [ ] Selecting an SVG node, a `<table>` cell, a Shadow DOM host, and a `contenteditable` all complete without throwing — the per-probe `try/catch` isolation holds.
- [ ] Export a queue with a detected component: the Markdown `**Component:**` line shows `name (source, confidence)` and, when present, `— path:line`, plus a `**Component tree:**` breadcrumb when `ancestry.length > 1`.
- [ ] `list_annotations` over MCP now includes a `component: { name, source, sourcePath }` object per item; `get_annotation` still returns the full record including `confidence`, `sourceLine`, `ancestry`.
- [ ] Network tab across all of the above: **zero** requests — every probe is a synchronous property/attribute read. Same hard guardrail as Feature 2.
- [ ] `manifest.json` is byte-for-byte unchanged by this feature.
- [ ] Toggle inspection mode off and back on, re-select: still fires a correct enriched `spotcheck:element-captured` — the IIFE re-injection guard still holds.
