// Listens for spotcheck:element-selected independently — never reads
// state.js/overlay.js/picker.js directly. Computes a selector path, a
// curated computed-style snapshot, and a best-effort component name, then
// dispatches spotcheck:element-captured with all three. Pure synchronous
// DOM reads only; no network calls, nothing written back to the page.

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

  const DATA_ATTRIBUTES = ["data-testid", "data-component", "data-cy", "data-component-name"];
  const DATA_ATTRIBUTE_MAX_DEPTH = 5;

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

  function getReactComponentName(el) {
    let fiber = getReactFiber(el);
    while (fiber) {
      const type = fiber.type;
      if (typeof type === "function") {
        const name = type.displayName || type.name;
        if (name) return name;
      } else if (type && typeof type === "object" && type.displayName) {
        return type.displayName;
      }
      fiber = fiber.return;
    }
    return null;
  }

  function getVueComponentName(el) {
    const vue3 = el.__vueParentComponent;
    if (vue3 && vue3.type) {
      const name = vue3.type.name || vue3.type.__name;
      if (name) return name;
    }

    const vue2 = el.__vue__;
    if (vue2 && vue2.$options) {
      const name = vue2.$options.name || vue2.$options._componentTag;
      if (name) return name;
    }

    return null;
  }

  function getDataAttributeName(el) {
    let node = el;
    let depth = 0;

    while (node && node.nodeType === 1 && depth < DATA_ATTRIBUTE_MAX_DEPTH) {
      for (const attr of DATA_ATTRIBUTES) {
        const value = node.getAttribute(attr);
        if (value) return value;
      }
      node = node.parentElement;
      depth += 1;
    }

    return null;
  }

  function getComponentInfo(el) {
    const reactName = getReactComponentName(el);
    if (reactName) return { name: reactName, source: "react" };

    const vueName = getVueComponentName(el);
    if (vueName) return { name: vueName, source: "vue" };

    const dataName = getDataAttributeName(el);
    if (dataName) return { name: dataName, source: "data-attribute" };

    return { name: null, source: "none" };
  }

  function captureElement(el) {
    let selector = null;
    let styles = null;
    let component = { name: null, source: "none" };

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
