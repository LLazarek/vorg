# Project Plan

OrgHTML is a local malleable interface for plaintext workspaces. The goal is to keep durable content in ordinary Org files while allowing visual layout, derived data views, and custom interactive components to live in a sidecar workspace.

## Product Direction

The core interaction loop is:

1. Write or load an Org document.
2. Render each heading as a visual block.
3. Place, resize, and link blocks spatially.
4. Add components inside blocks using `#+orghtml_component:` directives.
5. Use named tables, SQL, and local files as data sources.
6. Add sidecar custom components when built-in views are not enough.
7. Iterate by editing Org source, sidecar files, or generated recipes.

This is not meant to become a replacement for Org mode. It is a layer over Org that makes documents and data more malleable without abandoning plaintext.

## Design Commitments

- Org remains readable outside OrgHTML.
- Blocks correspond one-to-one with Org headings.
- Component placement remains explicit in Org source.
- Layout and view implementation details live in `.orghtml/`.
- Sidecar custom components and SQL sources are workspace-local.
- Code and complex SQL live in files, not JSON strings.
- The app runs as a local Python web server.
- The system should prefer small, inspectable file formats over opaque state.

## Current MVP Capabilities

Document model:

- load Org files from a project root
- render headings as blocks
- preserve source order among text, components, tables, and images
- edit block text chunks from the canvas
- edit full source text in the source pane
- insert missing heading IDs on source save

Canvas:

- pan and zoom
- drag blocks
- resize blocks
- save sidecar layout
- flow layout for newly discovered headings
- visual block links with shift-click toggle
- component-specific scrolling before viewport panning

Components:

- table
- image
- chart
- board
- cards
- log
- gallery
- form
- custom iframe component

Data:

- named Org tables
- inline Org table views through `#+orghtml_view:`
- external CSV and JSONL files
- local image assets
- document-local named SQL source blocks
- workspace-local SQL files under `.orghtml/queries/`
- custom components with `ctx.query(sql)`

Safety:

- source/sidecar snapshots in SQLite before mutations
- restore previous document states
- load is non-mutating
- missing IDs and source/data errors surface as diagnostics

## Near-Term Priorities

1. Improve custom component authoring
   - add more examples
   - document patterns for charts and small dashboards
   - consider a lightweight in-app sidecar file browser later

2. Strengthen data querying
   - expose schema discovery to users
   - make external table names easier to discover
   - improve SQL error display in custom components

3. Improve source-span robustness
   - replace positional text chunk indexes with more stable source spans
   - reduce parser/editor surprises around newly introduced structured Org content

4. Improve component configuration
   - make inspector controls more type-aware
   - support richer field editors for board/table/chart params
   - surface missing data/component definitions more clearly

5. Expand examples
   - realistic course/session planning workspace
   - research synthesis workspace
   - task/project dashboard
   - custom chart component using SQL

## Deferred Work

- direct heading title editing
- subtree editing
- multi-document cross-file links
- full Org syntax rendering
- collaborative editing
- package/plugin system for reusable component libraries
- arbitrary write access from custom components
- long-lived custom component cleanup hooks

## Main Risks

Parser/editing fidelity:

The most fragile behavior is still editing text around structured Org constructs. The current parser is intentionally small and targeted, so source edits should remain conservative.

Custom component safety:

Custom JS runs in sandboxed iframes, but it is still trusted local workspace code. The app should keep the API narrow and avoid direct access to main app internals.

Sidecar drift:

Layout and view definitions depend on stable heading IDs and source names. Diagnostics should keep improving so broken references are obvious.

Scope creep:

The project gets much more complicated if it tries to become a complete Org editor. The useful boundary is a malleable view and interaction layer over regular Org.
