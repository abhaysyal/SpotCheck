// Small floating button, visible only once at least one annotation exists,
// that serializes the current annotation queue into Markdown and copies it
// to the clipboard — the terminal stage of the pipeline: Feature 1 locks,
// Feature 2 captures, Feature 3 annotates, this is where the data leaves
// the browser. Clipboard-only, no network calls, matches PROJECT.md §6.
// Tracks its own on/off lifecycle independently of picker.js/annotations.js
// — listens for the same SPOTCHECK_SET_ACTIVE broadcast, per the
// cross-feature convention (features talk via CustomEvents on document,
// not direct calls into each other's modules).

window.__spotcheck = window.__spotcheck || {};

(function (spotcheck) {
  if (spotcheck.exportBundle) return;

  let active = false;
  // Always a full replace from the latest event's allAnnotations, never
  // patched incrementally — see applySnapshot below for why that matters.
  let annotations = [];

  let hostEl = null;
  let buttonEl = null;
  let copiedTimer = null;

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
    spotcheck.uiHosts.add(hostEl);

    const shadowRoot = hostEl.attachShadow({ mode: "open" });

    const style = document.createElement("style");
    style.textContent = `
      .export-button {
        position: fixed;
        right: 16px;
        bottom: 16px;
        display: none;
        align-items: center;
        gap: 6px;
        padding: 8px 14px;
        border-radius: 999px;
        background: #0b0b0c;
        color: #f3f4f6;
        border: none;
        cursor: pointer;
        font-size: 13px;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        box-shadow: 0 8px 24px rgba(0, 0, 0, 0.4);
        pointer-events: auto;
        z-index: 2147483647;
      }
      .export-button:hover { background: #1c1d21; }
      .export-button.copied { background: #22c55e; color: #ffffff; }
    `;
    shadowRoot.appendChild(style);

    buttonEl = document.createElement("button");
    buttonEl.className = "export-button";
    buttonEl.addEventListener("click", onCopyClick);
    shadowRoot.appendChild(buttonEl);

    renderButtonLabel();
  }

  function renderButtonLabel() {
    if (!buttonEl) return;
    buttonEl.textContent = `\u{1F4CB} Copy (${annotations.length})`; // 📋 — icon + count, no separate label needed
    buttonEl.style.display = annotations.length > 0 ? "flex" : "none";
  }

  // --- Markdown formatting -------------------------------------------------

  // getComputedStyle (Feature 2) returns JS-cased property names, e.g.
  // backgroundColor — real CSS inside a ```css block should read
  // background-color, not the JS-cased version.
  function camelToKebab(prop) {
    return prop.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
  }

  function formatMarkdown() {
    const lines = [
      "# SpotCheck Annotations",
      "",
      `**Page:** ${window.location.href}`,
      `**Title:** ${document.title}`,
      `**Count:** ${annotations.length}`,
      "",
      "---",
    ];

    for (const a of annotations) {
      lines.push("");
      lines.push(`## ${a.number}. \`${a.selector || "(selector unavailable)"}\``);
      lines.push("");
      lines.push(`**Note:** ${a.note}`);

      // Feature 8 — name + source + confidence, plus a source file path and
      // an ancestry breadcrumb when the framework/dev-build exposed them.
      if (a.component && (a.component.name || a.component.sourcePath)) {
        const c = a.component;
        lines.push("");
        let tag = `${c.name || "(unnamed)"} (${c.source}`;
        if (c.confidence) tag += `, ${c.confidence}`;
        tag += c.confidence === "low" ? " — name may be minified)" : ")";
        let line = `**Component:** ${tag}`;
        if (c.sourcePath) line += ` — ${c.sourcePath}${c.sourceLine ? ":" + c.sourceLine : ""}`;
        lines.push(line);
        if (Array.isArray(c.ancestry) && c.ancestry.length > 1) {
          lines.push("");
          lines.push(`**Component tree:** ${c.ancestry.join(" › ")}`); // ›
        }
      }

      if (a.styles) {
        lines.push("");
        lines.push("```css");
        for (const [prop, value] of Object.entries(a.styles)) {
          lines.push(`${camelToKebab(prop)}: ${value};`);
        }
        lines.push("```");
      }

      lines.push("");
      lines.push("---");
    }

    return lines.join("\n");
  }

  // --- copy action ----------------------------------------------------

  async function onCopyClick() {
    const markdown = formatMarkdown();
    try {
      await navigator.clipboard.writeText(markdown);
      showCopiedFeedback();
    } catch (err) {
      console.warn("SpotCheck: clipboard write failed", err);
    }
  }

  function showCopiedFeedback() {
    if (!buttonEl) return;
    if (copiedTimer) clearTimeout(copiedTimer);
    buttonEl.textContent = "✓ Copied"; // ✓ Copied
    buttonEl.classList.add("copied");
    copiedTimer = setTimeout(() => {
      buttonEl.classList.remove("copied");
      // Re-derive from the current count rather than restoring the prior
      // label — another annotation may have been saved/deleted while this
      // confirmation was showing, and the button shouldn't lie about it.
      renderButtonLabel();
    }, 1500);
  }

  // --- Feature 3 event subscription ---------------------------------------

  function applySnapshot(detail) {
    if (!detail || !detail.allAnnotations) return;
    annotations = detail.allAnnotations;
    renderButtonLabel();
  }

  document.addEventListener("spotcheck:annotation-saved", (e) => applySnapshot(e.detail));
  document.addEventListener("spotcheck:annotation-deleted", (e) => applySnapshot(e.detail));

  // --- toggle lifecycle ----------------------------------------------------

  function start() {
    ensureHost();
  }

  function stop() {
    if (copiedTimer) clearTimeout(copiedTimer);
    copiedTimer = null;
    if (hostEl) {
      spotcheck.uiHosts.delete(hostEl);
      hostEl.remove();
    }
    hostEl = null;
    buttonEl = null;
    annotations = [];
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

  spotcheck.exportBundle = {};
})(window.__spotcheck);
