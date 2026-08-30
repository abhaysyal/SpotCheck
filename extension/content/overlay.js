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

    startTracking();
  }

  function applyPosition() {
    if (!lastTarget || !boxEl) return;
    if (!document.body.contains(lastTarget)) {
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

    lastTarget = el;
    lastMode = mode;
    applyPosition();
    boxEl.style.display = "block";
    boxEl.className = `box ${mode === "locked" ? "locked" : "hover"}`;
  }

  function hideHighlight() {
    if (boxEl) boxEl.style.display = "none";
    lastTarget = null;
  }

  function teardown() {
    stopTracking();
    if (hostEl) hostEl.remove();
    hostEl = null;
    shadowRoot = null;
    boxEl = null;
    lastTarget = null;
    lastMode = null;
    spotcheck.state.shadowRoot = null;
  }

  spotcheck.overlay = { showHighlight, hideHighlight, teardown };
})(window.__spotcheck);
