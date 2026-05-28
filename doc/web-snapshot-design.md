# Web Snapshot Feature — Design Spec

## Overview

Extends the existing local-first notes canvas with the ability to embed live-web research as spatial "snapshot" components. A snapshot is just a frozen `{url, title, screenshot, timestamp}`, all of which can be stored as component parameters in the org source. Clicking a snapshot in the canvas opens its URL in a real browser tab; freezing that tab (via the extension) updates the snapshot in place.

The feature ships as a browser extension that talks directly to the existing local web server over HTTP. The canvas remains a pure frontend for server state and does not communicate with the extension.

## State model

**Snapshot** (durable, server-owned). A record `{id, url, title, screenshot_link, frozen_at}`. Always represents frozen data; there is no "live" state.

**Tab linkage** (ephemeral, extension-owned). An in-memory map `tabId → snapshot_id` held in the extension's background script. Lifetime is the browser session; nothing is persisted.

Transitions:

- `unlinked → linked(X)`: extension opens a tab in response to "open snapshot X."
- `linked(X) → linked(X)`: any navigation within the tab. Link is preserved — drilling deeper is expected.
- `linked(X) → removed`: tab closes. Snapshot remains in its last frozen state on the server.

User actions:

1. **Freeze linked tab** → overwrite snapshot X. Link persists.
2. **Freeze unlinked tab** → create new snapshot Y on the server; this takes the screenshot, sends it over to the server, which can then insert a snapshot component into the document.
3. **Open snapshot X from canvas** → if X has a linked open tab, focus it; otherwise open a new tab and link it.
4. **Close linked tab** → drop the entry. No server call.

## Web server

Single local HTTP server bound to `127.0.0.1:PORT`. Already serves the canvas; this feature adds three endpoints and one table.

**Storage.** New `snapshots` table with the fields above. Screenshots stored as blobs (filesystem or DB blob column — match whatever the existing app does for other binary assets).

**Endpoints (all JSON except where noted).**

- `POST /snapshots` — create. Body: `{url, title, screenshot (base64 or multipart)}`. Returns `{id, ...}`. Canvas position defaults to a sensible drop location (e.g., near viewport center) if omitted.
- `PUT /snapshots/:id` — overwrite. Body: `{url, title, screenshot}`. Returns updated record. 404 if id unknown.
- `GET /snapshots/:id` — read. Used by the extension when it needs to resolve "open snapshot X" to a URL. Returns `{id, url}`.

The canvas already has whatever endpoints it uses for general document state; snapshot cards are just one more node type in that document, referencing the snapshot id, url, timestamp, and screenshot image path.

**Security.** Two checks on every request, both cheap:

1. Server bound to `127.0.0.1` only — not reachable off-machine.
2. `Origin` header must be either `http://localhost:PORT` (the canvas) or `chrome-extension://<id>` / `moz-extension://<uuid>` (the extension). Reject otherwise with 403. This blocks the only realistic threat: random web pages firing opportunistic `fetch` calls to localhost.

Additionally: state-changing endpoints accept only `POST`/`PUT` with `Content-Type: application/json` (or `multipart/form-data` for screenshot upload), which forces a CORS preflight that cross-origin pages will fail. `Access-Control-Allow-Origin` set to the canvas origin and extension origin only.

## Browser extension

Cross-browser WebExtension (MV3). Three components:

**`manifest.json`** declares:

- `host_permissions`: `http://127.0.0.1:*/*`
- `permissions`: `tabs`, `activeTab`, `scripting`, `storage`
- A toolbar action (button) and a keyboard shortcut (e.g., `Cmd/Ctrl+Shift+S`) for freeze.
- An options page for one-time config of the server port (default sensible, user-editable).

**Background service worker** holds the only meaningful state: the `tabId → snapshot_id` map, in memory. Handles:

- Toolbar-button / shortcut press → freeze flow (below).
- `chrome.tabs.onRemoved` → delete entry from map.
- A message handler for "open snapshot X" requests originating from the canvas (see communication below).

**Content script.** Minimal, possibly none for v1. The freeze action uses `chrome.tabs.captureVisibleTab()` (viewport-only — full-page stitching is explicitly out of scope) and reads `tab.url` / `tab.title` from the tabs API, neither of which needs a content script. If you later want extracted readable text via Readability.js, that goes here.

**Freeze flow.**

1. User invokes freeze (button or shortcut) on the active tab.
2. Background worker reads `tab.url`, `tab.title`, calls `captureVisibleTab()`.
3. Looks up `tabId` in the linkage map.
4. If linked to snapshot X: `PUT /snapshots/X` with the payload. Link persists.
5. If unlinked: `POST /snapshots` with the payload, receive new id Y, set `tabId → Y` in the map. (The new snapshot now appears on the canvas via the canvas's existing server-state subscription.)

**Open flow.**

1. Canvas user clicks a snapshot. Canvas needs the extension to open the URL and establish a link.
2. Communication uses `chrome.runtime.sendMessage` with the extension id (see below).
3. Extension receives `{type: "open", snapshot_id: X}`. Checks the map for an existing tab linked to X — if found, `chrome.tabs.update(tabId, {active: true})` and focus its window. If not, fetch `GET /snapshots/X` to resolve the URL, `chrome.tabs.create({url})`, and record the new `tabId → X` mapping.

## How the canvas and extension communicate

They don't talk directly in a continuous sense. Two narrow seams:

**Server is the bus for snapshot data.** Both clients hit the HTTP API. The canvas already polls / subscribes to server state through its existing mechanism; new snapshots and updates flow through that path with no extension-canvas coupling. The extension never tells the canvas anything; it tells the server, and the canvas notices.

**Direct extension messaging for the open action only.** Opening a tab is something only the extension can do, and it's user-initiated from the canvas. The canvas calls `chrome.runtime.sendMessage(EXTENSION_ID, {type: "open", snapshot_id: X})`. This requires the extension to declare `"externally_connectable": {"matches": ["http://localhost:PORT/*"]}` in its manifest, which scopes who can message it to the canvas origin only.

If the extension isn't installed, `sendMessage` fails fast and the canvas shows a small "install the extension to open snapshots" hint. No fallback needed for v1.

That's the whole communication surface: HTTP from each client to the server for data, one `sendMessage` channel from canvas to extension for the open action.

## Out of scope for v1

Full-page screenshots. Readability text extraction. Persisting tab linkage across browser restarts. Multiple canvas windows competing for the same snapshot. Server-side URL screenshotting as a fallback. All are reasonable v2 additions; none change the architecture above.
