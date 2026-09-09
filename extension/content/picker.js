// Wires up hover, click-to-lock, and Escape-to-cancel. Owns the on/off
// lifecycle for inspection mode; background.js only ever sends it a toggle
// message, it never reaches into picker state directly.

window.__spotcheck = window.__spotcheck || {};

(function (spotcheck) {
  if (spotcheck.picker) return;

  let listenersAttached = false;

  function onMouseMove(e) {
    const hitEl = document.elementFromPoint(e.clientX, e.clientY);
    if (hitEl && spotcheck.uiHosts.has(hitEl)) return;
    if (!hitEl || hitEl === spotcheck.state.hoveredElement) return;
    spotcheck.state.hoveredElement = hitEl;
    spotcheck.overlay.showHighlight(hitEl, "hover");
    // Feature 9 — announce the hover so capture.js can ask the MAIN-world
    // probe what component this is, and overlay.js can label the box with
    // the answer. Fired only when the hovered element actually *changes*
    // (the early return above), not on every mousemove. Carries the pointer
    // coordinates so the probe can re-resolve the node without capture.js
    // having to build a selector path per hover — see component-probe.js's
    // resolveTarget.
    document.dispatchEvent(
      new CustomEvent("spotcheck:element-hovered", {
        detail: { element: hitEl, x: e.clientX, y: e.clientY },
      })
    );
  }

  function onClick(e) {
    const hitEl = document.elementFromPoint(e.clientX, e.clientY);
    if (hitEl && spotcheck.uiHosts.has(hitEl)) {
      // Click landed on one of SpotCheck's own Shadow DOM UI hosts (Feature
      // 3's bubbles/popup, Feature 4's export button, etc), not a page
      // element — elementFromPoint returns the shadow host itself for any
      // point covered by a Shadow DOM tree. Step aside so the click
      // continues on to that feature's own listeners; don't
      // preventDefault/stopPropagation here. picker.js doesn't need to know
      // which feature owns the host, only that it isn't page content — see
      // state.js's spotcheck.uiHosts.
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    if (!hitEl) return;
    spotcheck.setSelectedElement(hitEl); // shows the locked highlight itself, see state.js
  }

  function onKeyDown(e) {
    if (e.key !== "Escape") return;
    // TODO: this clears the lock unconditionally, even while keyboard focus
    // is inside the annotation layer's note textarea — pressing Escape
    // mid-typing (e.g. out of habit, to dismiss a browser autofill dropdown)
    // discards an unsaved draft. Known gap, explicitly deferred, not fixed.
    spotcheck.clearSelection();
    spotcheck.state.hoveredElement = null;
    spotcheck.overlay.hideHighlight();
  }

  function start() {
    if (listenersAttached) return;
    document.addEventListener("mousemove", onMouseMove, true);
    document.addEventListener("click", onClick, true);
    document.addEventListener("keydown", onKeyDown, true);
    listenersAttached = true;
  }

  function stop() {
    if (!listenersAttached) return;
    document.removeEventListener("mousemove", onMouseMove, true);
    document.removeEventListener("click", onClick, true);
    document.removeEventListener("keydown", onKeyDown, true);
    listenersAttached = false;

    spotcheck.overlay.teardown();
    spotcheck.clearSelection();
    spotcheck.state.hoveredElement = null;
  }

  chrome.runtime.onMessage.addListener((message) => {
    if (!message || message.type !== "SPOTCHECK_SET_ACTIVE") return;
    // Absolute state, not a flip — see background.js's sendSetActive for why.
    spotcheck.state.active = message.active;
    if (spotcheck.state.active) {
      start();
    } else {
      stop();
    }
  });

  // TODO: elementFromPoint cannot see inside cross-origin <iframe>s — the
  // picker will select the iframe element itself, not its internal content.
  // Out of scope for v1.

  spotcheck.picker = { start, stop };
})(window.__spotcheck);
