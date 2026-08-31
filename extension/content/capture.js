// Listens for spotcheck:element-selected independently — never reads
// state.js/overlay.js/picker.js directly. Computes a selector path and a
// curated computed-style snapshot synchronously, dispatches
// spotcheck:element-captured, then asks the MAIN-world component probe
// (content/component-probe.js) for the component descriptor and re-dispatches
// spotcheck:element-captured once it comes back. Pure synchronous DOM reads
// here; no network calls, nothing written back to the page.
//
// Why the split: this file runs in Chrome's ISOLATED world, where the
// properties React/Vue/Svelte/Angular attach to DOM nodes (el.__reactFiber$*,
// el.__vue__, el.__svelte_meta, …) and page globals
// (window.__REACT_DEVTOOLS_GLOBAL_HOOK__, window.ng) are all invisible. The
// probe runs in the page's MAIN world where it can read them, and hands back
// a plain-JSON descriptor over window.postMessage. See
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

  // Feature 8 — the shape content/component-probe.js also produces (keep in
  // sync with that file's emptyComponent()). Used as the placeholder in the
  // first (synchronous) spotcheck:element-captured; the probe's real answer
  // arrives in a second dispatch. A function, not a shared object constant —
  // `ancestry` is an array, and a shared instance would let a future push()
  // onto any one "empty" component corrupt every other one.
  function emptyComponent() {
    return {
      name: null, source: "none", confidence: "low",
      sourcePath: null, sourceLine: null, ancestry: [],
    };
  }
  const PROBE_TIMEOUT_MS = 800;

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

  function captureElement(el) {
    let selector = null;
    let styles = null;

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

    return {
      element: el,
      tagName: el.tagName.toLowerCase(),
      id: el.id || null,
      // SVG elements expose className as an SVGAnimatedString, not a string —
      // fall back to null there rather than capturing the wrong shape.
      classNames: typeof el.className === "string" ? el.className.trim() || null : null,
      selector,
      styles,
      component: emptyComponent(), // real value arrives via the probe, see below
    };
  }

  // --- MAIN-world probe channel ----------------------------------------

  let probeSeq = 0;
  const pendingProbes = new Map(); // nonce -> resolve fn

  window.addEventListener("message", (ev) => {
    if (ev.source !== window) return;
    const d = ev.data;
    if (!d || d.__spotcheck !== "probe-response" || typeof d.nonce !== "string") return;
    const resolve = pendingProbes.get(d.nonce);
    if (!resolve) return;
    pendingProbes.delete(d.nonce);
    resolve(d.component || null);
  });

  function requestComponent(selector, tagName) {
    if (!selector) return Promise.resolve(null);
    return new Promise((resolve) => {
      const nonce = `sc-${Date.now()}-${probeSeq++}`;
      pendingProbes.set(nonce, resolve);
      try {
        // tagName lets the probe reject a selector that, by the time it runs
        // (up to PROBE_TIMEOUT_MS later), now resolves to a different element
        // than the one the user clicked — e.g. an SPA re-render reordering
        // siblings shifts what an :nth-of-type-based selector matches.
        window.postMessage({ __spotcheck: "probe-request", nonce, selector, tagName }, "*");
      } catch (err) {
        pendingProbes.delete(nonce);
        resolve(null);
        return;
      }
      // Probe not installed (restricted page), or a slow page — don't leave
      // the caller hanging or the map growing.
      setTimeout(() => {
        if (pendingProbes.has(nonce)) {
          pendingProbes.delete(nonce);
          resolve(null);
        }
      }, PROBE_TIMEOUT_MS);
    });
  }

  document.addEventListener("spotcheck:element-selected", (e) => {
    const el = e.detail && e.detail.element;
    if (!el) return;

    const detail = captureElement(el);
    document.dispatchEvent(new CustomEvent("spotcheck:element-captured", { detail }));

    // Second pass: enrich with the component descriptor from the MAIN world.
    // Downstream (annotations.js) already re-reads spotcheck:element-captured
    // and updates both its capture cache and any existing record, so a second
    // dispatch for the same element is the intended way to deliver this late.
    requestComponent(detail.selector, detail.tagName).then((component) => {
      if (!component || !el.isConnected) return;
      document.dispatchEvent(
        new CustomEvent("spotcheck:element-captured", {
          detail: Object.assign({}, detail, { element: el, component }),
        })
      );
    });
  });

  spotcheck.capture = { captureElement };
})(window.__spotcheck);
