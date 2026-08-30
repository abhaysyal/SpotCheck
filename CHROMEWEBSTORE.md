# CHROMEWEBSTORE.md

Chrome Web Store submission reference for SpotCheck. Kept up to date alongside the extension's own code — whenever `extension/manifest.json`'s `permissions`/`host_permissions` change, or the extension's behavior around user data changes, this file should change with it. Copy the relevant sections straight into the Developer Dashboard at submission time; review/adjust before actually submitting rather than pasting blind.

*Note on provenance: this file is a manually-written best-effort against general Chrome Web Store policy, not generated from Google's official `chrome-extensions` agent skill (Modern Web Guidance) — that skill isn't installed in this environment. If it's added later, worth diffing this file against what that skill would produce.*

## Extension identity

- **Name:** SpotCheck
- **Category:** Developer Tools
- **Short description** (matches `manifest.json`): Click-to-select DOM annotation for AI coding agents.

## Single purpose statement

SpotCheck lets a developer click an element on any web page, attach a free-text note describing what's wrong with it, and export the whole queue of annotations as a Markdown bundle for pasting into an AI coding agent (Claude Code, Cursor, ChatGPT, etc.). Every capability in the extension — the picker, the capture engine, the annotation popup, the Markdown export — serves that one purpose: removing the ambiguity of describing a UI element in text by letting the user point at it directly. There is no unrelated functionality bundled in.

## Permissions and justifications

`extension/manifest.json` currently requests three permissions plus one narrowly-scoped `host_permissions` entry:

