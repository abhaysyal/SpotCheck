// Anchored dark popup for adding/editing/deleting a free-text note on the
// locked element; a saved note collapses into a small numbered bubble
// (Figma-comment-style) pinned to that element, plus a persistent green
// outline traced around the element itself — stays lit the whole time
// inspection mode is on, not just while it's the currently-selected
// element, so it's unambiguous which exact node a bubble belongs to even
// in deeply nested parent/child structures. Tracks its own on/off
// lifecycle independently of picker.js — listens for the same
// SPOTCHECK_SET_ACTIVE broadcast rather than reading picker.js's internal
// state, per the cross-feature convention (features talk via CustomEvents
// on document, not direct calls into each other's modules).

window.__spotcheck = window.__spotcheck || {};

(function (spotcheck) {
  if (spotcheck.annotations) return;

  let active = false;

  // element -> record. annotationsInOrder holds the *same* record objects
  // (not copies), so updating one found via the WeakMap is automatically
  // reflected in the array too.
  let annotationsByElement = new WeakMap();
  let annotationsInOrder = [];
  let activeRecord = null; // record currently open in the popup, or null
  let draftElement = null; // element the popup is open for but not yet saved

  let hostEl = null;
  let outlinesLayer = null;
  let bubblesLayer = null;
  let popupEl = null;
  let headerEl = null;
  let issueTypeTrigger = null;
  let issueTypeLabel = null;
  let issueTypeMenu = null;
  let snapshotCheckboxEl = null;
  let noteTextarea = null;
  let sendButton = null;
  let deleteButton = null;
  let savedIndicatorEl = null; // Feature 6 — edit mode's "✓ Saved" flash, replaces the send button there
  let numberBadgeEl = null; // this update — edit-mode-only numbered badge at the popup's corner, per Figma node 30:145
  let rafId = null;

  // Feature 5 (UI Makeover) — the popup's own form state, live while it's
  // open, committed onto a record only when send is actually clicked. Reset
  // fresh on every openPopupFor call (add mode: all blank; edit mode:
  // seeded from the existing record). `snapshot` (Feature 6) holds the
  // already-captured data URL, if any — captured once when the checkbox is
  // checked, not at save time, see spec.md. `causes` (the old, separate
  // multi-select chip row) is gone as of this update — the Figma file
  // merged it into the single Issue type selector below (node 24:85), so
  // there's nothing left for a second field to hold.
  let draftState = { issueType: null, includeSnapshot: false, snapshot: null };

  let hotSaveTimer = null; // Feature 6 — debounced autosave for editing an existing annotation
  const HOT_SAVE_DEBOUNCE_MS = 500;

  // Single-select, one flat list grouped into two labeled sections — merged
  // from what used to be two separate controls (an Issue type dropdown and
  // an independent "What's wrong?" chip row) per Figma node 24:85. "Token"
  // (one of the old chips) is dropped entirely; it has no home in the new
  // list and isn't in the Figma file. "State" is renamed "State / Interaction"
  // to match the file exactly. `group` drives which items get a group-label
  // row and where the one divider lands when the menu is built.
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

  // --- Feature 6 (Annotation Capture & Edit) tag-scoped style capture -----

  // Mirrors capture.js's own FLEX_PROPERTIES/GRID_PROPERTIES exactly — kept
  // as a separate copy rather than exported from Feature 2, see spec.md.
  // Keep these two in sync with capture.js by hand if either ever changes.
  const LAYOUT_BASE_PROPERTIES = ["display", "position", "top", "right", "bottom", "left", "zIndex"];
  const LAYOUT_FLEX_PROPERTIES = ["flexDirection", "justifyContent", "alignItems", "flexWrap", "gap"];
  const LAYOUT_GRID_PROPERTIES = ["gridTemplateColumns", "gridTemplateRows", "gap"];

  const TAG_SCOPED_PROPERTIES = {
    color: ["color", "backgroundColor", "borderColor"],
    typography: ["fontFamily", "fontSize", "fontWeight", "lineHeight", "letterSpacing"],
    spacing: [
      "marginTop", "marginRight", "marginBottom", "marginLeft",
      "paddingTop", "paddingRight", "paddingBottom", "paddingLeft",
      "gap", "width", "height",
    ],
    // layout and other are handled specially in captureTagScopedStyles, not via a flat list
  };

  // Recomputed fresh at every save (send or hot-save), never cached from
  // when the Issue type was first picked — see spec.md.
  function captureTagScopedStyles(el, issueType) {
    const computed = window.getComputedStyle(el);

    if (issueType === "other") {
      const result = {};
      for (let i = 0; i < computed.length; i++) {
        const prop = computed[i];
        result[prop] = computed.getPropertyValue(prop);
      }
      return result;
    }

    if (issueType === "layout") {
      const result = {};
      for (const prop of LAYOUT_BASE_PROPERTIES) result[prop] = computed[prop];
      if (computed.display.includes("flex")) for (const prop of LAYOUT_FLEX_PROPERTIES) result[prop] = computed[prop];
      if (computed.display.includes("grid")) for (const prop of LAYOUT_GRID_PROPERTIES) result[prop] = computed[prop];
      return result;
    }

    // Falls through here for "component" / "component-variant" /
    // "state-interaction" too, not just an unset issueType — confirmed with
    // the human reviewer when the Issue type list merged with the old cause
    // chips: those three are about identity/state, not CSS properties, so
    // they deliberately get no computed-style capture at all (null), same
    // as an unset issueType (which shouldn't be reachable at save time
    // regardless — the mandatory-fields gate requires a selection).
    const props = TAG_SCOPED_PROPERTIES[issueType];
    if (!props) return null;
    const result = {};
    for (const prop of props) result[prop] = computed[prop];
    return result;
  }

  // --- shadow host + markup -------------------------------------------

  function ensureHost() {
    if (hostEl) return;

    hostEl = document.createElement("div");
    hostEl.style.all = "initial";
    hostEl.style.position = "fixed";
    hostEl.style.top = "0";
    hostEl.style.left = "0";
    hostEl.style.width = "0";
    hostEl.style.height = "0";
    hostEl.style.zIndex = "2147483647";
    document.documentElement.appendChild(hostEl);
    spotcheck.annotations.hostEl = hostEl;
    spotcheck.uiHosts.add(hostEl);

    const shadowRoot = hostEl.attachShadow({ mode: "open" });

    const style = document.createElement("style");
    style.textContent = `
      .outline {
        position: fixed;
        box-sizing: border-box;
        border: 2px solid #22c55e;
        border-radius: 2px;
        pointer-events: none;
        z-index: 2147483646;
      }
      .outline.hovering {
        /* Same fill as Feature 1's locked highlight — reinforces "this
           already has feedback" while the cursor is over it. Transient: only
           applied while actually hovering, unlike the outline itself (and
           its border), which stays permanently once an annotation exists. */
        background: rgba(34, 197, 94, 0.08);
      }
      .bubble {
        position: fixed;
        width: 22px;
        height: 22px;
        border-radius: 50%;
        background: #000;
        color: #fff;
        font-size: 11px;
        display: flex;
        align-items: center;
        justify-content: center;
        cursor: pointer;
        pointer-events: auto;
        box-shadow: 0 0 0 2px rgba(255, 255, 255, 0.15);
        z-index: 2147483647;
      }
      /* --- Feature 5 (UI Makeover) — popup redesign; the .outline/.bubble
         rules above are page-level annotation markers and are unaffected,
         see feature-5-ui-makeover/spec.md. Values below come straight from
         a Figma pull, documented in that same spec.md. --- */
      .popup {
        position: fixed;
        background: #000000;
        color: #f3f4f6;
        border: 1px solid #313131;
        border-radius: 8px;
        padding: 4px 12px 12px;
        box-sizing: border-box;
        display: flex;
        flex-direction: column;
        gap: 10px;
        min-width: 260px;
        max-width: 380px;
        box-shadow: 0 8px 24px rgba(0, 0, 0, 0.4);
        z-index: 2147483647;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Inter", sans-serif;
      }
      /* No longer nowrap: a long selector (e.g. a deep CSS.escape'd id path)
         would otherwise overflow past the new 380px max-width instead of
         wrapping inside it. */
      .popup-header { font-size: 12px; line-height: 22px; overflow-wrap: break-word; }
      .popup-header .muted { color: #7b7b7b; }
      .popup-header .selector { color: #77cff4; }
      .popup-body { display: flex; flex-direction: column; gap: 12px; }
      .issue-type { position: relative; }
      .issue-type-trigger {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        background: #2c2c2c;
        color: #cecece;
        font-size: 14px;
        border-radius: 4px;
        padding: 4px 8px;
        cursor: pointer;
        width: fit-content;
      }
      .issue-type-chevron { font-size: 10px; color: #cecece; }
      /* Sizing below matches Figma node 24:85 exactly (32px items, 14px
         text, 4px container padding) — this reverts an earlier ad-hoc
         "make it tighter" pass from before this node existed as an
         authoritative reference. Matching the actual file now wins. */
      .issue-type-menu {
        position: absolute;
        top: calc(100% + 4px);
        left: 0;
        display: none;
        flex-direction: column;
        background: #262626;
        border: 1px solid #545454;
        border-radius: 4px;
        padding: 4px;
        min-width: 160px;
        z-index: 2147483647;
      }
      .issue-type-menu.open { display: flex; }
      .issue-type-item {
        height: 32px;
        display: flex;
        align-items: center;
        padding: 5px 12px;
        border-radius: 4px;
        color: rgba(255, 255, 255, 0.88);
        font-size: 14px;
        cursor: pointer;
      }
      .issue-type-item:hover { background: rgba(9, 153, 214, 0.15); }
      /* Group labels ("Property"/"Structure") and the divider between them
         — structural only, never clickable, no hover state (see spec note
         in the markup below). */
      .issue-type-group-label {
        height: 25px;
        display: flex;
        align-items: center;
        padding: 6px 12px;
        color: rgba(255, 255, 255, 0.65);
        font-size: 12px;
      }
      .issue-type-divider {
        height: 1px;
        background: #4b4b4b;
        margin: 0;
      }
      .popup-note {
        width: 100%;
        height: 92px;
        background: transparent;
        color: #c4c4c4;
        border: 1px solid #313131;
        border-radius: 4px;
        resize: vertical;
        box-sizing: border-box;
        padding: 4px 8px;
        font: inherit;
        font-size: 14px;
        line-height: 24px;
      }
      .popup-note:focus {
        /* Browser default focus styling (a system-colored outline ring,
           plus on some platforms a secondary white inset ring) otherwise
           shows alongside the design's own accent color — two different
           rings competing. Replace both with a single, consistent ring in
           the same accent used everywhere else in this popup. */
        outline: none;
        border-color: #77cff4;
        box-shadow: 0 0 0 1px #77cff4;
      }
      .popup-footer {
        display: flex;
        align-items: center;
        justify-content: space-between;
      }
      .snapshot-checkbox { display: flex; align-items: center; gap: 8px; cursor: pointer; }
      .snapshot-checkbox .box {
        width: 16px;
        height: 16px;
        border-radius: 4px;
        border: 1px solid #545454;
        box-sizing: border-box;
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 11px;
        color: #000000;
      }
      .snapshot-checkbox .box::before { content: "✓"; opacity: 0; line-height: 1; }
      .snapshot-checkbox.checked .box { background: #77cff4; border-color: #77cff4; }
      .snapshot-checkbox.checked .box::before { opacity: 1; }
      .snapshot-checkbox .label { color: #cecece; font-size: 14px; }
      .popup-actions {
        display: flex;
        justify-content: flex-end;
        gap: 10px;
      }
      .popup-send,
      .popup-delete {
        width: 38px;
        height: 36px;
        border-radius: 4px;
        border: none;
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 13px;
        pointer-events: auto;
      }
      .popup-delete { background: #2c2c2c; color: #f3f4f6; }
      .popup-delete:hover { background: #3a1d1d; }
      .popup-send {
        background: #77cff4; /* same accent as the header selector text and the checked checkbox — see spec.md */
        color: #0b0b0c;
      }
      .popup-send:hover { background: #5fb9e0; }
      .popup-send.disabled { opacity: 0.4; cursor: not-allowed; }
      .saved-indicator {
        display: none;
        align-items: center;
        color: #77cff4;
        font-size: 12px;
        padding: 0 4px;
      }
      .saved-indicator.visible { display: flex; }
      /* Edit-mode-only numbered badge at the popup's corner — Figma node
         30:145. Fill (#77CFF4) and text color (black) pulled directly from
         that node's own SVG/text fill data, not approximated from a
         screenshot. Centered on the corner (half overlapping outside the
         card) — the standard notification-badge convention; the node's own
         canvas placement is a separate, floating preview swatch elsewhere
         in the file, not a literal offset to copy. */
      .number-badge {
        display: none;
        position: absolute;
        top: -13px;
        left: -13px;
        width: 26px;
        height: 26px;
        border-radius: 50%;
        background: #77cff4;
        color: #000000;
        align-items: center;
        justify-content: center;
        font-family: "Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        font-size: 14px;
        font-weight: 600;
      }
      .number-badge.visible { display: flex; }
    `;
    shadowRoot.appendChild(style);

    // Outlines layer appended before bubbles, so bubbles stack visually on
    // top of outlines at equal z-index (DOM order breaks the tie).
    outlinesLayer = document.createElement("div");
    outlinesLayer.className = "outlines-layer";
    shadowRoot.appendChild(outlinesLayer);

    bubblesLayer = document.createElement("div");
    bubblesLayer.className = "bubbles-layer";
    shadowRoot.appendChild(bubblesLayer);

    popupEl = document.createElement("div");
    popupEl.className = "popup";
    popupEl.style.display = "none";

    // Edit-mode-only numbered badge at the popup's own corner (Figma node
    // 30:145) — appended directly to popupEl, not header/body/footer, so it
    // can be absolutely positioned relative to the whole card regardless of
    // internal layout. Visibility + number text are set in openPopupFor.
    numberBadgeEl = document.createElement("div");
    numberBadgeEl.className = "number-badge";
    popupEl.appendChild(numberBadgeEl);

    // --- header: "Annotating "/"Annotated " + selector, filled per-open in
    // openPopupFor -----------------------------------------------------
    headerEl = document.createElement("div");
    headerEl.className = "popup-header";
    const mutedSpan = document.createElement("span");
    mutedSpan.className = "muted";
    const selectorSpan = document.createElement("span");
    selectorSpan.className = "selector";
    headerEl.appendChild(mutedSpan);
    headerEl.appendChild(document.createTextNode(" "));
    headerEl.appendChild(selectorSpan);
    popupEl.appendChild(headerEl);

    const bodyEl = document.createElement("div");
    bodyEl.className = "popup-body";

    // --- Issue type: single-select, collapsed by default -------------------
    const issueTypeWrap = document.createElement("div");
    issueTypeWrap.className = "issue-type";

    issueTypeTrigger = document.createElement("div");
    issueTypeTrigger.className = "issue-type-trigger";
    issueTypeLabel = document.createElement("span");
    issueTypeLabel.textContent = "Issue type";
    const chevron = document.createElement("span");
    chevron.className = "issue-type-chevron";
    chevron.textContent = "⌄"; // ⌄ — text glyph, no icon asset, same pattern as 🗑/↑ elsewhere in this file
    issueTypeTrigger.appendChild(issueTypeLabel);
    issueTypeTrigger.appendChild(chevron);
    issueTypeTrigger.addEventListener("click", () => {
      issueTypeMenu.classList.toggle("open");
    });

    // Single flat list, grouped into two labeled, non-interactive sections
    // with one divider between them — merged from the old separate Issue
    // type dropdown + cause-chips row per Figma node 24:85. Group labels
    // ("Property"/"Structure") and the divider are plain, unclickable rows:
    // no click listener attached, matching Figma's own visual treatment
    // (muted text, no hover background) for exactly those two rows.
    issueTypeMenu = document.createElement("div");
    issueTypeMenu.className = "issue-type-menu";
    let previousGroup = null;
    TYPE_OPTIONS.forEach((type) => {
      if (type.group !== previousGroup) {
        if (previousGroup !== null) {
          const divider = document.createElement("div");
          divider.className = "issue-type-divider";
          issueTypeMenu.appendChild(divider);
        }
        const groupLabel = document.createElement("div");
        groupLabel.className = "issue-type-group-label";
        groupLabel.textContent = type.group;
        issueTypeMenu.appendChild(groupLabel);
        previousGroup = type.group;
      }
      const item = document.createElement("div");
      item.className = "issue-type-item";
      item.textContent = type.label;
      item.addEventListener("click", () => setIssueType(type.id));
      issueTypeMenu.appendChild(item);
    });

    issueTypeWrap.appendChild(issueTypeTrigger);
    issueTypeWrap.appendChild(issueTypeMenu);
    bodyEl.appendChild(issueTypeWrap);

    // --- note (mechanically unchanged from Feature 3 — Enter/Shift+Enter
    // wiring stays below; only the placeholder copy changes) ----------------
    noteTextarea = document.createElement("textarea");
    noteTextarea.className = "popup-note";
    noteTextarea.placeholder = "Enter note";
    bodyEl.appendChild(noteTextarea);

    popupEl.appendChild(bodyEl);

    // --- footer: Include Snapshot checkbox + delete/send actions -----------
    const footerEl = document.createElement("div");
    footerEl.className = "popup-footer";

    snapshotCheckboxEl = document.createElement("div");
    snapshotCheckboxEl.className = "snapshot-checkbox";
    const checkboxBox = document.createElement("div");
    checkboxBox.className = "box";
    const checkboxLabel = document.createElement("span");
    checkboxLabel.className = "label";
    checkboxLabel.textContent = "Include Snapshot";
    snapshotCheckboxEl.appendChild(checkboxBox);
    snapshotCheckboxEl.appendChild(checkboxLabel);
    snapshotCheckboxEl.addEventListener("click", toggleSnapshotCheckbox);
    footerEl.appendChild(snapshotCheckboxEl);

    const actions = document.createElement("div");
    actions.className = "popup-actions";

    deleteButton = document.createElement("button");
    deleteButton.className = "popup-delete";
    deleteButton.setAttribute("aria-label", "Delete annotation");
    // Inline SVG (Tabler "trash"), path data pulled directly from the Figma
    // file's own asset export — not an emoji substitute. currentColor so
    // the button's own `color` CSS controls the icon's color, no separate
    // fill to keep in sync. No <img>/remote src — this is static markup
    // baked into the extension at authoring time, not fetched at runtime.
    deleteButton.innerHTML =
      '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">' +
      '<path d="M14.25 4C14.25 3.9337 14.2236 3.87013 14.1768 3.82324C14.1299 3.77636 14.0663 3.75 14 3.75H10C9.9337 3.75 9.87013 3.77636 9.82324 3.82324C9.77636 3.87013 9.75 3.9337 9.75 4V6.25H14.25V4ZM6.74707 18.9375C6.7488 18.9582 6.75 18.9792 6.75 19C6.75 19.3315 6.88179 19.6494 7.11621 19.8838C7.35063 20.1182 7.66848 20.25 8 20.25H16C16.3315 20.25 16.6494 20.1182 16.8838 19.8838C17.1182 19.6494 17.25 19.3315 17.25 19C17.25 18.9792 17.2512 18.9582 17.2529 18.9375L18.1855 7.75H5.81445L6.74707 18.9375ZM9.25 17V11C9.25 10.5858 9.58579 10.25 10 10.25C10.4142 10.25 10.75 10.5858 10.75 11V17C10.75 17.4142 10.4142 17.75 10 17.75C9.58579 17.75 9.25 17.4142 9.25 17ZM13.25 17V11C13.25 10.5858 13.5858 10.25 14 10.25C14.4142 10.25 14.75 10.5858 14.75 11V17C14.75 17.4142 14.4142 17.75 14 17.75C13.5858 17.75 13.25 17.4142 13.25 17ZM15.75 6.25H20C20.4142 6.25 20.75 6.58579 20.75 7C20.75 7.41421 20.4142 7.75 20 7.75H19.6895L18.7471 19.0625C18.731 19.7692 18.4453 20.4434 17.9443 20.9443C17.4286 21.4601 16.7293 21.75 16 21.75H8C7.27065 21.75 6.57139 21.4601 6.05566 20.9443C5.5547 20.4434 5.26899 19.7692 5.25293 19.0625L4.31055 7.75H4C3.58579 7.75 3.25 7.41421 3.25 7C3.25 6.58579 3.58579 6.25 4 6.25H8.25V4C8.25 3.53587 8.43451 3.09088 8.7627 2.7627C9.09088 2.43451 9.53587 2.25 10 2.25H14C14.4641 2.25 14.9091 2.43451 15.2373 2.7627C15.5655 3.09088 15.75 3.53587 15.75 4V6.25Z" fill="currentColor"/>' +
      "</svg>";
    // Only shown in edit mode — see openPopupFor. Figma's Annotation-add
    // frame has no delete/cancel control at all; Annotation-edit has
    // delete + send. Corrected during spec review; see spec.md.
    deleteButton.style.display = "none";
    actions.appendChild(deleteButton);

    sendButton = document.createElement("button");
    sendButton.className = "popup-send";
    sendButton.setAttribute("aria-label", "Save note");
    // Inline SVG (Tabler "arrow-up"), same sourcing/rationale as the delete
    // icon above.
    sendButton.innerHTML =
      '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">' +
      '<path d="M11 19V7.41406L6.70703 11.707C6.31651 12.0976 5.68349 12.0976 5.29297 11.707C4.90244 11.3165 4.90244 10.6835 5.29297 10.293L11.293 4.29297L11.3691 4.22461C11.7619 3.90426 12.3409 3.92685 12.707 4.29297L18.707 10.293C19.0976 10.6835 19.0976 11.3165 18.707 11.707C18.3165 12.0976 17.6835 12.0976 17.293 11.707L13 7.41406V19C13 19.5523 12.5523 20 12 20C11.4477 20 11 19.5523 11 19Z" fill="currentColor"/>' +
      "</svg>";
    // Hidden in edit mode (see openPopupFor) — replaced by hot-save + the
    // saved-indicator below, per Feature 5's original written spec.
    actions.appendChild(sendButton);

    savedIndicatorEl = document.createElement("span");
    savedIndicatorEl.className = "saved-indicator";
    savedIndicatorEl.textContent = "✓ Saved";
    actions.appendChild(savedIndicatorEl);

    footerEl.appendChild(actions);
    popupEl.appendChild(footerEl);
    shadowRoot.appendChild(popupEl);

    sendButton.addEventListener("click", onSendClick);
    deleteButton.addEventListener("click", onDeleteClick);
    noteTextarea.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        if (activeRecord) {
          // Edit mode has no send/commit step anymore — Enter just forces
          // the pending hot-save to happen immediately instead of waiting
          // out the debounce, without closing the popup the way commit() would.
          clearTimeout(hotSaveTimer);
          performHotSave();
        } else {
          // Routed through onSendClick, not a direct commit() — Enter must
          // respect the same mandatory-fields gate the send button does,
          // rather than bypassing it (a real, separate gap: this line called
          // commit() unconditionally even before this feature added the
          // note/cause requirement, quietly ignoring the Issue-type gate too).
          onSendClick();
        }
      }
    });
    // Note text is part of the mandatory-fields gate (Issue type AND
    // (a chip OR a note)) — typing/deleting text can flip that condition,
    // so the send button's enabled state has to react live, not just on
    // open/issueType-change/chip-toggle.
    noteTextarea.addEventListener("input", () => {
      updateSendEnabled();
      if (activeRecord) scheduleHotSave();
    });
  }

  // --- Feature 5 (UI Makeover) form-field wiring --------------------------

  // `silent` (Feature 6): openPopupFor reuses this same function to render
  // the initial state of an existing record on open — without it, opening
  // a saved annotation would immediately schedule a hot-save for a value
  // that never actually changed.
  function setIssueType(id, options) {
    draftState.issueType = id;
    issueTypeLabel.textContent = id ? TYPE_OPTIONS.find((t) => t.id === id).label : "Issue type";
    issueTypeMenu.classList.remove("open");
    updateSendEnabled();
    if (activeRecord && !(options && options.silent)) scheduleHotSave();
  }

  // Revised again with this update: now that the old cause chips are gone
  // (merged into the single Issue type selector above), a selection alone
  // is the whole requirement — note is fully optional, same as the original
  // pre-chips Feature 5 design. Factored out so performHotSave (Feature 6)
  // can reuse the exact same condition instead of duplicating it.
  function sendGateDisabled() {
    return draftState.issueType === null;
  }
  function updateSendEnabled() {
    sendButton.classList.toggle("disabled", sendGateDisabled());
  }

  // Checks the same visual/logical gate updateSendEnabled just set, rather
  // than re-deriving the requirement here too — one place decides what
  // "enabled" means, this just respects it.
  function onSendClick() {
    if (sendButton.classList.contains("disabled")) return;
    commit();
  }

  // --- Feature 6 (Annotation Capture & Edit): hot-save (edit mode only) --

  function scheduleHotSave() {
    if (!activeRecord) return; // add mode has no hot-save — explicit send only, see spec.md
    clearTimeout(hotSaveTimer);
    hotSaveTimer = setTimeout(performHotSave, HOT_SAVE_DEBOUNCE_MS);
  }

  function performHotSave() {
    // Mandatory fields no longer satisfied (e.g. the only chip was just
    // removed and the note is empty) — skip silently rather than persist an
    // annotation that no longer meets the extension's own minimum bar. The
    // record keeps its last valid saved state until the gate is met again.
    if (sendGateDisabled()) return;
    saveNote(activeRecord.element, noteTextarea.value);
    showSavedIndicator();
    document.dispatchEvent(
      new CustomEvent("spotcheck:annotation-saved", {
        detail: {
          number: activeRecord.number,
          note: activeRecord.note,
          selector: activeRecord.selector,
          element: activeRecord.element,
          allAnnotations: buildSnapshot(),
        },
      })
    );
  }

  function showSavedIndicator() {
    savedIndicatorEl.classList.add("visible");
    clearTimeout(showSavedIndicator._timer);
    showSavedIndicator._timer = setTimeout(() => savedIndicatorEl.classList.remove("visible"), 1500);
  }

  // --- Feature 6: real on-demand snapshot capture -------------------------

  // Captured once, at the moment the checkbox is checked — not deferred to
  // send/hot-save time. See spec.md for why: edit mode has no "send" moment
  // to hang capture off of, and re-capturing on every debounced hot-save
  // while someone is mid-typing would visibly flicker the popup several
  // times a minute. Unchecking drops the image; rechecking re-captures.
  async function toggleSnapshotCheckbox() {
    draftState.includeSnapshot = !draftState.includeSnapshot;
    snapshotCheckboxEl.classList.toggle("checked", draftState.includeSnapshot);

    if (!draftState.includeSnapshot) {
      draftState.snapshot = null;
      if (activeRecord) scheduleHotSave();
      return;
    }

    const el = activeRecord ? activeRecord.element : draftElement;
    try {
      draftState.snapshot = await captureAndCropSnapshot(el);
    } catch (err) {
      // Fails silently — an expired activeTab grant, hitting captureVisibleTab's
      // own rate limit, etc. The rest of the annotation is unaffected.
      console.warn("SpotCheck: snapshot capture failed", err);
      draftState.snapshot = null;
    }
    if (activeRecord) scheduleHotSave(); // capturing a snapshot on an existing annotation is itself an edit
  }

  async function captureAndCropSnapshot(el) {
    const wasVisible = popupEl.style.display !== "none";
    if (wasVisible) popupEl.style.display = "none";
    await new Promise((resolve) => requestAnimationFrame(resolve)); // let the hide actually paint before capturing

    let dataUrl;
    try {
      const response = await chrome.runtime.sendMessage({ type: "SPOTCHECK_CAPTURE_VISIBLE_TAB" });
      if (!response || response.error) throw new Error((response && response.error) || "no response");
      dataUrl = response.dataUrl;
    } finally {
      if (wasVisible) popupEl.style.display = "flex";
    }

    const rect = el.getBoundingClientRect();
    const scale = window.devicePixelRatio || 1;
    const img = await new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = reject;
      image.src = dataUrl;
    });

    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(rect.width * scale));
    canvas.height = Math.max(1, Math.round(rect.height * scale));
    const ctx = canvas.getContext("2d");
    ctx.drawImage(
      img,
      rect.left * scale, rect.top * scale, canvas.width, canvas.height,
      0, 0, canvas.width, canvas.height
    );
    return canvas.toDataURL("image/png");
  }

  // Closes the Issue type dropdown on ANY click outside it — a chip, the
  // textarea, the checkbox, another SpotCheck UI element entirely (e.g.
  // Feature 4's export button), or the host page itself. A document-level
  // listener, not one scoped to popupEl: a click on the export button is
  // routed past picker.js's own lock logic (it's a registered uiHost) but
  // nothing in export.js knows or cares about this dropdown, so a listener
  // confined to popupEl would never see that click at all. A click that
  // picker.js *does* treat as a fresh page-element selection already closes
  // this dropdown via the normal openPopupFor→setIssueType reset path
  // (picker.js's own stopPropagation would block this listener from ever
  // firing for that case anyway) — this handler exists specifically to
  // cover every click picker.js lets through untouched.
  function onDocumentClickForDropdown(e) {
    if (!issueTypeMenu || !issueTypeMenu.classList.contains("open")) return;
    // e.target is retargeted to the shadow host on a listener outside the
    // shadow tree (standard Shadow DOM event retargeting) — checking it
    // directly here made this always look like "click was outside," closing
    // the menu on the very same click that had just opened it. composedPath()
    // returns the real, un-retargeted path, so it actually contains
    // issueTypeTrigger/issueTypeMenu when the click really did land on them.
    const path = e.composedPath();
    if (path.includes(issueTypeTrigger) || path.includes(issueTypeMenu)) return;
    issueTypeMenu.classList.remove("open");
  }

  // --- annotation store --------------------------------------------------

  // element -> { selector, styles, component } — the *latest* capture for
  // any selected element, regardless of whether it ever becomes an
  // annotation. Exists because spotcheck:element-captured fires immediately
  // on selection, while a record isn't created until commit() — a separate,
  // later user action (type a note, click send), not "the same click." A
  // listener trying to write straight onto annotationsByElement would find
  // nothing there yet for a brand-new annotation and silently drop the
  // capture. This cache is always populated on selection; saveNote reads
  // from it once, at record-creation time, instead of waiting on a second
  // capture event that was never going to arrive for that specific element.
  let latestCaptureByElement = new WeakMap();

  function getExistingRecord(el) {
    return annotationsByElement.get(el) || null;
  }

  function saveNote(el, text) {
    const trimmed = text.trim();
    // No independent "note can't be empty" guard here anymore — that was
    // Feature 3's original rule, back when note was the only field and the
    // only thing send could possibly submit. Feature 5's mandatory-fields
    // gate (Issue type AND (a chip OR a note) — see updateSendEnabled) is
    // now the single source of truth for "is this submission valid," and
    // both entry points that reach here (the send button and Enter) already
    // route through that gate via onSendClick before ever calling commit().
    // A leftover guard here would silently swallow the exact case that gate
    // is meant to allow: Issue type + a chip, with no note at all — the
    // send button would look enabled and clicking it would just close the
    // popup with nothing saved, no error, no bubble, work quietly lost.

    let record = annotationsByElement.get(el);

    if (!record) {
      const cached = latestCaptureByElement.get(el);
      record = {
        number: annotationsInOrder.length + 1,
        element: el,
        selector: cached ? cached.selector : null,
        styles: cached ? cached.styles : null,
        component: cached ? cached.component : null,
        id: crypto.randomUUID(), // Feature 6 — stable identity for the persisted queue, independent of the DOM element
        status: "open", // Feature 6 — "open" | "agent-resolved" | "verified"; only a future Feature 7 tool ever advances this
        resolutionSummary: null, // Feature 6 — set only by that future tool
        history: [], // Feature 6 — append-only reopen log, see below
        bubbleEl: null, // set by renderBubble() — carried on the record so
        // deleting/renumbering never needs a separate number -> element lookup
        outlineEl: null, // set by renderOutline() — persistent, stays lit as long as the annotation exists
        createdAt: Date.now(),
      };
      annotationsByElement.set(el, record);
      annotationsInOrder.push(record);
    }

    // Auto-reopen on edit (Feature 6) — before anything else about this
    // save is applied. A fresh record is always already "open" so this is a
    // no-op for the create path; it only fires for an edit to a previously
    // agent-resolved/verified annotation.
    if (record.status !== "open") {
      record.history.push(`previously resolved: ${record.resolutionSummary}, reopened after edit`);
      record.resolutionSummary = null;
      record.status = "open";
    }

    record.note = trimmed;
    // Feature 5 fields — every send (add or edit) re-copies the popup's
    // current form state onto the record, not just note/updatedAt. No more
    // `causes` field as of this update — the old multi-select chip row is
    // gone, merged into the single issueType selection above.
    record.issueType = draftState.issueType;
    record.includeSnapshot = draftState.includeSnapshot;
    record.snapshot = draftState.snapshot; // Feature 6 — already captured (or null), see toggleSnapshotCheckbox
    record.tagScopedStyles = captureTagScopedStyles(el, draftState.issueType); // Feature 6 — fresh every save, never cached
    record.updatedAt = Date.now();

    const serializable = { ...record };
    delete serializable.element;
    delete serializable.bubbleEl;
    delete serializable.outlineEl;
    spotcheck.queue.upsert(serializable).catch((err) => console.warn("SpotCheck: queue upsert failed", err));

    return record;
  }

  function deleteAnnotation(record) {
    annotationsByElement.delete(record.element);
    const idx = annotationsInOrder.indexOf(record);
    if (idx !== -1) annotationsInOrder.splice(idx, 1);
    if (record.bubbleEl) record.bubbleEl.remove();
    if (record.outlineEl) record.outlineEl.remove();
    if (hoveredAnnotationRecord === record) hoveredAnnotationRecord = null; // its outline is gone, nothing left to un-hover
    renumberAll();
    positionAllBubbles(); // let any bubble that had cascaded away reflow back toward its ideal spot
    spotcheck.queue.remove(record.id).catch((err) => console.warn("SpotCheck: queue remove failed", err));
    document.dispatchEvent(
      new CustomEvent("spotcheck:annotation-deleted", {
        detail: { number: record.number, element: record.element, allAnnotations: buildSnapshot() },
      })
    );
  }

  function renumberAll() {
    annotationsInOrder.forEach((record, i) => {
      record.number = i + 1;
      if (record.bubbleEl) record.bubbleEl.textContent = String(record.number);
    });
    // The corner badge (this update) shows activeRecord's number independently
    // of the page bubble — keep it in sync too if a delete elsewhere just
    // shifted the number of the annotation currently open for editing.
    if (activeRecord) numberBadgeEl.textContent = String(activeRecord.number);
  }

  // Numbers are positional (renumberAll above), so a consumer that caches
  // per-item data from individual saved/deleted events would show a stale
  // number for anything after a deletion — that record's own number changed
  // but it never got its own event. Dispatched fresh alongside both events
  // below so a consumer (Feature 4) can just fully replace its local copy
  // every time, never patch it incrementally.
  function buildSnapshot() {
    return annotationsInOrder.map((r) => ({
      number: r.number,
      note: r.note,
      selector: r.selector,
      styles: r.styles,
      component: r.component,
      element: r.element,
    }));
  }

  // --- positioning (outlines + bubbles + popup), continuous rAF loop -----

  // Not event-triggered (scroll/resize) — a continuous loop instead, so
  // annotations never lag a scroll or drift out of sync with their element.
  // Reacting to scroll/resize events has an inherent gap: the browser
  // paints the new scroll offset on its own compositor thread well before a
  // 'scroll' event even reaches this content script's main-thread listener,
  // so anything positioned only in response to that event is always at
  // least one step behind what's on screen. Reading live rects every single
  // animation frame, regardless of what caused something to move, is the
  // closest a content script can get to "stuck to the element" without
  // modifying the page's own DOM (which every guardrail in this project
  // rules out) — this is the same reasoning applied to overlay.js's own
  // transient highlight box, see that file.
  let repositionLoopActive = false;

  function repositionLoop() {
    if (!repositionLoopActive) return;
    repositionAll();
    rafId = requestAnimationFrame(repositionLoop);
  }

  function repositionAll() {
    positionAllBubbles();
    for (const record of annotationsInOrder) positionOutline(record);
    if (activeRecord || draftElement) positionPopup(getPopupAnchorRect(activeRecord ? activeRecord.element : draftElement, activeRecord));
  }

  // The popup must anchor to the *bubble's actual current position* when
  // reopening an existing annotation, not to the underlying element's own
  // rect — positionAllBubbles cascades a bubble away from its "ideal"
  // corner-anchored spot whenever it would otherwise overlap another one, so
  // the two can genuinely be in different places. Anchoring to the element
  // instead of the bubble was a real bug: the popup appearing "in the wrong
  // place" (and, incidentally, looking like it was overlapping a different
  // bubble entirely) when reopening via a cascaded bubble. A fresh draft
  // with no existing record has no bubble yet, so it still falls back to
  // the element's own rect — there's nothing else to anchor to.
  function getPopupAnchorRect(el, record) {
    if (record && record.bubbleEl) return record.bubbleEl.getBoundingClientRect();
    return el.getBoundingClientRect();
  }

  function positionOutline(record) {
    if (!record.outlineEl) return;
    if (!document.body.contains(record.element)) {
      record.outlineEl.style.display = "none"; // annotated element no longer in the DOM — known v1 limitation
      return;
    }
    // Traces the element's actual bounding box — deliberately NOT clamped to
    // the viewport the way the bubble is: this is meant to outline exactly
    // where the element is, including partially off-screen, not stay usable
    // as a fixed-size clickable marker the way the bubble needs to.
    const rect = record.element.getBoundingClientRect();
    record.outlineEl.style.display = "block";
    record.outlineEl.style.left = `${rect.left}px`;
    record.outlineEl.style.top = `${rect.top}px`;
    record.outlineEl.style.width = `${rect.width}px`;
    record.outlineEl.style.height = `${rect.height}px`;
  }

  const BUBBLE_SIZE = 22;
  const BUBBLE_MARGIN = 4;
  const BUBBLE_GAP = 4; // minimum clearance enforced between two bubbles' edges

  // Positions every bubble together as one pass, not independently — nested
  // parent/child elements very often share the same (or a near-identical)
  // top-left corner, which would otherwise stack their bubbles exactly on
  // top of each other: visually indistinguishable, and whichever one ends
  // up underneath becomes unclickable. A colliding bubble cascades straight
  // down in fixed steps until it finds a free spot, wrapping into a new
  // column if it runs out of vertical room. Processed in annotationsInOrder
  // (creation order, which also matches numbering) so earlier annotations
  // keep their ideal corner-anchored spot and later ones cascade away from
  // it — a stable, deterministic tie-break, not an arbitrary one.
  function positionAllBubbles() {
    const placed = [];

    for (const record of annotationsInOrder) {
      if (!record.bubbleEl) continue;
      if (!document.body.contains(record.element)) {
        record.bubbleEl.style.display = "none"; // annotated element no longer in the DOM — known v1 limitation
        continue;
      }

      const rect = record.element.getBoundingClientRect();
      let left = Math.min(Math.max(BUBBLE_MARGIN, rect.left - 10), window.innerWidth - BUBBLE_SIZE - BUBBLE_MARGIN);
      let top = Math.min(Math.max(BUBBLE_MARGIN, rect.top - 10), window.innerHeight - BUBBLE_SIZE - BUBBLE_MARGIN);

      let attempts = 0;
      while (
        attempts < 200 &&
        placed.some(
          (p) => Math.abs(p.left - left) < BUBBLE_SIZE + BUBBLE_GAP && Math.abs(p.top - top) < BUBBLE_SIZE + BUBBLE_GAP
        )
      ) {
        top += BUBBLE_SIZE + BUBBLE_GAP;
        if (top > window.innerHeight - BUBBLE_SIZE - BUBBLE_MARGIN) {
          top = BUBBLE_MARGIN; // ran out of vertical room — wrap to a new column
          // Re-clamped, same as the initial left computation above — without
          // this, enough columns of collisions (many annotations sharing a
          // corner) push left past the viewport's right edge with nothing
          // to stop it, leaving that bubble permanently off-screen and
          // unreachable even though repositionAll runs every frame.
          left = Math.min(left + BUBBLE_SIZE + BUBBLE_GAP, window.innerWidth - BUBBLE_SIZE - BUBBLE_MARGIN);
        }
        attempts += 1;
      }

      record.bubbleEl.style.display = "flex";
      record.bubbleEl.style.left = `${left}px`;
      record.bubbleEl.style.top = `${top}px`;
      placed.push({ left, top });
    }
  }

  function positionPopup(anchorRect) {
    popupEl.style.left = "0px";
    popupEl.style.top = "0px";
    // Must match .popup's own CSS `display` (flex, not block) — this runs
    // every animation frame via repositionAll, so setting the wrong value
    // here doesn't just misrender once, it permanently overrides the CSS
    // class every single frame. "block" (Feature 3's original value, correct
    // for Feature 3's plain unstyled div) silently killed both the flex
    // column layout AND the `gap` between header/body/footer on every frame
    // once Feature 5 made `.popup` a flex container, since `gap` has no
    // effect outside flex/grid — the visible symptom was the note textarea
    // and footer sitting flush with no spacing, reading as "overlapping."
    popupEl.style.display = "flex"; // must be visible+rendered before measuring its own size
    const popupRect = popupEl.getBoundingClientRect();
    const left = Math.min(Math.max(8, anchorRect.left), window.innerWidth - popupRect.width - 8);
    const top = Math.min(Math.max(8, anchorRect.bottom + 8), window.innerHeight - popupRect.height - 8);
    popupEl.style.left = `${left}px`;
    popupEl.style.top = `${top}px`;
  }

  // --- wiring: open/close/save/delete -------------------------------------

  function openPopupFor(el) {
    ensureHost();
    positionAllBubbles(); // make sure any existing bubble's position is current before anchoring the popup to it
    draftElement = el;
    activeRecord = getExistingRecord(el);

    const cached = latestCaptureByElement.get(el);
    const selectorText = (activeRecord ? activeRecord.selector : cached && cached.selector) || "(selector unavailable)";
    headerEl.querySelector(".muted").textContent = activeRecord ? "Annotated" : "Annotating";
    headerEl.querySelector(".selector").textContent = selectorText;

    draftState = {
      issueType: activeRecord ? activeRecord.issueType : null,
      includeSnapshot: activeRecord ? activeRecord.includeSnapshot : false,
      snapshot: activeRecord ? activeRecord.snapshot : null,
    };
    noteTextarea.value = activeRecord ? activeRecord.note : "";
    clearTimeout(hotSaveTimer); // a stale pending save from whatever was open before must not fire against this element
    savedIndicatorEl.classList.remove("visible"); // never start a freshly-opened popup mid-flash

    // Re-render every field from draftState — setIssueType doubles as the
    // render path here (not just the on-click change path), so the trigger
    // label logic isn't duplicated in two places. { silent: true } — this
    // is a render, not an edit, and must not schedule a hot-save.
    setIssueType(draftState.issueType, { silent: true });
    snapshotCheckboxEl.classList.toggle("checked", draftState.includeSnapshot);
    updateSendEnabled();

    // Delete only exists in edit mode — matches Figma's Annotation-add
    // (send only) vs Annotation-edit (delete + send) frames exactly. A
    // fresh draft has no cancel control; see spec.md.
    deleteButton.style.display = activeRecord ? "flex" : "none";
    // Send is add-mode only now — edit mode uses hot-save + the saved
    // indicator instead, per Feature 5's original written spec (Feature 6
    // is what actually removes it, per that feature's own TODO).
    sendButton.style.display = activeRecord ? "none" : "flex";
    // Numbered corner badge (this update, Figma node 30:145) — edit mode only.
    numberBadgeEl.classList.toggle("visible", !!activeRecord);
    if (activeRecord) numberBadgeEl.textContent = String(activeRecord.number);

    positionPopup(getPopupAnchorRect(el, activeRecord));
    noteTextarea.focus();
    const len = noteTextarea.value.length;
    noteTextarea.setSelectionRange(len, len);
  }

  function closePopup() {
    if (popupEl) popupEl.style.display = "none";
    activeRecord = null;
    draftElement = null;
  }

  function renderBubble(record) {
    if (record.bubbleEl) {
      record.bubbleEl.textContent = String(record.number); // already exists — keep the label in sync
      return;
    }
    const bubbleEl = document.createElement("div");
    bubbleEl.className = "bubble";
    bubbleEl.textContent = String(record.number);
    // Route through setSelectedElement rather than calling openPopupFor
    // directly, so clicking a bubble shows the green locked highlight too —
    // the same as clicking the underlying element itself would. This is the
    // canonical "select this element" path; state.js's setSelectedElement
    // dispatches spotcheck:element-selected, which the listener below
    // catches and opens the popup from — one path, not two duplicated ones.
    bubbleEl.addEventListener("click", () => spotcheck.setSelectedElement(record.element));
    bubblesLayer.appendChild(bubbleEl);
    record.bubbleEl = bubbleEl;
    // Full re-pass, not a single-record position — a new bubble might land
    // exactly where an existing one already is (see positionAllBubbles).
    positionAllBubbles();
  }

  function renderOutline(record) {
    if (record.outlineEl) return; // already exists, position tracking handles the rest
    const outlineEl = document.createElement("div");
    outlineEl.className = "outline";
    outlinesLayer.appendChild(outlineEl);
    record.outlineEl = outlineEl;
    positionOutline(record);
  }

  function commit() {
    if (!draftElement) return;
    const record = saveNote(draftElement, noteTextarea.value);
    if (record) {
      renderBubble(record);
      // Persistent outline — created once a note is actually saved ("logged"),
      // not while just previewing/drafting, and stays lit as long as the
      // annotation exists (not just while it's the "currently selected" one).
      // Makes it unambiguous which exact element a bubble belongs to, even
      // deep in nested parent/child structures where a small pin alone
      // doesn't make that clear.
      renderOutline(record);
      document.dispatchEvent(
        new CustomEvent("spotcheck:annotation-saved", {
          detail: {
            number: record.number,
            note: record.note,
            selector: record.selector,
            element: record.element,
            allAnnotations: buildSnapshot(),
          },
        })
      );
    }
    closePopup();
  }

  function onDeleteClick() {
    // No existing record (a fresh, never-saved draft) — delete just discards
    // it, same as closePopup() alone. Doubles as a cancel button.
    if (activeRecord) deleteAnnotation(activeRecord);
    closePopup();
  }

  // --- Feature 1 / Feature 2 event subscriptions --------------------------

  document.addEventListener("spotcheck:element-selected", (e) => {
    const el = e.detail && e.detail.element;
    if (!el) return;
    openPopupFor(el);
  });

  document.addEventListener("spotcheck:element-captured", (e) => {
    const el = e.detail && e.detail.element;
    if (!el) return;

    const data = { selector: e.detail.selector, styles: e.detail.styles, component: e.detail.component };
    latestCaptureByElement.set(el, data); // always kept current, whether or not this element ends up annotated

    // If an annotation already exists (re-selecting an already-annotated
    // element, e.g. via its bubble, to edit it), refresh it directly too —
    // saveNote only reads the cache once, at creation time, so an existing
    // record needs this separate path to stay live on re-selection.
    const record = annotationsByElement.get(el);
    if (record) {
      record.selector = data.selector;
      record.styles = data.styles;
      record.component = data.component;
    }
  });

  // --- hover-fill on already-annotated elements ---------------------------

  let hoveredAnnotationRecord = null; // record whose outline currently has .hovering, or null

  // Independent of picker.js's own mousemove handling (same reasoning as
  // everywhere else in this file: no reaching into Feature 1's internals),
  // so this does its own elementFromPoint hit-test rather than reading
  // spotcheck.state.hoveredElement.
  function onMouseMoveForHoverFill(e) {
    const el = document.elementFromPoint(e.clientX, e.clientY);
    const record = el ? annotationsByElement.get(el) : null;
    if (record === hoveredAnnotationRecord) return;
    if (hoveredAnnotationRecord && hoveredAnnotationRecord.outlineEl) {
      hoveredAnnotationRecord.outlineEl.classList.remove("hovering");
    }
    hoveredAnnotationRecord = record || null;
    if (hoveredAnnotationRecord && hoveredAnnotationRecord.outlineEl) {
      hoveredAnnotationRecord.outlineEl.classList.add("hovering");
    }
  }

  // --- toggle lifecycle ----------------------------------------------------

  const HOVER_OPTS = { passive: true };

  function start() {
    repositionLoopActive = true;
    rafId = requestAnimationFrame(repositionLoop);
    document.addEventListener("mousemove", onMouseMoveForHoverFill, HOVER_OPTS);
    document.addEventListener("click", onDocumentClickForDropdown);
  }

  function stop() {
    repositionLoopActive = false;
    document.removeEventListener("mousemove", onMouseMoveForHoverFill, HOVER_OPTS);
    document.removeEventListener("click", onDocumentClickForDropdown);
    if (rafId) cancelAnimationFrame(rafId);
    rafId = null;
    clearTimeout(hotSaveTimer);
    hotSaveTimer = null;

    if (hostEl) {
      spotcheck.uiHosts.delete(hostEl);
      hostEl.remove();
    }
    hostEl = null;
    outlinesLayer = null;
    bubblesLayer = null;
    popupEl = null;
    headerEl = null;
    issueTypeTrigger = null;
    issueTypeLabel = null;
    issueTypeMenu = null;
    snapshotCheckboxEl = null;
    noteTextarea = null;
    sendButton = null;
    deleteButton = null;
    savedIndicatorEl = null;
    numberBadgeEl = null;
    draftState = { issueType: null, includeSnapshot: false, snapshot: null };
    spotcheck.annotations.hostEl = null;

    // Only the live, DOM-bound view resets here — none of it can meaningfully
    // survive a toggle-off regardless of storage (the bubble/outline nodes
    // are gone, and a fresh toggle-on re-injects a brand-new content script
    // instance with fresh closures). spotcheck.queue's chrome.storage.local
    // copy is deliberately left untouched — see spec.md's storage decision.
    annotationsByElement = new WeakMap();
    latestCaptureByElement = new WeakMap();
    annotationsInOrder = [];
    activeRecord = null;
    draftElement = null;
    hoveredAnnotationRecord = null;
  }

  chrome.runtime.onMessage.addListener((message) => {
    if (!message || message.type !== "SPOTCHECK_SET_ACTIVE") return;
    // Absolute state, not a flip — see background.js's sendSetActive for why.
    active = message.active;
    if (active) {
      start();
    } else {
      stop();
    }
  });

  spotcheck.annotations = { hostEl: null };
})(window.__spotcheck);
