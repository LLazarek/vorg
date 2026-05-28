// Tab linkage: tabId -> { snapshotId, title } (kept in sync with chrome.storage.session)
const tabLinks = new Map();

const DEFAULT_PORT = 8765;

async function getServerPort() {
  const result = await chrome.storage.local.get({ serverPort: DEFAULT_PORT });
  return result.serverPort;
}

function serverBase(port) {
  return `http://127.0.0.1:${port}`;
}

// Persist tabLinks so the mapping survives service worker termination.
async function saveTabLinks() {
  const obj = {};
  for (const [tabId, info] of tabLinks.entries()) {
    obj[String(tabId)] = info;
  }
  await chrome.storage.session.set({ tabLinks: obj });
}

// Load on startup so a restarted service worker picks up existing links.
chrome.storage.session.get("tabLinks").then((stored) => {
  for (const [tabId, info] of Object.entries(stored.tabLinks || {})) {
    tabLinks.set(Number(tabId), info);
  }
});

function setSnapshotBadge(tabId) {
  chrome.action.setBadgeText({ text: "●", tabId });
  chrome.action.setBadgeBackgroundColor({ color: "#2563eb", tabId });
}

async function doFreeze() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return { ok: false, error: "No active tab." };

  const port = await getServerPort();
  const url = tab.url || "";
  const title = tab.title || url;

  let screenshotData;
  try {
    screenshotData = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
  } catch (err) {
    return { ok: false, error: `Screenshot failed: ${err.message}` };
  }

  const base64 = screenshotData.replace(/^data:[^;]+;base64,/, "");
  const link = tabLinks.get(tab.id);
  const snapshotId = link ? link.snapshotId : null;
  const body = { url, title, screenshot: base64 };
  if (snapshotId) body.snapshotId = snapshotId;

  try {
    const response = await fetch(`${serverBase(port)}/api/snapshot/freeze`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      const text = await response.text();
      return { ok: false, error: `Server error ${response.status}: ${text}` };
    }
    const result = await response.json();
    if (result.kind === "overwritten") {
      // Update stored title so popup reflects new title.
      if (tabLinks.has(tab.id)) {
        const existing = tabLinks.get(tab.id);
        tabLinks.set(tab.id, { ...existing, title });
        saveTabLinks();
      }
      return { ok: true, kind: "overwritten", snapshotId: result.snapshotId };
    } else {
      return { ok: true, kind: "pending", pendingId: result.pendingId };
    }
  } catch (err) {
    return { ok: false, error: `Request failed: ${err.message}` };
  }
}

// Keyboard shortcut — freeze silently
chrome.commands.onCommand.addListener((command) => {
  if (command === "freeze-tab") {
    doFreeze();
  }
});

// Clean up linkage when a tab closes
chrome.tabs.onRemoved.addListener((tabId) => {
  if (!tabLinks.has(tabId)) return;
  tabLinks.delete(tabId);
  saveTabLinks();
});

function handleOpen(message, sendResponse) {
  const { snapshotId, url, title } = message;
  console.log("[orghtml-ext] bg open", message);
  if (!snapshotId || !url) {
    sendResponse({ ok: false, error: "missing snapshotId or url" });
    return;
  }
  chrome.tabs.create({ url }).then((tab) => {
    console.log("[orghtml-ext] bg created tab", tab.id, "->", snapshotId);
    tabLinks.set(tab.id, { snapshotId, title: title || url });
    setSnapshotBadge(tab.id);
    saveTabLinks();
    sendResponse({ ok: true, tabId: tab.id });
  }).catch((err) => {
    console.error("[orghtml-ext] bg tabs.create failed:", err);
    sendResponse({ ok: false, error: err.message });
  });
}

// Messages from the popup and content script
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === "freeze") {
    doFreeze().then(sendResponse);
    return true;
  }

  if (message.type === "open") { handleOpen(message, sendResponse); return true; }

  if (message.type === "getLink") {
    chrome.tabs.query({ active: true, currentWindow: true }).then(([tab]) => {
      if (!tab) { sendResponse({ linked: false }); return; }
      const info = tabLinks.get(tab.id);
      if (info) sendResponse({ linked: true, ...info });
      else sendResponse({ linked: false });
    });
    return true; // async
  }
});
