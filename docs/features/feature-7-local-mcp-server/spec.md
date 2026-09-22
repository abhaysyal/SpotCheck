# Feature 7 — Local MCP Server — spec.md

## What it does

Gets the annotation queue Feature 6 already persists in `chrome.storage.local` in front of an AI coding agent without a copy/paste step. A new, separate local Node process — not part of the Chrome extension bundle — receives a copy of the queue from the extension's background service worker, keeps its own on-disk copy, and exposes exactly two read-only MCP tools (`list_annotations`, `get_annotation`) over HTTP. **Scoped down deliberately, per the original brief**: no resolve/reopen tools, no verification loop, no dashboard — those are explicitly later work, not this feature.

## Architecture decision — researched, not guessed

Before writing this plan, I looked at how **Vibe Annotations** (a shipped, public competitor solving the identical problem — browser-extension annotations exposed to an AI agent) actually does this, rather than design blind. Their docs (`vibe-annotations.com/docs/architecture`, `/docs/mcp-setup`) describe: two independent processes talking over plain HTTP, the extension's background worker *pushing* to a local server via `POST /api/annotations`, that server persisting to its own on-disk JSON file, and the same server exposing an MCP-over-HTTP endpoint agents connect to. No native messaging, no WebSocket.

This directly shapes the design below, and answers the real architectural problem flagged when Feature 6 shipped: **`chrome.storage.local` is only reachable from inside the extension's own processes — a standalone MCP server process cannot read it directly, at all, by any means.** The extension has to be the one to hand the data over. Pull-from-outside isn't an option; push-from-inside is the only one.

