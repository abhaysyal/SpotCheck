// Service worker. No content_scripts entry in manifest.json — injection only
// happens here, on explicit toolbar icon click, so the extension is inert on
// every page until the user acts.

const CONTENT_FILES = [
  "content/state.js",
  "content/overlay.js",
  "content/picker.js",
  "content/capture.js",
  "content/queue.js",
  "content/annotations.js",
  "content/export.js",
];

// Feature 8 — injected into the page's MAIN world (a separate executeScript
// call; one call can't span both worlds). It only reads framework internals
// the ISOLATED-world scripts above can't see and answers capture.js over
// window.postMessage — no DOM writes, no page globals added beyond one guard
// flag. See docs/features/feature-8-component-name-extraction/spec.md.
const MAIN_WORLD_FILES = ["content/component-probe.js"];

// tabId -> boolean (inspection mode active). Presence in the map also means
// the content scripts have already been injected for that tab. In-memory
// only — resets on browser/service-worker restart, which is fine since
// nothing here needs to survive that.
const tabState = new Map();

function updateBadge(tabId, isActive) {
  chrome.action.setBadgeText({ tabId, text: isActive ? "ON" : "" });
  chrome.action.setBadgeBackgroundColor({ tabId, color: "#22c55e" });
}

// Returns true on success, or null if the page refuses injection entirely
// (chrome://, the Web Store, etc). A fresh injection always starts active.
async function inject(tabId) {
  try {
    // The two injections target different worlds and don't depend on each
    // other, so start them together rather than waiting on the isolated one
    // before even asking Chrome to start the MAIN-world one.
    const isolatedInjection = chrome.scripting.executeScript({
      target: { tabId },
      files: CONTENT_FILES,
    });
    // Best-effort — the extension works without the component probe (the
    // component field just stays empty). A page that blocks MAIN-world
    // injection must not break the rest of the injection above.
    const probeInjection = chrome.scripting
      .executeScript({
        target: { tabId },
        world: "MAIN",
        files: MAIN_WORLD_FILES,
      })
      .catch((probeErr) => {
        console.warn("SpotCheck: component probe injection failed (non-fatal).", probeErr);
      });
    await isolatedInjection;
    await probeInjection;
    return true;
  } catch (err) {
    console.warn("SpotCheck: could not inject into this tab.", err);
    return null;
  }
}

// Returns false if there's no content script listening — happens when the
// tab reloaded/navigated after activation, which wipes the isolated world
// (and window.__spotcheck with it) without us hearing about it directly.
//
// Sends the *absolute* next state, not a flip instruction. Every listener
// (picker.js, annotations.js — each tracks its own local `active` boolean
// independently) sets itself to exactly this value rather than inverting
// its current one. That makes the protocol self-correcting: if any listener
// were ever out of sync with background.js's own tabState (a transient
// desync, not something that should happen, but with three independently
// toggling listeners it's cheap insurance), the next message still drives
// it to the right state instead of compounding the drift the way a flip
// message would.
async function sendSetActive(tabId, active) {
  try {
    await chrome.tabs.sendMessage(tabId, { type: "SPOTCHECK_SET_ACTIVE", active });
    return true;
  } catch (err) {
    return false;
  }
}

async function toggleTab(tab) {
  if (!tab.id) return;
  const tabId = tab.id;

  let nextActive;
  if (!tabState.has(tabId)) {
    nextActive = await inject(tabId);
    if (nextActive === null) return;
  } else {
    nextActive = !tabState.get(tabId);
  }

  let delivered = await sendSetActive(tabId, nextActive);
  if (!delivered) {
    // Stale bookkeeping — the tab looked injected but isn't anymore.
    // Re-inject fresh and retry once before giving up. inject()'s return
    // value here only means "did injection succeed," never "what state
    // should we be in" — nextActive was already decided above (the user's
    // actual intent, on or off) and must survive this retry unchanged, or
    // an intended toggle-OFF would silently come back as ON since a fresh
    // injection always reports success as `true`.
    tabState.delete(tabId);
    const injected = await inject(tabId);
    if (injected === null) return;
    delivered = await sendSetActive(tabId, nextActive);
    if (!delivered) return;
  }

  tabState.set(tabId, nextActive);
  updateBadge(tabId, nextActive);
}

chrome.action.onClicked.addListener(toggleTab);

chrome.tabs.onRemoved.addListener((tabId) => {
  tabState.delete(tabId);
});

// Screenshot capture for Feature 6's "Include Snapshot" — chrome.tabs.
// captureVisibleTab is only callable from an extension page (background,
// popup), never a content script, so annotations.js relays the request
// here. A second, independent onMessage listener from the toggle one below
// — Chrome calls every matching listener, so there's no interference.
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.type !== "SPOTCHECK_CAPTURE_VISIBLE_TAB") return;
  (async () => {
    try {
      const dataUrl = await chrome.tabs.captureVisibleTab(sender.tab.windowId, { format: "png" });
      sendResponse({ dataUrl });
    } catch (err) {
      sendResponse({ error: String(err) });
    }
  })();
  return true; // keeps the channel open for the async response
});

// A full navigation/reload wipes the content script's isolated world, so any
// bookkeeping we hold for that tab goes stale the instant it starts. Reset
// eagerly here instead of waiting to discover it reactively on next click.
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status !== "loading") return;
  tabState.delete(tabId);
  chrome.action.setBadgeText({ tabId, text: "" });
});

// Feature 7 — pushes the annotation queue to the local MCP server (a
// separate Node process, see mcp-server/) whenever it changes, regardless
// of which context wrote it. content/queue.js runs in a page's isolated
// world and has no way to reach a localhost URL not on that page's own
// origin — chrome.storage.onChanged fires here in the background context
// for any chrome.storage.local write, from any content script instance, on
// any tab, which is what lets this feature avoid touching queue.js at all.
// See docs/features/feature-7-local-mcp-server/spec.md for why the
// extension pushes rather than the server pulling (chrome.storage.local is
// unreachable from outside the extension's own processes, full stop).
const MCP_SERVER_URL = "http://127.0.0.1:8934"; // fixed for this pass, see spec.md's "Known limitations"

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !changes.spotcheck_annotations) return;
  const annotations = changes.spotcheck_annotations.newValue || [];
  fetch(`${MCP_SERVER_URL}/sync`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ annotations }),
  }).catch(() => {}); // server not running — fail silently, must never affect the extension's own behavior
});
