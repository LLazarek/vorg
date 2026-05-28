const portInput = document.getElementById("port");
const connectBtn = document.getElementById("connect");
const freezeBtn = document.getElementById("freeze");
const statusEl = document.getElementById("status");
const linkStatusEl = document.getElementById("link-status");

async function refreshLinkStatus() {
  try {
    const result = await chrome.runtime.sendMessage({ type: "getLink" });
    if (result && result.linked) {
      linkStatusEl.textContent = `Tab linked to: ${result.title || result.snapshotId}`;
      linkStatusEl.style.background = "#dcfce7";
      linkStatusEl.style.color = "#166534";
    } else {
      linkStatusEl.textContent = "This tab is not linked to OrgHTML.";
      linkStatusEl.style.background = "#f5f5f5";
      linkStatusEl.style.color = "#888";
    }
  } catch {
    linkStatusEl.textContent = "This tab is not linked to OrgHTML.";
  }
}
refreshLinkStatus();

function setStatus(text, variant = "muted") {
  statusEl.textContent = text;
  statusEl.className = variant;
}

async function getPort() {
  const result = await chrome.storage.local.get({ serverPort: 8765 });
  return result.serverPort;
}

// Restore saved port on open
getPort().then((port) => { portInput.value = port; }).catch(() => {});

// Check current connection status on open
async function checkConnection() {
  let port;
  try {
    port = await getPort();
  } catch {
    setStatus("Could not read storage.", "error");
    return;
  }
  try {
    const resp = await fetch(`http://127.0.0.1:${port}/api/snapshot/extension-info`);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const info = await resp.json();
    if (info.connected) {
      setStatus("Connected to server.", "ok");
    } else {
      setStatus("Server reachable — click Connect to register.", "muted");
    }
  } catch {
    setStatus("Server not reachable on port " + port + ".", "error");
  }
}
checkConnection();

connectBtn.addEventListener("click", async () => {
  const port = parseInt(portInput.value, 10);
  if (isNaN(port) || port < 1024 || port > 65535) {
    setStatus("Enter a valid port (1024–65535).", "error");
    return;
  }
  connectBtn.disabled = true;
  setStatus("Connecting…", "muted");
  try {
    await chrome.storage.local.set({ serverPort: port });
    const resp = await fetch(`http://127.0.0.1:${port}/api/snapshot/register-extension`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ extensionId: chrome.runtime.id }),
    });
    if (!resp.ok) throw new Error(`Server returned HTTP ${resp.status}`);
    setStatus("Connected to server.", "ok");
  } catch (err) {
    setStatus("Failed: " + err.message, "error");
  } finally {
    connectBtn.disabled = false;
  }
});

freezeBtn.addEventListener("click", async () => {
  freezeBtn.disabled = true;
  setStatus("Freezing…", "muted");
  try {
    const result = await chrome.runtime.sendMessage({ type: "freeze" });
    if (!result || !result.ok) {
      setStatus(result?.error || "Freeze failed.", "error");
    } else if (result.kind === "overwritten") {
      setStatus("Snapshot updated.", "ok");
    } else {
      setStatus("Pending snapshot queued.", "ok");
    }
  } catch (err) {
    setStatus("Error: " + err.message, "error");
  } finally {
    freezeBtn.disabled = false;
  }
});