- **Push, not pull.** `background.js` listens for `chrome.storage.onChanged` on the `spotcheck_annotations` key (this fires in *any* extension context when that key changes, regardless of which context — a content script's `queue.js` — actually wrote it, so `queue.js` itself needs zero changes for this feature) and `POST`s the full current array to the local server on every change. No polling, no diffing — the debounce already baked into Feature 6's hot-save (500ms) naturally rate-limits how often this fires.
- **The server is the source of truth for anything an agent reads**, not a pass-through to the extension. It keeps its own on-disk copy (`~/.spotcheck/annotations.json`, mirroring Vibe's `~/.vibe-annotations/` convention) and answers MCP tool calls from that file — it does not reach back into the browser at read time. This means an agent can query annotations even if the browser tab (or Chrome itself) has since closed, as long as the server process is still running.
- **HTTP transport, a persistent process — not stdio.** A stdio-spawned MCP server only lives as long as one client keeps its child process alive, and multiple Claude Code sessions would each spawn an independent instance with no shared state — wrong shape for something the extension needs to push to continuously, independent of whether any agent session happens to be connected right now. The server runs on its own, started once; Claude Code (or any other MCP-over-HTTP client) connects to it, the same way `.mcp.json`'s own `chrome-devtools` entry in this repo is a *stdio* server for comparison — this one deliberately isn't that shape.
- **This is the anticipated exception to "no network calls," not a new one being snuck in.** `PROJECT.md` §6 already carves this out explicitly: *"When MCP is added later (Phase 2): the local MCP server must bind to localhost only, require no external network exposure, and should be treated as a trust boundary."* Everything below is about honoring that "trust boundary" phrase concretely, not about whether to build this at all.

## How it works

### Repo layout

New top-level directory, `mcp-server/`, sibling to `extension/` — a completely separate Node.js runtime, not injected into any page and not part of the Chrome extension's own bundle:

```
mcp-server/
├── package.json
├── server.js          — HTTP server: the /sync endpoint + the MCP-over-HTTP endpoint
├── store.js            — reads/writes ~/.spotcheck/annotations.json
└── mcp-tools.js         — list_annotations / get_annotation tool definitions
```

Kept in the same repo for now (matching how the rest of this project is organized) rather than split into a separately-published package — that's a distribution concern for whenever this actually needs to be handed to someone who isn't also checking out this repo, not something this pass needs to solve. **`npx <package> init`-style one-command install (what Vibe ships) is explicitly out of scope here** — this feature builds the server and the extension-side push; running it during development is `node mcp-server/server.js` and a manual `claude mcp add`, not a polished installer.

### Security — the local server is a real trust boundary, not a formality

A localhost HTTP server with no access control is reachable by **any web page open in any tab**, not just the SpotCheck extension — this is a well-known attack class (a malicious page's own `fetch('http://127.0.0.1:PORT/...')` can probe or poison anything listening on loopback with no auth). Binding to `127.0.0.1` stops the *internet* from reaching it; it does nothing to stop another tab in the same browser.

- **The `/sync` endpoint checks the `Origin` header and rejects anything that isn't a `chrome-extension://` origin.** A real webpage's fetch always carries its own page origin (`https://whatever.com`), which a malicious page cannot spoof — the browser sets this header, script can't override it. Requests with a missing or non-matching origin get `403`, full stop, before any body is even parsed. A missing `Origin` is rejected too: the extension's own `fetch` from `background.js` always sends one (verified live — see "Origin pinning" below).
- **Pinning one specific extension id is optional.** By default any `chrome-extension://` origin is accepted, which is what lets the server run with zero configuration. Setting `SPOTCHECK_EXTENSION_ORIGIN` (or, once SpotCheck is published, the hardcoded `PUBLISHED_EXTENSION_ORIGIN` constant in `server.js`) narrows it to exact-match. See "Origin pinning" below for exactly what that trade buys and costs.
- **The MCP endpoint (`/mcp`) rejects any request carrying a browser `Origin` header at all** — not just `http(s)`. A legitimate MCP client (Claude Code, or any other agent running as a local process) is not a browser page and doesn't send one; anything in a browser always does. Nothing in SpotCheck's own extension calls `/mcp` (`background.js` only POSTs to `/sync`), so the earlier `http(s)`-only rule left the entire annotation queue readable by **any other installed extension** — a real hole, closed by rejecting every origin rather than a scheme-specific subset.
- **No auth token/handshake beyond the Origin check in this pass** — noted explicitly as a simplification, not an oversight: real bearer-token auth would need a way to get a shared secret into the extension in the first place (itself a small design problem — a fresh one per server start, written somewhere the extension can read, is more moving parts than this scoped-down pass calls for). Worth revisiting if this ever needs to be hardened beyond local single-user dev use.

### The extension side (`background.js` only — no changes to `queue.js`/`annotations.js`)

```js
const MCP_SERVER_URL = "http://127.0.0.1:8934"; // fixed default for this pass, see "Known limitations"

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !changes.spotcheck_annotations) return;
  const annotations = changes.spotcheck_annotations.newValue || [];
  fetch(`${MCP_SERVER_URL}/sync`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ annotations }),
  }).catch(() => {}); // server not running — fail silently, see below
});
```

- **Fails completely silently if the server isn't running.** The extension must work exactly as it does today with zero server running at all — this push is additive, never a dependency for the extension's own core loop (picking, capturing, annotating, exporting). No retry queue, no error surfaced to the user; the next `chrome.storage` change tries again naturally.
- **Corrected during implementation: a new manifest entry *is* required.** The assumption that a background service worker's `fetch()` to an arbitrary URL is ungated by `permissions`/`host_permissions` was wrong — verified directly by building it: without `"host_permissions": ["http://127.0.0.1/*"]`, `fetch("http://127.0.0.1:8934/sync")` from `background.js` failed with a bare `TypeError: Failed to fetch`, even though the exact same request from `curl` succeeded against the exact same running server. Adding that one host permission line fixed it immediately, no other change needed. Flagged to verify empirically before writing this note, and it's a good thing it was — this is exactly the kind of permission edge case this project has been surprised by before (see Feature 6's `activeTab`/`captureVisibleTab` note).

### The server (`mcp-server/`)

- **`POST /sync`** — body `{ annotations: [...] }`, the exact array shape `queue.js` already stores (see "Data shape" below). Overwrites `~/.spotcheck/annotations.json` wholesale — this pass doesn't merge or diff, the extension always sends its full current queue.
- **`list_annotations`** (MCP tool, no arguments) — returns every annotation currently on disk, but as **lightweight summaries**: `id`, `number`, `selector`, `issueType`, `note`, `status`, `createdAt`, `updatedAt`. Deliberately excludes `snapshot` (a base64 image, potentially large) and `tagScopedStyles` (verbose) — an agent triaging "what needs fixing" doesn't need either just to decide what to look at next.
- **`get_annotation`** (MCP tool, argument: `id`) — returns the **full** record for one annotation, including `tagScopedStyles`, `snapshot`, `component`, `resolutionSummary`, `history` — everything Feature 6 captured. This is the one written-brief requirement this feature is actually building toward: "Each annotation exposed over MCP should carry exactly what Feature 6 captured."
- No `resolve`/`reopen` tool, no filtering/pagination on `list_annotations`, no push-to-agent (`watch_annotations`-style long polling, which Vibe has) — all explicitly out of scope per the original brief, not omissions to reconsider mid-build.

### Data shape exposed (from `get_annotation`)

Mirrors the record `content/annotations.js`'s `saveNote()` already builds and hands to `spotcheck.queue.upsert()`, unchanged: `id`, `number`, `selector`, `styles`, `component`, `issueType`, `note`, `includeSnapshot`, `snapshot`, `tagScopedStyles`, `status`, `resolutionSummary`, `history`, `createdAt`, `updatedAt`. This feature doesn't add, rename, or reshape any field — it's a read-only window onto exactly what's already there.

## Guardrails specific to this feature

- **Binds to `127.0.0.1` only** — never `0.0.0.0`, never an externally-reachable interface. Verified at implementation time, not assumed.
- **No outbound network calls from the server itself** — it only ever talks to `localhost` (the extension) and the local filesystem (`~/.spotcheck/`). No telemetry, no update-check pings, nothing phoning home.
- **The Chrome extension's own existing guardrails otherwise hold.** `manifest.json` gains exactly one narrowly-scoped `host_permissions` entry for this feature — `http://127.0.0.1/*`, required per the correction above, nothing broader. The extension itself still makes no calls beyond `127.0.0.1`; `CHROMEWEBSTORE.md`'s permissions section is updated alongside this feature the same way it was for Feature 6's `storage` addition.
- **This is the one place in the whole project where "no network calls" doesn't apply** — and only because `PROJECT.md` §6 pre-approved exactly this exception for exactly this purpose. Nothing here should be read as loosening that guardrail generally.

## Known limitations

- **Fixed port (`8934`), not configurable in this pass.** No options page, no env-var wiring on the extension side. If that port's taken on someone's machine, the push just fails silently (per the fail-silent design above) until that's resolved by hand.
- **No install wizard.** Running the server is `npm start` in `mcp-server/` (which is `node --env-file-if-exists=.env server.js` — see below); pointing Claude Code at it is a manual `claude mcp add --transport http spotcheck http://127.0.0.1:8934/mcp`. A Vibe-style one-command setup is real, deliberate future work, not attempted here.

### Origin pinning — `SPOTCHECK_EXTENSION_ORIGIN` is optional

**The server runs with no configuration at all.** `npm start` in `mcp-server/`, load the extension, done — verified end to end with the real extension pushing a real annotation to an unconfigured server. This was a deliberate revision: the first pass made the env var mandatory and `process.exit(1)`'d without it, which put a manual "read your extension id off `chrome://extensions`" step in front of every user for a guarantee that turns out to be much narrower than it looks.

**What the origin check defends against, pinned or not.** The threat is a **web page** — any tab the user has open can `fetch('http://127.0.0.1:8934/sync')` and poison the queue. The browser sets `Origin` itself and page script cannot override it, so rejecting everything that isn't `chrome-extension://` stops that class outright. Pinning changes nothing here.

**What pinning adds.** Exactly one thing: it stops a *different installed extension* from overwriting the queue. It adds **nothing** against a non-browser local process (curl, malware), which can forge any `Origin` header it likes — including a published extension's id, which is public by definition. So the default trades "other extensions the user has chosen to install are trusted" for "no setup step," which is the right default for a local single-user dev tool.

**Three ways to pin, in precedence order:**

- **`PUBLISHED_EXTENSION_ORIGIN` in `server.js`** — currently `null`. Fill it in the moment SpotCheck is published: a Web Store extension's id is fixed and public, so hardcoding it is safe and gives every end user exact-origin matching with **zero** setup. This is the real long-term answer.
- **`mcp-server/.env`** — `SPOTCHECK_EXTENSION_ORIGIN=chrome-extension://<id>`, then `npm start`. Loaded by Node's own `--env-file-if-exists` flag in the `start` script, **not** by a `dotenv` dependency; there is no dotenv in this project, so `node server.js` on its own will *not* read the file. `.env` is gitignored; `.env.example` documents the shape.
- **A shell env var** — `SPOTCHECK_EXTENSION_ORIGIN=... node server.js`. A real environment variable takes precedence over the file.

A value that is set but isn't a `chrome-extension://` origin is treated as a typo, not a preference: the server refuses to start rather than silently rejecting every push.

For an **unpacked** extension the id is per-machine and per-checkout (Chrome derives it from the absolute path it was loaded from — it was also observed to change when that directory was deleted and recreated at the same path), so it can never be committed as a shared default. Read the real one off `chrome://extensions` with Developer mode on. **A stale pin is the worst of both worlds** — the server starts fine and rejects every push, and the extension swallows the failure by design, so annotations simply never appear. If syncing stops working, check the server log for `/sync rejected` before anything else.
- **No auth beyond the Origin check.** Adequate for local single-user development, not a hardened multi-user posture. Flagged above, not silently accepted.
- **Full-array sync only, no incremental diffing.** Fine at the realistic scale (tens of annotations); would need revisiting if that assumption ever stops holding.
- **No rehydration/dashboard/watch-mode** — all explicitly deferred, matching the original brief's own scope cut, not discovered gaps.

## Relevance / dependencies

- **Depends entirely on Feature 6's queue** (`content/queue.js`'s `chrome.storage.local` schema) — this feature reads that shape, doesn't alter it.
- **Depends on Feature 5's popup only indirectly**, through whatever data Feature 6 already captures from it.
- **No dependency on Feature 8** (component-name detection) beyond exposing whatever `component` field Feature 2/8 already populate on the record — this feature doesn't interpret that field, just passes it through.
- **Sets up, but does not build, the future resolve/reopen loop** (`PROJECT.md`'s Phase 2 "Live verification loop") — that would add write-tools to this same server and is exactly the kind of addition the "swappable data layer" framing from Feature 6 was meant to make painless later, not something this feature needs to anticipate further than that.
