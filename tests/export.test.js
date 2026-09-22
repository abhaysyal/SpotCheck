// Feature 4/8 — the Markdown bundle export.js puts on the clipboard. This is
// "the prompt" the whole tool exists to produce, so the component fields
// Feature 8 added are asserted here rather than trusted.
//
// Driven the way the extension drives it: the SPOTCHECK_SET_ACTIVE broadcast
// to start, an annotation-saved event carrying the queue, then a real click
// on the button export.js builds in its own shadow root.

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createPage } from "./helpers/dom-harness.js";

let page;

beforeEach(() => {
  page = createPage({
    html: `<!doctype html><html><head><title>Checkout — Acme</title></head><body>
      <button id="submit">Place order</button>
    </body></html>`,
    url: "https://acme.test/checkout?step=2",
    scripts: ["state.js", "export.js"],
  });
  page.setInspectionMode(true);
});

afterEach(() => {
  page.close();
});

function exportButton() {
  for (const host of page.document.documentElement.children) {
    if (!host.shadowRoot) continue;
    const found = host.shadowRoot.querySelector(".export-button");
    if (found) return found;
  }
  return null;
}

/** The snapshot annotations.js broadcasts after every save. */
function publishQueue(allAnnotations) {
  page.document.dispatchEvent(
    new page.window.CustomEvent("spotcheck:annotation-saved", {
      detail: { allAnnotations },
    })
  );
}

async function copyToClipboard() {
  exportButton().dispatchEvent(new page.window.MouseEvent("click", { bubbles: true }));
  await page.settle(10);
  const writes = page.window.__clipboardWrites;
  return writes[writes.length - 1];
}

const withComponent = {
  number: 1,
  selector: "#submit",
  note: "Padding looks 4px too tight here.",
  component: {
    name: "SubmitButton",
    source: "react",
    confidence: "high",
    sourcePath: "src/checkout/SubmitButton.jsx",
    sourceLine: 24,
    ancestry: ["SubmitButton", "CheckoutForm", "App"],
  },
  styles: { paddingTop: "10px", backgroundColor: "rgb(239, 239, 239)" },
};

describe("the copy button", () => {
  test("stays hidden until there is something to export", () => {
    assert.equal(exportButton().style.display, "none");
  });

  test("appears with a count once annotations exist", () => {
    publishQueue([withComponent]);

    assert.equal(exportButton().style.display, "flex");
    assert.match(exportButton().textContent, /Copy \(1\)/);
  });

  test("tracks the queue length, including back down to zero", () => {
    publishQueue([withComponent, { ...withComponent, number: 2 }]);
    assert.match(exportButton().textContent, /Copy \(2\)/);

    publishQueue([]);
    assert.equal(exportButton().style.display, "none");
  });
});

describe("markdown bundle", () => {
  test("includes the page context", async () => {
    publishQueue([withComponent]);

    const md = await copyToClipboard();

    assert.match(md, /^# SpotCheck Annotations/);
    assert.match(md, /\*\*Page:\*\* https:\/\/acme\.test\/checkout\?step=2/);
    assert.match(md, /\*\*Title:\*\* Checkout — Acme/);
    assert.match(md, /\*\*Count:\*\* 1/);
  });

  test("renders the selector and note per annotation", async () => {
    publishQueue([withComponent]);

    const md = await copyToClipboard();

    assert.match(md, /## 1\. `#submit`/);
    assert.match(md, /\*\*Note:\*\* Padding looks 4px too tight here\./);
  });

  test("renders the component with source, confidence and file:line", async () => {
    publishQueue([withComponent]);

    const md = await copyToClipboard();

    // The single most useful line for an agent — it points at a file to open
    // instead of a selector to guess at.
    assert.match(
      md,
      /\*\*Component:\*\* SubmitButton \(react, high\) — src\/checkout\/SubmitButton\.jsx:24/
    );
  });

  test("renders the ancestry breadcrumb when there is more than one level", async () => {
    publishQueue([withComponent]);

    const md = await copyToClipboard();

    assert.match(md, /\*\*Component tree:\*\* SubmitButton › CheckoutForm › App/);
  });

  test("omits the breadcrumb for a single-level ancestry", async () => {
    publishQueue([{ ...withComponent, component: { ...withComponent.component, ancestry: ["SubmitButton"] } }]);

    const md = await copyToClipboard();

    assert.ok(!md.includes("**Component tree:**"));
  });

  test("flags a low-confidence name as possibly minified", async () => {
    publishQueue([
      {
        ...withComponent,
        component: {
          name: "tR",
          source: "react",
          confidence: "low",
          sourcePath: null,
          sourceLine: null,
          ancestry: [],
        },
      },
    ]);

    const md = await copyToClipboard();

    assert.match(md, /\*\*Component:\*\* tR \(react, low — name may be minified\)/);
  });

  test("omits the component line entirely when nothing was detected", async () => {
    publishQueue([
      {
        ...withComponent,
        component: {
          name: null,
          source: "none",
          confidence: "low",
          sourcePath: null,
          sourceLine: null,
          ancestry: [],
        },
      },
    ]);

    const md = await copyToClipboard();

    // Better a missing line than "(unnamed) (none, low)" noise.
    assert.ok(!md.includes("**Component:**"));
  });

  test("still reports a source path when the name is unknown", async () => {
    publishQueue([
      {
        ...withComponent,
        component: {
          name: null,
          source: "data-attribute",
          confidence: "high",
          sourcePath: "src/components/Cart.astro",
          sourceLine: 42,
          ancestry: [],
        },
      },
    ]);

    const md = await copyToClipboard();

    assert.match(md, /\*\*Component:\*\* \(unnamed\) \(data-attribute, high\) — src\/components\/Cart\.astro:42/);
  });

  test("converts captured style property names to real CSS", async () => {
    publishQueue([withComponent]);

    const md = await copyToClipboard();

    assert.match(md, /```css\npadding-top: 10px;\nbackground-color: rgb\(239, 239, 239\);\n```/);
  });

  test("serializes every queued annotation in order", async () => {
    publishQueue([
      withComponent,
      { ...withComponent, number: 2, selector: "#price", note: "Wrong colour.", styles: null },
    ]);

    const md = await copyToClipboard();

    assert.ok(md.indexOf("## 1. `#submit`") < md.indexOf("## 2. `#price`"));
    assert.match(md, /\*\*Count:\*\* 2/);
  });

  test("survives an annotation with no selector", async () => {
    publishQueue([{ ...withComponent, selector: null }]);

    const md = await copyToClipboard();

    assert.match(md, /## 1\. `\(selector unavailable\)`/);
    assert.deepEqual(page.errors(), []);
  });
});

describe("lifecycle", () => {
  test("toggling inspection mode off removes the button", () => {
    publishQueue([withComponent]);
    assert.ok(exportButton());

    page.setInspectionMode(false);

    assert.equal(exportButton(), null);
  });

  test("toggling back on starts from an empty queue", () => {
    publishQueue([withComponent]);
    page.setInspectionMode(false);
    page.setInspectionMode(true);

    // The on-page state resets on toggle-off by design; the persisted queue
    // is queue.js's job, not this button's.
    assert.equal(exportButton().style.display, "none");
  });
});
