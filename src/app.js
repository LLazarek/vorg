const NODE_WIDTH = 320;
const NODE_MIN_WIDTH = 280;
const NODE_MIN_HEIGHT = 112;
const ZOOM_MIN = 0.35;
const ZOOM_MAX = 2.2;
const SCROLLBAR_HIT_SIZE = 12;

const elements = {
  fileSelect: document.getElementById("file-select"),
  refreshFiles: document.getElementById("refresh-files"),
  reloadDocument: document.getElementById("reload-document"),
  saveSource: document.getElementById("save-source"),
  toggleSourcePanel: document.getElementById("toggle-source-panel"),
  toggleInspectorPanel: document.getElementById("toggle-inspector-panel"),
  loadSample: document.getElementById("load-sample"),
  generateWorkspace: document.getElementById("generate-workspace"),
  generateRecipe: document.getElementById("generate-recipe"),
  applyRecipe: document.getElementById("apply-recipe"),
  saveFile: document.getElementById("save-file"),
  createLink: document.getElementById("create-link"),
  deleteLink: document.getElementById("delete-link"),
  sourceInput: document.getElementById("source-input"),
  recipeInput: document.getElementById("recipe-input"),
  sourceStatus: document.getElementById("source-status"),
  workspaceStatus: document.getElementById("workspace-status"),
  inspectorStatus: document.getElementById("inspector-status"),
  componentInspector: document.getElementById("component-inspector"),
  refreshMetadata: document.getElementById("refresh-metadata"),
  scanSettings: document.getElementById("scan-settings"),
  scanSettingsDialog: document.getElementById("scan-settings-dialog"),
  scanDirsList: document.getElementById("scan-dirs-list"),
  scanSettingsSave: document.getElementById("scan-settings-save"),
  scanSettingsCancel: document.getElementById("scan-settings-cancel"),
  projectPalette: document.getElementById("project-palette"),
  diagnostics: document.getElementById("diagnostics"),
  historyList: document.getElementById("history-list"),
  pendingSnapshots: document.getElementById("pending-snapshots"),
  pendingStatus: document.getElementById("pending-status"),
  extensionStatus: document.getElementById("extension-status"),
  sourcePanel: document.querySelector(".source-panel"),
  inspectorPanel: document.querySelector(".inspector-panel"),
  workspace: document.querySelector(".workspace"),
  viewport: document.getElementById("viewport"),
  world: document.getElementById("world"),
  edgeCanvas: document.getElementById("edge-canvas")
};

const state = {
  path: null,
  blocks: [],
  links: [],
  selectedIds: new Set(),
  camera: { x: 20, y: 20, zoom: 1 },
  drag: null,
  resize: null,
  pan: null,
  dirty: false,
  linkMode: false,
  selectedComponentId: null,
  metadata: { tables: [], imageDirs: [] },
  namedSources: {},
  customComponents: {},
  sqlSources: {},
  history: [],
  sourceDirty: false,
  sourceCollapsed: true,
  inspectorCollapsed: true,
  extensionConnected: false,
  scanConfig: { dirs: [{ path: ".", recursive: false }] }
};
const dataCache = new Map();
const bodySaveTimers = new Map();
let _sidecarSaveTimer = null;
const blockResizeObserver = new ResizeObserver(() => {
  applyFlowLayout();
  drawEdges();
});
const COMPONENT_SCHEMAS = {
  board: ["source", "group", "title", "titleColumn", "columns", "sort", "color", "limit"],
  cards: ["source", "columns", "title", "limit"],
  chart: ["source", "x", "y", "title", "limit"],
  custom: ["definition", "source", "title"],
  form: ["target", "fields", "submit"],
  gallery: ["source", "path", "title", "limit"],
  image: ["path", "source", "alt"],
  log: ["source", "title", "limit"],
  pdf: ["path", "title", "page", "height"],
  table: ["source", "columns", "sort", "title", "limit"],
  websnapshot: ["id", "url", "title", "frozen_at"]
};
const COMPONENT_TYPES = Object.keys(COMPONENT_SCHEMAS).filter((t) => t !== "websnapshot");

function setStatus(element, text, variant = "") {
  element.textContent = text;
  element.className = variant ? `status-pill ${variant}` : "status-pill";
}

async function apiGet(path) {
  const response = await fetch(path);
  if (!response.ok) {
    const text = await response.text();
    const error = new Error(text || response.statusText);
    error.status = response.status;
    error.path = path;
    throw error;
  }
  return response.json();
}

async function apiPost(path, payload) {
  const response = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  if (!response.ok) {
    throw new Error(await response.text());
  }
  return response.json();
}

async function refreshFiles() {
  const result = await apiGet("/api/files");
  if (result.scanConfig) {
    state.scanConfig = result.scanConfig;
  }
  elements.fileSelect.replaceChildren();

  result.files.forEach((path) => {
    const option = document.createElement("option");
    option.value = path;
    option.textContent = path;
    elements.fileSelect.append(option);
  });

  if (!result.files.length) {
    const option = document.createElement("option");
    option.textContent = "No .org files found";
    elements.fileSelect.append(option);
  }

  return result.files;
}

async function refreshMetadata() {
  state.metadata = await apiGet("/api/metadata");
  renderProjectPalette();
}

async function refreshHistory() {
  if (!state.path) {
    state.history = [];
    renderHistory();
    return;
  }
  const result = await apiGet(`/api/history?path=${encodeURIComponent(state.path)}`);
  state.history = result.snapshots || [];
  renderHistory();
}

async function loadDocument(path) {
  bodySaveTimers.forEach((timer) => clearTimeout(timer));
  bodySaveTimers.clear();
  const result = await apiGet(`/api/document?path=${encodeURIComponent(path)}`);
  state.path = result.path;
  state.blocks = result.parsed.blocks;
  state.links = result.parsed.links;
  state.namedSources = result.parsed.namedSources || {};
  state.customComponents = result.parsed.customComponents || {};
  state.sqlSources = result.parsed.sqlSources || {};
  state.camera = result.parsed.camera || { x: 20, y: 20, zoom: 1 };
  state.selectedIds.clear();
  state.selectedComponentId = null;
  state.dirty = false;
  state.sourceDirty = false;
  state.linkMode = false;
  elements.sourceInput.value = result.text;
  if (result.idsMissing) {
    setStatus(elements.sourceStatus, `Loaded ${path} - ${result.idsMissing} missing IDs; save source to enable editing`, "muted");
  } else {
    setStatus(elements.sourceStatus, `Loaded ${path}`, "ok");
  }
  render();
  refreshHistory().catch((error) => setStatus(elements.sourceStatus, error.message, "error"));
  refreshMetadata().catch((error) => setStatus(elements.sourceStatus, error.message, "error"));
}

async function saveSource() {
  if (!state.path) {
    return;
  }
  const previousBlocks = state.blocks;
  const previousLinks = state.links;
  const result = await apiPost("/api/source-save", {
    path: state.path,
    text: elements.sourceInput.value
  });
  state.blocks = mergeLocalBlockLayout(previousBlocks, result.parsed.blocks);
  state.links = previousLinks;
  state.namedSources = result.parsed.namedSources || {};
  state.customComponents = result.parsed.customComponents || {};
  state.sqlSources = result.parsed.sqlSources || {};
  elements.sourceInput.value = result.text;
  state.sourceDirty = false;
  render();
  await refreshHistory();
  setStatus(elements.sourceStatus, result.idsInserted ? `Saved ${state.path}; inserted IDs` : `Saved ${state.path}`, "ok");
}

async function reloadDocument() {
  if (!state.path) {
    return;
  }
  if (!confirmDiscardLocalChanges()) {
    return;
  }
  await loadDocument(state.path);
  setStatus(elements.sourceStatus, `Reloaded ${state.path}`, "ok");
}

async function saveWorkspace() {
  if (!state.path) {
    return;
  }

  await apiPost("/api/save-workspace", {
    path: state.path,
    camera: state.camera,
    nodes: state.blocks.map((block) => ({
      id: block.id,
      x: block.position.x,
      y: block.position.y,
      width: block.size?.width,
      height: block.size?.height,
      layout: block.layout?.mode || "free",
      after: block.layout?.after || null,
      gap: block.layout?.gap ?? 28
    })),
    links: state.links.map((link) => ({
      source: link.sourceId,
      target: link.targetId,
      kind: "visual"
    }))
  });

  state.dirty = false;
  setStatus(elements.sourceStatus, `Saved .orghtml/workspace.json`, "ok");
  setStatus(elements.workspaceStatus, `${state.blocks.length} blocks`, "ok");
  await refreshHistory();
}

function scheduleSidecarSave(delay = 800) {
  if (_sidecarSaveTimer) {
    clearTimeout(_sidecarSaveTimer);
  }
  _sidecarSaveTimer = setTimeout(() => {
    _sidecarSaveTimer = null;
    if (state.dirty && state.path) {
      saveWorkspace().catch((error) => setStatus(elements.sourceStatus, error.message, "error"));
    }
  }, delay);
}

async function generateWorkspace() {
  if (!confirmDiscardLocalChanges()) {
    return;
  }
  const result = await apiPost("/api/generate-workspace", {});
  await refreshFiles();
  elements.fileSelect.value = result.path;
  await loadDocument(result.path);
  setStatus(elements.sourceStatus, `Generated ${result.path}`, "ok");
}

async function generateRecipe() {
  const recipe = await apiGet("/api/recipe/generate");
  elements.recipeInput.value = JSON.stringify(recipe, null, 2);
  setStatus(elements.sourceStatus, "Generated recipe JSON", "ok");
}

async function applyRecipe() {
  if (!confirmDiscardLocalChanges()) {
    return;
  }
  const recipe = JSON.parse(elements.recipeInput.value);
  const result = await apiPost("/api/recipe/apply", { recipe });
  await refreshFiles();
  elements.fileSelect.value = result.path;
  await loadDocument(result.path);
  setStatus(elements.sourceStatus, `Applied recipe to ${result.path}`, "ok");
}

async function openScanSettings() {
  const result = await apiGet("/api/scan-dirs");
  const subdirs = result.dirs;
  const scanConfig = result.scanConfig || state.scanConfig;
  const configByPath = {};
  (scanConfig.dirs || []).forEach((entry) => { configByPath[entry.path] = entry; });

  elements.scanDirsList.replaceChildren();

  [".", ...subdirs].forEach((dirPath) => {
    const entry = configByPath[dirPath];
    const included = !!entry;
    const recursive = entry?.recursive || false;

    const row = document.createElement("div");
    row.className = "scan-dir-row";

    const includeCheck = document.createElement("input");
    includeCheck.type = "checkbox";
    includeCheck.id = `scan-dir-${CSS.escape(dirPath)}`;
    includeCheck.dataset.path = dirPath;
    includeCheck.checked = included;

    const includeLabel = document.createElement("label");
    includeLabel.htmlFor = includeCheck.id;
    includeLabel.textContent = dirPath === "." ? "Root directory (.)" : dirPath;
    includeLabel.className = "scan-dir-label";

    const recursiveLabel = document.createElement("label");
    recursiveLabel.className = "scan-recursive-label";
    const recursiveCheck = document.createElement("input");
    recursiveCheck.type = "checkbox";
    recursiveCheck.checked = recursive;
    recursiveCheck.disabled = !included;
    recursiveLabel.append(recursiveCheck, " recursive");

    includeCheck.addEventListener("change", () => {
      recursiveCheck.disabled = !includeCheck.checked;
      if (!includeCheck.checked) recursiveCheck.checked = false;
    });

    row.append(includeCheck, includeLabel, recursiveLabel);
    elements.scanDirsList.append(row);
  });

  elements.scanSettingsDialog.showModal();
}

