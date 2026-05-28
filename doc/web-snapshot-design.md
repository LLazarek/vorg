# Web Snapshot Feature — Design Spec

## Overview

Extends OrgHTML with the ability to embed live-web research as `webSnapshot` components inside Org blocks. A snapshot is a frozen `{id, url, title, screenshot, frozen_at}` tuple. Clicking a snapshot on the canvas opens its URL in a real browser tab; freezing that tab (via the browser extension) updates the snapshot in place. Freezing an unlinked tab queues a *pending snapshot* on the server that the user can then promote into a new heading block from the canvas.

The feature ships as a browser extension that talks to OrgHTML's existing local web server over HTTP. The canvas remains a frontend for server state and only communicates with the extension to trigger the "open" action.

## How this fits OrgHTML's data model

The feature follows OrgHTML's existing split:

- **Org source owns durable snapshot state.** Each snapshot is an ordinary `#+orghtml_component: webSnapshot` directive placed inside a heading block. Its parameters carry the URL, title, timestamp, and a stable snapshot UUID.
- **Sidecar owns binary content.** The screenshot is stored as a PNG file under `.orghtml/snapshots/<snapshot-id>.png`. The file path is *implicit* from the snapshot id — it is not a separate component parameter.
- **No new persistent DB table.** Snapshots live in Org + sidecar files, like every other component. The existing `.orghtml/history.sqlite` snapshot/restore mechanism covers them.
- **One in-memory list on the server.** A *pending snapshots* queue exists only for the time between a freeze-from-unlinked-tab event and the user's promote action. Its lifetime is process lifetime; nothing is persisted.

## Component shape

In Org source:

```org
#+orghtml_component: webSnapshot id=4f0c… url="https://example.com/page" title="Example page" frozen_at="2026-05-13T14:21:08Z"
```

Rules:

- `id` is a UUID and is required. It is the stable snapshot identity used by the extension, the canvas, and the screenshot filename.
- `url`, `title`, `frozen_at` are required and edited only by the server (via freeze flows). The component inspector should treat them as read-only.
- The screenshot for this component is always located at `.orghtml/snapshots/<id>.png`. If the file is missing, the canvas renders a placeholder and a "screenshot missing" diagnostic.
- `webSnapshot` is a new built-in component type alongside `table`, `image`, `chart`, etc.

The frontend renders the component as a card: title + URL + screenshot thumbnail + frozen-at timestamp. Click on the card → sends an "open snapshot" message to the extension. The card itself is purely a component; spatial placement comes from its enclosing heading block, exactly like every other component.

## State model

**Snapshot** (durable). Lives in Org source as a `webSnapshot` directive + its associated PNG file under `.orghtml/snapshots/`. There is no "live" state — a snapshot is always frozen.

**Pending snapshot** (transient, server-owned, in-memory). Created when the extension freezes a tab that is not currently linked to any snapshot id. Shape:

```
{ pending_id, url, title, captured_at, screenshot_bytes }
```

The server keeps these in a plain in-process list/map. They are not written to disk and do not survive a server restart. Once a pending snapshot is *promoted* into a document, it is removed from the queue and becomes a real `webSnapshot` component.

**Tab linkage** (transient, extension-owned). In-memory `tabId → snapshot_id` map in the extension background worker. Lifetime is the browser session.

Transitions:

- `unlinked tab → linked(X)`: extension opens a tab in response to "open snapshot X" from the canvas, or the user promotes a pending snapshot they just created (see promote flow below).
- `linked(X) → linked(X)`: any navigation within the tab. Link preserved.
- `linked(X) → removed`: tab closes. Snapshot stays at its last frozen state.

## Server changes

### New endpoints

All endpoints follow the existing `/api/...` JSON convention.

- **`POST /api/snapshot/freeze`** — Called by the extension after a `captureVisibleTab()`. Body: `{url, title, screenshot}` (PNG as base64). If the request includes `snapshotId`, the server treats it as an *overwrite* (existing component is identified by that id); otherwise it is a *new* freeze and goes onto the pending queue. Returns either:
  - `{kind: "overwritten", snapshotId, frozen_at}` — overwrite path.
  - `{kind: "pending", pendingId}` — pending path.

