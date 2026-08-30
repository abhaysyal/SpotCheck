# Feature 5 — UI Makeover — spec.md

## What it does

Rebuilds Feature 3's annotation popup — the dark card that opens when you lock an element — to match the finalized Figma design (`AC3LWwExa2zUl5m3vR7Vgo`, node `1:5234`), replacing its current free-text-only markup with the full field set: an Issue type dropdown, the existing note textarea, an Include Snapshot checkbox, and delete/send icon buttons. **This is a visual/structural rebuild only.**

**Post-approval update (still this feature's file, `content/annotations.js`):** this feature originally shipped the Issue type dropdown and a separate row of four multi-select "what's wrong?" cause chips underneath it, per the Figma pull below. A later Figma revision (node `24:85`) merged both into a single grouped, single-select Issue type dropdown — a `Property` group (Color/Typography/Spacing/Layout) and a `Structure` group (Component/Component Variant/State / Interaction/Other), separated by a divider — and added a numbered corner badge on the popup in edit mode (node `30:145`). The section below ("Figma pull") is kept as-written for the historical reasoning (add-vs-edit mode, send-button-vs-hot-save discrepancy, etc.), but its `ISSUE_TYPES`/`CAUSE_CHIPS` code block and every "cause chip" reference are superseded — see "Current Issue type model" further down for what's actually in the code today. Most of what's new is genuinely interactive (dropdown opens, chips toggle, checkbox flips, send disables/enables) because that behavior lives entirely in local popup UI state — but the data those fields are *supposed* to eventually produce (tag-scoped CSS capture, a real screenshot, durable persistence) is stubbed. Feature 6 wires all of that up.

This feature does not touch `content/capture.js`, `content/picker.js`, `content/export.js`, `background.js`, or `manifest.json`. It is a rewrite of `content/annotations.js`'s markup, styling, and popup-side interaction wiring — the store (`annotationsByElement`/`annotationsInOrder`), the positioning loop, the toggle lifecycle, and the cross-feature event contract (`spotcheck:element-selected` in, `spotcheck:annotation-saved`/`spotcheck:annotation-deleted` out) all carry over from Feature 3 unchanged.

## Figma pull — what was fetched, and where it disagrees with the written brief

Pulled via the Figma MCP (`get_metadata` + `get_design_context` on node `1:5234` and its `Annotation-edit` (`14:1008`) and `Issue type single selection` (`9:796`) children) on 2026-08-29. Exact values below are ground truth for `plan.md`; two things in the file itself contradict the written brief that accompanied this spec, and per that brief's own instruction ("if anything in the file conflicts with the written spec, the written spec is more current"), the written brief wins in both cases:

1. **Header tense.** The Figma file's `Annotation-edit` frame reads "Annotating div.hero_cta > a.btn-primary" — same "Annotating" wording as the add-mode frame, not "Annotated." The written brief explicitly distinguishes `Annotating <selector>` (add) from `Annotated <selector>` (edit) — that distinction is implemented; the Figma file just hasn't been updated to show it yet.
2. **Edit-mode send button.** The written brief's end-state for edit mode is hot-save (debounced autosave, a small saved-confirmation indicator, **no explicit Save button**). The Figma `Annotation-edit` frame still shows a send button (identical to add mode) next to delete. Since Feature 6 — not this feature — owns "actual persistence/hot-save behavior," this feature ships the send button exactly as Figma shows it (so the visual handoff is pixel-accurate), with a `// TODO: wired in Feature 6 — replace with hot-save + saved-confirmation indicator once autosave lands` on it. Feature 6 is the one that removes it.

### Design tokens pulled from Figma (hex values, not variable-bound in most cases — this file mostly hardcodes color)

| Element | Value |
|---|---|
| Popup background | `#000000`, `border: 1px solid #313131`, `border-radius: 8px`, padding `4px 12px 12px`, `gap: 10px` (flex column) |
| Header text | Inter 12px/22px. "Annotating"/"Annotated" in `#7b7b7b`; selector in `#77cff4` |
| Issue type trigger (collapsed) | bg `#2c2c2c`, `border-radius: 4px`, padding `6px 8px`ish (Figma: `px-6 py-2` scaled), text `#cecece` 14px, chevron-down icon, 20×20 |
| Issue type dropdown (open) | container bg `#262626`, `border: 1px solid #545454`, `border-radius: 4px`, padding 4px; each item `32px` tall, `border-radius: 4px`, padding `12px/5px`, text `rgba(255,255,255,0.88)` 14px/22px; hovered/highlighted item bg `rgba(9,153,214,0.15)` |
| "What's wrong?" label | `#7b7b7b`, 11px/22px |
| Cause chips (pill) | `border-radius: 26px` (full pill), `border: 1px solid #313131`, text `#b2b2b2` 12px/20px, padding `3px 8px`, `gap: 6px` between chips. **Selected** state: `background: #1d1d1d` (filled); **unselected**: border only, transparent fill |
| Note textarea | `border: 1px solid #313131`, `border-radius: 4px`, height `92px`, padding `4px 8px`, text `#c4c4c4` 14px/24px, placeholder "Enter note" |
| Include Snapshot checkbox | 16×16, `border-radius: 4px`; **checked**: bg `#77cff4` with a check glyph; label `#cecece` 14px |
| Delete button | 38×36, bg `#2c2c2c`, `border-radius: 4px`, centered 24×24 trash icon (tabler-icon-trash) |
| Send button | 38×36, bg `#77cff4` (same accent as the checkbox/selector), `border-radius: 4px`, centered 24×24 up-arrow icon (tabler-icon-arrow-up) |
| Font | Inter throughout (system fallback stack if Inter isn't loaded — this extension has never bundled a webfont, and isn't starting here; use the existing `-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif` stack from Feature 3/4 and let Inter apply only where the host OS/browser already resolves it) |

**One accent color, reused three ways**: `#77cff4` is the selector text in the header, the checked-checkbox fill, and the send button background. Not a coincidence — it's this design's one "confirmed/active" signal, replacing the `#22c55e` green Feature 3 used for the same role (locked-highlight green, send-button green, saved-outline green). **This feature does not touch `overlay.js`'s or the rest of `annotations.js`'s outline/bubble green** — the persistent per-annotation outline traced on the page, and the bubble pins, are Feature 1/3's own visual language for marking *the page*, not the popup's internal chrome. Changing the popup's internal accent to `#77cff4` does not imply changing what's drawn on the inspected page itself; that's out of scope here and not requested.

## Current Issue type model (post-merge — what's actually in the code)

```js
const TYPE_OPTIONS = [
  { group: "Property", id: "color", label: "Color" },
  { group: "Property", id: "typography", label: "Typography" },
  { group: "Property", id: "spacing", label: "Spacing" },
  { group: "Property", id: "layout", label: "Layout" },
  { group: "Structure", id: "component", label: "Component" },
  { group: "Structure", id: "component-variant", label: "Component Variant" },
  { group: "Structure", id: "state-interaction", label: "State / Interaction" },
  { group: "Structure", id: "other", label: "Other" },
];
```

- **Single-select, one field, no chips.** `draftState` has one `issueType` field (an id from `TYPE_OPTIONS`, or `null`) — there is no `causes` array anywhere in the record or the popup. The dropdown menu renders a `.issue-type-group-label` row before each group and a `.issue-type-divider` between them, matching Figma node `24:85`.
- **Send/hot-save gate is `issueType !== null`, full stop.** No note/snapshot requirement layered on top — confirmed via AskUserQuestion during the merge ("selection alone is required").
- **Numbered corner badge, edit mode only.** A small circular badge (`#77cff4` fill, black text, `position: absolute; top: -13px; left: -13px` on the popup) showing the annotation's number, per Figma node `30:145`. Never rendered in add mode.
- **Tag-scoped capture keys off the chosen `issueType`,** not off any chip — see Feature 6's spec.md for `captureTagScopedStyles`.

## How it works (original Feature 5 pass — add/edit mode logic still accurate)

- **Add vs. edit mode is the same `getExistingRecord(el)` check Feature 3 already made** — a locked element with no existing record opens in add mode (header "Annotating…", Issue type trigger shows placeholder "Issue type", empty note, Include Snapshot unchecked). An element with an existing record opens in edit mode, pre-filled from that record: Issue type trigger shows the stored label, the note textarea is pre-filled, Include Snapshot reflects the stored boolean.
- **Corrected during review: the delete button only exists in edit mode, matching Figma exactly.** The `Annotation-add` frame's footer has only a send button; the `Annotation-edit` frame's footer has delete *and* send. This is a real behavior change from Feature 3, where delete was always present and doubled as a cancel control for an unsaved draft. There is no cancel button for a fresh draft in this design — clicking a different element (already-existing behavior: abandons the current draft with no confirmation) or Escape (existing, separately-tracked known limitation) remain the only ways to walk away from one. The delete element itself is only created/shown once `activeRecord` is truthy (i.e. edit mode); it does not exist in the DOM at all while a popup is in add mode.
- **Record fields as originally shipped: `issueType`, `causes`, `includeSnapshot`, `snapshot`.** `causes` was removed entirely in the post-approval merge (see "Current Issue type model" above) — the paragraph below describes the original design and is kept for history only.
- ~~All four cause chips — Token, Component, Component Variant, State — are always visible, regardless of Issue type.~~ Superseded — chips no longer exist; Component/Component Variant/State are now options inside the single Issue type dropdown's "Structure" group.
- ~~Send button enable/disable is a pure function of `issueType`... zero cause chips... are all valid states to send from.~~ Still true in spirit (`issueType !== null` is still the entire gate) — just with no chips left to be irrelevant.
- **The Issue type dropdown is a small piece of self-contained popup UI, not a `<select>`.** Matches Figma's custom-styled trigger + floating list exactly (a native `<select>` can't be styled to match the `#262626`/`#545454` dropdown or the `rgba(9,153,214,0.15)` hover tint at all reliably across browsers). Opens on trigger click, closes on: selecting an item, clicking anywhere else inside the popup, or clicking outside the popup entirely (which — per Feature 1/3's existing model — is already a "select a different element" click that tears down and rebuilds this whole popup anyway, so the dropdown closing is a side effect of the popup itself being replaced, not something this feature has to special-case). Single-select, and post-merge every option in the dropdown — property or structural — is part of that same single-select set.
- **Note remains a free-text textarea, unchanged mechanically from Feature 3** — same Enter-to-send / Shift+Enter-for-newline behavior, same "never required" gating. Only the placeholder copy changes, from Feature 3's "Add a note…" to the Figma-specified "Enter note".
- **Include Snapshot is a plain checkbox toggle in this feature — nothing behind it yet.** Checking it records `includeSnapshot: true` on send; nothing is captured, no image data exists anywhere, and the checked state carries no visible consequence in the popup itself (no thumbnail preview — Figma's mock doesn't show one, and the written brief only ever describes the checkbox itself, not a preview). Feature 6 is what makes checking this box actually do anything at send time.
- **Delete's own click behavior (remove the record, its bubble, its outline, renumber the rest) is unchanged from Feature 3** — only its *visibility* changes, per the correction above: rendered in edit mode only, never in add mode.
- **Selector display uses the real thing, not a placeholder — this feature declines the brief's "can use placeholder text" allowance.** Feature 1/2's `spotcheck:element-selected`/`spotcheck:element-captured` events are already flowing into this file (Feature 3 already reads them for exactly this purpose), so a real selector string is free — `latestCaptureByElement`'s cached value for a fresh draft, `record.selector` for an existing one, falling back to Feature 4's existing `"(selector unavailable)"` string only if capture itself failed. Inventing a fake placeholder here would be strictly more work than using data that's already sitting there correctly, for a worse demo.

## Guardrails specific to this feature

- **No new permissions, no manifest changes, no network calls, as originally shipped.** Every new interactive element (dropdown, checkbox) is local DOM/JS state inside the already-injected content script. `manifest.json` stayed at `["activeTab", "scripting"]` through this feature — it's Features 6 and 7, not this one, that later add `storage` and `host_permissions`.
- **Popup has a hard `max-width: 380px`** (`box-sizing: border-box`), added after initial approval per direct user feedback — the header text wraps (`overflow-wrap: break-word`) instead of overflowing for long selectors.
- **Still nothing written to the page being inspected.** All of this still renders inside the same Shadow DOM host Feature 3 already owns.
- **Still in-memory only.** No `chrome.storage` call is introduced by this feature. The new record fields live in the same plain JS objects Feature 3's store already used; Feature 6 is what turns that store into the "clean, swappable data layer" the build sequence calls for.
- **No stub silently pretends to be real.** Every stub point (tag-scoped CSS, snapshot capture, hot-save, in the edit-mode send button) carries a `// TODO: wired in Feature 6` comment at the exact line a future agent needs to touch — per the build sequence's own requirement, not a general style preference.

## Known limitations (carried over or newly introduced by this feature)

- **Escape-while-typing gap (Feature 3, unchanged) now also covers the open dropdown.** `picker.js`'s document-level, capture-phase Escape handler still clears the whole lock/selection unconditionally, with no check for focus being inside this feature's shadow root. Feature 3 already flagged this for the note textarea; this feature adds one more case to the same still-deferred gap — pressing Escape to *just* close an open Issue type dropdown instead clears the entire popup. Not fixed here, same as Feature 3's original.
- **No visible feedback for a disabled send button beyond dimming.** No tooltip, no inline "pick an issue type" hint — a user who doesn't notice the dimming has no explicit explanation. Acceptable for a visual-only pass; worth revisiting once Feature 6's real send-time validation exists.
- **Component/Component Variant/State-Interaction options carry no meaning yet beyond a label a person chose.** Post-merge these are `issueType` values, not chips — nothing in this feature (or Feature 2) cross-checks them against the actual captured `component` data. That reconciliation, if it's ever wanted, isn't scoped anywhere in the current build sequence.
- **A fresh, unsaved add-mode draft has no explicit cancel control.** A real regression from Feature 3 (where delete always doubled as cancel), traded deliberately for matching Figma's add-mode frame exactly, which has no delete button at all. Abandoning a draft still works — click a different element, or Escape (with the gap noted above) — just not via a visible button anymore.

## Relevance / dependencies

- **Rebuilds Feature 3's popup in place.** Everything Feature 3's `spec.md`/`plan.md` documented about the store, the positioning loop, the toggle lifecycle, and the `picker.js` own-UI click routing carries over unchanged — this feature only replaces markup, CSS, and popup-internal interaction wiring.
- **Feeds Feature 6 directly.** Every new field this feature adds to the record (`issueType`, `causes`, `includeSnapshot`, `snapshot`) is exactly what Feature 6's tag-scoped capture, real snapshot capture, and hot-save logic read from and write to. Feature 6 should not need to touch this feature's markup at all — only the stub functions this feature marks with `// TODO: wired in Feature 6`.
- **No dependency on Feature 7 or 8.** Nothing in this feature talks to MCP or does component-name detection beyond what Feature 2 already provides.
