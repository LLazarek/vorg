# OrgHTML Snapshot — Browser Extension

A Manifest V3 WebExtension for Chrome, Edge, and Firefox that lets you freeze browser tabs as `webSnapshot` components inside OrgHTML.

## Installing (unpacked / development)

**Chrome / Edge:**
1. Open `chrome://extensions` (or `edge://extensions`).
2. Enable **Developer mode**.
3. Click **Load unpacked** and select this `browser-extension/` directory.

**Firefox:**
1. Open `about:debugging#/runtime/this-firefox`.
2. Click **Load Temporary Add-on…** and select `manifest.json` inside this directory.
   (For a permanent install, the extension must be signed; use [about:config `xpinstall.signatures.required=false`](https://support.mozilla.org/en-US/kb/add-on-signing-in-firefox) for local development.)

## Connecting to the server

No `EXTENSION_ID` constant needs to be set anywhere. Instead:

1. Start the OrgHTML server (`python3 orghtml_server.py`).
2. Click the OrgHTML Snapshot toolbar button to open the popup.
3. Confirm the port matches your server (default `8765`), then click **Connect**.
4. The popup shows "Connected to server." — the canvas now knows the extension is active.

After a server restart, just click **Connect** again.

## Usage

| Action | How |
|---|---|
| Freeze the current tab | Click **Freeze tab** in the popup, or press `Ctrl+Shift+S` / `MacCtrl+Shift+S` |
| Promote a pending snapshot | OrgHTML canvas → right panel → **Pending Snapshots** → **Create block** |
| Open a snapshot tab | Click the snapshot card on the canvas |
| Re-freeze an open snapshot tab | Navigate / interact, then freeze again |

## How it works

- **Freeze (linked tab):** updates the existing `webSnapshot` component in the Org file and rewrites `.orghtml/snapshots/<id>.png`.
- **Freeze (unlinked tab):** queues a *pending snapshot* on the OrgHTML server. Promote or discard it from the canvas.
- **Promote:** appends a new heading with a `webSnapshot` directive to the current document and writes the PNG.
- **Open:** a content script bridges `window.postMessage` from the canvas to the background worker, which focuses an existing linked tab or opens a new one.

Tab linkage resets when the browser restarts.
