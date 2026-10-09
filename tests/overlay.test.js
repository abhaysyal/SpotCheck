// Feature 9 — the hover component badge overlay.js draws on the highlight
// box. Driven through overlay.js's public API (window.__spotcheck.overlay,
// the namespaced global CLAUDE.md describes) plus the two CustomEvents it
// listens for, and asserted against the real Shadow DOM it builds.

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createPage } from "./helpers/dom-harness.js";

const PAGE_HTML = `<!doctype html><html><body>
  <button id="submit">Place order</button>
  <span id="price">$42</span>
</body></html>`;

let page;
let overlay;

beforeEach(() => {
  page = createPage({ html: PAGE_HTML, scripts: ["state.js", "overlay.js"] });
  overlay = page.window.__spotcheck.overlay;
});

afterEach(() => {
  page.close();
});

const $ = (sel) => page.document.querySelector(sel);

/** overlay.js keeps its UI in an open shadow root on a child of <html>. */
function shadowQuery(selector) {
  for (const host of page.document.documentElement.children) {
    if (!host.shadowRoot) continue;
    const found = host.shadowRoot.querySelector(selector);
    if (found) return found;
  }
  return null;
}

const label = () => shadowQuery(".label");
const box = () => shadowQuery(".box");

function emitHoverComponent(element, component) {
  page.document.dispatchEvent(
    new page.window.CustomEvent("spotcheck:hover-component", {
      detail: { element, component },
    })
  );
}

function emitCaptured(element, component) {
  page.document.dispatchEvent(
    new page.window.CustomEvent("spotcheck:element-captured", {
      detail: { element, component },
    })
  );
}

const named = (name) => ({
  name,
  source: "react",
  confidence: "high",
  sourcePath: "src/Button.tsx",
  sourceLine: 4,
  ancestry: [name],
});

const nameless = () => ({
  name: null,
  source: "none",
  confidence: "low",
  sourcePath: null,
  sourceLine: null,
  ancestry: [],
});

describe("highlight box", () => {
  test("builds its UI inside a shadow root, not the page", () => {
    overlay.showHighlight($("#submit"), "hover");

    assert.ok(box(), "expected a .box inside a shadow root");
    // Nothing of ours leaks into the page's own tree.
    assert.equal(page.document.querySelector(".box"), null);
  });

  test("starts with no label until a component is known", () => {
    overlay.showHighlight($("#submit"), "hover");

    assert.equal(label().style.display, "none");
    assert.equal(label().textContent, "");
  });

  test("hides box and label when the tracked element leaves the DOM", async () => {
    const button = $("#submit");
    overlay.showHighlight(button, "hover");
    emitHoverComponent(button, named("SubmitButton"));
    assert.equal(label().style.display, "block");

    // A SPA re-render drops the element. Nothing calls back into overlay.js
    // here — the continuous requestAnimationFrame loop is what notices, so
    // the test has to let a frame actually run rather than poking the API.
    button.remove();
    await page.settle(80);

    assert.equal(box().style.display, "none");
    assert.equal(label().style.display, "none");
  });
});

describe("component badge", () => {
  test("shows the component name on hover", () => {
    const button = $("#submit");
    overlay.showHighlight(button, "hover");

    emitHoverComponent(button, named("SubmitButton"));

    assert.equal(label().textContent, "SubmitButton");
    assert.equal(label().style.display, "block");
    assert.equal(label().className, "label hover");
  });

  test("shows only the name — not the path, confidence or ancestry", () => {
    const button = $("#submit");
    overlay.showHighlight(button, "hover");

    emitHoverComponent(button, named("SubmitButton"));

    // Those belong in the popup and the export, where there is room to read
    // them; the badge answers one question.
    assert.equal(label().textContent, "SubmitButton");
  });

  test("survives the hover becoming a lock, and recolours", () => {
    const button = $("#submit");
    overlay.showHighlight(button, "hover");
    emitHoverComponent(button, named("SubmitButton"));

    overlay.showHighlight(button, "locked"); // same element, new mode

    // Dropping the name here would flicker it off at the exact moment the
    // user commits to the element.
    assert.equal(label().textContent, "SubmitButton");
    assert.equal(label().className, "label locked");
  });

  test("clears when the highlight moves to a different element", () => {
    overlay.showHighlight($("#submit"), "hover");
    emitHoverComponent($("#submit"), named("SubmitButton"));

    overlay.showHighlight($("#price"), "hover");

    assert.equal(label().style.display, "none");
  });

  test("a nameless component never clears a name already shown", () => {
    const button = $("#submit");
    overlay.showHighlight(button, "hover");
    emitHoverComponent(button, named("SubmitButton"));

    // capture.js's click path deliberately dispatches an empty placeholder
    // first and fills it a beat later; the placeholder must not wipe this.
    emitCaptured(button, nameless());

    assert.equal(label().textContent, "SubmitButton");
    assert.equal(label().style.display, "block");
  });

  test("ignores a descriptor for an element that is not highlighted", () => {
    overlay.showHighlight($("#submit"), "hover");

    // A late reply for an element the pointer already left.
    emitHoverComponent($("#price"), named("PriceLabel"));

    assert.equal(label().style.display, "none");
  });

  test("labels the locked element even when hover never resolved one", () => {
    const button = $("#submit");
    overlay.showHighlight(button, "locked");

    emitCaptured(button, named("SubmitButton"));

    assert.equal(label().textContent, "SubmitButton");
    assert.equal(label().className, "label locked");
  });

  test("hideHighlight drops the badge with the box", () => {
    const button = $("#submit");
    overlay.showHighlight(button, "hover");
    emitHoverComponent(button, named("SubmitButton"));

    overlay.hideHighlight();

    assert.equal(box().style.display, "none");
    assert.equal(label().style.display, "none");
  });

  test("a component arriving before any highlight is ignored, not thrown on", () => {
    emitHoverComponent($("#submit"), named("SubmitButton"));

    assert.equal(label(), null); // no host built yet
    assert.deepEqual(page.errors(), []);
  });
});

describe("badge placement", () => {
  test("sits just above the box's top-left corner", () => {
    const button = $("#submit");
    page.setRect(button, { top: 100, left: 40, width: 120, height: 32 });
    overlay.showHighlight(button, "hover");

    emitHoverComponent(button, named("SubmitButton"));

    // jsdom reports offsetHeight 0, so the code's 18px fallback applies:
    // 100 - 18 - 4 = 78.
    assert.equal(label().style.top, "78px");
    assert.equal(label().style.left, "40px");
  });

  test("flips inside the element when there is no room above", () => {
    const button = $("#submit");
    page.setRect(button, { top: 2, left: 0, width: 120, height: 32 });
    overlay.showHighlight(button, "hover");

    emitHoverComponent(button, named("SubmitButton"));

    assert.equal(label().style.top, "6px"); // rect.top + 4, not a negative offset
  });

  test("never positions the badge off the left edge", () => {
    const button = $("#submit");
    page.setRect(button, { top: 100, left: -50, width: 120, height: 32 });
    overlay.showHighlight(button, "hover");

    emitHoverComponent(button, named("SubmitButton"));

    assert.equal(label().style.left, "0px");
  });
});

describe("teardown", () => {
  test("removes the host and forgets the label", () => {
    const button = $("#submit");
    overlay.showHighlight(button, "hover");
    emitHoverComponent(button, named("SubmitButton"));

    overlay.teardown();

    assert.equal(label(), null);
    assert.equal(box(), null);

    // Toggling back on starts clean rather than restoring a stale name.
    overlay.showHighlight(button, "hover");
    assert.equal(label().style.display, "none");
  });
});
