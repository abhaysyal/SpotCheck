// Draws the hover/locked highlight box inside a Shadow DOM root, so the
// host page's CSS can't distort it and its own styles can't leak onto the
// page being inspected.

window.__spotcheck = window.__spotcheck || {};

(function (spotcheck) {
  if (spotcheck.overlay) return;

  let hostEl = null;
  let shadowRoot = null;
  let boxEl = null;

  // The box only gets repositioned when showHighlight is called, which only
  // happens from picker.js's mousemove/click handlers — so scrolling the
  // page without moving the mouse left the box exactly where it was,
  // visually detached from the element it's supposed to be tracking. A
  // continuous rAF loop re-reads the target's live rect every frame instead,
  // regardless of what caused it to move (scroll, resize, anything else) —
  // same reasoning, same fix, as annotations.js's persistent outlines.
  let lastTarget = null;
  let lastMode = null;
  let rafId = null;

  // Feature 9 — the component name for lastTarget, or null when we don't
  // know one (no framework, probe not installed, answer not back yet). Kept
  // as plain text next to the box rather than a second overlay of its own:
  // it has to move with the box every frame anyway, so it belongs to the
  // same shadow root and the same applyPosition pass.
  let labelEl = null;
  let labelText = null;

  function ensureHost() {
    if (hostEl) return;

    hostEl = document.createElement("div");
    hostEl.style.all = "initial";
    hostEl.style.position = "fixed";
    hostEl.style.top = "0";
    hostEl.style.left = "0";
    hostEl.style.width = "0";
    hostEl.style.height = "0";
    hostEl.style.zIndex = "2147483647";
    document.documentElement.appendChild(hostEl);

    shadowRoot = hostEl.attachShadow({ mode: "open" });
    spotcheck.state.shadowRoot = shadowRoot;

    const style = document.createElement("style");
    style.textContent = `
      .box {
        position: fixed;
        box-sizing: border-box;
        pointer-events: none;
        border: 2px solid transparent;
        border-radius: 2px;
        display: none;
      }
      .box.hover { border-color: #3b82f6; background: rgba(59, 130, 246, 0.08); }
      .box.locked { border-color: #22c55e; background: rgba(34, 197, 94, 0.08); }

      /* Feature 9 — component name badge, colour-matched to the box it
         belongs to so hover vs locked stays readable at a glance. */
      .label {
        position: fixed;
        box-sizing: border-box;
        display: none;
        max-width: 60vw;
        padding: 2px 6px;
        border-radius: 3px;
        background: #3b82f6;
        color: #ffffff;
        font: 500 11px/1.45 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        pointer-events: none;
      }
      .label.locked { background: #22c55e; }
    `;
    // No CSS transition on .box: an eased position change looks fine when
    // hopping between two different elements on a click/hover, but would
    // make the box visibly *chase* the element (a trailing lag, the exact
    // opposite of "stuck to it") once it's being repositioned every single
    // animation frame during a scroll.
    shadowRoot.appendChild(style);

    boxEl = document.createElement("div");
    boxEl.className = "box";
    shadowRoot.appendChild(boxEl);

    labelEl = document.createElement("div");
    labelEl.className = "label";
    shadowRoot.appendChild(labelEl);

    startTracking();
  }

  function applyPosition() {
    if (!lastTarget || !boxEl) return;
    if (!document.body.contains(lastTarget)) {
      if (labelEl) labelEl.style.display = "none";
      // The hovered/locked element was removed from the page (e.g. a SPA
      // re-render) while still tracked — getBoundingClientRect() on a
      // detached node returns an all-zero rect, which would otherwise pin a
      // visible 0x0 box at the viewport's top-left corner forever. Hide
      // instead, same as annotations.js's outlines/bubbles already do for
      // the identical case.
      boxEl.style.display = "none";
      return;
    }
    const rect = lastTarget.getBoundingClientRect();
    boxEl.style.top = `${rect.top}px`;
    boxEl.style.left = `${rect.left}px`;
    boxEl.style.width = `${rect.width}px`;
    boxEl.style.height = `${rect.height}px`;
    positionLabel(rect);
  }

  // Sits just above the box's top-left corner, the way the devtools
  // inspectors place theirs — and flips to just below that edge when the
  // element is hard against the top of the viewport and there's no room.
  function positionLabel(rect) {
    if (!labelEl || !labelText) return;
    const height = labelEl.offsetHeight || 18;
    const above = rect.top - height - 4;
    labelEl.style.top = `${above >= 0 ? above : Math.max(rect.top + 4, 0)}px`;
    labelEl.style.left = `${Math.max(rect.left, 0)}px`;
  }

  function renderLabel() {
    if (!labelEl) return;
    if (!labelText) {
      labelEl.style.display = "none";
      return;
    }
    labelEl.textContent = labelText;
    labelEl.className = `label ${lastMode === "locked" ? "locked" : "hover"}`;
    labelEl.style.display = "block";
    if (lastTarget && document.body.contains(lastTarget)) {
      positionLabel(lastTarget.getBoundingClientRect());
    }
  }

  function trackingLoop() {
    if (!hostEl) return; // torn down mid-flight — stop silently, don't reschedule
    applyPosition();
    rafId = requestAnimationFrame(trackingLoop);
  }

  function startTracking() {
    if (rafId) return;
    rafId = requestAnimationFrame(trackingLoop);
  }

  function stopTracking() {
    if (rafId) cancelAnimationFrame(rafId);
    rafId = null;
  }

  function showHighlight(el, mode) {
    if (!el) return;
    ensureHost();

    // Only a *change* of target invalidates the label. Clicking to lock
    // re-highlights the same element in a different mode, and dropping the
    // name there would make it flicker off at the exact moment the user
    // commits to that element.
    if (el !== lastTarget) labelText = null;

    lastTarget = el;
    lastMode = mode;
    applyPosition();
    boxEl.style.display = "block";
    boxEl.className = `box ${mode === "locked" ? "locked" : "hover"}`;
    renderLabel();
  }

  function hideHighlight() {
    if (boxEl) boxEl.style.display = "none";
    if (labelEl) labelEl.style.display = "none";
    lastTarget = null;
    labelText = null;
  }

  // Feature 9 — capture.js answers a hover with the MAIN-world probe's
  // component descriptor; the click path's spotcheck:element-captured
  // carries the same shape, so the locked element gets labelled too even if
  // the pointer never rested on it long enough for the hover probe to run.
  // Both are ignored unless they describe the element currently highlighted
  // — a late reply for an element the pointer has left is stale, not new
  // information. A nameless component never clears an existing label: the
  // click path deliberately dispatches an empty placeholder first and fills
  // it in a beat later (see capture.js), and that placeholder must not wipe
  // a name hover already resolved.
  function applyComponentLabel(el, component) {
    if (!el || el !== lastTarget) return;
    if (!component || !component.name) return;
    labelText = component.name;
    renderLabel();
  }

  document.addEventListener("spotcheck:hover-component", (e) => {
    if (!e.detail) return;
    applyComponentLabel(e.detail.element, e.detail.component);
  });

  document.addEventListener("spotcheck:element-captured", (e) => {
    if (!e.detail) return;
    applyComponentLabel(e.detail.element, e.detail.component);
  });

  function teardown() {
    stopTracking();
    if (hostEl) hostEl.remove();
    hostEl = null;
    shadowRoot = null;
    boxEl = null;
    labelEl = null;
    labelText = null;
    lastTarget = null;
    lastMode = null;
    spotcheck.state.shadowRoot = null;
  }

  spotcheck.overlay = { showHighlight, hideHighlight, teardown };
})(window.__spotcheck);
