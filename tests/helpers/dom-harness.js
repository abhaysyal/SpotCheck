// Loads SpotCheck's content scripts into a jsdom page so they can be tested
// through their real public contracts, with no changes to production code.
//
// Why it looks like this: the content scripts are deliberately classic
// scripts with no bundler and no ES modules (see CLAUDE.md) — each is an
// IIFE that hangs its surface off window.__spotcheck and exports nothing.
// So there is nothing to `import`. The only ways in are the ways the
// extension itself uses: CustomEvents on `document`, `window.postMessage`,
// and the chrome.runtime message that toggles inspection mode. Tests drive
// those, which means they exercise the same wiring the browser does rather
// than reaching into internals.
//
// What this CANNOT test: the isolated-world/MAIN-world split. jsdom has one
// JS realm, so loading capture.js and component-probe.js together puts them
// in the same scope where a real browser keeps them apart. The message
// contract between them is still exercised faithfully (and the discriminator
// fields keep the two listeners from confusing each other), but "can the
// isolated world actually see el.__reactFiber$*" is a question only a real
// browser can answer — that is what the Feature 9 plan's live browser
// verification covers.

import { JSDOM, VirtualConsole } from "jsdom";
import { readFileSync } from "node:fs";

const CONTENT_DIR = new URL("../../extension/content/", import.meta.url);

// Load order matters the same way it does in background.js's CONTENT_FILES:
// state.js must come first because overlay.js and picker.js reach into
// spotcheck.state / spotcheck.uiHosts as soon as they run.
export const ISOLATED_SCRIPTS = [
  "state.js",
  "overlay.js",
  "picker.js",
  "capture.js",
  "queue.js",
  "annotations.js",
  "export.js",
];

/**
 * Re-create a value in Node's realm so assert.deepStrictEqual can compare it.
 *
 * Objects built inside the jsdom window carry *jsdom's* Object.prototype, and
 * deepStrictEqual checks prototypes — so comparing a CustomEvent detail
 * against a literal fails with "same structure but not reference-equal" even
 * when every field matches. Values that arrive via postMessage don't need
 * this (the harness already serializes those, like a real browser would);
 * values read straight off an event detail do.
 */
export function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

export function createPage(options = {}) {
  const {
    html = "<!doctype html><html><head><title>Test page</title></head><body></body></html>",
    url = "https://app.test/checkout",
    scripts = [],
  } = options;

  const consoleMessages = [];
  const virtualConsole = new VirtualConsole();
  for (const level of ["error", "warn", "info", "log", "debug"]) {
    virtualConsole.on(level, (...args) =>
      consoleMessages.push({ level, text: args.map((a) => String(a)).join(" ") })
    );
  }
  // An uncaught throw inside an injected script surfaces here, not as a
  // rejected promise — without capturing it a broken script would look like
  // a silently passing test.
  virtualConsole.on("jsdomError", (err) =>
    consoleMessages.push({ level: "jsdomError", text: err.message })
  );

  const dom = new JSDOM(html, {
    runScripts: "outside-only", // enables window.eval; we never run page <script> tags
    pretendToBeVisual: true, // gives requestAnimationFrame, which overlay.js needs
    url,
    virtualConsole,
  });

  const window = dom.window;
  installBrowserShims(window);
  const chrome = installChromeStub(window);

  const page = {
    dom,
    window,
    document: window.document,
    chrome,
    consoleMessages,

    load(...names) {
      for (const name of names.flat()) {
        const src = readFileSync(new URL(name, CONTENT_DIR), "utf8");
        // Named so a syntax error points at the file, not at "evalmachine".
        window.eval(`${src}\n//# sourceURL=spotcheck/${name}`);
      }
      return page;
    },

    // --- driving the extension the way the browser does ------------------

    /** The toolbar-click broadcast background.js sends to every listener. */
    setInspectionMode(active) {
      chrome.__deliverRuntimeMessage({ type: "SPOTCHECK_SET_ACTIVE", active });
    },

    /** Synthesize the pointer move picker.js listens for. */
    hover(element, x = 10, y = 10) {
      window.__setHitTest(() => element);
      const event = new window.MouseEvent("mousemove", { clientX: x, clientY: y, bubbles: true });
      window.document.dispatchEvent(event);
    },

    /** Synthesize the click picker.js turns into a selection. */
    click(element, x = 10, y = 10) {
      window.__setHitTest(() => element);
      const event = new window.MouseEvent("click", { clientX: x, clientY: y, bubbles: true });
      window.document.dispatchEvent(event);
    },

    /** What document.elementFromPoint should return; jsdom has no layout. */
    setHitTest(fn) {
      window.__setHitTest(fn);
    },

    /**
     * jsdom lays nothing out, so every getBoundingClientRect is all-zero.
     * Give one element a rect so overlay positioning can be asserted.
     */
    setRect(element, rect) {
      const full = { top: 0, left: 0, width: 0, height: 0, ...rect };
      element.getBoundingClientRect = () => ({
        ...full,
        right: full.left + full.width,
        bottom: full.top + full.height,
        x: full.left,
        y: full.top,
        toJSON() {},
      });
    },

    /** Ask the MAIN-world probe directly, over its real message contract. */
    probe(target, timeoutMs = 500) {
      return new Promise((resolve) => {
        const nonce = `test-${Math.random().toString(16).slice(2)}`;
        const onMessage = (event) => {
          const d = event.data;
          if (!d || d.__spotcheck !== "probe-response" || d.nonce !== nonce) return;
          window.removeEventListener("message", onMessage);
          resolve(d.component);
        };
        window.addEventListener("message", onMessage);
        window.postMessage({ __spotcheck: "probe-request", nonce, ...target }, "*");
        setTimeout(() => {
          window.removeEventListener("message", onMessage);
          resolve("NO_REPLY");
        }, timeoutMs);
      });
    },

    /** Collect every dispatch of a SpotCheck CustomEvent, in order. */
    recordEvents(type) {
      const seen = [];
      window.document.addEventListener(type, (e) => seen.push(e.detail));
      return seen;
    },

    /** Resolve after the macrotask queue drains — postMessage is async. */
    async settle(ms = 0) {
      await new Promise((resolve) => setTimeout(resolve, ms));
    },

    errors() {
      return consoleMessages.filter((m) => m.level === "error" || m.level === "jsdomError");
    },

    close() {
      window.close();
    },
  };

  page.load(scripts);
  return page;
}