- **`activeTab`** — Justification: SpotCheck only ever needs to act on the one tab the user explicitly invokes it on, by clicking the toolbar icon. `activeTab` grants that access temporarily, scoped to the current tab, only after the user's own click — the extension has zero access to any tab until that happens, and no access to any *other* tab, ever. This is what lets SpotCheck avoid requesting broad host permissions (e.g. `<all_urls>`) that would let it act on every site a user visits without their per-use action. It also covers `chrome.tabs.captureVisibleTab` (Feature 6's optional "Include Snapshot" capture) — that API requires either `activeTab` or a host permission, and SpotCheck already has the former.
- **`scripting`** — Justification: Required for `chrome.scripting.executeScript`, which is how the content script bundle (`content/state.js`, `overlay.js`, `picker.js`, `capture.js`, `queue.js`, `annotations.js`, `export.js`) gets injected into the active tab on demand. SpotCheck deliberately has no static `content_scripts` entry in the manifest — without `scripting`, there would be no way to inject anything at all, and the extension would be unable to do the one thing it exists to do. Injection only ever happens in direct response to the toolbar icon click; nothing is injected automatically or in the background.
- **`storage`** — Justification: added in Feature 6 to persist the user's own annotation queue locally via `chrome.storage.local`, so it survives toggling inspection mode off, closing the tab, or restarting the browser — previously this data was memory-only and lost on any of those. This is local-only device storage scoped to the extension itself; see "Data usage disclosure" below for what is and isn't stored.
- **`host_permissions: ["http://127.0.0.1/*"]`** — Justification: added in Feature 7 so `background.js` can push the annotation queue to the optional local companion MCP server (`mcp-server/`, a separate Node process the user runs themselves — not bundled in this extension's ZIP, see "Packaging" below). Verified necessary by testing directly: without it, a `fetch()` from the service worker to `127.0.0.1` failed outright. Scoped to loopback only — this is not a "site" permission in the way reviewers usually mean; it grants no access to any actual website, only to a server running on the user's own machine. If that server isn't running, the push just fails silently and the extension's core behavior is completely unaffected (see `docs/features/feature-7-local-mcp-server/spec.md`).

No other permissions are requested. In particular:
- **No broader `host_permissions`** — nothing beyond the single loopback-only entry above; the extension never needs to run on any actual website by host pattern.
- **No `tabs`** (the broader permission, distinct from `activeTab`) — the extension never needs tab metadata (URLs, titles of *other* tabs) beyond the current tab it's already been granted access to via `activeTab`.
- **No `unlimitedStorage`** — annotation data (including any captured snapshot images, each cropped to a single UI element's own bounding box) is expected to stay well within `chrome.storage.local`'s default quota for realistic usage; revisit only if that stops being true.

## Data usage disclosure

- **No data is collected, stored remotely, or transmitted anywhere.** SpotCheck makes zero network requests of any kind — no `fetch`, no `XMLHttpRequest`, no analytics, no telemetry, no remote logging. This is a hard guardrail stated explicitly in `CLAUDE.md` and `PROJECT.md` §6, not an implementation detail that happens to be true today.
- **The only way data leaves the browser is the explicit "Copy" button** (Feature 4, `content/export.js`), which writes a Markdown-formatted summary of the user's own annotations to the OS clipboard via `navigator.clipboard.writeText()` — a local browser API, not a network call. Nothing happens automatically; the user must click the button.
- **No cookies, no browsing history, no credentials, no data from other tabs are read or stored.** The extension's DOM reads (`getComputedStyle`, `elementFromPoint`, selector-path walking) are scoped entirely to the single active tab's own visible page content, and only while the user has explicitly toggled inspection mode on.
- **Annotation data persists locally via `chrome.storage.local` as of Feature 6** (a deliberate, reviewed change from the original "memory only, resets on toggle-off" design — see `docs/features/feature-6-annotation-capture-edit/spec.md`'s "Storage decision"). What's stored: each annotation's note, selector, chosen issue type (a single selection covering both what property is affected and, where relevant, structural context like Component/Component Variant/State), captured computed-style data, and — only if the user explicitly checks "Include Snapshot" — a screenshot cropped to that single element's own bounding box. This storage is local to the browser profile, scoped to the extension, never synced to a Google account (`chrome.storage.sync` is not used), and never transmitted anywhere over the network; it stays on-device until the user removes an annotation or uninstalls the extension. The on-page visual state (highlight outlines, numbered bubbles) still resets on toggle-off exactly as before — only the underlying data survives.
- **As of Feature 7, that same data is also pushed to an optional local companion server on `127.0.0.1`** (`mcp-server/`, a separate Node process the user starts themselves — it is not installed or run automatically, and the extension works identically with or without it running). This is still not a network call in the sense reviewers care about: the destination is a process on the user's own machine, never a remote server, and the extension makes no request anywhere else. See `docs/features/feature-7-local-mcp-server/spec.md` for the full design, including the access controls that server applies to reject any origin other than this extension's own.

## Remote code

None. No code is fetched from a remote source at runtime — every script the extension runs is one of the files bundled in `extension/content/` and injected via `chrome.scripting.executeScript`. No `eval`, no dynamically constructed `<script src>` tags, no remote config.

## Host permissions rationale (for the "why don't you need `<all_urls>`" reviewer question)

SpotCheck's picker only ever needs to see the DOM of the tab the user is currently looking at, and only after they've explicitly clicked the toolbar icon for that specific tab. `activeTab` already grants exactly that, scoped per-invocation — requesting `host_permissions` for a broader set of sites (or all sites) would grant standing access the extension never actually uses, which is both unnecessary for the extension's single purpose and exactly the kind of over-broad permission the Chrome Web Store review process is designed to flag. The one `host_permissions` entry SpotCheck does have (`http://127.0.0.1/*`, added in Feature 7) isn't a website at all — it's the loopback address, used only to reach an optional companion process on the user's own machine; there is no site on the web this permission grants access to.

## Packaging: what NOT to include in the submission ZIP

- `.git/`, `node_modules/` (none currently *inside `extension/`* — but check before each release), `.env`, `CHROMEWEBSTORE.md` itself.
- **`mcp-server/` is never part of this ZIP.** It's a separate, optional Node.js companion process (Feature 7) that lives in this same repo for development convenience but is not a Chrome extension component — it has its own `package.json`/`node_modules`, isn't loaded by `manifest.json`, and isn't something the Store submission process needs to know exists. Ship only `extension/`'s own contents.
- ZIP the full contents of `extension/` — `manifest.json`, `background.js`, and `content/`.

## Version history

- **0.1.0** — Initial v1 feature set: Inspection Mode / Element Picker (Feature 1), Capture Engine (Feature 2), Annotation Layer (Feature 3), Export Bundle (Feature 4). Not yet submitted to the Chrome Web Store — submission is planned for v3/v4, not v1.
- **0.2.0** — UI Makeover (Feature 5): rebuilt annotation popup (issue type, cause chips, note, snapshot checkbox) per Figma; the standalone cause-chips row was later merged into a single grouped Issue-type dropdown (Property: Color/Typography/Spacing/Layout; Structure: Component/Component Variant/State-Interaction/Other), also per an updated Figma file. Annotation Capture & Edit (Feature 6): tag-scoped computed-CSS capture, real on-demand screenshot capture, debounced hot-save for editing an existing annotation, auto-reopen of a previously agent-resolved/verified annotation on edit, and local persistence of the annotation queue via `chrome.storage.local` (new `storage` permission — see Permissions and Data usage disclosure above). Still not yet submitted to the Chrome Web Store.
- **0.3.0** — Local MCP Server (Feature 7): an optional, separate local Node process (`mcp-server/`, not part of the extension ZIP) that the extension pushes the annotation queue to, exposing it read-only to AI coding agents over MCP (`list_annotations`, `get_annotation`). New `host_permissions: ["http://127.0.0.1/*"]` — see Permissions above. Still not yet submitted to the Chrome Web Store.
