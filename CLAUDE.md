# CLAUDE.md

Instructions for any AI agent (Claude Code or otherwise) working in this repo. Read `PROJECT.md` first for full context — this file is about *how to work here*, not what the product is.

## What this repo is

SpotCheck: a Chrome extension for click-to-select DOM annotation, exporting structured feedback for an AI coding agent to act on. Full background, architecture, and roadmap: `PROJECT.md`.

## How features are organized

Each numbered feature (v1: 1-4, v2: 5-8) has its own folder under `docs/features/`: `docs/features/feature-N-<name>/`, containing:
- **`plan.md`** — the concrete steps to implement it: which files to create/touch, what functions to write, in what order, and the test criteria to check before calling it done. **Follow this file directly when implementing** — it's written to be executable, not just descriptive.
- **`spec.md`** — the technical reference for the feature: what it does, how it works, feature-specific guardrails, and how it relates to/depends on other features. Read this when you need the "why," or when a downstream feature needs to know how an upstream one hands off data.

When asked to implement a feature, read both files in that feature's folder before writing any code.

## Non-negotiable guardrails (apply across all features)

These come from `PROJECT.md` §6 — restated here because an implementing agent should never need to go looking for them. Two of the v1 guardrails below have exactly one deliberate, already-reviewed exception each (Features 6 and 7) — noted inline so a future agent doesn't mistake either exception for a violation, or use it as precedent to add a third:

- **No network calls, except the one pre-approved exception: the local MCP server on `127.0.0.1` (Feature 7).** Everything else — no `fetch` to any remote host, no `XMLHttpRequest`, no analytics — still holds. Export itself is still clipboard-only; the MCP push is a separate, later addition `PROJECT.md` §6 explicitly carved out in advance ("When MCP is added later: the local MCP server must bind to localhost only... and should be treated as a trust boundary"), not a quiet erosion of "no network calls."
- **No content script in the manifest's static `content_scripts` list.** Injection happens on demand via `chrome.scripting.executeScript`, triggered only by explicit user action (toolbar icon click). The extension should be inert on any page until the user acts.
- **Permissions stay minimal.** Current baseline is `activeTab` + `scripting` + `storage` (Feature 6) + `host_permissions: ["http://127.0.0.1/*"]` (Feature 7, loopback-only) — see `manifest.json`. Don't add anything beyond that baseline unless a specific feature's `spec.md` explicitly grants it and explains why, the same way those two did.
- **Read-only DOM capture.** Nothing about the page being inspected is modified — only the extension's own overlay UI is added/removed.
- **No credential, cookie, or other-tab access. No storage access beyond the extension's own `chrome.storage.local` annotation queue** (Feature 6's one deliberate exception — see above) — never cookies, never another tab's data, never anything synced to a Google account.
- If a task seems to require breaking one of these — including anything beyond the two exceptions already named — stop and flag it rather than implementing around it. These are scope boundaries agreed on deliberately, not defaults to optimize away.

## Cross-feature communication convention

Features communicate via `CustomEvent`s dispatched on `document`, not direct function calls between feature modules. E.g. Feature 1 locks an element and dispatches `spotcheck:element-selected`; Feature 2 and Feature 3 each listen for it independently. Keep this pattern when adding new features — it keeps each feature's `plan.md` implementable without needing to know the internals of the others.

## Content script structure

No bundler, no ES modules in content scripts (MV3 `executeScript`-injected classic scripts share one isolated-world scope). Shared state lives on a single namespaced global, `window.__spotcheck`, not via `import`/`export`.

## Chrome Web Store submission tracking

Whenever you create or change anything in `extension/` — especially `manifest.json`'s `permissions`/`host_permissions`, or anything about what data the extension reads, stores, or transmits — update `CHROMEWEBSTORE.md` at the repo root to match. It tracks the Developer Dashboard submission info: single purpose statement, a justification per permission, data usage disclosure, and remote-code disclosure. Keep it accurate as the extension evolves, not just written once — a stale permission justification is worse than none, since it actively misleads whoever copies it into the Dashboard at submission time.

## When in doubt

Check `PROJECT.md` §7 (prior art) before reinventing something — VisBug, Agentation, and Markagent/DOM Review all solved pieces of this problem already and are worth a quick look before writing new logic from scratch, especially for the picker/overlay mechanics.
