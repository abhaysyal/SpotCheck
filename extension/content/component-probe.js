// SpotCheck — component probe (runs in the page's MAIN world).
//
// Injected separately from the rest of the content scripts, with
// `world: "MAIN"` (see background.js). It exists for one reason: the other
// content scripts run in Chrome's ISOLATED world, where the properties a
// framework attaches to DOM nodes — el.__reactFiber$*, el.__vue__,
// el.__svelte_meta, el.__ngContext__ — and page globals like
// window.__REACT_DEVTOOLS_GLOBAL_HOOK__ / window.ng are all invisible. Only
// code running in the page's own world can read them.
//
// It never touches the page: no DOM writes, no framework method that
// mutates, no globals added beyond a single re-injection guard flag. It
// answers exactly one message — "probe the element at this selector" — with
// a plain-JSON component descriptor, over window.postMessage (the standard
// isolated<->main channel). All framework internals are read for their
// name/loc/type and then dropped; the fiber / Vue instance / component
// instance itself is never serialized or returned.
//
// See docs/features/feature-8-component-name-extraction/spec.md.

(function () {
  if (window.__spotcheckProbeInstalled) return;
  window.__spotcheckProbeInstalled = true;

  const NOISE_COMPONENT_NAMES = new Set([
    "Slot", "SlotClone", "Provider", "Consumer", "Router", "Routes", "Route",
    "Outlet", "Suspense", "SuspenseList", "ErrorBoundary", "Profiler",
    "StrictMode", "Fragment", "EmotionCssPropInternal", "Anonymous",
    "Transition", "TransitionGroup", "KeepAlive", "RouterView", "RouterLink",
  ]);
  const NOISE_COMPONENT_PATTERNS = [
    /^Styled\(/, /^styled\./, /^WithStyles\(/, /^With[A-Z]/,
    /^Primitive\./, /^Context\./, /^ForwardRef\(\)?$/, /^Memo\(\)?$/,
  ];
  // 1–2 char identifiers of any case (e.g. `B`, `tR`, `n5`), or a 6+ hex tail
  // (webpack-style). Minifiers routinely produce all of these as component
  // "names".
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

  const EMPTY_COMPONENT = {
    name: null, source: "none", confidence: "low",
    sourcePath: null, sourceLine: null, ancestry: [],
  };

  // --- name classification + path helpers -------------------------------

  function isNoiseName(name) {
    if (!name || typeof name !== "string") return true;
    if (NOISE_COMPONENT_NAMES.has(name)) return true;
    return NOISE_COMPONENT_PATTERNS.some((re) => re.test(name));
  }

  function looksMinified(name) {
    return typeof name === "string" && MINIFIED_NAME_RE.test(name);
  }

  // Trim a build-machine absolute path to start at the last recognizable
  // project-root segment. Pure string work — never reads/opens the path.
  function normalizeSourcePath(fileName) {
    if (!fileName || typeof fileName !== "string") return null;
    for (const seg of PROJECT_ROOT_SEGMENTS) {
      const idx = fileName.lastIndexOf(seg);
      if (idx > -1) return fileName.slice(idx);
    }
    return fileName;
  }

  function basenameComponent(fileName) {
    if (!fileName) return null;
    const base = String(fileName).split(/[\\/]/).pop() || "";
    return base.replace(/\.(jsx?|tsx?|vue|svelte|astro)$/i, "") || null;
  }

  // --- React (modern) --------------------------------------------------

  function getReactFiber(node) {
    const key = Object.keys(node).find(
      (k) => k.startsWith("__reactFiber$") || k.startsWith("__reactInternalInstance$")
    );
    return key ? node[key] : null;
  }

  function unwrapReactType(type, guard) {
    guard = guard || 0;
    if (!type || guard > 5) return type;
    if (typeof type === "function") return type;
    if (type.type) return unwrapReactType(type.type, guard + 1); // React.memo
    if (type.render) return unwrapReactType(type.render, guard + 1); // forwardRef
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
    } catch (err) {
      return false;
    }
  }

  function getReactComponent(el) {
    let fiber = getReactFiber(el);
    if (!fiber) {
      return reactIsPresent()
        ? { name: null, source: "react", confidence: "low", sourcePath: null, sourceLine: null, ancestry: [] }
        : null;
    }

    // `ancestry` collects only real (non-minified) component names — on a
    // production build almost every fiber name is a mangled single char, and
    // an ancestry of ["B","tR","d","z"] is worse than an empty one.
    const ancestry = [];
    let firstName = null; // first non-noise name, minified or not — for honesty
    let sourcePath = null;
    let sourceLine = null;
    let steps = 0;

    while (fiber && steps < 200) {
      steps += 1;
      const type = fiber.type;
      if (type && typeof type !== "string") {
        const name = reactDisplayName(type);
        if (name && !isNoiseName(name)) {
          if (!firstName) firstName = name;
          if (!looksMinified(name)) {
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
      }
      if (ancestry.length >= ANCESTRY_CAP) break;
      fiber = fiber.return;
    }

    // Prefer a real name; fall back to the first mangled one only so the
    // agent knows *something* was there. confidence reflects which happened.
    const name = ancestry[0] || firstName || null;
    const confidence = ancestry[0] && !looksMinified(ancestry[0]) ? "high" : "low";
    return { name, source: "react", confidence, sourcePath, sourceLine, ancestry };
  }

  // --- Vue 2 / Vue 3 ---------------------------------------------------

  function getVueComponent(el) {
    const ancestry = [];
    let sourcePath = null;

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
      let node = el.__vue__; // Vue 2
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
      sourcePath, sourceLine: null, ancestry,
    };
  }

  // --- Angular -------------------------------------------------------

  function getAngularComponent(el) {
    const ng = window.ng;
    if (!ng || typeof ng.getComponent !== "function") return null;

    const ancestry = [];
    let node = el;
    let steps = 0;
    while (node && node.nodeType === 1 && steps < 50) {
      steps += 1;
      let cmp = null;
      try {
        cmp = ng.getComponent(node) || (ng.getOwningComponent && ng.getOwningComponent(node));
      } catch (err) {
        cmp = null;
      }
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

  // --- Svelte (dev-mode source location only) -------------------------

  function getSvelteComponent(el) {
    let node = el;
    let steps = 0;
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

  // --- Web Components / Lit / Stencil --------------------------------

  function getWebComponent(el) {
    let node = el;
    let steps = 0;
    while (node && node.nodeType === 1 && steps < 50) {
      steps += 1;
      const tag = node.tagName.toLowerCase();
      if (tag.includes("-")) {
        let name = tag;
        try {
          const ctor = customElements.get(tag);
          if (ctor && ctor.name && !looksMinified(ctor.name)) name = ctor.name;
        } catch (err) {
          /* customElements.get can throw on an invalid name — keep the tag */
        }
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

  // --- dev-tooling source attributes (Astro, react-dev-inspector) ----

  function getSourceFromAttributes(el) {
    let node = el;
    let depth = 0;
    while (node && node.nodeType === 1 && depth < DATA_ATTRIBUTE_MAX_DEPTH) {
      for (const pair of SOURCE_ATTR_PAIRS) {
        const file = node.getAttribute(pair[0]);
        if (file) {
          const loc = node.getAttribute(pair[1]) || "";
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
    let node = el;
    let depth = 0;
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

  // --- orchestrator -------------------------------------------------

  function getComponentInfo(el) {
    const probes = [
      getReactComponent, getVueComponent, getAngularComponent,
      getSvelteComponent, getWebComponent, getSourceFromAttributes, getDataAttributeName,
    ];

    let result = null;
    for (const probe of probes) {
      try {
        const hit = probe(el);
        if (hit && (hit.name || hit.source !== "none")) {
          result = hit;
          break;
        }
      } catch (err) {
        console.warn("SpotCheck: component probe " + probe.name + " failed", err);
      }
    }
    if (!result) return Object.assign({}, EMPTY_COMPONENT);

    // Opportunistically fill a missing source path from dev-inspector / Astro
    // attributes even when the name came from a framework instance tree
    // (a React app using react-dev-inspector is the common case).
    if (!result.sourcePath) {
      try {
        const src = getSourceFromAttributes(el);
        if (src && src.sourcePath) {
          result.sourcePath = src.sourcePath;
          result.sourceLine = src.sourceLine;
        }
      } catch (err) {
        /* non-fatal */
      }
    }

    if (result.name && looksMinified(result.name)) result.confidence = "low";
    if (!Array.isArray(result.ancestry)) result.ancestry = [];
    return result;
  }

  // --- message channel (isolated world <-> here) ---------------------

  window.addEventListener("message", (ev) => {
    if (ev.source !== window) return;
    const d = ev.data;
    if (!d || d.__spotcheck !== "probe-request" || typeof d.nonce !== "string") return;

    let component = null;
    try {
      const el = d.selector ? document.querySelector(d.selector) : null;
      if (el) component = getComponentInfo(el);
    } catch (err) {
      component = null;
    }

    // targetOrigin "*" — same-frame isolated<->main delivery, matching
    // Chrome's own documented content-script<->page messaging example. The
    // payload (a selector one way, a component descriptor the other) is not
    // sensitive relative to what a same-frame page script can already read.
    try {
      window.postMessage({ __spotcheck: "probe-response", nonce: d.nonce, component }, "*");
    } catch (err) {
      /* give up quietly */
    }
  });
})();
