# OrgHTML

OrgHTML is a local prototype for building malleable visual interfaces over ordinary Org files.

The core idea is simple:

- Org headings become visual blocks.
- Blocks can contain prose, standard Org elements, and interactive components.
- Fine-grained component placement stays in the Org source through `#+orghtml_component:` directives.
- Spatial layout, visual links, custom component definitions, SQL views, and history live in `.orghtml/`.

This lets a plain text document act as both a durable source file and the backing data model for a richer local workspace.

## Quick Start

Run the local server:

```sh
python3 orghtml_server.py --host 127.0.0.1 --port 8765
```

Open:

```text
http://127.0.0.1:8765/
```

To open a different workspace root:

```sh
python3 orghtml_server.py --host 127.0.0.1 --port 8765 --root /path/to/workspace
```

The default demo is `sample.org`.

## What It Does

Current prototype functionality includes:

- rendering Org headings as movable/resizable blocks
- flow layout for fresh documents and free layout after dragging
- canvas pan/zoom
- visual links between blocks
- source pane editing
- block text editing from the canvas
- component inspector editing for `#+orghtml_component:` directives
- rendering standard Org tables and local image links
- named Org tables as data sources
- read-only SQL views over workspace data
- built-in table, image, chart, board, cards, log, gallery, form, and pdf components
- custom JS components loaded from `.orghtml/components/`
- custom components querying workspace data with SQL
- snapshot/restore history in `.orghtml/history.sqlite`

## Project Model

Org source owns durable content:

- headings
- prose
- heading IDs
- named Org tables
- local links/images
- `#+orghtml_component:` placement directives

The `.orghtml/` sidecar owns workspace behavior:

- block layout
- camera state
- visual links
- custom component definitions
- workspace SQL source definitions
- snapshot history

Custom component code and SQL live in files rather than JSON strings:

```text
.orghtml/
  workspace.json
  components/
    status_pills.js
  queries/
    capture_status_counts.sql
  history.sqlite
```

## Example

Org source:

```org
#+name: capture_table
| signal | status | note         |
|--------+--------+--------------|
| energy | logged | steady       |
| focus  | review | check weekly |

#+orghtml_component: custom definition=status_pills source=capture_status_counts title="Status summary"
```

Sidecar:

```json
{
  "customComponents": {
    "status_pills": {
      "codeFile": "components/status_pills.js"
    }
  },
  "sqlSources": {
    "capture_status_counts": {
      "file": "queries/capture_status_counts.sql"
    }
  }
}
```

## Documentation

- [Prototype MVP](doc/prototype-mvp.md): how to run and evaluate the current prototype.
- [Data Contract](doc/data-contract.md): Org/source/sidecar persistence model.
- [Technical Design](doc/technical-design.md): server, frontend, parser, SQL, and rendering architecture.
- [Project Plan](doc/plan.md): goals, priorities, deferred work, and risks.
- [.orghtml README](.orghtml/README.md): custom component and sidecar file interface.

## Status

This is an active prototype. The current goal is to evaluate whether Org plus sidecar-defined layout, SQL, and custom components is a viable foundation for generative/malleable interfaces over plaintext documents and data.

It is not yet a complete Org editor. Heading title editing, subtree editing, multi-document workspaces, and reusable component packages are intentionally deferred.