async function saveScanSettings() {
  const dirs = [];
  elements.scanDirsList.querySelectorAll(".scan-dir-row").forEach((row) => {
    const includeCheck = row.querySelector("input[type='checkbox'][data-path]");
    const recursiveCheck = row.querySelector(".scan-recursive-label input");
    if (includeCheck.checked) {
      dirs.push({ path: includeCheck.dataset.path, recursive: recursiveCheck.checked });
    }
  });
  const result = await apiPost("/api/save-scan-config", { dirs });
  state.scanConfig = result.scan;
  elements.scanSettingsDialog.close();
  await refreshFiles();
  await refreshMetadata();
  setStatus(elements.sourceStatus, "Scan settings saved.", "ok");
}

function render() {
  renderDiagnostics(collectDiagnostics());
  renderNodes();
  renderComponentInspector();
  syncCamera();
  requestAnimationFrame(drawEdges);
  setStatus(elements.workspaceStatus, `${state.blocks.length} blocks${state.dirty ? " - unsaved sidecar" : ""}`, state.dirty ? "muted" : "ok");
}

function hasLocalChanges() {
  return state.dirty || bodySaveTimers.size > 0 || state.sourceDirty;
}

function confirmDiscardLocalChanges() {
  if (!hasLocalChanges()) {
    return true;
  }
  return window.confirm("Discard unsaved source, layout, or pending text edits?");
}

function collectDiagnostics() {
  return state.blocks.flatMap((block) =>
    block.diagnostics.map((message) => ({
      headingTitle: block.title,
      message
    }))
  );
}

function renderDiagnostics(diagnostics) {
  elements.diagnostics.replaceChildren();
  if (!diagnostics.length) {
    return;
  }
  diagnostics.slice(0, 8).forEach((diagnostic) => {
    const item = document.createElement("div");
    item.className = "diagnostic";
    item.textContent = diagnostic.headingTitle
      ? `${diagnostic.headingTitle}: ${diagnostic.message}`
      : diagnostic.message;
    elements.diagnostics.append(item);
  });
}

function renderProjectPalette() {
  elements.projectPalette.replaceChildren();
  const block = selectedBlock();

  if (!state.metadata.tables.length && !state.metadata.imageDirs.length) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.innerHTML = `No data files found in scanned directories. <button type="button" class="inline-link-button">Scan settings…</button>`;
    empty.querySelector("button").addEventListener("click", () => {
      openScanSettings().catch((error) => setStatus(elements.sourceStatus, error.message, "error"));
    });
    elements.projectPalette.append(empty);
    return;
  }

  state.metadata.tables.forEach((table) => {
    const item = document.createElement("section");
    item.className = "palette-item";
    const columns = table.columns.join(", ");
    item.innerHTML = `
      <h3>${escapeHtml(table.path)}</h3>
      <p>${escapeHtml(table.kind.toUpperCase())} · ${table.rows} rows</p>
      <p>${escapeHtml(columns)}</p>
    `;
    const actions = document.createElement("div");
    actions.className = "palette-actions";
    componentSuggestionsForTable(table).forEach((suggestion) => {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = suggestion.type;
      button.disabled = !block;
      button.addEventListener("click", () => addComponentToBlock(block.id, suggestion.type, suggestion.attrs));
      actions.append(button);
    });
    item.append(actions);
    elements.projectPalette.append(item);
  });

  state.metadata.imageDirs.forEach((directory) => {
    const item = document.createElement("section");
    item.className = "palette-item";
    item.innerHTML = `
      <h3>${escapeHtml(directory.path)}</h3>
      <p>${directory.images} images</p>
    `;
    const actions = document.createElement("div");
    actions.className = "palette-actions";
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = "gallery";
    button.disabled = !block;
    button.addEventListener("click", () => addComponentToBlock(block.id, "gallery", {
      source: directory.path,
      limit: "8"
    }));
    actions.append(button);
    item.append(actions);
    elements.projectPalette.append(item);
  });
}

function componentSuggestionsForTable(table) {
  const columns = table.columns;
  const lower = columns.map((column) => column.toLowerCase());
  const suggestions = [
    { type: "table", attrs: { source: table.path, columns: columns.slice(0, 5).join(","), limit: "8" } },
    { type: "cards", attrs: { source: table.path, columns: columns.slice(0, 4).join(","), limit: "6" } }
  ];
  if (lower.includes("status")) {
    suggestions.push({ type: "board", attrs: { source: table.path, group: columns[lower.indexOf("status")], limit: "8" } });
  }
  const numeric = columns.find((column) => table.kind === "jsonl" || ["completed", "amount", "count", "energy"].includes(column.toLowerCase()));
  if (columns.length >= 2 && numeric) {
    suggestions.push({ type: "chart", attrs: { source: table.path, x: columns.find((column) => column !== numeric) || columns[0], y: numeric, limit: "10" } });
  }
  if (table.kind === "jsonl") {
    suggestions.push({ type: "log", attrs: { source: table.path, limit: "8" } });
    suggestions.push({ type: "form", attrs: { target: table.path, fields: columns.map((column) => `${column}:text`).join(","), submit: "Append" } });
  }
  return suggestions;
}

function selectComponent(blockId, componentId) {
  state.selectedComponentId = componentId;
  state.selectedIds.clear();
  state.selectedIds.add(blockId);
  renderNodes();
  renderComponentInspector();
  renderProjectPalette();
}

function selectedComponent() {
  for (const block of state.blocks) {
    const component = block.components.find((candidate) => candidate.id === state.selectedComponentId);
    if (component) {
      return { block, component };
    }
  }
  return null;
}

function renderComponentInspector() {
  const selection = selectedComponent();
  elements.componentInspector.replaceChildren();

  if (!selection) {
    renderBlockInspector();
    return;
  }

  const { block, component } = selection;
  elements.componentInspector.className = "component-inspector";
  setStatus(elements.inspectorStatus, component.type, "ok");

  const form = document.createElement("form");
  form.className = "inspector-form";

  const typeField = componentTypeField(component.type);
  form.append(typeField);

  const attrsTitle = document.createElement("h3");
  attrsTitle.textContent = "Parameters";
  form.append(attrsTitle);

  const fieldsContainer = document.createElement("div");
  fieldsContainer.className = "inspector-fields";
  form.append(fieldsContainer);

  const addRow = document.createElement("div");
  addRow.className = "inspector-add-row";
  addRow.innerHTML = `
    <input name="new-key" placeholder="parameter">
    <input name="new-value" placeholder="value">
  `;
  form.append(addRow);

  const actions = document.createElement("div");
  actions.className = "inspector-actions";
  const save = document.createElement("button");
  save.type = "submit";
  save.textContent = "Apply";
  const clear = document.createElement("button");
  clear.type = "button";
  clear.textContent = "Clear";
  const duplicate = document.createElement("button");
  duplicate.type = "button";
  duplicate.textContent = "Duplicate";
  const remove = document.createElement("button");
  remove.type = "button";
  remove.textContent = "Delete";
  remove.className = "danger-button";
  actions.append(save, duplicate, remove, clear);
  form.append(actions);

  renderInspectorFields(fieldsContainer, component.type, component.attrs);
  typeField.querySelector("select").addEventListener("change", (event) => {
    renderInspectorFields(fieldsContainer, event.target.value, readInspectorAttrs(fieldsContainer));
  });

  clear.addEventListener("click", () => {
    state.selectedComponentId = null;
    renderNodes();
    renderComponentInspector();
  });
  duplicate.addEventListener("click", () => {
    addComponentToBlock(block.id, component.type, { ...component.attrs });
  });
  remove.addEventListener("click", () => {
    deleteComponent(block.id, component.id);
  });

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const formData = new FormData(form);
    const nextType = String(formData.get("type") || component.type).trim();
    const nextAttrs = readInspectorAttrs(fieldsContainer);
    const newKey = String(formData.get("new-key") || "").trim();
    const newValue = String(formData.get("new-value") || "").trim();
    if (newKey && newValue) {
      nextAttrs[newKey] = newValue;
    }
    saveComponentUpdate(block.id, component.id, nextType, nextAttrs);
  });

  elements.componentInspector.append(form);
}

function renderBlockInspector() {
  const block = selectedBlock();
  if (!block) {
    elements.componentInspector.className = "component-inspector empty-state";
    elements.componentInspector.textContent = "Select a block or a component.";
    setStatus(elements.inspectorStatus, "None", "muted");
    return;
  }

  elements.componentInspector.className = "component-inspector";
  setStatus(elements.inspectorStatus, "Block", "ok");

  const shell = document.createElement("div");
  shell.className = "block-inspector";
  const title = document.createElement("h3");
  title.textContent = block.title;
  shell.append(title);

  const list = document.createElement("div");
  list.className = "component-list";
  block.components.forEach((component) => {
    const row = document.createElement("button");
    row.type = "button";
    row.textContent = component.type;
    row.addEventListener("click", () => selectComponent(block.id, component.id));
    list.append(row);
  });
  if (!block.components.length) {
    const empty = document.createElement("p");
    empty.className = "empty-state";
    empty.textContent = "No components in this block.";
    list.append(empty);
  }
  shell.append(list);

  const form = document.createElement("form");
  form.className = "inspector-form";
  const typeField = componentTypeField("table");
  form.append(typeField);
  const fieldsContainer = document.createElement("div");
  fieldsContainer.className = "inspector-fields";
  form.append(fieldsContainer);
  renderInspectorFields(fieldsContainer, "table", {});
  typeField.querySelector("select").addEventListener("change", (event) => {
    renderInspectorFields(fieldsContainer, event.target.value, readInspectorAttrs(fieldsContainer));
  });
  const add = document.createElement("button");
  add.type = "submit";
  add.textContent = "Add Component";
  form.append(add);
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const formData = new FormData(form);
    addComponentToBlock(block.id, String(formData.get("type") || "table"), readInspectorAttrs(fieldsContainer));
  });
  shell.append(form);

  elements.componentInspector.append(shell);
}

function selectedBlock() {
  if (state.selectedIds.size !== 1) {
    return null;
  }
  const [id] = [...state.selectedIds];
  return blockById(id);
}

function componentTypeField(value) {
  const label = document.createElement("label");
  label.className = "inspector-field";
  const span = document.createElement("span");
  span.textContent = "type";
  const select = document.createElement("select");
  select.name = "type";
  COMPONENT_TYPES.forEach((type) => {
    const option = document.createElement("option");
    option.value = type;
    option.textContent = type;
    option.selected = type === value;
    select.append(option);
  });
  label.append(span, select);
  return label;
}

const WEB_SNAPSHOT_READONLY = new Set(["id", "url", "title", "frozen_at"]);

