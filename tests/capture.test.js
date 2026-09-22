// Feature 2/8/9 — capture.js, driven through the CustomEvent contract it
// actually listens on (spotcheck:element-selected / spotcheck:element-hovered)
// and the messages it exchanges with the MAIN-world probe.

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createPage, plain } from "./helpers/dom-harness.js";
import { attachVue3 } from "./helpers/fake-frameworks.js";

const PAGE_HTML = `<!doctype html><html><body>
  <main>
    <section><button id="submit" class="  btn primary  ">Place order</button></section>
    <section>
      <span>first</span>
      <span>second</span>
      <span>third</span>
    </section>
  </main>
</body></html>`;

let page;

afterEach(() => {
  page.close();
});

/** Fire the event state.js dispatches when the picker locks an element. */
function select(element) {
  page.document.dispatchEvent(
    new page.window.CustomEvent("spotcheck:element-selected", { detail: { element } })
  );
}

/** Fire the event picker.js dispatches when the hovered element changes. */
function hover(element, x = 100, y = 200) {
  page.document.dispatchEvent(
    new page.window.CustomEvent("spotcheck:element-hovered", { detail: { element, x, y } })
  );
}

describe("selector path", () => {
  beforeEach(() => {
    page = createPage({ html: PAGE_HTML, scripts: ["capture.js"] });
  });

  test("prefers a unique id and stops climbing there", async () => {
    const captured = page.recordEvents("spotcheck:element-captured");

    select(page.document.querySelector("#submit"));

    assert.equal(captured[0].selector, "#submit");
  });

  test("disambiguates same-tag siblings with nth-of-type", async () => {
    const captured = page.recordEvents("spotcheck:element-captured");

    select(page.document.querySelectorAll("span")[1]);

    assert.equal(
      captured[0].selector,
      "body > main > section:nth-of-type(2) > span:nth-of-type(2)"
    );
  });

  test("omits nth-of-type when a tag is unique among its siblings", async () => {
    const captured = page.recordEvents("spotcheck:element-captured");

    select(page.document.querySelector("main"));

    assert.equal(captured[0].selector, "body > main");
  });

  test("returns 'html' for the root element rather than an empty string", async () => {
    const captured = page.recordEvents("spotcheck:element-captured");

    select(page.document.documentElement);

    assert.equal(captured[0].selector, "html");
  });

  test("captures tag, id and trimmed class names", async () => {
    const captured = page.recordEvents("spotcheck:element-captured");

    select(page.document.querySelector("#submit"));

    assert.equal(captured[0].tagName, "button");
    assert.equal(captured[0].id, "submit");
    assert.equal(captured[0].classNames, "btn primary");
  });

  test("reports no class names for an SVG node, whose className is not a string", async () => {
    page.document.body.innerHTML = `<svg><path id="p" class="icon"/></svg>`;
    const captured = page.recordEvents("spotcheck:element-captured");

    select(page.document.querySelector("#p"));

    // SVGAnimatedString would otherwise be captured as the wrong shape.
    assert.equal(captured[0].classNames, null);
  });
});

describe("computed styles", () => {
  beforeEach(() => {
    page = createPage({ html: PAGE_HTML, scripts: ["capture.js"] });
  });

  test("captures the base property set", async () => {
    const captured = page.recordEvents("spotcheck:element-captured");

    select(page.document.querySelector("#submit"));

    const { styles } = captured[0];
    for (const prop of ["display", "color", "backgroundColor", "fontSize", "paddingTop", "zIndex"]) {
      assert.ok(prop in styles, `expected ${prop} in captured styles`);
    }
  });

  test("adds flex properties only when the element is a flex container", async () => {
    const flex = page.document.querySelector("main");
    flex.style.display = "flex";
    const captured = page.recordEvents("spotcheck:element-captured");

    select(flex);
    select(page.document.querySelector("#submit"));

    assert.ok("justifyContent" in captured[0].styles);
    assert.ok(!("justifyContent" in captured[1].styles));
  });

  test("adds grid properties only when the element is a grid container", async () => {
    const grid = page.document.querySelector("main");
    grid.style.display = "grid";
    const captured = page.recordEvents("spotcheck:element-captured");

    select(grid);

    assert.ok("gridTemplateColumns" in captured[0].styles);
  });
});

