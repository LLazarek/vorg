# Prototype MVP

The current prototype is a local web app for exploring malleable interfaces over Org files.

Run it with:

```sh
python3 orghtml_server.py --host 127.0.0.1 --port 8765
```

Then open:

```text
http://127.0.0.1:8765/
```

Use `--root /path/to/workspace` to point the app at another directory of Org/data files.

## Demo Workspace

`sample.org` is the canonical demo document. It exercises:

- heading blocks
- editable text chunks
- built-in components
- named Org tables
- inline table views
- external CSV/JSONL data
- local images
- sidecar SQL files
- sidecar custom components
- visual links
- flow and free block layout

Related files:

- `.orghtml/workspace.json`
- `.orghtml/queries/capture_status_counts.sql`
- `.orghtml/components/status_pills.js`
- `.orghtml/README.md`

## Mental Model

An Org heading becomes a block.

A block contains:

- the heading title
- editable text chunks
- standard inline Org elements that OrgHTML understands
- components placed by `#+orghtml_component:`

A component is a visual or interactive view inside a block.

Examples:

```org
#+orghtml_component: table source=capture_table columns=signal,status,note
#+orghtml_component: board source=capture_table group=status titleColumn=signal
#+orghtml_component: custom definition=status_pills source=capture_status_counts
```

## What To Try

1. Load `sample.org`.
2. Drag blocks around the canvas.
3. Resize a block from its bottom-right handle.
4. Use two-finger scroll or mouse wheel to pan the canvas.
5. Hold `Cmd` or `Ctrl` while scrolling to zoom.
6. Scroll inside a long table or board to confirm the component scrolls before the viewport pans.
7. Select a block and shift-click another block to toggle a visual link.
8. Edit text inside a block and confirm the source pane updates.
9. Edit a component in the inspector and confirm the Org directive changes.
10. Edit `.orghtml/queries/capture_status_counts.sql` or `.orghtml/components/status_pills.js`, then reload the document.
11. Use the history panel to restore an earlier snapshot.

## Persistence

Source saves write to the Org file.

Sidecar saves write to:

```text
.orghtml/workspace.json
```

Snapshots are stored in:

```text
.orghtml/history.sqlite
```

Before mutating source or sidecar state, the server snapshots the current state so changes can be restored.

## Current Boundaries

This prototype supports enough editing to evaluate the design, but it is not a complete Org editor.

Supported:

- block text editing
- source pane editing
- component directive editing
- sidecar layout editing through the canvas
- manual sidecar SQL/component file editing

Not yet supported:

- heading title editing from the canvas
- subtree editing from the canvas
- full Org markup rendering
- multi-document workspaces
- in-app editing for sidecar JS/SQL files
- reusable component packages