function renderInspectorFields(container, type, currentAttrs) {
  const attrs = normalizeAttrsForType(type, currentAttrs);
  const isWebSnapshot = type === "websnapshot";
  container.replaceChildren();
  Object.entries(attrs).forEach(([key, value]) => {
    const field = inspectorField(key, value);
    if (isWebSnapshot && WEB_SNAPSHOT_READONLY.has(key)) {
      const input = field.querySelector("input");
      if (input) input.readOnly = true;
    }
    container.append(field);
  });
}

function normalizeAttrsForType(type, currentAttrs) {
  const existing = { ...currentAttrs };
  if (!existing.source && existing.path && ["board", "cards", "chart", "gallery", "log", "table"].includes(type)) {
    existing.source = existing.path;
  }
  if (!existing.path && existing.source && type === "image") {
    existing.path = existing.source;
  }
  if (!existing.target && existing.source && type === "form") {
    existing.target = existing.source;
  }
  if (!existing.source && existing.target && ["log", "table"].includes(type)) {
    existing.source = existing.target;
  }

  const schema = COMPONENT_SCHEMAS[type] || [];
  const attrs = {};
  schema.forEach((key) => {
    attrs[key] = existing[key] ?? "";
  });

  Object.keys(existing)
    .filter((key) => !schema.includes(key))
    .sort()
    .forEach((key) => {
      attrs[key] = existing[key];
    });
  return attrs;
}

function readInspectorAttrs(container) {
  const attrs = {};
  container.querySelectorAll("input[name]").forEach((input) => {
    const value = input.value.trim();
    if (value !== "") {
      attrs[input.name] = value;
    }
  });
  return attrs;
}

function inspectorField(name, value) {
  const label = document.createElement("label");
  label.className = "inspector-field";
  const span = document.createElement("span");
  span.textContent = name;
  const input = document.createElement("input");
  input.name = name;
  input.value = value === true ? "true" : String(value ?? "");
  label.append(span, input);
  return label;
}

async function saveComponentUpdate(blockId, componentId, type, attrs) {
  const previousBlocks = state.blocks;
  const previousLinks = state.links;
  const result = await apiPost("/api/component", {
    path: state.path,
    blockId,
    componentId,
    type,
    attrs
  });
  state.blocks = mergeLocalBlockLayout(previousBlocks, result.parsed.blocks);
  state.links = previousLinks;
  state.namedSources = result.parsed.namedSources || {};
  state.customComponents = result.parsed.customComponents || {};
  state.sqlSources = result.parsed.sqlSources || {};
  elements.sourceInput.value = result.text;
  state.selectedComponentId = componentId;
  dataCache.clear();
  render();
  await refreshHistory();
  setStatus(elements.sourceStatus, `Updated component in ${state.path}`, "ok");
}

async function addComponentToBlock(blockId, type, attrs) {
  const previousBlocks = state.blocks;
  const previousLinks = state.links;
  const result = await apiPost("/api/component-add", {
    path: state.path,
    blockId,
    type,
    attrs
  });
  state.blocks = mergeLocalBlockLayout(previousBlocks, result.parsed.blocks);
  state.links = previousLinks;
  state.namedSources = result.parsed.namedSources || {};
  state.customComponents = result.parsed.customComponents || {};
  state.sqlSources = result.parsed.sqlSources || {};
  elements.sourceInput.value = result.text;
  state.selectedIds.clear();
  state.selectedIds.add(blockId);
  state.selectedComponentId = result.componentId;
  dataCache.clear();
  render();
  await refreshHistory();
  setStatus(elements.sourceStatus, `Added ${type} component`, "ok");
}

async function deleteComponent(blockId, componentId) {
  const previousBlocks = state.blocks;
  const previousLinks = state.links;
  const result = await apiPost("/api/component-delete", {
    path: state.path,
    blockId,
    componentId
  });
  state.blocks = mergeLocalBlockLayout(previousBlocks, result.parsed.blocks);
  state.links = previousLinks;
  state.namedSources = result.parsed.namedSources || {};
  state.customComponents = result.parsed.customComponents || {};
  state.sqlSources = result.parsed.sqlSources || {};
  elements.sourceInput.value = result.text;
  state.selectedIds.clear();
  state.selectedIds.add(blockId);
  state.selectedComponentId = null;
  dataCache.clear();
  render();
  await refreshHistory();
  setStatus(elements.sourceStatus, "Deleted component", "ok");
}

function renderNodes() {
  const existing = new Map([...elements.world.querySelectorAll(".block-card")].map((node) => [node.dataset.id, node]));
  const liveIds = new Set();
  const defaultWidth = defaultBlockWidth();

  state.blocks.forEach((block) => {
    liveIds.add(block.id);
    block.size = block.size || {};
    block.layout = block.layout || { mode: block.hasSavedPosition ? "free" : "flow", after: null, gap: 28 };
    if (!block.size.width) {
      block.size.width = defaultWidth;
    }
    let node = existing.get(block.id);
    if (!node) {
      node = document.createElement("article");
      node.className = "block-card";
      node.dataset.id = block.id;
      node.innerHTML = `
        <h3></h3>
        <div class="block-content"></div>
        <button class="resize-handle" type="button" aria-label="Resize block"></button>
      `;
      node.addEventListener("pointerdown", handleNodePointerDown);
      node.addEventListener("click", handleNodeClick);
      node.querySelector(".resize-handle").addEventListener("pointerdown", handleResizePointerDown);
      elements.world.append(node);
      blockResizeObserver.observe(node);
    }

    node.classList.toggle("selected", state.selectedIds.has(block.id));
    node.classList.toggle("warn", block.diagnostics.length > 0);
    node.style.transform = `translate(${block.position.x}px, ${block.position.y}px)`;
    node.style.width = `${Math.max(NODE_MIN_WIDTH, block.size.width || defaultWidth)}px`;
    node.style.minHeight = `${NODE_MIN_HEIGHT}px`;
    node.style.height = block.size.height ? `${Math.max(NODE_MIN_HEIGHT, block.size.height)}px` : "";
    node.querySelector("h3").textContent = block.title;
    const contentKey = JSON.stringify(block.content);
    if (node.dataset.contentKey !== contentKey) {
      node.dataset.contentKey = contentKey;
      renderBlockContent(node.querySelector(".block-content"), block);
    }
  });

  applyFlowLayout();

  existing.forEach((node, id) => {
    if (!liveIds.has(id)) {
      blockResizeObserver.unobserve(node);
      node.remove();
    }
  });
}

function defaultBlockWidth() {
  const width = elements.viewport.clientWidth * 0.66;
  return Math.round(Math.max(NODE_MIN_WIDTH, Math.min(820, width)));
}

function applyFlowLayout() {
  state.blocks.forEach((block) => {
    const node = elements.world.querySelector(`[data-id="${CSS.escape(block.id)}"]`);
    if (!node) {
      return;
    }
    if (block.layout?.mode === "flow" && block.layout.after) {
      const previous = blockById(block.layout.after);
      const previousNode = elements.world.querySelector(`[data-id="${CSS.escape(block.layout.after)}"]`);
      if (previous && previousNode) {
        block.position.x = previous.position.x;
        block.position.y = previous.position.y + previousNode.offsetHeight + (block.layout.gap ?? 28);
      }
      node.style.transform = `translate(${block.position.x}px, ${block.position.y}px)`;
    }
  });
}

function handleBlockBodyInput(event) {
  const node = event.currentTarget.closest(".block-card");
  const block = blockById(node.dataset.id);
  if (!block) {
    return;
  }

  const textIndex = Number(event.currentTarget.dataset.textIndex);
  const body = editableText(event.currentTarget);
  resizeTextEditor(event.currentTarget);
  applyFlowLayout();
  drawEdges();
  updateLocalTextChunk(block, textIndex, body);
  bodySaveTimers.set(bodySaveKey(block.id, textIndex), true);
  setStatus(elements.sourceStatus, "Text changed - click away to save", "muted");
}

function handleBlockBodyBlur(event) {
  const node = event.currentTarget.closest(".block-card");
  const block = blockById(node.dataset.id);
  const wrapper = event.currentTarget.closest(".block-body");
  const rendered = wrapper?.querySelector(".block-text-rendered");
  if (block) {
    const textIndex = Number(event.currentTarget.dataset.textIndex);
    const body = editableText(event.currentTarget);
    if (rendered) {
      rendered.replaceChildren(renderOrgInlineText(body));
    }
    saveBlockText(block.id, textIndex, body).catch((error) => setStatus(elements.sourceStatus, error.message, "error"));
  }
  if (rendered) {
    event.currentTarget.style.display = "none";
    rendered.style.display = "block";
  }
}

function editableText(element) {
  if ("value" in element) {
    return element.value;
  }
  return element.innerText.replace(/\u00a0/g, " ");
}

function updateLocalTextChunk(block, textIndex, body) {
  const item = block.content?.find((candidate) => candidate.kind === "text" && candidate.textIndex === textIndex);
  if (item) {
    item.text = body;
  }
}

function bodySaveKey(blockId, textIndex) {
  return `${blockId}:${textIndex}`;
}

async function saveBlockText(blockId, textIndex, body) {
  const previousBlocks = state.blocks;
  const previousLinks = state.links;
  const key = bodySaveKey(blockId, textIndex);
  bodySaveTimers.delete(key);
  const active = document.activeElement;
  const keepEditing = active?.classList?.contains("block-body-editor")
    && active.closest(".block-card")?.dataset.id === blockId
    && Number(active.dataset.textIndex) === textIndex;
  const result = await apiPost("/api/block-text", {
    path: state.path,
    blockId,
    textIndex,
    body
  });
  state.blocks = mergeLocalBlockLayout(previousBlocks, result.parsed.blocks);
  state.links = previousLinks;
  state.namedSources = result.parsed.namedSources || {};
  state.customComponents = result.parsed.customComponents || {};
  state.sqlSources = result.parsed.sqlSources || {};
  elements.sourceInput.value = result.text;
  if (keepEditing) {
    setStatus(elements.workspaceStatus, `${state.blocks.length} blocks${state.dirty ? " - unsaved sidecar" : ""}`, state.dirty ? "muted" : "ok");
    drawEdges();
  } else {
    render();
  }
  await refreshHistory();
  setStatus(elements.sourceStatus, `Saved text in ${state.path}`, "ok");
}

function mergeLocalBlockLayout(previousBlocks, parsedBlocks) {
  const previousById = new Map(previousBlocks.map((block) => [block.id, block]));
  return parsedBlocks.map((block) => {
    const previous = previousById.get(block.id);
    if (!previous) {
      return block;
    }
    return {
      ...block,
      position: { ...block.position, ...previous.position },
      size: { ...block.size, ...previous.size },
      layout: { ...block.layout, ...previous.layout },
      hasSavedPosition: block.hasSavedPosition || previous.hasSavedPosition
    };
  });
}

function syncSourcePanel() {
  elements.sourcePanel.classList.toggle("collapsed", state.sourceCollapsed);
  elements.workspace.classList.toggle("source-collapsed", state.sourceCollapsed);
  elements.toggleSourcePanel.textContent = state.sourceCollapsed ? "Expand" : "Collapse";
}

function syncInspectorPanel() {
  elements.inspectorPanel.classList.toggle("collapsed", state.inspectorCollapsed);
  elements.workspace.classList.toggle("inspector-collapsed", state.inspectorCollapsed);
  elements.toggleInspectorPanel.textContent = state.inspectorCollapsed ? "Expand" : "Collapse";
  if (state.inspectorCollapsed) { stopPendingPoll(); } else { startPendingPoll(); }
}

