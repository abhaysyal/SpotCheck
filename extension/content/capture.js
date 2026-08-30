// Listens for spotcheck:element-selected independently — never reads
// state.js/overlay.js/picker.js directly. Computes a selector path, a
// curated computed-style snapshot, and a best-effort component name, then
// dispatches spotcheck:element-captured with all three. Pure synchronous
// DOM reads only; no network calls, nothing written back to the page.
//
// Feature 8 rewrote the component half: modern-framework-aware extraction
// (React with memo/forwardRef/library-wrapper unwrapping, Vue 3 <script
// setup>, Svelte, Angular, Web Components, Astro islands), plus a source
// file path/line, a confidence flag, and the component ancestry. Still
// best-effort against undocumented framework internals — production/minified
// builds degrade to confidence:"low" or source:"none", and sourcePath is
// only present when the target app's own dev build put it in the DOM/fiber
// tree (the extension never reads the filesystem). See
// docs/features/feature-8-component-name-extraction/spec.md.

window.__spotcheck = window.__spotcheck || {};

(function (spotcheck) {
  if (spotcheck.capture) return;

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

  // --- Feature 8: modern-framework component extraction -----------------
  //
  // Component names that are library/tooling wrappers, never what a user
  // means by "this component." Exact match, case-sensitive.
  const NOISE_COMPONENT_NAMES = new Set([
    "Slot", "SlotClone", "Provider", "Consumer", "Router", "Routes", "Route",
    "Outlet", "Suspense", "SuspenseList", "ErrorBoundary", "Profiler",
    "StrictMode", "Fragment", "EmotionCssPropInternal", "Anonymous",
    "Transition", "TransitionGroup", "KeepAlive", "RouterView", "RouterLink",
  ]);
  // Prefix/pattern noise: styled-components, MUI HOCs, unnamed wrappers,
  // Radix primitives, bare context objects.
  const NOISE_COMPONENT_PATTERNS = [
    /^Styled\(/, /^styled\./, /^WithStyles\(/, /^With[A-Z]/,
    /^Primitive\./, /^Context\./, /^ForwardRef\(\)?$/, /^Memo\(\)?$/,
  ];
  // A name that looks like a minifier output rather than a real identifier.
  const MINIFIED_NAME_RE = /^[$_a-z]{1,2}$|[a-f0-9]{6,}$/;

  const DATA_ATTRIBUTES = [
    "data-testid", "data-component", "data-component-name", "data-cy", "data-slot",
  ];
  // [fileAttr, lineAttr] pairs emitted by dev tooling (Astro, react-dev-inspector).
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

  function getSelectorPath(el) {
    // elementFromPoint can legitimately return <html> itself (e.g. clicking
    // viewport space below a short page's content) — the loop below is
    // written to walk *up to but excluding* document.documentElement, so
    // without this early case it would never run at all for that one
    // element and silently return "" instead of "html".
    if (el === document.documentElement) return "html";

    const segments = [];
    let node = el;

    while (node && node.nodeType === 1 && node !== document.documentElement) {
      const id = node.id;
      if (id && document.querySelectorAll(`#${CSS.escape(id)}`).length === 1) {
        segments.unshift(`#${CSS.escape(id)}`);
        break;
      }

      const tag = node.tagName.toLowerCase();
      const parent = node.parentElement;
      if (!parent) {
        segments.unshift(tag);
        break;
      }

      const sameTagSiblings = Array.from(parent.children).filter((c) => c.tagName === node.tagName);
      const index = sameTagSiblings.indexOf(node) + 1;
      segments.unshift(sameTagSiblings.length > 1 ? `${tag}:nth-of-type(${index})` : tag);

      node = parent;
    }

    return segments.join(" > ");
  }

  function getRelevantStyles(el) {
    const computed = window.getComputedStyle(el);
    const result = {};

    for (const prop of BASE_PROPERTIES) {
      result[prop] = computed[prop];
    }
    if (computed.display.includes("flex")) {
      for (const prop of FLEX_PROPERTIES) result[prop] = computed[prop];
    }
    if (computed.display.includes("grid")) {
      for (const prop of GRID_PROPERTIES) result[prop] = computed[prop];
    }

    return result;
  }

  function getReactFiber(node) {
    const key = Object.keys(node).find(
      (k) => k.startsWith("__reactFiber$") || k.startsWith("__reactInternalInstance$")
    );
    return key ? node[key] : null;
  }

  // --- name classification + path helpers (Feature 8) -------------------

  function isNoiseName(name) {
    if (!name || typeof name !== "string") return true;
    if (NOISE_COMPONENT_NAMES.has(name)) return true;
    return NOISE_COMPONENT_PATTERNS.some((re) => re.test(name));
  }

  function looksMinified(name) {
    return typeof name === "string" && MINIFIED_NAME_RE.test(name);
  }

  // Trim a build-machine absolute path to start at the last recognizable
  // project-root segment. Pure string work — the extension never reads,
  // resolves, or opens the path; it's only ever a hint the page volunteered.
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

  // --- Vue 2 / Vue 3 -------------------------------------------------------

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

  // --- Angular ----------------------------------------------------------

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

  // --- Svelte (dev-mode source location only) ----------------------------

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

  // --- Web Components / Lit / Stencil ----------------------------------

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

  // --- dev-tooling source attributes (Astro, react-dev-inspector) --------

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

  // --- orchestrator ---------------------------------------------------

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
    if (!("ancestry" in result)) result.ancestry = [];
    return result;
  }

  function captureElement(el) {
    let selector = null;
    let styles = null;
    let component = Object.assign({}, EMPTY_COMPONENT);

    try {
      selector = getSelectorPath(el);
    } catch (err) {
      console.warn("SpotCheck: selector capture failed", err);
    }
    try {
      styles = getRelevantStyles(el);
    } catch (err) {
      console.warn("SpotCheck: style capture failed", err);
    }
    try {
      component = getComponentInfo(el);
    } catch (err) {
      console.warn("SpotCheck: component capture failed", err);
    }

    return {
      element: el,
      tagName: el.tagName.toLowerCase(),
      id: el.id || null,
      // SVG elements expose className as an SVGAnimatedString, not a string —
      // fall back to null there rather than capturing the wrong shape.
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

  spotcheck.capture = { captureElement };
})(window.__spotcheck);
