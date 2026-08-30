// Shared state for the content-script bundle. Classic script (no ES modules,
// no bundler) — everything hangs off window.__spotcheck so state.js,
// overlay.js, and picker.js share one namespaced global in this isolated
// world. Wrapped in an IIFE with a guard so re-injection into an already
// active tab never throws on redeclaration.

window.__spotcheck = window.__spotcheck || {};

(function (spotcheck) {
  if (spotcheck.state) return;

  spotcheck.state = {
    active: false,
    hoveredElement: null,
    selectedElement: null,
    shadowRoot: null,
  };

  // Shared registry of every SpotCheck-owned Shadow DOM host that renders
  // its own clickable UI (Feature 3's bubbles/popup, Feature 4's export
  // button, and any future feature like them). picker.js checks membership
  // here instead of hardcoding a separate hitEl === someFeature.hostEl
  // branch per feature — it only needs to know "this click landed on our
  // own UI," never which feature owns that UI. Each feature's ensureHost()
  // adds its host on creation; stop() removes it on teardown.
  spotcheck.uiHosts = new Set();

  spotcheck.setSelectedElement = function (el) {
    spotcheck.state.selectedElement = el;
    // Showing the locked highlight lives here, not in each caller, so every
    // path that selects an element (a fresh page click via picker.js, or
    // re-selecting an already-annotated element via its bubble) shows the
    // same green highlight without duplicating that call at each call site.
    spotcheck.overlay.showHighlight(el, "locked");
    document.dispatchEvent(
      new CustomEvent("spotcheck:element-selected", { detail: { element: el } })
    );
  };

  spotcheck.clearSelection = function () {
    spotcheck.state.selectedElement = null;
  };
})(window.__spotcheck);