function renderHistory() {
  elements.historyList.replaceChildren();
  if (!state.path) {
    return;
  }
  if (!state.history.length) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = "No snapshots yet.";
    elements.historyList.append(empty);
    return;
  }
  state.history.forEach((snapshot) => {
    const item = document.createElement("div");
    item.className = "history-item";
    const meta = document.createElement("div");
    meta.className = "history-meta";
    const time = new Date(snapshot.created_at).toLocaleString();
    meta.innerHTML = `<b>${escapeHtml(time)}</b><span>${escapeHtml(snapshot.reason)}</span>`;
    const restore = document.createElement("button");
    restore.type = "button";
    restore.textContent = "Restore";
    restore.addEventListener("click", () => restoreSnapshot(snapshot.id));
    item.append(meta, restore);
    elements.historyList.append(item);
  });
}

async function restoreSnapshot(snapshotId) {
  if (!state.path) {
    return;
  }
  if (!window.confirm("Restore this snapshot for the current document and workspace?")) {
    return;
  }
  const result = await apiPost("/api/history/restore", {
    path: state.path,
    snapshotId
  });
  state.blocks = result.parsed.blocks;
  state.links = result.parsed.links;
  state.namedSources = result.parsed.namedSources || {};
  state.customComponents = result.parsed.customComponents || {};
  state.sqlSources = result.parsed.sqlSources || {};
  state.camera = result.parsed.camera || { x: 20, y: 20, zoom: 1 };
  state.dirty = false;
  state.sourceDirty = false;
  state.selectedIds.clear();
  state.selectedComponentId = null;
  elements.sourceInput.value = result.text;
  render();
  await refreshHistory();
  setStatus(elements.sourceStatus, `Restored snapshot ${snapshotId}`, "ok");
}

function renderBlockContent(container, block) {
  container.replaceChildren();
  const content = block.content || [];

  content.forEach((item) => {
    if (item.kind === "text") {
      const wrapper = document.createElement("div");
      wrapper.className = "block-body";
      wrapper.addEventListener("pointerdown", (event) => event.stopPropagation());
      wrapper.addEventListener("click", (event) => event.stopPropagation());
      const rendered = document.createElement("div");
      rendered.className = "block-text-rendered";
      rendered.append(renderOrgInlineText(item.text || ""));

      rendered.addEventListener("click", (event) => {
        event.stopPropagation();
        activateTextEditor(wrapper);
      });
      const text = document.createElement("textarea");
      text.className = "block-body-editor";
      text.spellcheck = true;
      text.setAttribute("aria-label", "Block body");
      text.dataset.textIndex = String(item.textIndex);
      text.value = item.text || "";
      text.style.display = "none";
      text.addEventListener("click", (event) => event.stopPropagation());
      text.addEventListener("input", handleBlockBodyInput);
      text.addEventListener("blur", handleBlockBodyBlur);
      wrapper.append(rendered, text);
      container.append(wrapper);
      return;
    }

    if (item.kind === "orgTable") {
      container.append(renderInlineOrgTable(item, block));
      return;
    }

    if (item.kind === "image") {
      container.append(renderInlineOrgImage(item));
      return;
    }

    if (item.kind === "pdf") {
      container.append(renderInlineOrgPdf(item));
      return;
    }

    if (item.kind === "srcBlock") {
      const wrapper = document.createElement("div");
      wrapper.className = "src-block";
      if (item.language) {
        const lang = document.createElement("span");
        lang.className = "src-block-lang";
        lang.textContent = item.language;
        wrapper.append(lang);
      }
      const pre = document.createElement("pre");
      pre.textContent = item.body || "";
      wrapper.append(pre);
      container.append(wrapper);
      return;
    }


    const component = item.component || block.components.find((candidate) => candidate.id === item.componentId);
    if (!component) {
      return;
    }
    container.append(renderComponent(component, block));
  });
}


function renderInlineOrgTable(item, block) {
  if (item.view?.type && item.view.type !== "table") {
    return renderComponent({
      id: `${block.id}:orgtable:${item.name || item.raw}`,
      type: item.view.type,
      attrs: {
        ...item.view.attrs,
        source: item.name || item.view.attrs.source || ""
      },
      inlineData: item.data
    }, block);
  }
  const shell = document.createElement("div");
  shell.className = "inline-org-table table-wrap";
  const table = document.createElement("table");
  if (item.data?.columns?.length) {
    const thead = document.createElement("thead");
    const tr = document.createElement("tr");
    item.data.columns.forEach((cell) => {
      const th = document.createElement("th");
      th.textContent = cell;
      tr.append(th);
    });
    thead.append(tr);
    table.append(thead);
  }
  const tbody = document.createElement("tbody");
  (item.data?.rows || []).forEach((row) => {
    const tr = document.createElement("tr");
    item.data.columns.forEach((column) => {
      const td = document.createElement("td");
      td.textContent = row[column] ?? "";
      tr.append(td);
    });
    tbody.append(tr);
  });
  table.append(tbody);
  shell.append(table);
  return shell;
}

function renderInlineOrgImage(item) {
  const figure = document.createElement("figure");
  figure.className = "inline-org-image";
  const image = document.createElement("img");
  image.src = `/asset?path=${encodeURIComponent(item.path || "")}`;
  image.alt = item.alt || "";
  figure.append(image);
  if (item.alt) {
    const caption = document.createElement("figcaption");
    caption.textContent = item.alt;
    figure.append(caption);
  }
  return figure;
}

function renderInlineOrgPdf(item) {
  const figure = document.createElement("figure");
  figure.className = "inline-org-pdf";
  const frame = document.createElement("iframe");
  frame.className = "pdf-frame";
  frame.src = `/asset?path=${encodeURIComponent(item.path || "")}`;
  frame.style.height = "900px";
  frame.title = item.title || "PDF";
  figure.append(frame);
  if (item.title) {
    const caption = document.createElement("figcaption");
    caption.textContent = item.title;
    figure.append(caption);
  }
  return figure;
}

function activateTextEditor(wrapper) {
  const rendered = wrapper.querySelector(".block-text-rendered");
  const textarea = wrapper.querySelector(".block-body-editor");
  if (!textarea || !rendered) {
    return;
  }
  rendered.style.display = "none";
  textarea.style.display = "block";
  textarea.dataset.originalValue = textarea.value;
  resizeTextEditor(textarea);
  textarea.focus();
}

function resizeTextEditor(textarea) {
  textarea.style.height = "auto";
  textarea.style.height = `${textarea.scrollHeight}px`;
}

function renderOrgInlineText(text) {
  const fragment = document.createDocumentFragment();
  const lines = String(text).split("\n");
  lines.forEach((line, index) => {
    if (index > 0) {
      fragment.append(document.createElement("br"));
    }
    if (line) {
      fragment.append(renderOrgInlineLine(line));
    }
  });
  return fragment;
}

function renderOrgInlineLine(line) {
  const fragment = document.createDocumentFragment();
  const pattern = /\[\[([^\]\n]+?)(?:\]\[([^\]\n]*))?\]\]|\*([^*\n]+)\*|\/([^/\n]+)\//g;
  let cursor = 0;
  for (const match of line.matchAll(pattern)) {
    if (match.index > cursor) {
      fragment.append(document.createTextNode(line.slice(cursor, match.index)));
    }
    if (match[1]) {
      const anchor = document.createElement("a");
      anchor.href = orgLinkHref(match[1]);
      anchor.textContent = match[2] || match[1];
      anchor.target = "_blank";
      anchor.rel = "noreferrer";
      anchor.addEventListener("click", (event) => event.stopPropagation());
      fragment.append(anchor);
    } else if (match[3]) {
      const strong = document.createElement("strong");
      strong.textContent = match[3];
      fragment.append(strong);
    } else if (match[4]) {
      const em = document.createElement("em");
      em.textContent = match[4];
      fragment.append(em);
    }
    cursor = match.index + match[0].length;
  }
  if (cursor < line.length) {
    fragment.append(document.createTextNode(line.slice(cursor)));
  }
  return fragment;
}

function orgLinkHref(target) {
  if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith("#")) {
    return target;
  }
  return `/asset?path=${encodeURIComponent(target.replace(/^file:/, ""))}`;
}

function commitActiveTextEditor() {
  const textarea = document.activeElement;
  if (!textarea?.classList?.contains("block-body-editor")) {
    return;
  }
  const node = textarea.closest(".block-card");
  const wrapper = textarea.closest(".block-body");
  const rendered = wrapper?.querySelector(".block-text-rendered");
  const block = node ? blockById(node.dataset.id) : null;
  if (!block) {
    return;
  }
  const textIndex = Number(textarea.dataset.textIndex);
  const body = editableText(textarea);
  if (rendered) {
    rendered.replaceChildren(renderOrgInlineText(body));
    textarea.style.display = "none";
    rendered.style.display = "block";
  }
  if (textarea.dataset.originalValue !== body) {
    saveBlockText(block.id, textIndex, body).catch((error) => setStatus(elements.sourceStatus, error.message, "error"));
  }
}

function renderComponent(component, block) {
  let element;
  if (component.type === "table") {
    element = renderTableComponent(component);
  } else if (component.type === "image") {
    element = renderImageComponent(component);
  } else if (component.type === "chart") {
    element = renderChartComponent(component);
  } else if (component.type === "custom") {
    element = renderCustomComponent(component);
  } else if (component.type === "form") {
    element = renderFormComponent(component);
  } else if (component.type === "board") {
    element = renderBoardComponent(component);
  } else if (component.type === "cards") {
    element = renderCardsComponent(component);
  } else if (component.type === "log") {
    element = renderLogComponent(component);
  } else if (component.type === "gallery") {
    element = renderGalleryComponent(component);
  } else if (component.type === "pdf") {
    element = renderPdfComponent(component);
  } else if (component.type === "websnapshot") {
    element = renderWebSnapshotComponent(component);
  } else {
    element = document.createElement("div");
    element.className = "component-block";
    element.textContent = `Unsupported component: ${component.type}`;
  }
    element.dataset.componentId = component.id;
    element.dataset.blockId = block.id;
    element.classList.toggle("selected", state.selectedComponentId === component.id);
    element.addEventListener("click", (event) => {
      event.stopPropagation();
      selectComponent(block.id, component.id);
    });
  return element;
}

function renderTableComponent(component) {
  const block = componentShell("Table", component);
  const tableWrap = document.createElement("div");
  tableWrap.className = "table-wrap";
  block.append(tableWrap);

  loadData(component.attrs.source, component.inlineData).then((data) => {
    const columns = selectedColumns(data.columns, component.attrs.columns);
    const rows = sortRows(data.rows, component.attrs.sort).slice(0, Number(component.attrs.limit || 8));
    const table = document.createElement("table");
    table.innerHTML = `
      <thead><tr>${columns.map((column) => `<th>${escapeHtml(column)}</th>`).join("")}</tr></thead>
      <tbody></tbody>
    `;
    const body = table.querySelector("tbody");
    rows.forEach((row) => {
      const tr = document.createElement("tr");
      columns.forEach((column) => {
        const td = document.createElement("td");
        td.textContent = row[column] ?? "";
        tr.append(td);
      });
      body.append(tr);
    });
    tableWrap.replaceChildren(table);
  }).catch((error) => tableWrap.textContent = componentErrorMessage(error, "data source", component.attrs.source));

  return block;
}