function installBrowserShims(window) {
  // jsdom ships no CSS.escape, which capture.js's getSelectorPath calls for
  // every id it considers. Not a full spec implementation — enough to escape
  // what can legally appear in an id and would otherwise break a selector.
  if (!window.CSS) window.CSS = {};
  if (typeof window.CSS.escape !== "function") {
    window.CSS.escape = (value) =>
      String(value).replace(/[^a-zA-Z0-9_-]/g, (ch) => `\\${ch}`);
  }

  // jsdom performs no layout, so it implements no elementFromPoint at all.
  // Make it injectable rather than faking a hit-test that would be fiction
  // either way: a test says which element is under the pointer.
  let hitTest = () => null;
  window.document.elementFromPoint = (x, y) => hitTest(x, y);
  window.__setHitTest = (fn) => {
    hitTest = typeof fn === "function" ? fn : () => fn;
  };

  // jsdom delivers postMessage but leaves event.source null. Both capture.js
  // and component-probe.js open with `if (ev.source !== window) return`, so
  // unpatched, every message a test or a script sends is dropped and the
  // suite would pass by never running anything. Deliver a faithful
  // MessageEvent instead — asynchronously, like a real browser, and with the
  // payload serialized, so a test can't accidentally rely on passing a live
  // object reference through a channel that really clones.
  const pageOrigin = window.location.origin; // read now; location is gone after close()
  window.postMessage = (data, _targetOrigin) => {
    let payload;
    try {
      payload = JSON.parse(JSON.stringify(data));
    } catch {
      payload = data; // mirrors a DataCloneError loosely; no test relies on it
    }
    // window.setTimeout, not Node's: a timer owned by the jsdom window gets
    // cleared when the window closes. A Node timer would outlive the page and
    // fire into a torn-down realm after the test that scheduled it finished —
    // which node:test reports as "asynchronous activity after the test ended."
    window.setTimeout(() => {
      if (window.closed || !window.document) return;
      window.dispatchEvent(
        new window.MessageEvent("message", {
          data: payload,
          source: window,
          origin: pageOrigin,
        })
      );
    }, 0);
  };

  // export.js writes the bundle here. jsdom has no clipboard at all.
  const clipboardWrites = [];
  Object.defineProperty(window.navigator, "clipboard", {
    configurable: true,
    value: {
      writeText: async (text) => {
        clipboardWrites.push(text);
      },
    },
  });
  window.__clipboardWrites = clipboardWrites;
}

function installChromeStub(window) {
  const runtimeListeners = [];
  const changeListeners = [];
  const local = new Map();

  const chrome = {
    runtime: {
      id: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      lastError: undefined,
      onMessage: {
        addListener(fn) {
          runtimeListeners.push(fn);
        },
      },
      // annotations.js relays the screenshot request to background.js; the
      // stub answers with an error so the "Include Snapshot" path takes its
      // own failure branch rather than hanging a test.
      sendMessage(_message, callback) {
        const response = { error: "no background in tests" };
        if (typeof callback === "function") callback(response);
        return Promise.resolve(response);
      },
    },
    storage: {
      local: {
        async get(keys) {
          const wanted = keys == null ? [...local.keys()] : [].concat(keys);
          const out = {};
          for (const key of wanted) if (local.has(key)) out[key] = local.get(key);
          return out;
        },
        async set(items) {
          const changes = {};
          for (const [key, value] of Object.entries(items)) {
            changes[key] = { oldValue: local.get(key), newValue: value };
            local.set(key, value);
          }
          for (const fn of changeListeners) fn(changes, "local");
        },
        async remove(keys) {
          for (const key of [].concat(keys)) local.delete(key);
        },
      },
      onChanged: {
        addListener(fn) {
          changeListeners.push(fn);
        },
      },
    },

    // --- test-only handles ------------------------------------------------
    __deliverRuntimeMessage(message) {
      for (const fn of runtimeListeners) fn(message, { tab: null }, () => {});
    },
    __storageSnapshot() {
      return Object.fromEntries(local);
    },
    __listenerCount() {
      return runtimeListeners.length;
    },
  };

  window.chrome = chrome;
  return chrome;
}
