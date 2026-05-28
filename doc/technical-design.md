# Technical Design

OrgHTML is implemented as a local Python web server plus a vanilla HTML/CSS/JavaScript frontend.

## Architecture

Server:

- `orghtml_server.py`
- serves the app assets
- serves project files from `--root`
- parses Org documents
- reads and writes `.orghtml/workspace.json`
- manages snapshot history in SQLite
- imports local data into an in-memory SQLite database
- executes read-only SQL for named sources and custom components

Frontend:

- `index.html`
- `src/app.js`
- `src/styles.css`
- renders the workspace
- handles canvas interactions
- edits source/text/component directives
- renders built-in components
- runs custom components in sandboxed iframes

## Source and Workspace Roots

The app distinguishes two roots:

- app root: where `index.html`, `src/`, and server code live
- project root: the `--root` directory containing Org/data files

Static app assets are served from the app root. Org files, data files, assets, and `.orghtml/` are served from the project root.

## Server Data Flow

Document load:

1. Read the Org file.
2. Read `.orghtml/workspace.json` if present.
3. Build the effective workspace document:
   - document camera/nodes/links from `documents[path]`
   - workspace custom components from top-level `customComponents`
   - workspace SQL sources from top-level `sqlSources`
4. Parse headings and supported content.
5. Build named data sources.
6. Return source text plus parsed workspace state.

Source save:

1. Snapshot current state.
2. Insert missing IDs if needed.
3. Write source text.
4. Reparse and return updated state.

Sidecar save:

1. Snapshot current state.
2. Write camera, node layout, and visual links to `workspace.json`.
3. Leave workspace-level SQL/custom-component definitions untouched.

SQL query:

1. Read current document and effective workspace.
2. Import named Org tables.
3. Import external CSV/JSONL files.
4. Evaluate workspace SQL sources.
5. Execute a read-only `SELECT` or `WITH` query.
6. Return `{ columns, rows }`.

## Org Parser Scope

The parser is intentionally targeted, not a full Org implementation.

It recognizes:

- headings
- property drawers
- `ID` properties
- `#+name:`
- `#+orghtml_component:`
- `#+orghtml_view:`
- `#+begin_src sql` / `#+end_src`
- Org tables
- standalone local image links

It preserves ordered block content across text, components, tables, and images.

Unsupported Org constructs are treated as text.

## Block Model

Frontend block shape:

```js
{
  id,
  title,
  components,
  content,
  position,
  size,
  layout,
  diagnostics
}
```

`content` is ordered. Text chunks are edited by `textIndex`.

Known weakness:

- `textIndex` is positional and can become fragile if an edit introduces new structured Org elements. A later design should use stable source spans or chunk IDs.

## Layout Engine

Each block has a layout mode.

`free`:

- explicit world-space `x` and `y`
- set when a block is dragged

`flow`:

- follows another block by ID
- recomputed from actual rendered block height
- uses `gap`

The frontend uses `ResizeObserver` to recompute flow layout when content height changes.

## Rendering

The canvas area uses:

- DOM block cards for content and interaction
- an SVG/canvas-like edge layer for visual links
- a shared camera transform for pan and zoom

Dragging a block updates only the moved block transform during pointer movement. Full rerender happens at the end of the interaction.

Wheel behavior:

- `Cmd`/`Ctrl` + wheel zooms
- plain wheel pans the viewport
- scrollable component content gets first chance to consume wheel events

## Built-In Components

Built-ins are rendered directly in the main frontend:

- `table`
- `image`
- `chart`
- `board`
- `cards`
- `log`
- `gallery`
- `form`
- `pdf`
- `webSnapshot`

They consume data through `loadData(source)`, which checks:

1. inline data
2. named sources from the parsed document/workspace
3. `/api/data?path=...` for external files

## Custom Components

Custom components are workspace-local.

Workspace definition:

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

Org placement:

```org
#+orghtml_component: custom definition=status_pills source=capture_status_counts
```

Runtime:

- component code is loaded from `.orghtml/components/`
- optional CSS is loaded from `.orghtml/components/`
- each instance runs in a sandboxed iframe
- the iframe receives a constrained `ctx`
- SQL queries are proxied through `postMessage` to `/api/sql-query`

See `.orghtml/README.md` for the exact component API.

## SQL and Data

The server builds an in-memory SQLite database per parse/query operation.

Imported sources:

- named Org tables
- named document SQL blocks
- workspace SQL files
- external `.csv`
- external `.jsonl`

External file tables get generated names such as:

```text
file_data_tasks_csv
```

The helper table `orghtml_sources` maps external paths to generated table names.

Only read-only SQL is accepted for custom component queries:

- `SELECT`
- `WITH`

## History

History is stored in:

```text
.orghtml/history.sqlite
```

Snapshots include:

- document path
- timestamp
- reason
- source file contents
- document sidecar entry

Restore snapshots the current state first, then restores the selected source and sidecar entry.

## Security Model

This is a local trusted tool.

Current containment:

- custom components run in sandboxed iframes
- custom components do not receive main app DOM access
- SQL API accepts read-only queries only
- sidecar file references must stay under `.orghtml/`
- project file access is constrained to `--root`

Current limits:

- custom JS is still trusted workspace code
- no package isolation
- no network policy enforcement inside component code beyond browser/runtime defaults

## Verification Checklist

Before considering a change complete:

1. Run `python3 -m py_compile orghtml_server.py`.
2. Validate `.orghtml/workspace.json`.
3. Load `sample.org`.
4. Confirm blocks render.
5. Confirm built-in components render.
6. Confirm custom components render.
7. Confirm `ctx.query(sql)` works.
8. Confirm source save and sidecar save still work.
9. Confirm history restore still works after a mutation.
