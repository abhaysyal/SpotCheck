# Feature 5 — UI Makeover — plan.md

Implementation plan for an AI coding agent. Read `spec.md` first — it has the full Figma pull (exact hex/spacing values) and the rationale behind every decision below. This file is the concrete "what to change, in what order" companion to it.

**Historical note:** this plan built the originally-shipped design — an Issue type dropdown (`ISSUE_TYPES`, 5 options) plus a separate row of four multi-select `CAUSE_CHIPS` (Token/Component/Component Variant/State). A later Figma revision (post-approval, node `24:85`) merged both into one grouped single-select `TYPE_OPTIONS` dropdown with no chips, plus added a numbered edit-mode corner badge (node `30:145`) — see `spec.md`'s "Current Issue type model" section for what's actually in the code today. Every code block below referencing `ISSUE_TYPES`, `CAUSE_CHIPS`, `chipEls`, or `draftState.causes` is a record of the original build, not a current-state reference.

## Scope reminder

Visual/structural rebuild of the existing annotation popup only. Do **not** implement in this pass:
- Tag-scoped computed-CSS capture per issue type — Feature 6.
- Real `chrome.tabs.captureVisibleTab` snapshot capture — Feature 6.
- Debounced hot-save / persistence layer — Feature 6.
- Removing the edit-mode send button in favor of a saved-confirmation indicator — Feature 6 (this pass ships the send button in edit mode, matching Figma, with a `// TODO` on it — see `spec.md`'s "Figma pull" section).
- Anything MCP- or component-name-related — Features 7 and 8.

No new files. No `manifest.json`/`background.js`/`picker.js`/`capture.js`/`export.js` changes. This is a rewrite of `content/annotations.js`'s markup, `<style>` block, and popup-internal event wiring — the store, positioning loop, and toggle lifecycle it already has stay structurally the same, extended with the new fields below.

## Files to touch

1. **`extension/content/annotations.js`** — the only file this feature touches. Sections affected: the `<style>` block inside `ensureHost()`, the popup markup built in `ensureHost()`, the record shape in `saveNote()`, and a new block of dropdown/chip/checkbox wiring alongside the existing `commit()`/`openPopupFor()`/`closePopup()`.

## Step-by-step

### Step 1 — Extend the record shape

In `saveNote(el, text)`, the object created for a brand-new record gains four fields. Existing fields (`number`, `element`, `selector`, `styles`, `component`, `note`, `bubbleEl`, `outlineEl`, `createdAt`, `updatedAt`) are unchanged:

```js
record = {
  number: annotationsInOrder.length + 1,
  element: el,
  selector: cached ? cached.selector : null,
  styles: cached ? cached.styles : null,
  component: cached ? cached.component : null,
  note: trimmed,
  issueType: draftState.issueType,        // new — one of ISSUE_TYPES[].id, or null
  causes: [...draftState.causes],         // new — array of CAUSE_CHIPS[].id, copy not reference
  includeSnapshot: draftState.includeSnapshot, // new — boolean
  snapshot: null,                          // new — always null in this feature; Feature 6 fills it
  bubbleEl: null,
  outlineEl: null,
  createdAt: Date.now(),
  updatedAt: Date.now(),
};
```

`saveNote` currently only ever updates `note`/`updatedAt` on an existing record; extend that branch to also copy the four new fields from `draftState` on every save (add or edit) — an edit is exactly where Issue type/causes/snapshot-checkbox changes need to actually land on the record:

```js
if (record) {
  record.note = trimmed;
  record.issueType = draftState.issueType;
  record.causes = [...draftState.causes];
  record.includeSnapshot = draftState.includeSnapshot;
  record.updatedAt = Date.now();
}
```

`saveNote`'s existing empty/whitespace-note early return (`if (!trimmed) return null;`) stays exactly as is — the written brief only exempts note/chips/snapshot from *send-button gating*, not from the fact that this popup's one commit action is still "send." (Send being disabled until Issue type is chosen already prevents ever reaching `saveNote` with `issueType: null` — see Step 5.)

### Step 2 — Popup-local draft state

One new plain object, reset every time the popup opens (`openPopupFor`), mirrors exactly the fields on a record — this is the form's live editing state before a send commits it:

```js
let draftState = { issueType: null, causes: [], includeSnapshot: false };

const ISSUE_TYPES = [
  { id: "color", label: "Color" },
  { id: "typography", label: "Typography" },
  { id: "spacing", label: "Spacing" },
  { id: "layout", label: "Layout" },
  { id: "other", label: "Other" },
];
const CAUSE_CHIPS = [
  { id: "token", label: "Token" },
  { id: "component", label: "Component" },
  { id: "component-variant", label: "Component Variant" },
  { id: "state", label: "State" },
];
```

### Step 3 — New markup inside `ensureHost()`

Replace the current popup markup (textarea + actions row only) with the full structure. Keep building it with `createElement`, matching the existing file's style (no template-string HTML injection anywhere in this codebase) — this is a direct DOM-node-by-node translation of the Figma pull in `spec.md`:

```
.popup
├── .popup-header          → "Annotating "/"Annotated " (span, muted) + selector (span, accent)
├── .popup-body
│   ├── .issue-type
│   │   ├── .issue-type-trigger   → label text + chevron, click toggles .issue-type-menu
│   │   └── .issue-type-menu      → 5 items, hidden by default, absolutely positioned below trigger
│   ├── .cause-section
│   │   ├── .cause-label   → "What's wrong?"
│   │   └── .cause-chips   → 4 chip buttons (Token/Component/Component Variant/State)
│   └── .popup-note        → existing textarea, placeholder changes to "Enter note"
└── .popup-footer
    ├── .snapshot-checkbox → checkbox + "Include Snapshot" label
    └── .popup-actions     → delete button (edit mode only, see Step 6) + send button (unchanged element, new gating)
```

Concrete element references you'll need to keep as module-level `let`s (alongside the existing `popupEl`/`noteTextarea`/`sendButton`/`deleteButton`): `headerEl`, `issueTypeTrigger`, `issueTypeLabel`, `issueTypeMenu`, `chipEls` (a `Map<string, HTMLElement>` keyed by chip id, so Step 5's chip-selection toggling doesn't need a DOM query), `snapshotCheckbox`.

### Step 4 — CSS (values straight from `spec.md`'s table)

```css
.popup {
  position: fixed;
  background: #000000;
  color: #f3f4f6; /* base text color fallback; specific elements override per the table */
  border: 1px solid #313131;
  border-radius: 8px;
  padding: 4px 12px 12px;
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-width: 260px;
  z-index: 2147483647;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Inter", sans-serif;
}
.popup-header { font-size: 12px; line-height: 22px; white-space: nowrap; }
.popup-header .muted { color: #7b7b7b; }
.popup-header .selector { color: #77cff4; }

.issue-type-trigger {
  display: inline-flex; align-items: center; gap: 6px;
  background: #2c2c2c; color: #cecece; font-size: 14px;
  border-radius: 4px; padding: 4px 8px; cursor: pointer; width: fit-content;
}
.issue-type-menu {
  position: absolute; display: none; flex-direction: column;
  background: #262626; border: 1px solid #545454; border-radius: 4px; padding: 4px;
  min-width: 140px; z-index: 2147483647;
}
.issue-type-menu.open { display: flex; }
.issue-type-item {
  height: 32px; display: flex; align-items: center; padding: 5px 12px;
  border-radius: 4px; color: rgba(255,255,255,0.88); font-size: 14px; cursor: pointer;
}
.issue-type-item:hover { background: rgba(9, 153, 214, 0.15); }

.cause-label { color: #7b7b7b; font-size: 11px; line-height: 22px; }
.cause-chips { display: flex; gap: 6px; flex-wrap: wrap; }
.chip {
  border: 1px solid #313131; border-radius: 26px; padding: 3px 8px;
  color: #b2b2b2; font-size: 12px; background: transparent; cursor: pointer;
}
.chip.selected { background: #1d1d1d; }

.popup-note {
  border: 1px solid #313131; border-radius: 4px; height: 92px; padding: 4px 8px;
  color: #c4c4c4; font-size: 14px; line-height: 24px; background: transparent;
  resize: vertical; box-sizing: border-box; font: inherit;
}

.popup-footer { display: flex; align-items: center; justify-content: space-between; }
.snapshot-checkbox { display: flex; align-items: center; gap: 8px; cursor: pointer; }
.snapshot-checkbox .box {
  width: 16px; height: 16px; border-radius: 4px; border: 1px solid #545454;
  display: flex; align-items: center; justify-content: center;
}
.snapshot-checkbox.checked .box { background: #77cff4; border-color: #77cff4; }
.snapshot-checkbox .label { color: #cecece; font-size: 14px; }

.popup-actions { display: flex; gap: 10px; }
.popup-send, .popup-delete {
  width: 38px; height: 36px; border-radius: 4px; border: none; cursor: pointer;
  display: flex; align-items: center; justify-content: center;
}
.popup-delete { background: #2c2c2c; color: #f3f4f6; }
.popup-send { background: #77cff4; color: #0b0b0c; }
.popup-send.disabled { opacity: 0.4; cursor: not-allowed; }
```

- Checkbox and chips are custom-drawn `div`s with a click handler, not native `<input type="checkbox">`/`<input type="radio">` — consistent with the Issue type dropdown decision in `spec.md` (native controls can't match this palette reliably across browsers/OSes).
- `.popup-send.disabled` only changes appearance; the actual no-op behavior is in the click handler (Step 5), not a `disabled` attribute — keeps it in the accessibility tree as a real, discoverable button.

### Step 5 — Wiring

```js
function setIssueType(id) {
  draftState.issueType = id;
  issueTypeLabel.textContent = id ? ISSUE_TYPES.find((t) => t.id === id).label : "Issue type";
  issueTypeMenu.classList.remove("open");
  updateSendEnabled();
}

function toggleCause(id) {
  const chipEl = chipEls.get(id);
  const idx = draftState.causes.indexOf(id);
  if (idx === -1) {
    draftState.causes.push(id);
    chipEl.classList.add("selected");
  } else {
    draftState.causes.splice(idx, 1);
    chipEl.classList.remove("selected");
  }
}

function updateSendEnabled() {
  sendButton.classList.toggle("disabled", draftState.issueType === null);
}

function onSendClick() {
  if (draftState.issueType === null) return; // gated — see updateSendEnabled
  commit();
}

function toggleSnapshotCheckbox() {
  draftState.includeSnapshot = !draftState.includeSnapshot;
  snapshotCheckboxEl.classList.toggle("checked", draftState.includeSnapshot);
}
```

- `issueTypeTrigger` click toggles `.issue-type-menu`'s `.open` class; each `.issue-type-item` click calls `setIssueType(item.id)`.
- A `click` listener on `popupEl` itself (not `document`) closes the dropdown whenever the click target isn't inside `.issue-type-trigger`/`.issue-type-menu` — this is what makes clicking the note textarea, a chip, or the checkbox while the dropdown happens to be open close it without abandoning the draft. A click outside `popupEl` entirely is already handled by the existing Feature 1/3 flow (it's a different-element selection, which tears down and rebuilds this whole popup) — nothing new needed there.
- `sendButton.addEventListener("click", onSendClick)` replaces the existing direct `commit` binding. `commit()` itself is otherwise unchanged from Feature 3 except for reading the four new fields off `draftState` in Step 1's `saveNote` call.

### Step 6 — `openPopupFor` / `closePopup` extensions

```js
function openPopupFor(el) {
  ensureHost();
  positionAllBubbles();
  draftElement = el;
  activeRecord = getExistingRecord(el);

  const cached = latestCaptureByElement.get(el);
  const selectorText = (activeRecord ? activeRecord.selector : cached && cached.selector) || "(selector unavailable)";
  headerEl.querySelector(".muted").textContent = activeRecord ? "Annotated" : "Annotating";
  headerEl.querySelector(".selector").textContent = selectorText;

  draftState = {
    issueType: activeRecord ? activeRecord.issueType : null,
    causes: activeRecord ? [...activeRecord.causes] : [],
    includeSnapshot: activeRecord ? activeRecord.includeSnapshot : false,
  };
  noteTextarea.value = activeRecord ? activeRecord.note : "";

  // Re-render every field from draftState — same pattern for all four:
  setIssueType(draftState.issueType); // updates the trigger label
  CAUSE_CHIPS.forEach((c) => chipEls.get(c.id).classList.toggle("selected", draftState.causes.includes(c.id)));
  snapshotCheckboxEl.classList.toggle("checked", draftState.includeSnapshot);
  updateSendEnabled();

  // Delete only exists in edit mode — matches Figma's Annotation-add (send
  // only) vs Annotation-edit (delete + send) frames exactly. A fresh draft
  // has no cancel control at all; see spec.md's "corrected during review" note.
  deleteButton.style.display = activeRecord ? "flex" : "none";

  positionPopup(getPopupAnchorRect(el, activeRecord));
  noteTextarea.focus();
  const len = noteTextarea.value.length;
  noteTextarea.setSelectionRange(len, len);
}
```

- Calling `setIssueType(draftState.issueType)` to *render* the initial state (not just to *change* it) is deliberate reuse — it's the one function that already knows how to keep the trigger label in sync with `draftState.issueType`, so the render path and the change path share logic instead of duplicating it.
- `closePopup()` needs no changes — it already just hides `popupEl` and nulls `activeRecord`/`draftElement`; `draftState` gets fully replaced on the next `openPopupFor` call regardless of its value when closed. `deleteButton`'s visibility is likewise fully re-decided on every `openPopupFor` call, so nothing needs resetting on close either.

### Step 7 — Leave the required `// TODO` markers

Per the build sequence's own instruction, every stub point gets one, at the exact line a Feature 6 implementer needs to find:

- On `snapshot: null` in Step 1's record shape: `// TODO: wired in Feature 6 — chrome.tabs.captureVisibleTab + crop, only when includeSnapshot is true`.
- On the send button in edit mode (Step 3/4, wherever it's rendered): `// TODO: wired in Feature 6 — replace with hot-save (debounced autosave + saved-confirmation indicator), no explicit send button in edit mode per the written spec`.
- Near `saveNote`'s new fields: `// TODO: wired in Feature 6 — tag-scoped computed CSS capture per issueType; this feature only stores the chosen issueType/causes/note/includeSnapshot themselves`.

## Test criteria before calling this feature done

- [ ] Clicking an unannotated element opens the popup in add mode: header reads "Annotating `<real selector>`", Issue type trigger shows placeholder "Issue type", all four cause chips visible and unselected, note empty with placeholder "Enter note", Include Snapshot unchecked, send button visually disabled, **no delete button rendered anywhere in the popup**.
- [ ] Send button does nothing (no record created, popup stays open) while Issue type is unselected — click it, confirm no bubble/outline appears.
- [ ] Selecting an Issue type (e.g. "Color") updates the trigger label, closes the dropdown, and visually enables the send button.
- [ ] Selecting "Other" as Issue type leaves all four chips — including Token — visible and independently toggleable, same as any other Issue type. There is no chip-hiding behavior anywhere in this feature.
- [ ] Toggling Token, Component, Component Variant, and State chips (independently, in any combination) visually selects/deselects each one without affecting the others — confirms multi-select, non-exclusive behavior.
- [ ] Clicking Include Snapshot toggles its checked visual state (accent-filled box) on and off.
- [ ] Clicking the note textarea, a chip, or the checkbox while the Issue type dropdown is open closes the dropdown without abandoning any other field's current value.
- [ ] With an Issue type selected, clicking send creates a record (bubble + outline appear, same as Feature 3) and closes the popup.
- [ ] Clicking that bubble again reopens the popup in edit mode: header reads "Annotated `<same selector>`", Issue type trigger pre-filled with the previously chosen type, previously-toggled chips pre-selected, note pre-filled, Include Snapshot reflecting its previous state, **and the delete button now visible** alongside send (per this feature's scope — send stays present in edit mode too).
- [ ] Editing any field in edit mode and clicking send updates the same record (same bubble number, no duplicate created) — confirms `commit()`/`saveNote()` still route through the existing single-record-per-element path.
- [ ] Delete (edit mode only) removes the record, its bubble, and its outline, and renumbers the rest — same mechanics as Feature 3, just gated to edit mode visibility now. There is no way to explicitly cancel an unsaved add-mode draft via a button; clicking a different element or pressing Escape are the only ways to abandon one.
- [ ] Visual spot-check against the Figma screenshot at each of the hex/spacing values in `spec.md`'s table — background, border, chip pill shape, accent color usage (header selector / checkbox / send button all share the same `#77cff4`).
- [ ] Opening the Network tab and repeating all of the above produces zero network requests — same guardrail as every other feature. (The one-time Figma pull used to write this plan is a design-authoring step, not part of the shipped extension's runtime.)
