# tests/

```bash
npm install     # once — jsdom is the only dependency
npm test        # ~15s
npm run test:watch
```

Node's built-in test runner (`node:test` + `node:assert/strict`). No Jest, no Vitest, no Babel, no config file — matching the repo's no-bundler, no-build-step stance. jsdom is the single devDependency; the extension itself still ships nothing.

## What's covered

| File | Covers |
|---|---|
| `component-probe.test.js` | Framework detection: React (`memo`/`forwardRef` unwrapping, wrapper-noise filtering, minified-build honesty, dev source paths), Vue 2/3, Svelte, Angular, Web Components, Astro/dev-inspector attributes, no-framework pages, and the request-guard behaviour (tagName mismatch, point vs selector targets, re-injection, foreign messages). |
| `capture.test.js` | Selector-path generation, computed-style capture, the two-phase click dispatch (placeholder then enriched), and Feature 9's hover path: coordinate-based probing, the 60 ms debounce, and out-of-order reply rejection. |
| `overlay.test.js` | The hover component badge: when it shows, that it survives hover→lock, that a nameless placeholder can't erase a real name, that a stale descriptor for another element is ignored, and its placement/flip/clamp rules. |
| `export.test.js` | The Markdown bundle — "the prompt" — including the `**Component:**` line, the ancestry breadcrumb, low-confidence flagging, and camelCase→kebab-case CSS. |
| `mcp-server.test.js` | The real server, spawned: the `/sync` and `/mcp` origin policies (pinned and unpinned), malformed-pin startup refusal, and queue persistence. |

## How the content scripts are tested

The content scripts are deliberately classic scripts with no bundler and no ES modules (see `CLAUDE.md`) — each is an IIFE that hangs its surface off `window.__spotcheck` and exports nothing. There is nothing to `import`, so **nothing is tested by reaching inside**. `tests/helpers/dom-harness.js` loads the real files into a jsdom page and drives them the only ways the extension itself does:

- `CustomEvent`s on `document` (`spotcheck:element-selected`, `spotcheck:element-hovered`, …)
- `window.postMessage` (the isolated↔MAIN probe channel)
- the `chrome.runtime` `SPOTCHECK_SET_ACTIVE` broadcast
- real clicks on the shadow-DOM UI the scripts build

So a test failing here means a contract broke, not that an internal was renamed.

### Three shims, because jsdom is not a browser

| Shim | Why |
|---|---|
| `CSS.escape` | jsdom ships none; `capture.js` calls it for every id it considers. |
| `document.elementFromPoint` | jsdom performs no layout, so it implements none. Made injectable (`page.setHitTest`) rather than faked — a test says what is under the pointer. |
| `window.postMessage` | jsdom delivers the event but leaves `event.source` **null**. Both `capture.js` and `component-probe.js` open with `if (ev.source !== window) return`, so unshimmed every message is dropped and the suite would pass by never running anything. |

`getBoundingClientRect` is all-zero for the same reason — `page.setRect(el, …)` gives one element a rect when geometry is what's under test.

### The one thing these tests cannot check

jsdom has a single JS realm, so loading `capture.js` and `component-probe.js` together puts them in one scope where a real browser keeps them in the isolated and MAIN worlds respectively. The *message contract* between them is exercised faithfully, but "can the isolated world actually see `el.__reactFiber$*`?" is answerable only in a real browser — and getting that wrong is exactly the bug Feature 8 shipped with (see `docs/features/feature-8-component-name-extraction/plan.md`'s revision note).

That gap is covered by live browser verification instead: driving the loaded extension against real React and Vue dev builds, per `docs/features/feature-9-hover-component-labels/plan.md`'s test criteria. Treat these tests as necessary, not sufficient, for anything touching the world split.

## Notes

- `mcp-server.test.js` spawns servers on the hardcoded port **8934** and fails with a clear message if it's already in use — stop a running SpotCheck MCP server first. It redirects `HOME`/`USERPROFILE` to a temp dir so it never touches your real `~/.spotcheck/annotations.json`, and always sets `SPOTCHECK_EXTENSION_ORIGIN` explicitly so a value in your shell can't change what the tests mean.
- Use `plain(value)` from the harness before `assert.deepEqual` on anything read straight off an event detail: objects built inside jsdom carry *jsdom's* `Object.prototype`, and `deepStrictEqual` compares prototypes. Values arriving via `postMessage` are already serialized and don't need it.