function renderImageComponent(component) {
  const block = componentShell("Image", component);
  const image = document.createElement("img");
  image.className = "embedded-image";
  image.alt = component.attrs.alt || "";
  image.src = `/asset?path=${encodeURIComponent(component.attrs.path || component.attrs.source || "")}`;
  block.append(image);
  return block;
}

function renderChartComponent(component) {
  const block = componentShell("Chart", component);
  const chart = document.createElement("div");
  chart.className = "chart-component";
  block.append(chart);

  loadData(component.attrs.source, component.inlineData).then((data) => {
    const xKey = component.attrs.x || data.columns[0];
    const yKey = component.attrs.y || data.columns[1];
    const rows = data.rows.slice(0, Number(component.attrs.limit || 10));
    const values = rows.map((row) => Number(row[yKey]) || 0);
    const max = Math.max(...values, 1);
    chart.replaceChildren();
    rows.forEach((row, index) => {
      const bar = document.createElement("div");
      bar.className = "chart-row";
      bar.innerHTML = `
        <span>${escapeHtml(row[xKey] ?? String(index + 1))}</span>
        <div><i style="width:${Math.max(2, values[index] / max * 100)}%"></i></div>
        <b>${escapeHtml(String(row[yKey] ?? ""))}</b>
      `;
      chart.append(bar);
    });
  }).catch((error) => chart.textContent = componentErrorMessage(error, "data source", component.attrs.source));

  return block;
}

function renderCustomComponent(component) {
  const block = componentShell(component.attrs.title || "Custom", component);
  const definitionName = String(component.attrs.definition || "").trim();
  const definition = state.customComponents[definitionName];
  if (!definition || !definition.code) {
    const empty = document.createElement("div");
    empty.className = "custom-component-frame custom-component-error";
    empty.textContent = definitionName
      ? `Missing custom component definition: ${definitionName}`
      : "Missing custom component definition.";
    block.append(empty);
    return block;
  }

  const frame = document.createElement("iframe");
  frame.className = "custom-component-frame";
  frame.setAttribute("sandbox", "allow-scripts");
  frame.setAttribute("title", definitionName || "custom component");
  frame.style.height = "72px";
  frame.srcdoc = customComponentDocument();
  block.append(frame);

  const componentId = component.id;
  const handleMessage = (event) => {
    const data = event.data || {};
    if (event.source !== frame.contentWindow || data.componentId !== componentId) {
      return;
    }
    if (data.type === "custom-component-height") {
      frame.style.height = `${Math.max(48, Number(data.height) || 48)}px`;
    } else if (data.type === "custom-component-error") {
      frame.style.height = "72px";
      setTimeout(() => {
        if (frame.isConnected) {
          frame.style.height = "72px";
        }
      }, 0);
    } else if (data.type === "custom-component-query") {
      if (!state.path) {
        frame.contentWindow?.postMessage({
          type: "custom-component-query-response",
          componentId,
          requestId: data.requestId,
          error: "No document loaded.",
        }, "*");
        return;
      }
      apiPost("/api/sql-query", {
        path: state.path,
        sql: data.sql,
      }).then((result) => {
        frame.contentWindow?.postMessage({
          type: "custom-component-query-response",
          componentId,
          requestId: data.requestId,
          result: result.result,
          diagnostics: result.diagnostics || [],
        }, "*");
      }).catch((error) => {
        frame.contentWindow?.postMessage({
          type: "custom-component-query-response",
          componentId,
          requestId: data.requestId,
          error: error.message || "Query failed.",
        }, "*");
      });
    }
  };
  window.addEventListener("message", handleMessage);

  const sendInit = async () => {
    try {
      const source = component.attrs.source ? await loadData(component.attrs.source, component.inlineData) : null;
      frame.contentWindow?.postMessage({
        type: "custom-component-init",
        componentId,
        code: normalizeCustomComponentCode(definition.code),
        css: normalizeCustomComponentCss(definition.css),
        params: component.attrs,
        source,
        sources: state.namedSources,
        assetBase: "/asset?path=",
      }, "*");
    } catch (error) {
      const message = componentErrorMessage(error, "data source", component.attrs.source);
      frame.srcdoc = `<body style="margin:0;font:13px system-ui;color:#9f2f2f;background:#fff;padding:10px;">${escapeHtml(message)}</body>`;
    }
  };

  frame.addEventListener("load", () => {
    sendInit().catch((error) => {
      frame.srcdoc = `<body style="margin:0;font:13px system-ui;color:#9f2f2f;background:#fff;padding:10px;">${escapeHtml(error.message || "Failed to render custom component.")}</body>`;
    });
  }, { once: true });

  return block;
}

function normalizeCustomComponentCode(code) {
  return String(code || "")
    .replace(/\bexport\s+async\s+function\s+render\b/, "async function render")
    .replace(/\bexport\s+function\s+render\b/, "function render")
    .replace(/\bexport\s+const\s+render\b/, "const render")
    .replace(/\bexport\s+let\s+render\b/, "let render")
    .replace(/\bexport\s+var\s+render\b/, "var render");
}

function normalizeCustomComponentCss(css) {
  return String(css || "");
}

function customComponentDocument() {
  return `<!doctype html>
<html>
  <body style="margin:0;background:transparent;">
    <style id="custom-style"></style>
    <div id="mount"></div>
    <script>
      const mount = document.getElementById('mount');
      const customStyle = document.getElementById('custom-style');
      function post(type, payload) {
        parent.postMessage({ type, ...payload }, '*');
      }
      function assetUrl(assetBase, path) {
        return assetBase + encodeURIComponent(String(path || '').replace(/^file:/, ''));
      }
      function updateHeight(componentId) {
        const height = Math.ceil(document.documentElement.scrollHeight || document.body.scrollHeight || 48);
        post('custom-component-height', { componentId, height });
      }
      new ResizeObserver(() => {
        if (window.__componentId) updateHeight(window.__componentId);
      }).observe(document.documentElement);
      window.addEventListener('message', async (event) => {
        const data = event.data || {};
        if (data.type !== 'custom-component-init') return;
        window.__componentId = data.componentId;
        try {
          customStyle.textContent = String(data.css || '');
          mount.replaceChildren();
          const ctx = {
            params: data.params || {},
            source: data.source || null,
            sources: data.sources || {},
            getSource(name) {
              if (!name) return data.source || null;
              return (data.sources || {})[name] || (name === data.params?.source ? data.source : null) || null;
            },
            assetUrl(path) {
              return assetUrl(data.assetBase || '/asset?path=', path);
            },
            query(sql) {
              const requestId = 'q-' + Math.random().toString(36).slice(2);
              return new Promise((resolve, reject) => {
                const onMessage = (messageEvent) => {
                  const payload = messageEvent.data || {};
                  if (payload.type !== 'custom-component-query-response' || payload.componentId !== data.componentId || payload.requestId !== requestId) {
                    return;
                  }
                  window.removeEventListener('message', onMessage);
                  if (payload.error) {
                    reject(new Error(payload.error));
                    return;
                  }
                  resolve(payload.result || { columns: [], rows: [] });
                };
                window.addEventListener('message', onMessage);
                parent.postMessage({
                  type: 'custom-component-query',
                  componentId: data.componentId,
                  requestId,
                  sql,
                }, '*');
              });
            },
            element: mount,
          };
          const runner = new Function('ctx', \`\${data.code}
if (typeof render !== "function") {
  throw new Error("Custom component must define render(ctx).");
}
return render(ctx);\`);
          const result = await runner(ctx);
          if (result instanceof Node) {
            mount.replaceChildren(result);
          } else if (typeof result === 'string') {
            mount.innerHTML = result;
          }
          updateHeight(data.componentId);
        } catch (error) {
          mount.innerHTML = '<div style="padding:10px;color:#9f2f2f;font:13px system-ui;">' + String(error.message || error) + '</div>';
          post('custom-component-error', { componentId: data.componentId, message: String(error.message || error) });
          updateHeight(data.componentId);
        }
      });
    </script>
  </body>
</html>`;
}

function renderFormComponent(component) {
  const block = componentShell("Form", component);
  const form = document.createElement("form");
  form.className = "form-component";
  const fields = parseFields(component.attrs.fields || "");
  fields.forEach((field) => form.append(renderField(field)));

  const submit = document.createElement("button");
  submit.type = "submit";
  submit.textContent = component.attrs.submit || "Append";
  form.append(submit);
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const values = {};
    fields.forEach((field) => {
      const input = form.elements[field.name];
      values[field.name] = field.type === "checkbox" ? input.checked : input.value;
    });
    apiPost("/api/append", { path: component.attrs.target, fields, values })
      .then(() => {
        dataCache.delete(component.attrs.target);
        setStatus(elements.sourceStatus, `Appended to ${component.attrs.target}`, "ok");
        form.reset();
      })
      .catch((error) => setStatus(elements.sourceStatus, error.message, "error"));
  });

  block.append(form);
  return block;
}

function renderBoardComponent(component) {
  const block = componentShell(component.attrs.title || "Board", component);
  const board = document.createElement("div");
  board.className = "board-component";
  block.append(board);

  loadData(component.attrs.source, component.inlineData).then((data) => {
    const groupKey = component.attrs.group || data.columns[0];
    const titleKey = component.attrs.titleColumn || data.columns.find((column) => column !== groupKey) || data.columns[0];
    const visibleColumns = selectedColumns(
      data.columns.filter((column) => column !== groupKey),
      component.attrs.columns || data.columns.filter((column) => column !== groupKey).join(",")
    );
    const sortedRows = sortRows(data.rows, component.attrs.sort);
    const groups = new Map();
    sortedRows.forEach((row) => {
      const group = row[groupKey] || "Ungrouped";
      if (!groups.has(group)) {
        groups.set(group, []);
      }
      groups.get(group).push(row);
    });

    board.replaceChildren();
    groups.forEach((rows, group) => {
      const column = document.createElement("section");
      column.className = "board-column";
      const header = document.createElement("h4");
      header.textContent = group;
      column.append(header);
      rows.slice(0, Number(component.attrs.limit || 8)).forEach((row) => {
        const card = document.createElement("article");
        card.className = "mini-card";
        applyColorField(card, row, component.attrs.color);
        const title = document.createElement("strong");
        title.className = "mini-card-title";
        title.textContent = row[titleKey] || JSON.stringify(row);
        card.append(title);
        visibleColumns
          .filter((column) => column !== titleKey)
          .forEach((columnName) => {
            const line = document.createElement("div");
            line.innerHTML = `<b>${escapeHtml(columnName)}</b><span>${escapeHtml(row[columnName] ?? "")}</span>`;
            card.append(line);
          });
      column.append(card);
      });
      board.append(column);
    });
  }).catch((error) => board.textContent = componentErrorMessage(error, "data source", component.attrs.source));

  return block;
}