describe("two-phase capture (click path)", () => {
  test("dispatches synchronously with an empty component placeholder", () => {
    page = createPage({ html: PAGE_HTML, scripts: ["capture.js"] });
    const captured = page.recordEvents("spotcheck:element-captured");

    select(page.document.querySelector("#submit"));

    // Synchronously — annotations.js opens its popup off this first dispatch.
    assert.equal(captured.length, 1);
    assert.deepEqual(plain(captured[0].component), {
      name: null,
      source: "none",
      confidence: "low",
      sourcePath: null,
      sourceLine: null,
      ancestry: [],
    });
  });

  test("re-dispatches with the component once the probe answers", async () => {
    page = createPage({ html: PAGE_HTML, scripts: ["capture.js", "component-probe.js"] });
    attachVue3(page.document.querySelector("#submit"), [
      { name: "SubmitButton", file: "/app/src/SubmitButton.vue" },
    ]);
    const captured = page.recordEvents("spotcheck:element-captured");

    select(page.document.querySelector("#submit"));
    await page.settle(60);

    assert.equal(captured.length, 2);
    assert.equal(captured[1].component.name, "SubmitButton");
    // Same element and selector — only the component differs.
    assert.equal(captured[1].selector, captured[0].selector);
    assert.equal(captured[1].element, captured[0].element);
  });

  test("sends the tagName so the probe can reject a moved target", async () => {
    page = createPage({ html: PAGE_HTML, scripts: ["capture.js"] });
    const requests = [];
    page.window.addEventListener("message", (e) => {
      if (e.data && e.data.__spotcheck === "probe-request") requests.push(e.data);
    });

    select(page.document.querySelector("#submit"));
    await page.settle(20);

    assert.equal(requests.length, 1);
    assert.equal(requests[0].selector, "#submit");
    assert.equal(requests[0].tagName, "button");
    assert.ok(typeof requests[0].nonce === "string" && requests[0].nonce.length > 0);
  });

  test("with no probe installed, only the placeholder dispatch ever happens", async () => {
    page = createPage({ html: PAGE_HTML, scripts: ["capture.js"] });
    const captured = page.recordEvents("spotcheck:element-captured");

    select(page.document.querySelector("#submit"));
    await page.settle(900); // past the 800ms click-path timeout

    assert.equal(captured.length, 1);
    assert.deepEqual(page.errors(), []);
  });
});

describe("hover path (Feature 9)", () => {
  beforeEach(() => {
    page = createPage({ html: PAGE_HTML, scripts: ["capture.js", "component-probe.js"] });
  });

  test("answers a hover with spotcheck:hover-component", async () => {
    const button = page.document.querySelector("#submit");
    attachVue3(button, [{ name: "SubmitButton", file: "/app/src/SubmitButton.vue" }]);
    page.setHitTest(() => button);
    const hovered = page.recordEvents("spotcheck:hover-component");

    hover(button);
    await page.settle(150);

    assert.equal(hovered.length, 1);
    assert.equal(hovered[0].element, button);
    assert.equal(hovered[0].component.name, "SubmitButton");
  });

  test("probes by pointer coordinates, not a selector", async () => {
    const button = page.document.querySelector("#submit");
    const requests = [];
    page.window.addEventListener("message", (e) => {
      if (e.data && e.data.__spotcheck === "probe-request") requests.push(e.data);
    });

    hover(button, 640, 480);
    await page.settle(150);

    assert.equal(requests.length, 1);
    assert.deepEqual(requests[0].point, { x: 640, y: 480 });
    assert.equal(requests[0].selector, undefined);
  });

  test("debounces a sweep across many elements into a single probe", async () => {
    const spans = [...page.document.querySelectorAll("span")];
    const requests = [];
    page.window.addEventListener("message", (e) => {
      if (e.data && e.data.__spotcheck === "probe-request") requests.push(e.data);
    });

    // Three hover changes inside the 60ms debounce window.
    hover(spans[0], 1, 1);
    hover(spans[1], 2, 2);
    hover(spans[2], 3, 3);
    await page.settle(150);

    assert.equal(requests.length, 1);
    assert.deepEqual(requests[0].point, { x: 3, y: 3 }); // the newest wins
  });

  test("emits nothing when the element has no detectable component", async () => {
    const button = page.document.querySelector("#submit");
    page.setHitTest(() => button);
    const hovered = page.recordEvents("spotcheck:hover-component");

    hover(button);
    await page.settle(150);

    // A nameless descriptor would only give overlay.js something useless to
    // render, so capture.js drops it rather than dispatching.
    assert.equal(hovered.length, 0);
  });
});

describe("hover staleness", () => {
  // No probe loaded: the test plays the probe, so it can answer out of order.
  beforeEach(() => {
    page = createPage({ html: PAGE_HTML, scripts: ["capture.js"] });
  });

  test("a slow reply for an abandoned element never overwrites a newer one", async () => {
    const spans = [...page.document.querySelectorAll("span")];
    const requests = [];
    page.window.addEventListener("message", (e) => {
      if (e.data && e.data.__spotcheck === "probe-request") requests.push(e.data);
    });
    const hovered = page.recordEvents("spotcheck:hover-component");

    hover(spans[0], 1, 1);
    await page.settle(100); // first probe goes out
    hover(spans[1], 2, 2);
    await page.settle(100); // second probe goes out

    assert.equal(requests.length, 2);

    // Answer the NEWER request first, then the older one — the order a deep
    // fiber tree versus a shallow one really can produce.
    const reply = (nonce, name) =>
      page.window.postMessage(
        {
          __spotcheck: "probe-response",
          nonce,
          component: {
            name,
            source: "react",
            confidence: "high",
            sourcePath: null,
            sourceLine: null,
            ancestry: [name],
          },
        },
        "*"
      );
    reply(requests[1].nonce, "NewerComponent");
    await page.settle(20);
    reply(requests[0].nonce, "StaleComponent");
    await page.settle(50);

    assert.deepEqual(
      hovered.map((h) => h.component.name),
      ["NewerComponent"]
    );
  });
});
