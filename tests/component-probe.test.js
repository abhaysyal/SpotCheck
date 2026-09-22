// Feature 8/9 — component detection, exercised through component-probe.js's
// only public surface: the window.postMessage request/response contract.
// Nothing here reaches inside the IIFE, so these tests describe the contract
// capture.js depends on rather than the implementation behind it.

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createPage } from "./helpers/dom-harness.js";
import {
  attachReactFiber,
  reactComponent,
  reactFiberChain,
  memo,
  forwardRef,
  installReactDevtoolsHook,
  attachVue3,
  attachVue2,
  attachSvelteMeta,
  installAngular,
  angularComponentInstance,
} from "./helpers/fake-frameworks.js";

let page;

beforeEach(() => {
  page = createPage({
    html: `<!doctype html><html><body>
      <main id="root"><button id="submit">Place order</button><span id="price">$42</span></main>
    </body></html>`,
    scripts: ["component-probe.js"],
  });
});

afterEach(() => {
  page.close();
});

const $ = (sel) => page.document.querySelector(sel);

describe("React", () => {
  test("unwraps memo(forwardRef(Component)) to the real component name", async () => {
    // The case Feature 8's spec singles out: naive detection reports
    // "Memo"/"ForwardRef" here, which is useless to an agent.
    const button = $("#submit");
    attachReactFiber(
      button,
      reactFiberChain([
        { type: memo(forwardRef(reactComponent("SubmitButton"))), file: "/build/x/src/checkout/SubmitButton.jsx", line: 24 },
        { type: reactComponent("CheckoutForm"), file: "/build/x/src/checkout/CheckoutForm.jsx", line: 12 },
      ])
    );

    const component = await page.probe({ selector: "#submit", tagName: "button" });

    assert.equal(component.name, "SubmitButton");
    assert.equal(component.source, "react");
    assert.equal(component.confidence, "high");
    assert.deepEqual(component.ancestry, ["SubmitButton", "CheckoutForm"]);
  });

  test("reports the source path and line from the dev build, trimmed to the project root", async () => {
    const button = $("#submit");
    attachReactFiber(
      button,
      reactFiberChain([
        { type: reactComponent("SubmitButton"), file: "/home/ci/checkout-app/src/checkout/SubmitButton.jsx", line: 24 },
      ])
    );

    const component = await page.probe({ selector: "#submit", tagName: "button" });

    // The build-machine prefix is dropped; the project-relative path is what
    // a coding agent can actually open.
    assert.equal(component.sourcePath, "src/checkout/SubmitButton.jsx");
    assert.equal(component.sourceLine, 24);
  });

  test("does not truncate a path at a directory that merely ends in a root segment", async () => {
    const button = $("#submit");
    attachReactFiber(
      button,
      reactFiberChain([{ type: reactComponent("Widget"), file: "/repos/my-app/lib/Widget.tsx", line: 3 }])
    );

    const component = await page.probe({ selector: "#submit", tagName: "button" });

    // "my-app/" must not satisfy the "app/" root segment — the match only
    // counts at a real path boundary.
    assert.equal(component.sourcePath, "lib/Widget.tsx");
  });

  test("skips library wrapper names instead of reporting them", async () => {
    const span = $("#price");
    const styled = reactComponent("StyledDiv", { displayName: "styled.div" });
    attachReactFiber(
      span,
      reactFiberChain([
        { type: styled },
        { type: forwardRef(reactComponent("Slot")) }, // Radix noise, by exact name
        { type: reactComponent("PriceLabel"), file: "/app/src/checkout/PriceLabel.jsx", line: 4 },
      ])
    );

    const component = await page.probe({ selector: "#price", tagName: "span" });

    assert.equal(component.name, "PriceLabel");
    assert.deepEqual(component.ancestry, ["PriceLabel"]);
    assert.equal(component.sourcePath, "src/checkout/PriceLabel.jsx");
  });

  test("a production build of all-minified names stays honest rather than confident", async () => {
    const button = $("#submit");
    attachReactFiber(
      button,
      reactFiberChain([{ type: reactComponent("tR") }, { type: reactComponent("B") }])
    );

    const component = await page.probe({ selector: "#submit", tagName: "button" });

    // A name is still reported so the agent knows something was there, but
    // flagged low and kept out of the ancestry — ["B","tR"] is worse than [].
    assert.equal(component.source, "react");
    assert.equal(component.confidence, "low");
    assert.deepEqual(component.ancestry, []);
    assert.equal(component.name, "tR");
  });

  test("a node with no fiber on a React page yields the weak react signal, not a false name", async () => {
    installReactDevtoolsHook(page.window);

    const component = await page.probe({ selector: "#submit", tagName: "button" });

    assert.equal(component.source, "react");
    assert.equal(component.name, null);
    assert.equal(component.confidence, "low");
  });

  test("that weak react signal never outranks a real hit from a later probe", async () => {
    // Regression guard for the orchestrator's reactPresentFallback: a
    // data-testid on a React page used to lose to "React is here somewhere".
    installReactDevtoolsHook(page.window);
    $("#submit").setAttribute("data-testid", "checkout-submit");

    const component = await page.probe({ selector: "#submit", tagName: "button" });

    assert.equal(component.name, "checkout-submit");
    assert.equal(component.source, "data-attribute");
  });

  test("fills a missing source path from react-dev-inspector attributes", async () => {
    const button = $("#submit");
    attachReactFiber(button, reactFiberChain([{ type: reactComponent("SubmitButton") }])); // no _debugSource
    button.setAttribute("data-inspector-file", "/app/src/checkout/SubmitButton.tsx");
    button.setAttribute("data-inspector-line", "31");

    const component = await page.probe({ selector: "#submit", tagName: "button" });

    // Name from the fiber tree, path opportunistically from the attributes.
    assert.equal(component.name, "SubmitButton");
    assert.equal(component.source, "react");
    assert.equal(component.sourcePath, "src/checkout/SubmitButton.tsx");
    assert.equal(component.sourceLine, 31);
  });
});