- **`GET /api/snapshot/pending`** — Returns the current pending queue: `{pending: [{pendingId, url, title, captured_at}, …]}`. The canvas's Components tab polls this when open. Screenshot bytes are not returned; the canvas can request a preview via `GET /api/snapshot/pending/<pendingId>/image` if a thumbnail is desired (optional for v1; the title+URL alone are sufficient).

- **`POST /api/snapshot/promote`** — Promotes a pending snapshot into a new top-level heading in the currently open document. Body: `{path, pendingId, headingTitle?}`. The server:
  1. Calls `snapshot_path_state(root, path, "snapshot-promote")` to record history.
  2. Allocates a fresh snapshot UUID.
  3. Writes the PNG to `.orghtml/snapshots/<uuid>.png`.
  4. Appends a new top-level heading to the Org file with a `:PROPERTIES:` drawer (a fresh `:ID:`) and a single `#+orghtml_component: webSnapshot id=<uuid> url=… title=… frozen_at=…` directive.
  5. Removes the entry from the pending queue.
  6. Returns the reparsed document, in the same shape as `/api/component-add`, so the canvas can refresh.

- **`POST /api/snapshot/discard`** — Discards a pending snapshot. Body: `{pendingId}`.

The *overwrite* path needs to find the component in source by its `id=` attribute. This is a small extension to the existing `update_component_directive` logic in `orghtml_server.py`: locate the directive whose parsed `id` attr matches the target snapshot id, replace it via `serialize_component_directive`, write the file, and snapshot history under reason `snapshot-overwrite`. The endpoint does not need a `blockId` or `componentId` from the caller — only the snapshot id is needed, because snapshot ids are workspace-globally unique.

Overwrite is workspace-wide: the server scans known Org files under the project root (the same set used by `/api/files`) and updates wherever the matching `id=` lives. There is exactly one such component by construction.

### Storage

- Screenshots: `.orghtml/snapshots/<snapshot-id>.png`. The directory is created on first write. Files are served through the existing `/asset?path=.orghtml/snapshots/<id>.png` endpoint, which already permits any path under the project root.
- Pending queue: in-memory only.

### History integration

Promote and overwrite both call `snapshot_path_state` before mutating, so they appear in the existing per-document history list and are restorable through the existing `/api/history/restore` path. No new history schema is required.

### What does NOT change

- No new SSE/poll/subscription path. The user manually refreshes the canvas to see new blocks after a promote (consistent with the rest of OrgHTML today). Auto-refresh is a separate, future improvement.
- No CORS handling is added in v1. The server stays bound to `127.0.0.1` and the extension uses `host_permissions` to reach it. Tightening origin checks is tracked as a separate improvement.

## Browser extension

Cross-browser WebExtension (MV3). Three pieces:

### `manifest.json`