function renderCardsComponent(component) {
  const block = componentShell(component.attrs.title || "Cards", component);
  const cards = document.createElement("div");
  cards.className = "cards-component";
  block.append(cards);

  loadData(component.attrs.source, component.inlineData).then((data) => {
    const columns = selectedColumns(data.columns, component.attrs.columns || data.columns.slice(0, 4).join(","));
    cards.replaceChildren();
    data.rows.slice(0, Number(component.attrs.limit || 6)).forEach((row) => {
      const card = document.createElement("article");
      card.className = "record-card";
      columns.forEach((column) => {
        const line = document.createElement("div");
        line.innerHTML = `<b>${escapeHtml(column)}</b><span>${escapeHtml(row[column] ?? "")}</span>`;
        card.append(line);
      });
      cards.append(card);
    });
  }).catch((error) => cards.textContent = componentErrorMessage(error, "data source", component.attrs.source));

  return block;
}

function renderLogComponent(component) {
  const block = componentShell(component.attrs.title || "Log", component);
  const log = document.createElement("div");
  log.className = "log-component";
  block.append(log);

  loadData(component.attrs.source, component.inlineData).then((data) => {
    log.replaceChildren();
    data.rows.slice(-Number(component.attrs.limit || 8)).reverse().forEach((row) => {
      const entry = document.createElement("article");
      entry.className = "log-entry";
      Object.entries(row).forEach(([key, value]) => {
        const line = document.createElement("div");
        line.innerHTML = `<b>${escapeHtml(key)}</b><span>${escapeHtml(String(value))}</span>`;
        entry.append(line);
      });
      log.append(entry);
    });
  }).catch((error) => log.textContent = componentErrorMessage(error, "data source", component.attrs.source));

  return block;
}

function renderGalleryComponent(component) {
  const block = componentShell(component.attrs.title || "Gallery", component);
  const gallery = document.createElement("div");
  gallery.className = "gallery-component";
  block.append(gallery);

  apiGet(`/api/assets?path=${encodeURIComponent(component.attrs.source || component.attrs.path || "")}`)
    .then((data) => {
      gallery.replaceChildren();
      data.images.slice(0, Number(component.attrs.limit || 8)).forEach((image) => {
        const figure = document.createElement("figure");
        figure.innerHTML = `
          <img src="/asset?path=${encodeURIComponent(image.path)}" alt="">
          <figcaption>${escapeHtml(image.name)}</figcaption>
        `;
        gallery.append(figure);
      });
    })
    .catch((error) => gallery.textContent = componentErrorMessage(error, "image directory", component.attrs.source || component.attrs.path));

  return block;
}

function openSnapshotTab(snapshotId, url, title) {
  if (!snapshotId) {
    console.log("[orghtml] openSnapshotTab: no snapshotId, plain window.open");
    window.open(url, "_blank", "noopener");
    return;
  }
  const reqId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  let settled = false;
  const onAck = (e) => {
    if (e.source !== window || e.origin !== window.location.origin) return;
    if (!e.data || e.data.type !== "orghtml-open-ack" || e.data.reqId !== reqId) return;
    if (settled) return;
    settled = true;
    window.removeEventListener("message", onAck);
    console.log("[orghtml] bridge ack:", e.data);
  };
  window.addEventListener("message", onAck);
  console.log("[orghtml] posting orghtml-open via bridge", { reqId });
  window.postMessage({ type: "orghtml-open", snapshotId, url, title, reqId }, window.location.origin);
  setTimeout(() => {
    window.removeEventListener("message", onAck);
    if (settled) return;
    settled = true;
    console.warn("[orghtml] bridge timeout — falling back to window.open");
    window.open(url, "_blank", "noopener");
  }, 400);
}

function renderWebSnapshotComponent(component) {
  const attrs = component.attrs;
  const snapshotId = attrs.id || "";
  const url = attrs.url || "";
  const title = attrs.title || url || "Web Snapshot";
  const frozenAt = attrs.frozen_at || "";

  let frozenLabel = "";
  if (frozenAt) {
    try { frozenLabel = new Date(frozenAt).toLocaleString(); } catch { frozenLabel = frozenAt; }
  }
  const blockTitle = frozenLabel ? `${title} — ${frozenLabel}` : title;
  const block = componentShell(blockTitle, component);

  if (url) {
    const openBtn = document.createElement("button");
    openBtn.type = "button";
    openBtn.className = "web-snapshot-open";
    openBtn.textContent = "Open page";
    openBtn.addEventListener("click", (event) => {
      event.stopPropagation();
      console.log("[orghtml] Open page clicked", {
        snapshotId, url, extensionConnected: state.extensionConnected,
      });
      openSnapshotTab(snapshotId, url, title);
    });
    block.append(openBtn);
  }

  const urlSpan = document.createElement("span");
  urlSpan.className = "web-snapshot-url";
  urlSpan.textContent = url;
  block.append(urlSpan);

  if (snapshotId) {
    const imgPath = `.orghtml/snapshots/${encodeURIComponent(snapshotId)}.png`;
    const img = document.createElement("img");
    img.className = "web-snapshot-thumb";
    img.alt = title;
    img.src = `/asset?path=${encodeURIComponent(imgPath)}`;
    img.addEventListener("error", () => {
      img.replaceWith((() => {
        const ph = document.createElement("div");
        ph.className = "web-snapshot-missing";
        ph.textContent = "Screenshot missing";
        return ph;
      })());
    });
    block.append(img);
  }

  return block;
}

function renderPdfComponent(component) {
  const label = component.attrs.title || "PDF";
  const block = componentShell(label, component);
  const path = component.attrs.path || "";
  if (!path.toLowerCase().endsWith(".pdf")) {
    const err = document.createElement("div");
    err.className = "custom-component-error";
    err.textContent = path ? `Not a PDF: ${path}` : "Missing path attr.";
    block.append(err);
    return block;
  }
  const page = component.attrs.page ? `#page=${encodeURIComponent(component.attrs.page)}` : "";
  const height = component.attrs.height ? `${parseInt(component.attrs.height, 10)}px` : "900px";
  const frame = document.createElement("iframe");
  frame.className = "pdf-frame";
  frame.src = `/asset?path=${encodeURIComponent(path)}${page}`;
  frame.style.height = height;
  frame.title = label;
  block.append(frame);
  return block;
}

function renderField(field) {
  const label = document.createElement("label");
  label.className = "form-field";
  const text = document.createElement("span");
  text.textContent = field.label || field.name;
  const input = document.createElement("input");
  input.name = field.name;
  input.type = field.type;
  if (field.type === "range") {
    input.min = field.min ?? "0";
    input.max = field.max ?? "10";
    input.step = field.step ?? "1";
    const output = document.createElement("b");
    output.textContent = input.value || input.min;
    input.addEventListener("input", () => output.textContent = input.value);
    label.append(text, input, output);
    return label;
  }
  if (field.placeholder) {
    input.placeholder = field.placeholder;
  }
  label.append(input, text);
  if (field.type !== "checkbox") {
    label.replaceChildren(text, input);
  }
  return label;
}

function parseFields(raw) {
  return raw.split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const [name, type = "text", min, max, step] = part.split(":");
      return { name, type, min, max, step };
    });
}

function componentShell(label, component) {
  const block = document.createElement("section");
  block.className = `component-block ${component.type}-block`;
  block.addEventListener("pointerdown", (event) => event.stopPropagation());
  block.addEventListener("click", (event) => event.stopPropagation());
  const title = document.createElement("div");
  title.className = "component-title";
  title.textContent = label;
  block.append(title);
  return block;
}

async function loadData(path, inlineData = null) {
  if (inlineData) {
    return inlineData;
  }
  if (!path) {
    throw new Error("Missing data source.");
  }
  if (state.namedSources[path]) {
    return state.namedSources[path];
  }
  if (!dataCache.has(path)) {
    dataCache.set(path, apiGet(`/api/data?path=${encodeURIComponent(path)}`));
  }
  return dataCache.get(path);
}

function selectedColumns(columns, raw) {
  if (!raw) {
    return columns;
  }
  const wanted = raw.split(",").map((column) => column.trim()).filter(Boolean);
  return wanted.filter((column) => columns.includes(column));
}

function sortRows(rows, rawSort) {
  const sortSpec = String(rawSort || "").trim();
  if (!sortSpec) {
    return [...rows];
  }
  const descending = sortSpec.startsWith("-");
  const column = descending ? sortSpec.slice(1) : sortSpec;
  return [...rows].sort((left, right) => compareValues(left?.[column], right?.[column], descending));
}

function compareValues(left, right, descending = false) {
  const leftNumber = Number(left);
  const rightNumber = Number(right);
  const bothNumeric = Number.isFinite(leftNumber) && Number.isFinite(rightNumber) && left !== "" && right !== "";
  const result = bothNumeric
    ? leftNumber - rightNumber
    : String(left ?? "").localeCompare(String(right ?? ""), undefined, { numeric: true, sensitivity: "base" });
  return descending ? -result : result;
}

function applyColorField(element, row, colorField) {
  const field = String(colorField || "").trim();
  if (!field || !row?.[field]) {
    return;
  }
  element.style.borderLeft = `4px solid ${colorForValue(String(row[field]))}`;
}

function colorForValue(value) {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) >>> 0;
  }
  const hue = hash % 360;
  return `hsl(${hue} 55% 52%)`;
}