describe("Vue", () => {
  test("reads a Vue 3 <script setup> SFC's name, file and parent chain", async () => {
    attachVue3($("#submit"), [
      { name: "SubmitButton", file: "/app/src/checkout/SubmitButton.vue" },
      { name: "CheckoutForm", file: "/app/src/checkout/CheckoutForm.vue" },
      { name: "App", file: "/app/src/App.vue" },
    ]);

    const component = await page.probe({ selector: "#submit", tagName: "button" });

    assert.equal(component.name, "SubmitButton");
    assert.equal(component.source, "vue");
    assert.equal(component.confidence, "high");
    assert.equal(component.sourcePath, "src/checkout/SubmitButton.vue");
    assert.deepEqual(component.ancestry, ["SubmitButton", "CheckoutForm", "App"]);
  });

  test("falls back to Vue 2's instance tree when there is no Vue 3 instance", async () => {
    attachVue2($("#price"), [
      { name: "PriceLabel", file: "/app/src/PriceLabel.vue" },
      { name: "App", file: "/app/src/App.vue" },
    ]);

    const component = await page.probe({ selector: "#price", tagName: "span" });

    assert.equal(component.name, "PriceLabel");
    assert.equal(component.source, "vue");
    assert.deepEqual(component.ancestry, ["PriceLabel", "App"]);
  });

  test("a Vue name without a source file is reported but not trusted", async () => {
    attachVue3($("#submit"), [{ name: "SubmitButton", file: undefined }]);

    const component = await page.probe({ selector: "#submit", tagName: "button" });

    assert.equal(component.name, "SubmitButton");
    assert.equal(component.sourcePath, null);
    assert.equal(component.confidence, "low");
  });

  test("skips Vue's own framework components", async () => {
    attachVue3($("#submit"), [
      { name: "Transition", file: "/app/node_modules/vue/Transition.vue" },
      { name: "SubmitButton", file: "/app/src/SubmitButton.vue" },
    ]);

    const component = await page.probe({ selector: "#submit", tagName: "button" });

    assert.equal(component.name, "SubmitButton");
    assert.deepEqual(component.ancestry, ["SubmitButton"]);
  });
});

describe("other frameworks", () => {
  test("Svelte reports the filename and line, and no ancestry", async () => {
    attachSvelteMeta($("#submit"), { file: "/app/src/lib/SubmitButton.svelte", line: 17 });

    const component = await page.probe({ selector: "#submit", tagName: "button" });

    assert.equal(component.name, "SubmitButton");
    assert.equal(component.source, "svelte");
    assert.equal(component.sourcePath, "src/lib/SubmitButton.svelte");
    assert.equal(component.sourceLine, 17);
    assert.deepEqual(component.ancestry, []);
  });

  test("Angular reports the component class name and no source path", async () => {
    const button = $("#submit");
    installAngular(page.window, new Map([[button, angularComponentInstance("SubmitButtonComponent")]]));

    const component = await page.probe({ selector: "#submit", tagName: "button" });

    assert.equal(component.name, "SubmitButtonComponent");
    assert.equal(component.source, "angular");
    assert.equal(component.confidence, "high");
    assert.equal(component.sourcePath, null); // Angular exposes none
  });

  test("a custom element is identified by its tag", async () => {
    page.document.body.innerHTML = `<sl-button id="wc"><span id="inner">go</span></sl-button>`;

    const component = await page.probe({ selector: "#inner", tagName: "span" });

    assert.equal(component.source, "web-component");
    assert.equal(component.name, "sl-button");
    assert.equal(component.confidence, "high");
    assert.deepEqual(component.ancestry, ["sl-button"]);
  });

  test("an Astro island reports the island's source file", async () => {
    const button = $("#submit");
    button.setAttribute("data-astro-source-file", "/app/src/components/Cart.astro");
    button.setAttribute("data-astro-source-loc", "42:7");

    const component = await page.probe({ selector: "#submit", tagName: "button" });

    assert.equal(component.source, "data-attribute");
    assert.equal(component.confidence, "high");
    assert.equal(component.name, "Cart");
    assert.equal(component.sourcePath, "src/components/Cart.astro");
    assert.equal(component.sourceLine, 42); // the column is dropped
  });

  test("a data-testid is a last resort, reported with low confidence", async () => {
    $("#submit").setAttribute("data-testid", "submit-order");

    const component = await page.probe({ selector: "#submit", tagName: "button" });

    assert.equal(component.name, "submit-order");
    assert.equal(component.source, "data-attribute");
    assert.equal(component.confidence, "low");
  });
});

