# Data Contract

OrgHTML uses ordinary Org files for durable document content and a `.orghtml/` sidecar directory for workspace state, view logic, and history.

## Ownership Split

Org source owns:

- headings
- heading `ID` properties
- prose inside headings
- named Org tables
- local Org links, including inline image links
- `#+orghtml_component:` directives that place components inside a heading block
- optional `#+orghtml_view:` directives immediately above inline Org tables
- optional named `sql` source blocks

The sidecar owns:

- block layout
- camera position
- visual links between blocks
- workspace-local SQL source definitions
- workspace-local custom component definitions
- snapshot history

The current design intentionally does not store layout or visual links in per-heading Org properties.

## Org Headings and Blocks

Each Org heading maps one-to-one to a visual block.

Required for full editing/layout persistence:

```org
* Heading title
:PROPERTIES:
:ID: 1a24be18-6984-4dbd-b651-2435ad8c5a2b
:END:
```

Rules:

- `ID` is the stable block identifier.
- Missing IDs are reported on load.
- IDs are inserted when the source is explicitly saved.
- Duplicate IDs are diagnostics and should be treated as unsafe for persistence.
- Heading title editing is not part of the current MVP.

## Block Content

The parser preserves source order among supported content items:

- text chunks
- `#+orghtml_component:` directives
- inline Org tables
- local image links
- named SQL source blocks

Frontend block content shape:

```js
{
  id: "heading-id",
  title: "Heading title",
  components: [...],
  content: [
    { kind: "text", textIndex: 0, text: "..." },
    { kind: "component", componentId: "...", component: {...} },
    { kind: "orgTable", table: {...}, view: null },
    { kind: "image", image: {...} }
  ]
}
```

`content` is the canonical ordered structure. There is no legacy aggregate `body` field.

## Component Directives

Component instances live in Org source:

```org
#+orghtml_component: table source=capture_table columns=status,note sort=-status
#+orghtml_component: board source=capture_table group=status titleColumn=signal
#+orghtml_component: custom definition=status_pills source=capture_status_counts title="Status summary"
```

Rules:

- The first token is the component type.
- Remaining tokens are parsed as shell-style `key=value` attrs.
- Component placement is fine-grained and source-local.
- Component implementation details belong in the sidecar only when the type is `custom`.

Current built-in types:

- `table`
- `image`
- `chart`
- `board`
- `cards`
- `log`
- `gallery`
- `form`
- `pdf`
- `custom`

## Inline Org Tables

Standard Org tables render inline inside blocks.

```org
#+name: capture_table
#+orghtml_view: board group=status titleColumn=signal
| signal | status | note         |
|--------+--------+--------------|
| energy | logged | steady       |
| focus  | review | check weekly |
```

Rules:

- `#+name:` makes the table available as a named data source.
- `#+orghtml_view:` changes how that inline table is rendered.
- Without `#+orghtml_view:`, it renders as a table.
- The header row is not included as data.

## SQL Sources

There are two SQL source mechanisms.

Document-local named SQL blocks:

```org
#+name: capture_logged
#+begin_src sql
select signal, status, note
from capture_table
where status = 'logged'
#+end_src
```

Workspace-local sidecar SQL sources:

```json
{
  "sqlSources": {
    "capture_status_counts": {
      "file": "queries/capture_status_counts.sql"
    }
  }
}
```

Sidecar SQL files live under `.orghtml/queries/`.

Rules:

- SQL sources are read-only.
- Queries are evaluated against an in-memory SQLite database.
- Workspace SQL source definitions must use file references.
- Inline SQL strings in `workspace.json` are not supported.

Available SQL tables include:

- named Org tables in the current document
- named SQL source results
- imported CSV/JSONL files under the project root
- `orghtml_sources`, mapping external data paths to generated SQLite table names

## Sidecar Workspace

Main file:

```text
.orghtml/workspace.json
```

Top-level shape:

```json
{
  "version": 1,
  "customComponents": {
    "status_pills": {
      "codeFile": "components/status_pills.js"
    }
  },
  "sqlSources": {
    "capture_status_counts": {
      "file": "queries/capture_status_counts.sql"
    }
  },
  "documents": {
    "sample.org": {
      "camera": { "x": 20, "y": 20, "zoom": 1 },
      "nodes": {},
      "links": []
    }
  }
}
```

Workspace-local definitions:

- `customComponents` is workspace-scoped only.
- `sqlSources` is workspace-scoped only.
- Document-local custom components and sidecar SQL definitions are not supported.

Document state:

```json
{
  "camera": { "x": 20, "y": 20, "zoom": 1 },
  "nodes": {
    "heading-id": {
      "layout": "free",
      "x": 80,
      "y": 80,
      "width": 760,
      "height": null,
      "after": null,
      "gap": 28
    }
  },
  "links": [
    { "source": "source-heading-id", "target": "target-heading-id", "kind": "visual" }
  ]
}
```

## Layout Modes

Blocks support two layout modes.

`free`:

- uses explicit `x` and `y`
- created by dragging a block
- used for the first unsaved block

`flow`:

- follows another block by ID
- computes `y` from the previous block's rendered height plus `gap`
- used by default for newly discovered headings after the first heading

Example:

```json
{
  "layout": "flow",
  "after": "previous-heading-id",
  "gap": 28,
  "x": 80,
  "y": 420,
  "width": 760,
  "height": null
}
```

## Custom Components

Custom component code lives under `.orghtml/components/` and is referenced from `workspace.json`.

```json
{
  "customComponents": {
    "status_pills": {
      "codeFile": "components/status_pills.js",
      "cssFile": "components/status_pills.css"
    }
  }
}
```

Rules:

- `codeFile` is required.
- `cssFile` is optional.
- paths are relative to `.orghtml/`.
- files must stay inside `.orghtml/`.
- components render in sandboxed iframes.

See `.orghtml/README.md` for the runtime `ctx` API.

## History

Snapshots are stored in:

```text
.orghtml/history.sqlite
```

The server snapshots the current document and its sidecar document entry before mutations such as:

- source save
- block text save
- component add/update/delete
- sidecar save
- recipe apply
- restore

History is document-scoped in the UI.