function componentErrorMessage(error, kind, source) {
  if (error?.status === 404) {
    return `Missing ${kind}: ${source}`;
  }
  if (error?.status === 403) {
    return `Not allowed to read ${kind}: ${source}`;
  }
  return error?.message || `Failed to load ${kind}: ${source}`;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function syncCamera() {
  elements.world.style.transform = `translate(${state.camera.x}px, ${state.camera.y}px) scale(${state.camera.zoom})`;
}

function resizeCanvas() {
  const rect = elements.viewport.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  elements.edgeCanvas.width = Math.max(1, Math.floor(rect.width * dpr));
  elements.edgeCanvas.height = Math.max(1, Math.floor(rect.height * dpr));
  elements.edgeCanvas.style.width = `${rect.width}px`;
  elements.edgeCanvas.style.height = `${rect.height}px`;
  const ctx = elements.edgeCanvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

function drawEdges() {
  resizeCanvas();
  const ctx = elements.edgeCanvas.getContext("2d");
  const rect = elements.viewport.getBoundingClientRect();
  ctx.clearRect(0, 0, rect.width, rect.height);
  ctx.lineWidth = 2;
  ctx.strokeStyle = "rgba(26, 82, 118, 0.68)";
  ctx.fillStyle = "rgba(26, 82, 118, 0.68)";

  state.links.forEach((link) => {
    const source = nodeBounds(link.sourceId);
    const target = nodeBounds(link.targetId);
    if (!source || !target) {
      return;
    }

    const anchors = edgeAnchors(source, target);
    const start = worldToScreen(anchors.start);
    const end = worldToScreen(anchors.end);
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    const bend = Math.max(40, Math.hypot(dx, dy) / 3);
    const horizontal = Math.abs(dx) >= Math.abs(dy);
    const c1 = horizontal
      ? { x: start.x + Math.sign(dx || 1) * bend, y: start.y }
      : { x: start.x, y: start.y + Math.sign(dy || 1) * bend };
    const c2 = horizontal
      ? { x: end.x - Math.sign(dx || 1) * bend, y: end.y }
      : { x: end.x, y: end.y - Math.sign(dy || 1) * bend };

    ctx.beginPath();
    ctx.moveTo(start.x, start.y);
    ctx.bezierCurveTo(c1.x, c1.y, c2.x, c2.y, end.x, end.y);
    ctx.stroke();
    drawArrow(ctx, start, end);
  });
}

function nodeBounds(id) {
  const block = blockById(id);
  const node = elements.world.querySelector(`[data-id="${CSS.escape(id)}"]`);
  if (!block || !node) {
    return null;
  }
  return {
    x: block.position.x,
    y: block.position.y,
    width: node.offsetWidth || NODE_WIDTH,
    height: node.offsetHeight || 1
  };
}

function rectCenter(rect) {
  return {
    x: rect.x + rect.width / 2,
    y: rect.y + rect.height / 2
  };
}

function edgeAnchors(source, target) {
  const sourceCenter = rectCenter(source);
  const targetCenter = rectCenter(target);
  const dx = targetCenter.x - sourceCenter.x;
  const dy = targetCenter.y - sourceCenter.y;
  const useHorizontal = Math.abs(dx) / Math.max(source.width, 1) >= Math.abs(dy) / Math.max(source.height, 1);

  if (useHorizontal) {
    const sourceSideX = dx >= 0 ? source.x + source.width : source.x;
    const targetSideX = dx >= 0 ? target.x : target.x + target.width;
    return {
      start: { x: sourceSideX, y: clamp(targetCenter.y, source.y + 12, source.y + source.height - 12) },
      end: { x: targetSideX, y: clamp(sourceCenter.y, target.y + 12, target.y + target.height - 12) }
    };
  }

  const sourceSideY = dy >= 0 ? source.y + source.height : source.y;
  const targetSideY = dy >= 0 ? target.y : target.y + target.height;
  return {
    start: { x: clamp(targetCenter.x, source.x + 12, source.x + source.width - 12), y: sourceSideY },
    end: { x: clamp(sourceCenter.x, target.x + 12, target.x + target.width - 12), y: targetSideY }
  };
}

function clamp(value, min, max) {
  if (min > max) {
    return (min + max) / 2;
  }
  return Math.max(min, Math.min(max, value));
}

function drawArrow(ctx, start, end) {
  const angle = Math.atan2(end.y - start.y, end.x - start.x);
  const size = 8;
  ctx.beginPath();
  ctx.moveTo(end.x, end.y);
  ctx.lineTo(end.x - size * Math.cos(angle - Math.PI / 6), end.y - size * Math.sin(angle - Math.PI / 6));
  ctx.lineTo(end.x - size * Math.cos(angle + Math.PI / 6), end.y - size * Math.sin(angle + Math.PI / 6));
  ctx.closePath();
  ctx.fill();
}

function blockById(id) {
  return state.blocks.find((block) => block.id === id);
}

function worldToScreen(point) {
  return {
    x: point.x * state.camera.zoom + state.camera.x,
    y: point.y * state.camera.zoom + state.camera.y
  };
}

function screenToWorld(point) {
  return {
    x: (point.x - state.camera.x) / state.camera.zoom,
    y: (point.y - state.camera.y) / state.camera.zoom
  };
}

function handleNodeClick(event) {
  if (!event.target.closest(".block-body-editor")) {
    commitActiveTextEditor();
  }
  const id = event.currentTarget.dataset.id;
  if (state.linkMode || (event.shiftKey && state.selectedIds.size === 1 && !state.selectedIds.has(id))) {
    toggleLink(id);
    event.stopPropagation();
    return;
  }

  if (event.shiftKey) {
    if (state.selectedIds.has(id)) {
      state.selectedIds.delete(id);
    } else {
      state.selectedIds.add(id);
    }
  } else if (!state.selectedIds.has(id)) {
    state.selectedIds.clear();
    state.selectedIds.add(id);
  }
  state.selectedComponentId = null;
  renderNodes();
  renderComponentInspector();
  renderProjectPalette();
}

function handleNodePointerDown(event) {
  if (
    event.button !== 0
    || state.linkMode
    || event.target.closest(".component-block")
    || event.target.closest(".block-body-editor")
    || event.target.closest(".resize-handle")
    || pointerIsOnNativeScrollbar(event)
  ) {
    return;
  }
  commitActiveTextEditor();
  if (event.shiftKey && state.selectedIds.size === 1 && !state.selectedIds.has(event.currentTarget.dataset.id)) {
    return;
  }
  const id = event.currentTarget.dataset.id;
  if (!state.selectedIds.has(id)) {
    if (!event.shiftKey) {
      state.selectedIds.clear();
    }
    state.selectedIds.add(id);
  }

  event.currentTarget.setPointerCapture(event.pointerId);
  state.drag = {
    pointerId: event.pointerId,
    start: { x: event.clientX, y: event.clientY },
    nodes: state.blocks
      .filter((block) => state.selectedIds.has(block.id))
      .map((block) => ({
        id: block.id,
        x: block.position.x,
        y: block.position.y
      }))
  };
  event.preventDefault();
  renderNodes();
}

function handlePointerMove(event) {
  if (state.resize) {
    const block = blockById(state.resize.id);
    if (block) {
      block.size = block.size || {};
      block.size.width = Math.max(NODE_MIN_WIDTH, state.resize.width + (event.clientX - state.resize.start.x) / state.camera.zoom);
      block.size.height = Math.max(NODE_MIN_HEIGHT, state.resize.height + (event.clientY - state.resize.start.y) / state.camera.zoom);
      const node = elements.world.querySelector(`[data-id="${CSS.escape(block.id)}"]`);
      if (node) {
        node.style.width = `${block.size.width}px`;
        node.style.height = `${block.size.height}px`;
      }
      state.dirty = true;
      drawEdges();
    }
    return;
  }

  if (state.drag) {
    const dx = (event.clientX - state.drag.start.x) / state.camera.zoom;
    const dy = (event.clientY - state.drag.start.y) / state.camera.zoom;
    state.drag.nodes.forEach((dragNode) => {
      const block = blockById(dragNode.id);
      if (block) {
        block.hasSavedPosition = true;
        block.layout = { ...(block.layout || {}), mode: "free", after: null };
        block.position.x = dragNode.x + dx;
        block.position.y = dragNode.y + dy;
        const node = elements.world.querySelector(`[data-id="${CSS.escape(block.id)}"]`);
        if (node) {
          node.style.transform = `translate(${block.position.x}px, ${block.position.y}px)`;
        }
      }
    });
    state.dirty = true;
    drawEdges();
    return;
  }

  if (state.pan) {
    state.camera.x = state.pan.camera.x + event.clientX - state.pan.start.x;
    state.camera.y = state.pan.camera.y + event.clientY - state.pan.start.y;
    state.dirty = true;
    syncCamera();
    drawEdges();
  }
}

function handlePointerUp(event) {
  if (state.resize?.pointerId === event.pointerId) {
    state.resize = null;
    render();
  }
  if (state.drag?.pointerId === event.pointerId) {
    state.drag = null;
    render();
  }
  if (state.pan?.pointerId === event.pointerId) {
    state.pan = null;
    render();
  }
  if (state.dirty) {
    scheduleSidecarSave();
  }
}

function handleResizePointerDown(event) {
  event.stopPropagation();
  event.preventDefault();
  commitActiveTextEditor();
  const node = event.currentTarget.closest(".block-card");
  const block = blockById(node.dataset.id);
  if (!block) {
    return;
  }
  node.setPointerCapture(event.pointerId);
  block.size = block.size || {};
  state.resize = {
    pointerId: event.pointerId,
    id: block.id,
    start: { x: event.clientX, y: event.clientY },
    width: block.size.width || node.offsetWidth,
    height: block.size.height || node.offsetHeight
  };
}

function handleViewportPointerDown(event) {
  if (event.target !== elements.viewport && event.target !== elements.edgeCanvas && event.target !== elements.world) {
    return;
  }
  commitActiveTextEditor();
  state.selectedIds.clear();
  state.selectedComponentId = null;
  elements.viewport.setPointerCapture(event.pointerId);
  state.pan = {
    pointerId: event.pointerId,
    start: { x: event.clientX, y: event.clientY },
    camera: { ...state.camera }
  };
  renderNodes();
  renderComponentInspector();
  renderProjectPalette();
}

function normalizedWheelDelta(event) {
  if (event.deltaMode === WheelEvent.DOM_DELTA_LINE) {
    return { x: event.deltaX * 16, y: event.deltaY * 16 };
  }
  if (event.deltaMode === WheelEvent.DOM_DELTA_PAGE) {
    return { x: event.deltaX * elements.viewport.clientWidth, y: event.deltaY * elements.viewport.clientHeight };
  }
  return { x: event.deltaX, y: event.deltaY };
}

function canScrollElement(element) {
  const style = getComputedStyle(element);
  const overflowX = style.overflowX;
  const overflowY = style.overflowY;
  const scrollableX = /(auto|scroll|overlay)/.test(overflowX) && element.scrollWidth > element.clientWidth;
  const scrollableY = /(auto|scroll|overlay)/.test(overflowY) && element.scrollHeight > element.clientHeight;
  return scrollableX || scrollableY;
}

function canScrollWithDelta(element, delta) {
  const maxLeft = element.scrollWidth - element.clientWidth;
  const maxTop = element.scrollHeight - element.clientHeight;
  const canScrollX = (delta.x < 0 && element.scrollLeft > 0) || (delta.x > 0 && element.scrollLeft < maxLeft - 1);
  const canScrollY = (delta.y < 0 && element.scrollTop > 0) || (delta.y > 0 && element.scrollTop < maxTop - 1);
  return canScrollX || canScrollY;
}

function findScrollableWheelTarget(event, delta) {
  for (let element = event.target; element && element !== elements.viewport; element = element.parentElement) {
    if (!(element instanceof HTMLElement) || !canScrollElement(element)) {
      continue;
    }
    if (canScrollWithDelta(element, delta)) {
      return element;
    }
  }

  return null;
}

function scrollElementByDelta(element, delta) {
  element.scrollLeft += delta.x;
  element.scrollTop += delta.y;
}

function pointerIsOnNativeScrollbar(event) {
  for (let element = event.target; element && element !== elements.viewport; element = element.parentElement) {
    if (!(element instanceof HTMLElement) || !canScrollElement(element)) {
      continue;
    }
    if (pointerIsInScrollbarGutter(event, element)) {
      return true;
    }
  }
  return false;
}

function pointerIsInScrollbarGutter(event, element) {
  const rect = element.getBoundingClientRect();
  const style = getComputedStyle(element);
  const borderLeft = parseFloat(style.borderLeftWidth) || 0;
  const borderRight = parseFloat(style.borderRightWidth) || 0;
  const borderTop = parseFloat(style.borderTopWidth) || 0;
  const borderBottom = parseFloat(style.borderBottomWidth) || 0;
  const verticalGutter = Math.max(SCROLLBAR_HIT_SIZE, element.offsetWidth - element.clientWidth - borderLeft - borderRight);
  const horizontalGutter = Math.max(SCROLLBAR_HIT_SIZE, element.offsetHeight - element.clientHeight - borderTop - borderBottom);
  const onVerticalScrollbar = verticalGutter > 0
    && element.scrollHeight > element.clientHeight
    && event.clientX >= rect.right - borderRight - verticalGutter
    && event.clientX <= rect.right - borderRight;
  const onHorizontalScrollbar = horizontalGutter > 0
    && element.scrollWidth > element.clientWidth
    && event.clientY >= rect.bottom - borderBottom - horizontalGutter
    && event.clientY <= rect.bottom - borderBottom;
  return onVerticalScrollbar || onHorizontalScrollbar;
}

function scrollableContentCanConsumeWheel(event, delta) {
  const target = findScrollableWheelTarget(event, delta);
  if (!target) {
    return false;
  }
  event.preventDefault();
  event.stopPropagation();
  scrollElementByDelta(target, delta);
  return true;
}

function handleWheel(event) {
  const rect = elements.viewport.getBoundingClientRect();
  const anchor = { x: event.clientX - rect.left, y: event.clientY - rect.top };
  let delta = normalizedWheelDelta(event);

  if (event.metaKey || event.ctrlKey) {
    event.preventDefault();
    const before = screenToWorld(anchor);
    const factor = Math.exp(-delta.y * 0.002);
    state.camera.zoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, state.camera.zoom * factor));
    state.camera.x = anchor.x - before.x * state.camera.zoom;
    state.camera.y = anchor.y - before.y * state.camera.zoom;
  } else {
    if (scrollableContentCanConsumeWheel(event, delta)) {
      return;
    }
    event.preventDefault();
    state.camera.x -= delta.x;
    state.camera.y -= delta.y;
  }

  state.dirty = true;
  syncCamera();
  drawEdges();
  scheduleSidecarSave();
}