describe("no framework / robustness", () => {
  test("plain HTML gets an empty descriptor and logs nothing", async () => {
    const component = await page.probe({ selector: "#submit", tagName: "button" });

    assert.deepEqual(component, {
      name: null,
      source: "none",
      confidence: "low",
      sourcePath: null,
      sourceLine: null,
      ancestry: [],
    });
    assert.deepEqual(page.errors(), []);
  });

  test("a tagName mismatch reports nothing rather than the wrong component", async () => {
    // The DOM reflowed under an :nth-of-type selector: it now resolves to a
    // different element than the one the user picked.
    attachVue3($("#price"), [{ name: "PriceLabel", file: "/app/src/PriceLabel.vue" }]);

    const component = await page.probe({ selector: "#price", tagName: "button" });

    assert.equal(component, null);
  });

  test("a selector matching nothing reports null, not a throw", async () => {
    const component = await page.probe({ selector: "#gone", tagName: "div" });

    assert.equal(component, null);
    assert.deepEqual(page.errors(), []);
  });

  test("resolves the element from pointer coordinates when given a point", async () => {
    // Feature 9's hover path: no selector is computed, the probe re-resolves
    // the node with the same elementFromPoint call the picker used.
    const button = $("#submit");
    attachVue3(button, [{ name: "SubmitButton", file: "/app/src/SubmitButton.vue" }]);
    page.setHitTest((x, y) => (x === 120 && y === 240 ? button : null));

    const component = await page.probe({ point: { x: 120, y: 240 }, tagName: "button" });

    assert.equal(component.name, "SubmitButton");
  });

  test("a point that hits nothing reports null", async () => {
    page.setHitTest(() => null);

    const component = await page.probe({ point: { x: 1, y: 1 }, tagName: "button" });

    assert.equal(component, null);
  });

  test("ignores messages that are not probe requests", async () => {
    const replies = [];
    page.window.addEventListener("message", (e) => {
      if (e.data && e.data.__spotcheck === "probe-response") replies.push(e.data);
    });

    page.window.postMessage({ __spotcheck: "probe-response", nonce: "forged", component: {} }, "*");
    page.window.postMessage({ hello: "not ours" }, "*");
    page.window.postMessage({ __spotcheck: "probe-request" }, "*"); // no nonce
    await page.settle(50);

    // Only the forged response we posted ourselves; the probe answered none.
    assert.equal(replies.length, 1);
    assert.equal(replies[0].nonce, "forged");
  });

  test("re-injection does not install a second listener", async () => {
    // background.js re-injects on every toggle; the guard flag has to hold or
    // every probe would be answered twice.
    page.load("component-probe.js");
    attachVue3($("#submit"), [{ name: "SubmitButton", file: "/app/src/SubmitButton.vue" }]);

    const replies = [];
    page.window.addEventListener("message", (e) => {
      if (e.data && e.data.__spotcheck === "probe-response") replies.push(e.data);
    });
    page.window.postMessage({ __spotcheck: "probe-request", nonce: "once", selector: "#submit" }, "*");
    await page.settle(50);

    assert.equal(replies.length, 1);
    assert.equal(replies[0].component.name, "SubmitButton");
  });

  test("survives element shapes that have no className string or parent chain", async () => {
    page.document.body.innerHTML = `<svg id="icon"><path id="p" d="M0 0"/></svg>`;

    const component = await page.probe({ selector: "#p", tagName: "path" });

    assert.equal(component.source, "none");
    assert.deepEqual(page.errors(), []);
  });
});