- `host_permissions`: `http://127.0.0.1:*/*` (matches OrgHTML's default bind address).
- `permissions`: `tabs`, `activeTab`, `scripting`, `storage`.
- A toolbar action (button) and a keyboard shortcut (e.g. `Cmd/Ctrl+Shift+S`) for freeze.
- `externally_connectable.matches`: `http://127.0.0.1:*/*` so the canvas can send the "open snapshot" message.
- Options page for one-time configuration of the server port (default `8765`, user-editable).

### Background service worker

Holds the `tabId → snapshot_id` map. Handles:

- Freeze action (toolbar / shortcut) → see Freeze flow.
- `chrome.tabs.onRemoved` → delete entry from the map. No server call.
- Message handler for `{type: "open", snapshotId, url}` from the canvas → see Open flow.

### Content script

Not needed for v1. Freeze uses `chrome.tabs.captureVisibleTab()` (viewport-only) plus `tab.url` / `tab.title` from the tabs API. Readability or full-page stitching is out of scope.

## Flows

### Freeze flow (extension)

1. User invokes freeze (button or shortcut) on the active tab.
2. Background worker reads `tab.url`, `tab.title`, calls `captureVisibleTab()`.
3. Looks up `tabId` in the linkage map.
4. **Linked to snapshot X:** `POST /api/snapshot/freeze` with `{snapshotId: X, url, title, screenshot}`. Server overwrites the matching `webSnapshot` component and its PNG file. Link persists.
5. **Unlinked:** `POST /api/snapshot/freeze` with no `snapshotId`. Server enqueues a pending snapshot and returns `{pendingId}`. The tab stays unlinked until promotion happens (see promote flow).

### Promote flow (canvas)

1. The Components tab on the canvas polls `GET /api/snapshot/pending` while open and shows pending snapshots with title + URL + age.
2. Each pending entry has a "Create block" button. Clicking it sends `POST /api/snapshot/promote` with the currently open document path and the `pendingId`.
3. The server writes the PNG, appends a new heading with a `webSnapshot` component, snapshots history, and removes the pending entry.
4. The canvas reloads the document (the response includes the reparsed document, same shape as `/api/component-add`).
5. The originating tab in the browser is **not** retroactively linked to the new snapshot id. The link is established the next time the user opens the snapshot from the canvas (see Open flow). This keeps the extension's tab-link map decoupled from the promote action — the extension has no idea promotion happened, which is fine.

A discard button beside each pending entry calls `POST /api/snapshot/discard`.

### Open flow

1. User clicks a `webSnapshot` component on the canvas.
2. The canvas sends `chrome.runtime.sendMessage(EXTENSION_ID, {type: "open", snapshotId, url})`. Passing the URL alongside the id means the extension does not need a server lookup to resolve it.
3. Extension checks its map for an existing tab linked to that `snapshotId`. If found, `chrome.tabs.update(tabId, {active: true})` and focus its window. Otherwise `chrome.tabs.create({url})` and record `tabId → snapshotId`.
4. If `sendMessage` fails (extension not installed), the canvas shows an "install the extension to open snapshots" hint. No fallback for v1.

## Communication summary

- **HTTP, extension → server:** freeze (create-pending and overwrite).
- **HTTP, canvas → server:** pending list polling, promote, discard, plus every other existing endpoint.
- **`chrome.runtime.sendMessage`, canvas → extension:** open-snapshot only.
- **No direct extension → canvas channel.** The server is the bus for snapshot data; the canvas notices changes when the user manually refreshes.

That is the entire communication surface.

## Open questions / deferred

- **Auto-refresh after promote.** v1 requires a manual canvas refresh after promoting. A future auto-refresh mechanism (SSE, version-counter polling, or general autosave/autoreload work) will subsume this and is intentionally out of scope here.
- **CORS hardening.** The server currently performs no origin checks. Adding `Access-Control-Allow-Origin` restricted to the canvas and extension origins, plus an `Origin` allow-list on state-changing endpoints, is a separate follow-up improvement.
- **Full-page screenshots.** Out of scope. `captureVisibleTab()` is viewport-only.
- **Readability / extracted text.** Out of scope. Would live in a content script if added later.
- **Persisting tab linkage across browser restarts.** Out of scope. Linkage is session-scoped.
- **Multiple canvas windows.** No coordination beyond what the server already provides.
- **Server-side URL screenshotting fallback.** Out of scope.

None of these affect the architecture above.

## Implementation plan

Work is ordered so each step is independently testable and the server side lands before the extension.

### 1. Server: pending-snapshot store

In `orghtml_server.py`:

- Add a module-level `PendingSnapshots` object (a dict keyed by `pendingId`, with a lock since the server is `ThreadingHTTPServer`). Entries hold `{url, title, captured_at, screenshot_bytes}`.
- Add helpers `enqueue_pending(url, title, png_bytes)`, `list_pending()`, `pop_pending(pending_id)`, `discard_pending(pending_id)`.

### 2. Server: snapshot id lookup + overwrite

- Add `find_component_by_snapshot_id(root, snapshot_id)` that iterates `*.org` files under the project root (mirroring `handle_files`), parses each with `find_headings` + `parse_block_content`, and returns `(rel_path, block_id, component_id)` for the `webSnapshot` directive whose parsed `attrs["id"]` matches. Returns `None` if absent.
- Add `overwrite_snapshot_component(root, snapshot_id, url, title, frozen_at, png_bytes)`:
  1. Resolve via the lookup above; raise if missing.
  2. `snapshot_path_state(root, rel_path, "snapshot-overwrite")`.
  3. Write `.orghtml/snapshots/<snapshot_id>.png` (creating the dir).
  4. Build new attrs dict, call `update_component_directive(text, block_id, component_id, "webSnapshot", attrs)`, write the file.
  5. Return the reparsed document via `parse_org_document`.

### 3. Server: promote pending → new heading

- Add `promote_pending_snapshot(root, rel_path, pending_id, heading_title=None)`:
  1. `pop_pending` (raise if absent).
  2. Generate snapshot uuid; write the PNG.
  3. `snapshot_path_state(root, rel_path, "snapshot-promote")`.
  4. Append to the target Org file: a blank line, a `* <title>` heading (default title `Web snapshot — <hostname>`), a `:PROPERTIES:` / `:ID:` / `:END:` drawer, and the `#+orghtml_component: webSnapshot` directive (built with `serialize_component_directive`).
  5. Reparse with `parse_org_document` and return the same shape as `handle_component_add`.

### 4. Server: HTTP endpoints

Add to `do_POST` / `do_GET` in `OrgHtmlHandler`:

- `POST /api/snapshot/freeze` — parse JSON body, base64-decode `screenshot`, branch on presence of `snapshotId`:
  - present → call `overwrite_snapshot_component`, return `{kind: "overwritten", snapshotId, frozen_at, parsed}`.
  - absent → `enqueue_pending`, return `{kind: "pending", pendingId}`.
- `GET /api/snapshot/pending` — return `{pending: [{pendingId, url, title, captured_at}, …]}` (omit bytes).
- `POST /api/snapshot/promote` — call `promote_pending_snapshot`, return parsed-document response.
- `POST /api/snapshot/discard` — call `discard_pending`.

Wire the `webSnapshot` type so existing component machinery accepts it. Nothing in the parser is type-specific — `parse_component_directive` already accepts any name — so no parser changes are needed.

### 5. Server: doc + verification

- Update `doc/data-contract.md` to list `webSnapshot` in built-in component types and to mention `.orghtml/snapshots/` as a sidecar-owned binary location.
- Update `doc/technical-design.md`'s Built-In Components list.
- Run `python3 -m py_compile orghtml_server.py`.
- Manual: hit each new endpoint with `curl` against `sample.org`; confirm pending queue, promote, overwrite, discard all behave; confirm `/api/history` shows the new entries.

### 6. Frontend: `webSnapshot` component renderer

In `src/app.js`:

- Add a `webSnapshot` branch alongside the existing built-in component renderers.
- Render: title (linked text), URL (small, muted), screenshot `<img>` pointing at `/asset?path=.orghtml/snapshots/<id>.png`, frozen-at timestamp. Placeholder + diagnostic if the image 404s.
- Click on the card → `chrome.runtime.sendMessage(EXTENSION_ID, {type: "open", snapshotId, url})` if the runtime is present, else inline hint about installing the extension. Extension id is read from a small config (hardcoded for v1; a settings UI is out of scope).

### 7. Frontend: Components tab — pending list

- Poll `GET /api/snapshot/pending` while the Components tab is open (e.g., every 3 s).
- Render each pending entry with title, URL, captured-at age, "Create block" and "Discard" buttons.
- Create-block button: `POST /api/snapshot/promote` with the currently open document `path` and the `pendingId`; on success, swap document state to the returned `parsed` object (same path the existing component-add response already uses).
- Discard button: `POST /api/snapshot/discard`.

### 8. Browser extension (separate repo / directory)

Skeleton under `extension/` (new directory; not strictly part of the server repo's runtime surface):

- `manifest.json` with the permissions, action, command shortcut, options page, and `externally_connectable` entry described above.
- `background.js`:
  - `tabLinks = new Map()`.
  - On action / shortcut: read active tab, `chrome.tabs.captureVisibleTab`, look up tabId in `tabLinks`, `POST /api/snapshot/freeze` accordingly. On pending response, do **not** link the tab (link only happens on Open flow).
  - `chrome.tabs.onRemoved` → `tabLinks.delete(tabId)`.
  - `chrome.runtime.onMessageExternal` → handle `{type: "open", snapshotId, url}`: existing-link branch focuses the tab, otherwise creates and records the link.
- `options.html` / `options.js`: single field for server port, stored via `chrome.storage.sync`.

### 9. End-to-end verification

Following the existing verification checklist in `doc/technical-design.md`, plus:

- Freeze an unlinked tab → pending entry appears in Components tab.
- Promote → new heading appears in the Org file; canvas reloads; history shows `snapshot-promote`.
- Click the rendered snapshot → tab opens; click again → existing tab is focused.
- Re-freeze the linked tab → component attrs and PNG update in place; history shows `snapshot-overwrite`.
- Restore the pre-promote snapshot from history → heading and component are removed; PNG file remains on disk (acceptable for v1; a cleanup pass is deferred).
- Close the linked tab → next click on the snapshot opens a fresh tab.