function startLink() {
  if (state.selectedIds.size !== 1) {
    setStatus(elements.workspaceStatus, "Select one source node first", "error");
    return;
  }
  state.linkMode = true;
  setStatus(elements.workspaceStatus, "Click target node", "muted");
}

function toggleLink(targetId) {
  const [sourceId] = [...state.selectedIds];
  state.linkMode = false;
  if (!sourceId || sourceId === targetId) {
    setStatus(elements.workspaceStatus, "Link cancelled", "muted");
    return;
  }

  const existingIndex = state.links.findIndex((link) => link.sourceId === sourceId && link.targetId === targetId);
  if (existingIndex >= 0) {
    state.links.splice(existingIndex, 1);
    setStatus(elements.workspaceStatus, "Link removed", "muted");
  } else {
    state.links.push({ id: `draft-${sourceId}-${targetId}`, sourceId, targetId });
    setStatus(elements.workspaceStatus, "Link added", "muted");
  }
  state.dirty = true;
  scheduleSidecarSave();
  render();
}

function deleteSelectedLinks() {
  if (state.selectedIds.size !== 2) {
    setStatus(elements.workspaceStatus, "Select two linked nodes", "error");
    return;
  }
  const ids = [...state.selectedIds];
  const before = state.links.length;
  state.links = state.links.filter((link) => {
    return !(
      (link.sourceId === ids[0] && link.targetId === ids[1]) ||
      (link.sourceId === ids[1] && link.targetId === ids[0])
    );
  });
  if (state.links.length !== before) {
    state.dirty = true;
    scheduleSidecarSave();
    render();
  }
}


let _pendingPollTimer = null;

function renderPendingSnapshots(pending) {
  if (!elements.pendingSnapshots) return;
  elements.pendingSnapshots.replaceChildren();
  if (!pending.length) {
    setStatus(elements.pendingStatus, "—", "muted");
    const empty = document.createElement("div");
    empty.className = "pending-empty";
    empty.textContent = "No pending snapshots.";
    elements.pendingSnapshots.append(empty);
    return;
  }
  setStatus(elements.pendingStatus, String(pending.length), "ok");
  pending.forEach((entry) => {
    const item = document.createElement("div");
    item.className = "pending-snapshot-item";

    const info = document.createElement("div");
    info.className = "pending-snapshot-info";
    const titleEl = document.createElement("strong");
    titleEl.textContent = entry.title || entry.url;
    const urlEl = document.createElement("div");
    urlEl.className = "web-snapshot-url";
    urlEl.textContent = entry.url;
    const ageEl = document.createElement("div");
    ageEl.className = "web-snapshot-ts";
    try {
      ageEl.textContent = new Date(entry.captured_at).toLocaleString();
    } catch {
      ageEl.textContent = entry.captured_at;
    }
    info.append(titleEl, urlEl, ageEl);

    const actions = document.createElement("div");
    actions.className = "pending-snapshot-actions";

    const createBtn = document.createElement("button");
    createBtn.type = "button";
    createBtn.textContent = "Create block";
    createBtn.addEventListener("click", async () => {
      if (!state.path) {
        alert("Open a document first.");
        return;
      }
      createBtn.disabled = true;
      try {
        await apiPost("/api/snapshot/promote", { path: state.path, pendingId: entry.pendingId });
        await loadDocument(state.path);
        setStatus(elements.workspaceStatus, "Block created from snapshot", "ok");
        refreshPendingSnapshots();
      } catch (error) {
        createBtn.disabled = false;
        setStatus(elements.workspaceStatus, error.message, "error");
      }
    });

    const discardBtn = document.createElement("button");
    discardBtn.type = "button";
    discardBtn.textContent = "Discard";
    discardBtn.addEventListener("click", async () => {
      discardBtn.disabled = true;
      try {
        await apiPost("/api/snapshot/discard", { pendingId: entry.pendingId });
        refreshPendingSnapshots();
      } catch {
        discardBtn.disabled = false;
      }
    });

    actions.append(createBtn, discardBtn);
    item.append(info, actions);
    elements.pendingSnapshots.append(item);
  });
}

async function refreshExtensionInfo() {
  try {
    const result = await apiGet("/api/snapshot/extension-info");
    state.extensionConnected = result.connected || false;
  } catch {
    state.extensionConnected = false;
  }
  if (elements.extensionStatus) {
    if (state.extensionConnected) {
      setStatus(elements.extensionStatus, "ext: connected", "ok");
    } else {
      setStatus(elements.extensionStatus, "ext: disconnected", "error");
    }
  }
}

async function refreshPendingSnapshots() {
  try {
    const result = await apiGet("/api/snapshot/pending");
    renderPendingSnapshots(result.pending || []);
  } catch {
    setStatus(elements.pendingStatus, "error", "error");
  }
}

function startPendingPoll() {
  if (_pendingPollTimer) return;
  refreshExtensionInfo();
  refreshPendingSnapshots();
  _pendingPollTimer = setInterval(() => {
    refreshExtensionInfo();
    refreshPendingSnapshots();
  }, 3000);
}

function stopPendingPoll() {
  if (_pendingPollTimer) {
    clearInterval(_pendingPollTimer);
    _pendingPollTimer = null;
  }
}

function applyDocumentResult(result) {
  if (!result.parsed) return;
  state.blocks = result.parsed.blocks || [];
  state.links = result.parsed.links || [];
  state.namedSources = result.parsed.namedSources || {};
  state.customComponents = result.parsed.customComponents || {};
  state.sqlSources = result.parsed.sqlSources || {};
  if (result.text !== undefined) {
    elements.sourceInput.value = result.text;
  }
  render();
}

elements.refreshFiles.addEventListener("click", () => {
  refreshFiles().catch((error) => setStatus(elements.sourceStatus, error.message, "error"));
});

elements.sourceInput.addEventListener("input", () => {
  state.sourceDirty = true;
  setStatus(elements.sourceStatus, `Edited ${state.path || "source"} - unsaved`, "muted");
});

elements.sourceInput.addEventListener("blur", () => {
  if (!state.sourceDirty) {
    return;
  }
  saveSource().catch((error) => setStatus(elements.sourceStatus, error.message, "error"));
});

elements.saveSource.addEventListener("click", () => {
  saveSource().catch((error) => setStatus(elements.sourceStatus, error.message, "error"));
});

elements.toggleSourcePanel.addEventListener("click", () => {
  state.sourceCollapsed = !state.sourceCollapsed;
  syncSourcePanel();
  drawEdges();
});

elements.toggleInspectorPanel.addEventListener("click", () => {
  state.inspectorCollapsed = !state.inspectorCollapsed;
  syncInspectorPanel();
  drawEdges();
});

elements.reloadDocument.addEventListener("click", () => {
  reloadDocument().catch((error) => setStatus(elements.sourceStatus, error.message, "error"));
});

elements.refreshMetadata.addEventListener("click", () => {
  refreshMetadata().catch((error) => setStatus(elements.sourceStatus, error.message, "error"));
});

elements.fileSelect.addEventListener("change", () => {
  if (elements.fileSelect.value) {
    if (!confirmDiscardLocalChanges()) {
      elements.fileSelect.value = state.path || "";
      return;
    }
    loadDocument(elements.fileSelect.value).catch((error) => setStatus(elements.sourceStatus, error.message, "error"));
  }
});

elements.loadSample.addEventListener("click", () => {
  if (!confirmDiscardLocalChanges()) {
    return;
  }
  elements.fileSelect.value = "sample.org";
  loadDocument("sample.org").catch((error) => setStatus(elements.sourceStatus, error.message, "error"));
});

elements.generateWorkspace.addEventListener("click", () => {
  generateWorkspace().catch((error) => setStatus(elements.sourceStatus, error.message, "error"));
});

elements.generateRecipe.addEventListener("click", () => {
  generateRecipe().catch((error) => setStatus(elements.sourceStatus, error.message, "error"));
});

elements.applyRecipe.addEventListener("click", () => {
  applyRecipe().catch((error) => setStatus(elements.sourceStatus, error.message, "error"));
});

elements.saveFile.addEventListener("click", () => {
  saveWorkspace().catch((error) => setStatus(elements.sourceStatus, error.message, "error"));
});

elements.scanSettings.addEventListener("click", () => {
  openScanSettings().catch((error) => setStatus(elements.sourceStatus, error.message, "error"));
});
elements.scanSettingsSave.addEventListener("click", () => {
  saveScanSettings().catch((error) => setStatus(elements.sourceStatus, error.message, "error"));
});
elements.scanSettingsCancel.addEventListener("click", () => {
  elements.scanSettingsDialog.close();
});

elements.createLink.addEventListener("click", startLink);
elements.deleteLink.addEventListener("click", deleteSelectedLinks);
elements.viewport.addEventListener("pointerdown", handleViewportPointerDown);
elements.viewport.addEventListener("pointermove", handlePointerMove);
elements.viewport.addEventListener("pointerup", handlePointerUp);
elements.viewport.addEventListener("pointercancel", handlePointerUp);
elements.viewport.addEventListener("wheel", handleWheel, { passive: false });
window.addEventListener("resize", drawEdges);
window.addEventListener("beforeunload", (event) => {
  if (!hasLocalChanges()) {
    return;
  }
  event.preventDefault();
});

syncSourcePanel();
syncInspectorPanel();
const files = await refreshFiles();
await refreshMetadata();
await refreshExtensionInfo();
const initialPath = files.includes("sample.org") ? "sample.org" : files[0];
if (initialPath) {
  elements.fileSelect.value = initialPath;
  try {
    await loadDocument(initialPath);
  } catch (error) {
    setStatus(elements.sourceStatus, error.message, "error");
  }
}
