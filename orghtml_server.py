#!/usr/bin/env python3
import argparse
import csv
import json
import mimetypes
import re
import shlex
import sqlite3
import sys
import uuid
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse
import base64
import threading
from urllib.parse import urlparse as _urlparse_hostname


HEADING_RE = re.compile(r"^(\*+)\s+(.*?)\s*$")
TAG_GROUP_RE = re.compile(r"\s+((?::[A-Za-z0-9_@#%]+)+:)\s*$")
PROPERTY_RE = re.compile(r"^:([A-Za-z0-9_@#%]+):\s*(.*?)\s*$")
COMPONENT_RE = re.compile(r"^#\+orghtml_component:\s*([A-Za-z0-9_-]+)(.*)$", re.IGNORECASE)
VIEW_RE = re.compile(r"^#\+orghtml_view:\s*([A-Za-z0-9_-]+)(.*)$", re.IGNORECASE)
NAME_RE = re.compile(r"^#\+name:\s*(.*?)\s*$", re.IGNORECASE)
BEGIN_SRC_RE = re.compile(r"^#\+begin_src\s+([A-Za-z0-9_-]+)(.*)$", re.IGNORECASE)
END_SRC_RE = re.compile(r"^#\+end_src\s*$", re.IGNORECASE)
ORG_LINK_RE = re.compile(r"^\[\[([^\]\n]+?)(?:\]\[([^\]\n]*))?\]\]$")
WORKSPACE_PATH = ".orghtml/workspace.json"
HISTORY_PATH = ".orghtml/history.sqlite"
IMAGE_EXTENSIONS = {".apng", ".avif", ".gif", ".jpeg", ".jpg", ".png", ".svg", ".webp"}

SNAPSHOTS_DIR = ".orghtml/snapshots"

_pending_lock = threading.Lock()
_pending_snapshots = {}  # pendingId -> {url, title, captured_at, screenshot_bytes}

_extension_lock = threading.Lock()
_extension_id = None  # set by POST /api/snapshot/register-extension


def register_extension(extension_id):
    global _extension_id
    with _extension_lock:
        _extension_id = extension_id


def get_extension_info():
    with _extension_lock:
        eid = _extension_id
    return {"extensionId": eid, "connected": eid is not None}


def enqueue_pending(url, title, png_bytes):
    pending_id = str(uuid.uuid4())
    with _pending_lock:
        _pending_snapshots[pending_id] = {
            "url": url,
            "title": title,
            "captured_at": datetime.now(timezone.utc).isoformat(),
            "screenshot_bytes": png_bytes,
        }
    return pending_id


def list_pending():
    with _pending_lock:
        return [
            {
                "pendingId": pid,
                "url": entry["url"],
                "title": entry["title"],
                "captured_at": entry["captured_at"],
            }
            for pid, entry in _pending_snapshots.items()
        ]


def pop_pending(pending_id):
    with _pending_lock:
        entry = _pending_snapshots.pop(pending_id, None)
    if entry is None:
        raise ValueError(f"Pending snapshot not found: {pending_id}")
    return entry


def discard_pending(pending_id):
    with _pending_lock:
        _pending_snapshots.pop(pending_id, None)


def detect_newline(text):
    return "\r\n" if "\r\n" in text else "\n"


def split_lines(text):
    return text.splitlines(keepends=True)


def line_body(line):
    return line.rstrip("\r\n")


def parse_property_drawer(lines, heading_line):
    start = heading_line + 1
    if start >= len(lines) or line_body(lines[start]).strip().upper() != ":PROPERTIES:":
        return None

    properties = {}
    property_lines = {}
    line = start + 1
    while line < len(lines):
        stripped = line_body(lines[line]).strip()
        if stripped.upper() == ":END:":
            return {
                "startLine": start,
                "endLine": line,
                "properties": properties,
                "propertyLines": property_lines,
            }
        match = PROPERTY_RE.match(stripped)
        if match:
            key = match.group(1).upper()
            properties[key] = match.group(2)
            property_lines[key] = line
        line += 1

    return {
        "startLine": start,
        "endLine": len(lines) - 1,
        "properties": properties,
        "propertyLines": property_lines,
        "diagnostic": "Unclosed property drawer.",
    }


def parse_component_directive(raw, heading_id, index):
    match = COMPONENT_RE.match(raw.strip())
    if not match:
        return None

    attrs = {}
    for token in shlex.split(match.group(2).strip()):
        if "=" not in token:
            attrs[token] = True
            continue
        key, value = token.split("=", 1)
        attrs[key] = value

    return {
        "id": f"{heading_id}:component-{index + 1}",
        "type": match.group(1).lower(),
        "attrs": attrs,
        "raw": raw.strip(),
    }


def parse_view_directive(raw):
    match = VIEW_RE.match(raw.strip())
    if not match:
        return None
    attrs = {}
    for token in shlex.split(match.group(2).strip()):
        if "=" not in token:
            attrs[token] = True
            continue
        key, value = token.split("=", 1)
        attrs[key] = value
    return {"type": match.group(1).lower(), "attrs": attrs, "raw": raw.strip()}


def parse_name_directive(raw):
    match = NAME_RE.match(raw.strip())
    if not match:
        return None
    return match.group(1).strip()


def parse_begin_src(raw):
    match = BEGIN_SRC_RE.match(raw.strip())
    if not match:
        return None
    return {"language": match.group(1).lower(), "raw": raw.strip()}


def is_org_table_line(raw):
    return raw.strip().startswith("|")


def parse_org_table_lines(table_lines, grouped=False):
    rows = []
    separator_indexes = []
    for index, raw in enumerate(table_lines):
        stripped = raw.strip()
        cells = [cell.strip() for cell in stripped.strip("|").split("|")]
        is_separator = bool(cells) and all(re.fullmatch(r"[-+=:\s]+", cell) for cell in cells)
        if is_separator:
            separator_indexes.append(index)
        else:
            rows.append({"sourceIndex": index, "cells": cells})

    header = []
    body_rows = rows
    if separator_indexes:
        first_separator = separator_indexes[0]
        header_rows = [row for row in rows if row["sourceIndex"] < first_separator]
        body_rows = [row for row in rows if row["sourceIndex"] > first_separator]
        if header_rows:
            header = header_rows[-1]["cells"]

    sample_row = body_rows[0]["cells"] if body_rows else (rows[0]["cells"] if rows else [])
    columns = header or [f"col{index + 1}" for index in range(len(sample_row))]

    if grouped and len(separator_indexes) > 1:
        # Build an ordered sequence of body rows and interior separators.
        body_events = [(row["sourceIndex"], row) for row in body_rows]
        for sep_idx in separator_indexes[1:]:
            body_events.append((sep_idx, "sep"))
        body_events.sort(key=lambda e: e[0])

        # Split into groups at each interior separator.
        groups = []
        current_group = []
        for _, event in body_events:
            if event == "sep":
                if current_group:
                    groups.append(current_group)
                current_group = []
            else:
                current_group.append(event)
        if current_group:
            groups.append(current_group)

        # Fill-down within each group: first column is always the first row's
        # value for the entire group; other columns fill empty cells from above.
        data_rows = []
        for group in groups:
            if not group:
                continue
            group_key = group[0]["cells"][0] if group[0]["cells"] else ""
            prev_cells = {col: "" for col in columns}
            for row in group:
                cells = row["cells"]
                record = {}
                for col_idx, column in enumerate(columns):
                    raw_val = cells[col_idx] if col_idx < len(cells) else ""
                    if col_idx == 0:
                        record[column] = group_key
                    else:
                        record[column] = raw_val if raw_val else prev_cells[column]
                prev_cells = record
                data_rows.append(record)
    else:
        data_rows = [
            {column: row["cells"][index] if index < len(row["cells"]) else "" for index, column in enumerate(columns)}
            for row in body_rows
        ]

    return {
        "raw": "\n".join(table_lines),
        "header": header,
        "rows": [row["cells"] for row in body_rows],
        "data": {
            "columns": columns,
            "rows": data_rows,
        },
    }


def image_path_from_org_link(raw):
    match = ORG_LINK_RE.match(raw.strip())
    if not match:
        return None
    target = match.group(1)
    display = match.group(2) or ""
    path = target.removeprefix("file:")
    if Path(path).suffix.lower() not in IMAGE_EXTENSIONS:
        return None
    return {"path": path, "alt": display or Path(path).name, "raw": raw.strip()}


def pdf_path_from_org_link(raw):
    match = ORG_LINK_RE.match(raw.strip())
    if not match:
        return None
    target = match.group(1)
    display = match.group(2) or ""
    path = target.removeprefix("file:")
    if Path(path).suffix.lower() != ".pdf":
        return None
    return {"path": path, "title": display or Path(path).name, "raw": raw.strip()}


def sql_identifier(name):
    return '"' + str(name).replace('"', '""') + '"'


def sql_table_name_for_path(rel_path):
    stem = re.sub(r"[^A-Za-z0-9_]+", "_", str(rel_path)).strip("_").lower()
    if not stem:
        stem = "source"
    if stem[0].isdigit():
        stem = f"t_{stem}"
    return f"file_{stem}"


def import_table_into_sqlite(connection, table_name, columns, rows):
    if not columns:
        return
    quoted_table = sql_identifier(table_name)
    quoted_columns = ", ".join(f"{sql_identifier(column)} TEXT" for column in columns)
    connection.execute(f"DROP TABLE IF EXISTS {quoted_table}")
    connection.execute(f"CREATE TABLE {quoted_table} ({quoted_columns})")
    placeholders = ", ".join("?" for _ in columns)
    insert_sql = f"INSERT INTO {quoted_table} ({', '.join(sql_identifier(column) for column in columns)}) VALUES ({placeholders})"
    connection.executemany(insert_sql, [[row.get(column, "") for column in columns] for row in rows])


def query_sqlite(connection, sql):
    cursor = connection.execute(sql)
    columns = [description[0] for description in cursor.description or []]
    rows = [dict(zip(columns, row)) for row in cursor.fetchall()]
    return {"columns": columns, "rows": rows}


def populate_workspace_sqlite(connection, root, named_tables, named_queries):
    diagnostics = []
    external_mappings = []
    for path in sorted(root.rglob("*")):
        if ".orghtml" in path.parts or not path.is_file():
            continue
        if path.suffix.lower() not in (".csv", ".jsonl"):
            continue
        rel_path = str(path.relative_to(root))
        table_name = sql_table_name_for_path(rel_path)
        try:
            table = read_table(path)
        except (OSError, json.JSONDecodeError, csv.Error) as error:
            diagnostics.append(f"Failed to import {rel_path} into SQL: {error}")
            continue
        import_table_into_sqlite(connection, table_name, table["columns"], table["rows"])
        external_mappings.append({"path": rel_path, "table": table_name})

    if external_mappings:
        import_table_into_sqlite(connection, "orghtml_sources", ["path", "table"], external_mappings)

    for name, table in named_tables.items():
        import_table_into_sqlite(connection, name, table["columns"], table["rows"])

    sources = {name: {"columns": table["columns"], "rows": table["rows"]} for name, table in named_tables.items()}
    pending = dict(named_queries)
    last_pending = None
    while pending and pending != last_pending:
        last_pending = dict(pending)
        for name, sql in list(pending.items()):
            try:
                result = query_sqlite(connection, sql)
            except sqlite3.Error:
                continue
            sources[name] = result
            import_table_into_sqlite(connection, name, result["columns"], result["rows"])
            pending.pop(name, None)

    for name, sql in pending.items():
        try:
            query_sqlite(connection, sql)
        except sqlite3.Error as error:
            diagnostics.append(f"SQL source {name}: {error}")

    return sources, diagnostics


def build_named_sources(root, named_tables, named_queries):
    connection = sqlite3.connect(":memory:")
    try:
        return populate_workspace_sqlite(connection, root, named_tables, named_queries)
    finally:
        connection.close()


def collect_workspace_named_data(text, workspace_doc=None):
    workspace_doc = workspace_doc or {}
    lines, headings = find_headings(text)
    named_tables = {}
    named_queries = dict(workspace_doc.get("sqlSources", {}))

    for index, heading in enumerate(headings):
        next_heading_line = headings[index + 1]["headingLine"] if index + 1 < len(headings) else len(lines)
        components, content, block_named_tables, block_named_queries = parse_block_content(
            lines,
            heading["headingLine"],
            next_heading_line,
            heading["propertyDrawer"],
            heading.get("id") or f"h-{index + 1}",
        )
        named_tables.update(block_named_tables)
        named_queries.update(block_named_queries)

    return named_tables, named_queries


def execute_workspace_query(root, text, workspace_doc, sql):
    statement = str(sql or "").strip()
    if not statement:
        raise ValueError("Missing SQL query.")
    if not re.match(r"^(select|with)\b", statement, re.IGNORECASE):
        raise ValueError("Only read-only SELECT queries are allowed.")

    named_tables, named_queries = collect_workspace_named_data(text, workspace_doc)
    connection = sqlite3.connect(":memory:")
    try:
        _, diagnostics = populate_workspace_sqlite(connection, root, named_tables, named_queries)
        result = query_sqlite(connection, statement)
    except sqlite3.Error as error:
        raise ValueError(str(error)) from error
    finally:
        connection.close()
    return {"result": result, "diagnostics": diagnostics}


def parse_block_content(lines, start_line, end_line, drawer, heading_id):
    body_start = start_line + 1
    if drawer:
        body_start = max(body_start, drawer["endLine"] + 1)

    content = []
    components = []
    named_tables = {}
    named_queries = {}
    pending_text = []
    pending_name = None
    pending_view = None

    def flush_text():
        nonlocal pending_text
        while pending_text and not pending_text[0].strip():
            pending_text.pop(0)
        while pending_text and not pending_text[-1].strip():
            pending_text.pop()
        if pending_text:
            text = "\n".join(pending_text)
            text_index = sum(1 for item in content if item["kind"] == "text")
            content.append({"kind": "text", "textIndex": text_index, "text": text})
        pending_text = []

    line_index = body_start
    while line_index < end_line:
        line = lines[line_index]
        raw = line_body(line)
        stripped = raw.strip()
        name = parse_name_directive(stripped)
        if name:
            pending_name = name
            line_index += 1
            continue
        begin_src = parse_begin_src(stripped)
        if begin_src:
            flush_text()
            language = begin_src["language"]
            line_index += 1
            src_lines = []
            while line_index < end_line and not END_SRC_RE.match(line_body(lines[line_index]).strip()):
                src_lines.append(line_body(lines[line_index]))
                line_index += 1
            if line_index < end_line:
                line_index += 1
            if language in ("sql", "sqlite"):
                if pending_name:
                    named_queries[pending_name] = "\n".join(src_lines).strip()
            else:
                content.append({"kind": "srcBlock", "language": language, "body": "\n".join(src_lines)})
            pending_name = None
            pending_view = None
            continue
        view = parse_view_directive(stripped)
        if view:
            pending_view = view
            line_index += 1
            continue
        component = parse_component_directive(stripped, heading_id, len(components))
        if component:
            flush_text()
            components.append(component)
            content.append({"kind": "component", "componentId": component["id"], "component": component})
            line_index += 1
            continue
        if is_org_table_line(raw):
            flush_text()
            table_lines = []
            while line_index < end_line and is_org_table_line(line_body(lines[line_index])):
                table_lines.append(line_body(lines[line_index]))
                line_index += 1
            grouped = bool(pending_view and pending_view.get("attrs", {}).get("grouped"))
            table = parse_org_table_lines(table_lines, grouped=grouped)
            item = {"kind": "orgTable", "name": pending_name, "view": pending_view, **table}
            content.append(item)
            if pending_name:
                named_tables[pending_name] = table["data"]
            pending_name = None
            pending_view = None
            continue
        image = image_path_from_org_link(stripped)
        if image:
            flush_text()
            content.append({"kind": "image", **image})
            pending_name = None
            pending_view = None
            line_index += 1
            continue
        pdf = pdf_path_from_org_link(stripped)
        if pdf:
            flush_text()
            content.append({"kind": "pdf", **pdf})
            pending_name = None
            pending_view = None
            line_index += 1
            continue
        if not stripped.startswith("#+"):
            if stripped:
                pending_name = None
                pending_view = None
            pending_text.append(raw)
        line_index += 1
    flush_text()

    return components, content, named_tables, named_queries


def quote_attr(value):
    text = str(value)
    if text == "":
        return '""'
    if re.search(r"\s|\"", text):
        return shlex.quote(text)
    return text


def serialize_component_directive(component_type, attrs):
    parts = []
    for key in sorted(attrs.keys()):
        value = attrs[key]
        if value is True:
            parts.append(key)
        elif value in (False, None):
            continue
        else:
            parts.append(f"{key}={quote_attr(value)}")
    suffix = f" {' '.join(parts)}" if parts else ""
    return f"#+orghtml_component: {component_type}{suffix}"


def update_component_directive(text, block_id, component_id, component_type, attrs):
    lines, headings = find_headings(text)
    newline = detect_newline(text)

    for index, heading in enumerate(headings):
        drawer = heading["propertyDrawer"]
        properties = drawer["properties"] if drawer else {}
        if properties.get("ID") != block_id:
            continue

        body_start = heading["headingLine"] + 1
        if drawer:
            body_start = max(body_start, drawer["endLine"] + 1)
        end_line = block_end_line(headings, index, lines)

        component_index = 0
        for line_no in range(body_start, end_line):
            raw = line_body(lines[line_no]).strip()
            if not COMPONENT_RE.match(raw):
                continue
            current_id = f"{block_id}:component-{component_index + 1}"
            if current_id == component_id:
                lines[line_no] = serialize_component_directive(component_type, attrs) + newline
                return "".join(lines)
            component_index += 1

    raise ValueError("Component directive not found.")


def insert_component_directive(text, block_id, component_type, attrs):
    lines, headings = find_headings(text)
    newline = detect_newline(text)

    for index, heading in enumerate(headings):
        drawer = heading["propertyDrawer"]
        properties = drawer["properties"] if drawer else {}
        if properties.get("ID") != block_id:
            continue

        end_line = block_end_line(headings, index, lines)
        insertion = []
        if end_line > 0 and line_body(lines[end_line - 1]).strip():
            insertion.append(newline)
        insertion.append(serialize_component_directive(component_type, attrs) + newline)
        lines[end_line:end_line] = insertion
        return "".join(lines)

    raise ValueError("Block not found.")


def delete_component_directive(text, block_id, component_id):
    lines, headings = find_headings(text)

    for index, heading in enumerate(headings):
        drawer = heading["propertyDrawer"]
        properties = drawer["properties"] if drawer else {}
        if properties.get("ID") != block_id:
            continue

        body_start = heading["headingLine"] + 1
        if drawer:
            body_start = max(body_start, drawer["endLine"] + 1)
        end_line = block_end_line(headings, index, lines)

        component_index = 0
        for line_no in range(body_start, end_line):
            raw = line_body(lines[line_no]).strip()
            if not COMPONENT_RE.match(raw):
                continue
            current_id = f"{block_id}:component-{component_index + 1}"
            if current_id == component_id:
                lines[line_no:line_no + 1] = []
                return "".join(lines)
            component_index += 1

    raise ValueError("Component directive not found.")


def text_segments(lines, start_line, end_line):
    segments = []
    segment_start = None
    segment_end = None
    in_src_block = False

    def flush():
        nonlocal segment_start, segment_end
        if segment_start is not None and segment_end is not None:
            while segment_end > segment_start and not line_body(lines[segment_end - 1]).strip():
                segment_end -= 1
            if segment_end > segment_start:
                segments.append((segment_start, segment_end))
        segment_start = None
        segment_end = None

    for line_no in range(start_line, end_line):
        stripped = line_body(lines[line_no]).strip()
        begin_src = parse_begin_src(stripped)
        if begin_src:
            in_src_block = True
            flush()
            continue
        if in_src_block:
            if END_SRC_RE.match(stripped):
                in_src_block = False
            flush()
            continue
        if stripped.startswith("#+") or is_org_table_line(stripped) or image_path_from_org_link(stripped):
            flush()
            continue
        if segment_start is None:
            if not stripped:
                continue
            segment_start = line_no
        segment_end = line_no + 1
    flush()
    return segments


def update_block_text(text, block_id, text_index, body):
    lines, headings = find_headings(text)
    newline = detect_newline(text)

    for index, heading in enumerate(headings):
        drawer = heading["propertyDrawer"]
        properties = drawer["properties"] if drawer else {}
        if properties.get("ID") != block_id:
            continue

        body_start = heading["headingLine"] + 1
        if drawer:
            body_start = max(body_start, drawer["endLine"] + 1)
        end_line = block_end_line(headings, index, lines)

        segments = text_segments(lines, body_start, end_line)
        if text_index < 0 or text_index >= len(segments):
            raise ValueError("Text chunk not found.")

        start, end = segments[text_index]
        replacement = [body_line.rstrip("\r\n") + newline for body_line in str(body or "").splitlines()]
        lines[start:end] = replacement
        return "".join(lines)

    raise ValueError("Block not found.")


def block_end_line(headings, index, lines):
    end = headings[index + 1]["headingLine"] if index + 1 < len(headings) else len(lines)
    j = index + 1
    if "mergeall" in headings[index]["tags"]:
        while j < len(headings) and headings[j]["level"] > headings[index]["level"]:
            end = headings[j + 1]["headingLine"] if j + 1 < len(headings) else len(lines)
            j += 1
    else:
        while j < len(headings) and headings[j]["level"] > headings[index]["level"] and "merge" in headings[j]["tags"]:
            end = headings[j + 1]["headingLine"] if j + 1 < len(headings) else len(lines)
            j += 1
    return end


def parse_heading_tags(raw_title):
    m = TAG_GROUP_RE.search(raw_title)
    if not m:
        return raw_title, frozenset()
    tags = frozenset(t for t in m.group(1).split(":") if t)
    return raw_title[:m.start()], tags


def find_headings(text):
    lines = split_lines(text)
    headings = []
    for idx, line in enumerate(lines):
        match = HEADING_RE.match(line_body(line))
        if match:
            raw_title = match.group(2).strip()
            clean_title, tags = parse_heading_tags(raw_title)
            headings.append({
                "level": len(match.group(1)),
                "title": clean_title or "Untitled heading",
                "tags": tags,
                "headingLine": idx,
                "propertyDrawer": parse_property_drawer(lines, idx),
            })
    return lines, headings



def ensure_heading_ids(text):
    lines, headings = find_headings(text)
    newline = detect_newline(text)
    edits = []
    changed = False

    novizall_level = None
    mergeall_level = None
    for heading in headings:
        if novizall_level is not None and heading["level"] <= novizall_level:
            novizall_level = None
        if mergeall_level is not None and heading["level"] <= mergeall_level:
            mergeall_level = None
        is_mergeall_child = mergeall_level is not None
        if "mergeall" in heading["tags"]:
            mergeall_level = heading["level"]
        if is_mergeall_child or novizall_level is not None or "noviz" in heading["tags"] or "novizall" in heading["tags"] or "merge" in heading["tags"]:
            if "novizall" in heading["tags"]:
                novizall_level = heading["level"]
            continue
        drawer = heading["propertyDrawer"]
        properties = drawer["properties"] if drawer else {}
        if properties.get("ID"):
            continue

        changed = True
        new_id = str(uuid.uuid4())
        if drawer:
            edits.append((drawer["endLine"], drawer["endLine"], [f":ID: {new_id}{newline}"]))
        else:
            drawer_lines = [
                f":PROPERTIES:{newline}",
                f":ID: {new_id}{newline}",
                f":END:{newline}",
            ]
            edits.append((heading["headingLine"] + 1, heading["headingLine"] + 1, drawer_lines))

    for start, end, replacement in sorted(edits, key=lambda edit: edit[0], reverse=True):
        lines[start:end] = replacement
    return "".join(lines), changed


def parse_org_document(text, workspace_doc=None, project_root=None):
    workspace_doc = workspace_doc or {}
    lines, headings = find_headings(text)
    diagnostics = []

    for index, heading in enumerate(headings):
        heading["contentEndLine"] = headings[index + 1]["headingLine"] if index + 1 < len(headings) else len(lines)

    for index, heading in enumerate(headings):
        heading["key"] = f"h-{index + 1}"
        drawer = heading["propertyDrawer"]
        heading["properties"] = drawer["properties"] if drawer else {}
        heading["id"] = heading["properties"].get("ID")
        heading["parentId"] = None
        heading["childIds"] = []

    stack = []
    for heading in headings:
        while stack and stack[-1]["level"] >= heading["level"]:
            stack.pop()
        if stack:
            heading["parentId"] = stack[-1].get("id")
            stack[-1]["childIds"].append(heading.get("id"))
        stack.append(heading)

    id_counts = {}
    for heading in headings:
        drawer = heading["propertyDrawer"]
        heading["diagnostics"] = []
        if drawer and drawer.get("diagnostic"):
            heading["diagnostics"].append(drawer["diagnostic"])
        if heading["id"]:
            id_counts[heading["id"]] = id_counts.get(heading["id"], 0) + 1

    public_blocks = []
    named_tables = {}
    named_queries = dict(workspace_doc.get("sqlSources", {}))
    nodes = workspace_doc.get("nodes", {})
    previous_block_id = None
    novizall_level = None
    mergeall_level = None
    for index, heading in enumerate(headings):
        heading_id = heading["id"]

        if novizall_level is not None and heading["level"] <= novizall_level:
            novizall_level = None
        if mergeall_level is not None and heading["level"] <= mergeall_level:
            mergeall_level = None
        is_mergeall_child = mergeall_level is not None
        if "mergeall" in heading["tags"]:
            mergeall_level = heading["level"]

        suppressed = novizall_level is not None or "noviz" in heading["tags"] or "novizall" in heading["tags"]
        if "novizall" in heading["tags"]:
            novizall_level = heading["level"]

        if suppressed:
            _, _, block_named_tables, block_named_queries = parse_block_content(
                lines,
                heading["headingLine"],
                heading["contentEndLine"],
                heading["propertyDrawer"],
                heading_id or heading["key"],
            )
            named_tables.update(block_named_tables)
            named_queries.update(block_named_queries)
            continue

        if "merge" in heading["tags"] or is_mergeall_child:
            continue

        if not heading_id:
            heading["diagnostics"].append("Missing ID.")
        elif id_counts[heading_id] > 1:
            heading["diagnostics"].append(f"Duplicate ID: {heading_id}")

        end_line = block_end_line(headings, index, lines)

        components, content, block_named_tables, block_named_queries = parse_block_content(
            lines,
            heading["headingLine"],
            end_line,
            heading["propertyDrawer"],
            heading_id or heading["key"],
        )
        saved_node = nodes.get(heading_id, {}) if heading_id else {}
        has_saved_node = bool(saved_node)
        has_saved_position = "x" in saved_node and "y" in saved_node
        if has_saved_node:
            layout_mode = saved_node.get("layout") or "free"
            layout_after = saved_node.get("after")
        elif previous_block_id:
            layout_mode = "flow"
            layout_after = previous_block_id
        else:
            layout_mode = "free"
            layout_after = None
        position = {
            "x": saved_node.get("x", 80),
            "y": saved_node.get("y", 80 + index * 260),
        }
        size = {
            "width": saved_node.get("width"),
            "height": saved_node.get("height"),
        }
        public = {
            "key": heading_id or heading["key"],
            "id": heading_id,
            "level": heading["level"],
            "title": heading["title"],
            "components": components,
            "content": content,
            "parentId": heading["parentId"],
            "childIds": [child_id for child_id in heading["childIds"] if child_id],
            "position": position,
            "size": size,
            "layout": {
                "mode": layout_mode,
                "after": layout_after,
                "gap": saved_node.get("gap", 28),
            },
            "hasSavedPosition": has_saved_position,
            "diagnostics": heading["diagnostics"],
        }
        public_blocks.append(public)
        named_tables.update(block_named_tables)
        named_queries.update(block_named_queries)
        if heading_id:
            previous_block_id = heading_id
        diagnostics.extend({
            "headingId": heading_id,
            "headingTitle": heading["title"],
            "message": message,
        } for message in heading["diagnostics"])

    block_ids = {block["id"] for block in public_blocks if block["id"]}
    links = []
    for link in workspace_doc.get("links", []):
        source = link.get("source")
        target = link.get("target")
        if source in block_ids and target in block_ids:
            links.append({"id": f"e-{source}-{target}", "sourceId": source, "targetId": target})

    named_sources, source_diagnostics = build_named_sources(project_root or Path("."), named_tables, named_queries)
    return {
        "blocks": public_blocks,
        "links": links,
        "namedSources": named_sources,
        "customComponents": workspace_doc.get("customComponents", {}),
        "sqlSources": workspace_doc.get("sqlSources", {}),
        "camera": workspace_doc.get("camera", {"x": 20, "y": 20, "zoom": 1}),
        "diagnostics": diagnostics
        + [{"message": message} for message in workspace_doc.get("workspaceDiagnostics", [])]
        + [{"message": message} for message in source_diagnostics],
    }


def find_component_by_snapshot_id(root, snapshot_id):
    """Return (rel_path, block_id, component_id) for the webSnapshot directive matching snapshot_id, or None."""
    for path in sorted(root.rglob("*.org")):
        if ".orghtml" in path.parts or not path.is_file():
            continue
        rel_path = str(path.relative_to(root))
        try:
            content = path.read_text(encoding="utf-8")
        except OSError:
            continue
        lines, headings = find_headings(content)
        for index, heading in enumerate(headings):
            drawer = heading["propertyDrawer"]
            properties = drawer["properties"] if drawer else {}
            block_id = properties.get("ID")
            if not block_id:
                continue
            body_start = heading["headingLine"] + 1
            if drawer:
                body_start = max(body_start, drawer["endLine"] + 1)
            end_line = block_end_line(headings, index, lines)
            component_index = 0
            for line_no in range(body_start, end_line):
                raw = line_body(lines[line_no]).strip()
                m = COMPONENT_RE.match(raw)
                if not m:
                    continue
                component_id = f"{block_id}:component-{component_index + 1}"
                component_index += 1
                if m.group(1).lower() != "websnapshot":
                    continue
                attrs = parse_attrs(m.group(2))
                if attrs.get("id") == snapshot_id:
                    return rel_path, block_id, component_id
    return None


def parse_attrs(raw):
    """Parse shell-style key=value attrs string into a dict."""
    result = {}
    try:
        tokens = shlex.split(raw)
    except ValueError:
        tokens = raw.split()
    for token in tokens:
        if "=" in token:
            key, _, value = token.partition("=")
            result[key.strip()] = value.strip()
    return result


def snapshot_dir(root):
    return root / SNAPSHOTS_DIR


def write_snapshot_png(root, snapshot_id, png_bytes):
    directory = snapshot_dir(root)
    directory.mkdir(parents=True, exist_ok=True)
    (directory / f"{snapshot_id}.png").write_bytes(png_bytes)


def overwrite_snapshot_component(root, snapshot_id, url, title, frozen_at, png_bytes):
    result = find_component_by_snapshot_id(root, snapshot_id)
    if result is None:
        raise ValueError(f"webSnapshot component with id={snapshot_id} not found.")
    rel_path, block_id, component_id = result
    target = root / rel_path
    text = target.read_text(encoding="utf-8")
    snapshot_path_state(root, rel_path, "snapshot-overwrite")
    write_snapshot_png(root, snapshot_id, png_bytes)
    new_attrs = {"id": snapshot_id, "url": url, "title": title, "frozen_at": frozen_at}
    updated = update_component_directive(text, block_id, component_id, "webSnapshot", new_attrs)
    target.write_text(updated, encoding="utf-8")
    _, doc_workspace = document_workspace(root, rel_path)
    return rel_path, parse_org_document(updated, doc_workspace, root)


def promote_pending_snapshot(root, rel_path, pending_id, heading_title=None):
    entry = pop_pending(pending_id)
    snapshot_id = str(uuid.uuid4())
    block_id = str(uuid.uuid4())
    frozen_at = entry["captured_at"]
    url = entry["url"]
    title = entry["title"]
    if not heading_title:
        try:
            hostname = _urlparse_hostname(url).hostname or url
        except Exception:
            hostname = url
        heading_title = f"Web snapshot — {hostname}"

    snapshot_path_state(root, rel_path, "snapshot-promote")
    write_snapshot_png(root, snapshot_id, entry["screenshot_bytes"])

    target = root / rel_path
    text = target.read_text(encoding="utf-8")
    newline = detect_newline(text)
    attrs = {"id": snapshot_id, "url": url, "title": title, "frozen_at": frozen_at}
    directive = serialize_component_directive("webSnapshot", attrs)
    block_heading = (
        f"{newline}* {heading_title}{newline}"
        f":PROPERTIES:{newline}"
        f":ID: {block_id}{newline}"
        f":END:{newline}"
        f"{directive}{newline}"
    )
    if not text.endswith(newline):
        block_heading = newline + block_heading
    updated = text + block_heading
    target.write_text(updated, encoding="utf-8")
    _, doc_workspace = document_workspace(root, rel_path)
    parsed = parse_org_document(updated, doc_workspace, root)
    return rel_path, updated, parsed


def workspace_file(root):
    return root / WORKSPACE_PATH


def sidecar_root(root):
    return root / ".orghtml"


def history_file(root):
    return root / HISTORY_PATH


def history_connection(root):
    path = history_file(root)
    path.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(path)
    connection.row_factory = sqlite3.Row
    connection.execute(
        """
        CREATE TABLE IF NOT EXISTS snapshots (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            path TEXT NOT NULL,
            created_at TEXT NOT NULL,
            reason TEXT NOT NULL,
            source_text TEXT,
            workspace_doc TEXT
        )
        """
    )
    connection.commit()
    return connection


def read_workspace(root):
    path = workspace_file(root)
    if not path.exists():
        return {"version": 1, "documents": {}}
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return {"version": 1, "documents": {}, "diagnostics": ["Invalid workspace JSON."]}


def write_workspace(root, workspace):
    path = workspace_file(root)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(workspace, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def resolve_sidecar_path(root, rel_path):
    if not rel_path:
        raise ValueError("Missing sidecar file path.")
    rel = str(rel_path).replace("\\", "/")
    if rel.startswith(".orghtml/"):
        rel = rel[len(".orghtml/"):]
    base = sidecar_root(root).resolve()
    target = (base / rel).resolve()
    if base not in target.parents and target != base:
        raise ValueError("Sidecar file must stay within .orghtml.")
    return target


def load_workspace_sql_sources(root, workspace):
    sql_sources = {}
    diagnostics = []
    for name, spec in (workspace.get("sqlSources") or {}).items():
        if not isinstance(spec, dict) or not spec.get("file"):
            diagnostics.append(f"Workspace SQL source {name} must use a file reference.")
            continue
        try:
            target = resolve_sidecar_path(root, spec.get("file"))
            sql_sources[name] = target.read_text(encoding="utf-8")
        except (OSError, ValueError) as error:
            diagnostics.append(f"Workspace SQL source {name}: {error}")
    return sql_sources, diagnostics


def load_workspace_custom_components(root, workspace):
    definitions = {}
    diagnostics = []
    for name, spec in (workspace.get("customComponents") or {}).items():
        if not isinstance(spec, dict) or not spec.get("codeFile"):
            diagnostics.append(f"Workspace custom component {name} must use a codeFile reference.")
            continue
        try:
            target = resolve_sidecar_path(root, spec.get("codeFile"))
            definition = {"code": target.read_text(encoding="utf-8")}
            css_file = spec.get("cssFile")
            if css_file:
                definition["css"] = resolve_sidecar_path(root, css_file).read_text(encoding="utf-8")
            definitions[name] = definition
        except (OSError, ValueError) as error:
            diagnostics.append(f"Workspace custom component {name}: {error}")
    return definitions, diagnostics


def document_workspace(root, rel_path):
    workspace = read_workspace(root)
    documents = workspace.setdefault("documents", {})
    doc = documents.setdefault(rel_path, {"camera": {"x": 20, "y": 20, "zoom": 1}, "nodes": {}, "links": []})
    return workspace, doc


def effective_workspace_document(root, workspace, rel_path):
    doc = workspace.get("documents", {}).get(rel_path, {})
    custom_components, custom_diagnostics = load_workspace_custom_components(root, workspace)
    sql_sources, sql_diagnostics = load_workspace_sql_sources(root, workspace)
    return {
        "camera": doc.get("camera", {"x": 20, "y": 20, "zoom": 1}),
        "nodes": doc.get("nodes", {}),
        "links": doc.get("links", []),
        "customComponents": custom_components,
        "sqlSources": sql_sources,
        "workspaceDiagnostics": custom_diagnostics + sql_diagnostics,
    }


def workspace_document(root, rel_path):
    workspace = read_workspace(root)
    return effective_workspace_document(root, workspace, rel_path)


def snapshot_path_state(root, rel_path, reason):
    target = (root / rel_path).resolve()
    source_text = None
    if target.exists() and target.is_file():
        source_text = target.read_text(encoding="utf-8")

    workspace_doc = None
    if Path(rel_path).suffix.lower() == ".org":
        workspace = read_workspace(root)
        workspace_doc = workspace.get("documents", {}).get(rel_path)

    if source_text is None and workspace_doc is None:
        return None

    with history_connection(root) as connection:
        cursor = connection.execute(
            """
            INSERT INTO snapshots(path, created_at, reason, source_text, workspace_doc)
            VALUES (?, ?, ?, ?, ?)
            """,
            (
                rel_path,
                datetime.now(timezone.utc).isoformat(),
                reason,
                source_text,
                json.dumps(workspace_doc) if workspace_doc is not None else None,
            ),
        )
        connection.commit()
        return cursor.lastrowid


def list_snapshots(root, rel_path, limit=30):
    with history_connection(root) as connection:
        rows = connection.execute(
            """
            SELECT id, path, created_at, reason
            FROM snapshots
            WHERE path = ?
            ORDER BY id DESC
            LIMIT ?
            """,
            (rel_path, max(1, min(int(limit), 200))),
        ).fetchall()
    return [dict(row) for row in rows]


def restore_snapshot(root, snapshot_id, expected_path=None):
    with history_connection(root) as connection:
        row = connection.execute(
            """
            SELECT id, path, created_at, reason, source_text, workspace_doc
            FROM snapshots
            WHERE id = ?
            """,
            (int(snapshot_id),),
        ).fetchone()
    if not row:
        raise ValueError("Snapshot not found.")
    rel_path = row["path"]
    if expected_path and rel_path != expected_path:
        raise ValueError("Snapshot path mismatch.")

    snapshot_path_state(root, rel_path, f"restore-before:{row['id']}")

    target = root / rel_path
    if row["source_text"] is not None:
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(row["source_text"], encoding="utf-8")

    if Path(rel_path).suffix.lower() == ".org":
        workspace = read_workspace(root)
        documents = workspace.setdefault("documents", {})
        if row["workspace_doc"] is None:
            documents.pop(rel_path, None)
        else:
            documents[rel_path] = json.loads(row["workspace_doc"])
        write_workspace(root, workspace)

    return {"id": row["id"], "path": rel_path, "createdAt": row["created_at"], "reason": row["reason"]}


def read_table(path):
    suffix = path.suffix.lower()
    if suffix == ".jsonl":
        rows = []
        for line in path.read_text(encoding="utf-8").splitlines():
            if line.strip():
                rows.append(json.loads(line))
        columns = sorted({key for row in rows if isinstance(row, dict) for key in row.keys()})
        return {"columns": columns, "rows": rows}

    with path.open(newline="", encoding="utf-8") as handle:
        reader = csv.DictReader(handle)
        rows = list(reader)
        return {"columns": reader.fieldnames or [], "rows": rows}


def image_files(root, rel_path):
    root = root.resolve()
    directory = (root / rel_path).resolve()
    if root not in directory.parents and directory != root:
        raise PermissionError("Path is outside project root.")
    if not directory.exists() or not directory.is_dir():
        return []

    images = []
    for path in sorted(directory.iterdir()):
        if path.is_file() and (mimetypes.guess_type(str(path))[0] or "").startswith("image/"):
            images.append({
                "path": str(path.relative_to(root)),
                "name": path.name,
            })
    return images


def scan_project_metadata(root):
    tables = []
    image_dirs = []
    for path in sorted(root.rglob("*")):
        if ".orghtml" in path.parts or not path.is_file():
            continue
        rel_path = str(path.relative_to(root))
        suffix = path.suffix.lower()
        if suffix in (".csv", ".jsonl"):
            try:
                table = read_table(path)
            except (OSError, json.JSONDecodeError, csv.Error):
                continue
            tables.append({
                "path": rel_path,
                "columns": table["columns"],
                "rows": len(table["rows"]),
                "kind": suffix.lstrip("."),
            })

    for directory in sorted({path.parent for path in root.rglob("*") if path.is_file()}):
        if ".orghtml" in directory.parts:
            continue
        images = image_files(root, str(directory.relative_to(root)))
        if images:
            image_dirs.append({
                "path": str(directory.relative_to(root)) or ".",
                "images": len(images),
            })

    return {"tables": tables, "imageDirs": image_dirs}


def table_has(columns, *names):
    lowered = {column.lower() for column in columns}
    return all(name.lower() in lowered for name in names)


def first_numeric_column(rows, columns):
    for column in columns:
        values = [row.get(column) for row in rows[:20]]
        if values and all(str(value).replace(".", "", 1).isdigit() for value in values if value not in (None, "")):
            return column
    return None


def generate_workspace(root):
    recipe = generate_recipe(root)
    return apply_recipe(root, recipe)


def generate_recipe(root):
    metadata = scan_project_metadata(root)
    blocks = []

    tasks = next((table for table in metadata["tables"] if "status" in [c.lower() for c in table["columns"]]), None)
    if tasks:
        blocks.append({
            "title": "Task board",
            "content": [
                {"kind": "text", "text": "Generated block grouping task records by status."},
                {"type": "board", "attrs": {"source": tasks["path"], "group": "status", "title": "Tasks", "limit": "8"}},
                {"type": "table", "attrs": {"source": tasks["path"], "columns": ",".join(tasks["columns"][:5]), "limit": "8"}},
            ],
        })

    chart_table = None
    chart_x = None
    chart_y = None
    for table in metadata["tables"]:
        rows = read_table(root / table["path"])["rows"]
        numeric = first_numeric_column(rows, table["columns"])
        if numeric and len(table["columns"]) >= 2:
            chart_table = table
            chart_y = numeric
            chart_x = next((column for column in table["columns"] if column != numeric), table["columns"][0])
            break
    if chart_table:
        blocks.append({
            "title": "Metric trend",
            "content": [
                {"kind": "text", "text": "Generated chart over a plaintext data table."},
                {"type": "chart", "attrs": {"source": chart_table["path"], "x": chart_x, "y": chart_y, "limit": "10"}},
            ],
        })

    jsonl = next((table for table in metadata["tables"] if table["kind"] == "jsonl"), None)
    if jsonl:
        fields = ",".join(f"{column}:text" for column in jsonl["columns"][:4]) or "note:text"
        blocks.append({
            "title": "Event log",
            "content": [
                {"kind": "text", "text": "Generated log and append form over an append-only JSONL file."},
                {"type": "log", "attrs": {"source": jsonl["path"], "limit": "8"}},
                {"type": "form", "attrs": {"target": jsonl["path"], "fields": fields, "submit": "Append event"}},
            ],
        })

    image_dir = metadata["imageDirs"][0] if metadata["imageDirs"] else None
    if image_dir:
        blocks.append({
            "title": "Image gallery",
            "content": [
                {"kind": "text", "text": "Generated gallery over local image assets."},
                {"type": "gallery", "attrs": {"source": image_dir["path"], "limit": "8"}},
            ],
        })

    if not blocks:
        blocks.append({
            "title": "Generated block",
            "content": [{"kind": "text", "text": "No CSV, JSONL, or image assets were found yet."}],
        })

    return {
        "version": 1,
        "path": "generated-workspace.org",
        "title": "Generated Malleable Workspace",
        "blocks": blocks,
        "links": [
            {
                "sourceIndex": index - 1,
                "targetIndex": index,
                "sourceTitle": blocks[index - 1]["title"],
                "targetTitle": blocks[index]["title"],
            }
            for index in range(1, len(blocks))
        ],
    }


def normalized_ref(value):
    return re.sub(r"[^a-z0-9]+", "", str(value).lower()).removesuffix("s")


def resolve_recipe_link_ref(link, prefix, block_ids, title_to_id):
    direct = link.get(prefix)
    if direct in block_ids:
        return direct
    if direct in title_to_id:
        return title_to_id[direct]

    title = link.get(f"{prefix}Title")
    if title in title_to_id:
        return title_to_id[title]

    title_norm = normalized_ref(title or direct or "")
    if title_norm:
        for candidate_title, candidate_id in title_to_id.items():
            if normalized_ref(candidate_title) == title_norm:
                return candidate_id

    index = link.get(f"{prefix}Index")
    if isinstance(index, int) and 0 <= index < len(block_ids):
        return block_ids[index]
    return None


def apply_recipe(root, recipe):
    rel_path = recipe.get("path") or "recipe-workspace.org"
    title = recipe.get("title") or "Recipe Workspace"
    blocks = recipe.get("blocks", [])
    snapshot_path_state(root, rel_path, "recipe-apply")
    lines = [f"#+title: {title}", ""]
    workspace_nodes = {}
    title_to_id = {}
    block_ids = []
    for index, block in enumerate(blocks):
        block_id = str(uuid.uuid4())
        title_to_id[block.get("title", f"Block {index + 1}")] = block_id
        block_ids.append(block_id)
        block_content = block.get("content")
        if not isinstance(block_content, list):
            block_content = []
            if block.get("text"):
                block_content.append({"kind": "text", "text": block.get("text", "")})
            for component in block.get("components", []):
                block_content.append({"kind": "component", **component})
        lines.extend([
            f"* {block.get('title', f'Block {index + 1}')}",
            ":PROPERTIES:",
            f":ID: {block_id}",
            ":END:",
        ])
        for item in block_content:
            if item.get("kind") == "text":
                for text_line in str(item.get("text", "")).splitlines():
                    lines.append(text_line)
            else:
                lines.append(serialize_component_directive(item.get("type", "table"), item.get("attrs", {})))
            lines.append("")
        lines.append("")
        if index == 0:
            workspace_nodes[block_id] = {"layout": "free", "x": 80, "y": 80}
        else:
            workspace_nodes[block_id] = {
                "layout": "flow",
                "after": block_ids[index - 1],
                "gap": 28,
                "x": 80,
                "y": 80 + index * 420,
            }

    workspace_links = []
    unresolved_links = []
    for link in recipe.get("links", []):
        source = resolve_recipe_link_ref(link, "source", block_ids, title_to_id)
        target = resolve_recipe_link_ref(link, "target", block_ids, title_to_id)
        if source and target and source != target:
            workspace_links.append({"source": source, "target": target, "kind": link.get("kind", "visual")})
        else:
            unresolved_links.append(link)

    (root / rel_path).write_text("\n".join(lines), encoding="utf-8")
    workspace, doc = document_workspace(root, rel_path)
    doc["camera"] = {"x": 20, "y": 20, "zoom": 1}
    doc["nodes"] = workspace_nodes
    doc["links"] = workspace_links
    write_workspace(root, workspace)
    return {"path": rel_path, "blocks": len(blocks), "links": len(workspace_links), "unresolvedLinks": unresolved_links}


def coerce_form_value(field, value):
    field_type = field.get("type", "text")
    if field_type == "checkbox":
        return bool(value)
    if field_type in ("range", "number"):
        try:
            return float(value)
        except (TypeError, ValueError):
            return value
    return value


class OrgHtmlHandler(BaseHTTPRequestHandler):
    server_version = "OrgHTML/0.2"

    def do_GET(self):
        parsed = urlparse(self.path)
        if parsed.path == "/api/files":
            return self.handle_files()
        if parsed.path == "/api/document":
            return self.handle_document(parsed.query)
        if parsed.path == "/api/data":
            return self.handle_data(parsed.query)
        if parsed.path == "/api/assets":
            return self.handle_assets(parsed.query)
        if parsed.path == "/api/metadata":
            return self.write_json(scan_project_metadata(self.server.project_root))
        if parsed.path == "/api/history":
            return self.handle_history(parsed.query)
        if parsed.path == "/api/recipe/generate":
            return self.write_json(generate_recipe(self.server.project_root))
        if parsed.path == "/api/snapshot/pending":
            return self.handle_snapshot_pending()
        if parsed.path == "/api/snapshot/extension-info":
            return self.write_json(get_extension_info())
        if parsed.path == "/asset":
            return self.handle_asset(parsed.query)
        return self.serve_static(parsed.path)

    def do_POST(self):
        parsed = urlparse(self.path)
        if parsed.path == "/api/save-workspace":
            return self.handle_save_workspace()
        if parsed.path == "/api/append":
            return self.handle_append()
        if parsed.path == "/api/generate-workspace":
            return self.handle_generate_workspace()
        if parsed.path == "/api/component":
            return self.handle_component_update()
        if parsed.path == "/api/component-add":
            return self.handle_component_add()
        if parsed.path == "/api/component-delete":
            return self.handle_component_delete()
        if parsed.path == "/api/source-save":
            return self.handle_source_save()
        if parsed.path == "/api/block-text":
            return self.handle_block_text_update()
        if parsed.path == "/api/sql-query":
            return self.handle_sql_query()
        if parsed.path == "/api/history/restore":
            return self.handle_history_restore()
        if parsed.path == "/api/recipe/apply":
            return self.handle_recipe_apply()
        if parsed.path == "/api/snapshot/freeze":
            return self.handle_snapshot_freeze()
        if parsed.path == "/api/snapshot/promote":
            return self.handle_snapshot_promote()
        if parsed.path == "/api/snapshot/discard":
            return self.handle_snapshot_discard()
        if parsed.path == "/api/snapshot/register-extension":
            return self.handle_register_extension()
        self.send_error(404)

    def handle_files(self):
        root = self.server.project_root
        files = []
        for path in sorted(root.rglob("*.org")):
            if ".orghtml" not in path.parts and path.is_file():
                files.append(str(path.relative_to(root)))
        return self.write_json({"root": str(root), "files": files, "workspace": WORKSPACE_PATH})

    def handle_document(self, query):
        params = parse_qs(query)
        rel_path = params.get("path", [""])[0]
        target = self.resolve_project_path(rel_path)
        if not target.exists() or not target.is_file():
            self.send_error(404)
            return

        text = target.read_text(encoding="utf-8")
        _, changed = ensure_heading_ids(text)
        doc_workspace = workspace_document(self.server.project_root, rel_path)
        parsed = parse_org_document(text, doc_workspace, self.server.project_root)
        missing_ids = sum(1 for block in parsed["blocks"] if not block.get("id"))
        return self.write_json({
            "path": rel_path,
            "text": text,
            "parsed": parsed,
            "idsInserted": False,
            "idsMissing": missing_ids,
            "workspace": WORKSPACE_PATH,
        })

    def handle_history(self, query):
        params = parse_qs(query)
        rel_path = params.get("path", [""])[0]
        limit = params.get("limit", ["30"])[0]
        if not rel_path:
            self.send_error(400, "Missing history path.")
            return
        return self.write_json({"path": rel_path, "snapshots": list_snapshots(self.server.project_root, rel_path, limit)})

    def handle_data(self, query):
        params = parse_qs(query)
        rel_path = params.get("path", [""])[0]
        target = self.resolve_project_path(rel_path)
        if not target.exists() or not target.is_file():
            self.send_error(404)
            return
        return self.write_json(read_table(target))

    def handle_assets(self, query):
        params = parse_qs(query)
        rel_path = params.get("path", [""])[0]
        try:
            return self.write_json({"images": image_files(self.server.project_root, rel_path)})
        except PermissionError:
            self.send_error(403)

    def handle_asset(self, query):
        params = parse_qs(query)
        rel_path = params.get("path", [""])[0]
        target = self.resolve_project_path(rel_path)
        if not target.exists() or not target.is_file():
            self.send_error(404)
            return
        content_type = mimetypes.guess_type(str(target))[0] or "application/octet-stream"
        body = target.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def handle_save_workspace(self):
        payload = self.read_json()
        rel_path = payload.get("path")
        if not rel_path:
            self.send_error(400, "Missing document path.")
            return

        snapshot_path_state(self.server.project_root, rel_path, "save-workspace")
        workspace, doc = document_workspace(self.server.project_root, rel_path)
        doc["camera"] = payload.get("camera", {"x": 20, "y": 20, "zoom": 1})
        doc["nodes"] = {
            node["id"]: {
                "x": node.get("x", 0),
                "y": node.get("y", 0),
                "width": node.get("width"),
                "height": node.get("height"),
                "layout": node.get("layout", "free"),
                "after": node.get("after"),
                "gap": node.get("gap", 28),
            }
            for node in payload.get("nodes", [])
            if node.get("id")
        }
        seen = set()
        links = []
        for link in payload.get("links", []):
            source = link.get("source")
            target = link.get("target")
            if not source or not target or source == target:
                continue
            key = (source, target)
            if key in seen:
                continue
            seen.add(key)
            links.append({"source": source, "target": target, "kind": link.get("kind", "visual")})
        doc["links"] = links
        write_workspace(self.server.project_root, workspace)
        return self.write_json({"ok": True, "workspace": WORKSPACE_PATH})

    def handle_append(self):
        payload = self.read_json()
        rel_path = payload.get("path")
        fields = payload.get("fields", [])
        values = payload.get("values", {})
        if not rel_path:
            self.send_error(400, "Missing append target.")
            return

        target = self.resolve_project_path(rel_path)
        target.parent.mkdir(parents=True, exist_ok=True)
        record = {
            field["name"]: coerce_form_value(field, values.get(field["name"]))
            for field in fields
            if field.get("name")
        }

        if target.suffix.lower() == ".jsonl":
            with target.open("a", encoding="utf-8") as handle:
                handle.write(json.dumps(record, separators=(",", ":")) + "\n")
        elif target.suffix.lower() == ".csv":
            exists = target.exists() and target.stat().st_size > 0
            with target.open("a", newline="", encoding="utf-8") as handle:
                writer = csv.DictWriter(handle, fieldnames=list(record.keys()))
                if not exists:
                    writer.writeheader()
                writer.writerow(record)
        else:
            self.send_error(400, "Append target must be .jsonl or .csv.")
            return
        return self.write_json({"ok": True, "record": record})

    def handle_generate_workspace(self):
        return self.write_json(generate_workspace(self.server.project_root))

    def handle_component_update(self):
        payload = self.read_json()
        rel_path = payload.get("path")
        block_id = payload.get("blockId")
        component_id = payload.get("componentId")
        component_type = payload.get("type")
        attrs = payload.get("attrs", {})
        if not rel_path or not block_id or not component_id or not component_type:
            self.send_error(400, "Missing component update fields.")
            return

        target = self.resolve_project_path(rel_path)
        text = target.read_text(encoding="utf-8")
        snapshot_path_state(self.server.project_root, rel_path, "component-update")
        try:
            updated = update_component_directive(text, block_id, component_id, component_type, attrs)
        except ValueError as error:
            self.send_error(404, str(error))
            return
        target.write_text(updated, encoding="utf-8")

        _, doc_workspace = document_workspace(self.server.project_root, rel_path)
        parsed = parse_org_document(updated, doc_workspace, self.server.project_root)
        return self.write_json({"path": rel_path, "text": updated, "parsed": parsed})

    def handle_component_add(self):
        payload = self.read_json()
        rel_path = payload.get("path")
        block_id = payload.get("blockId")
        component_type = payload.get("type")
        attrs = payload.get("attrs", {})
        if not rel_path or not block_id or not component_type:
            self.send_error(400, "Missing component add fields.")
            return

        target = self.resolve_project_path(rel_path)
        text = target.read_text(encoding="utf-8")
        snapshot_path_state(self.server.project_root, rel_path, "component-add")
        try:
            updated = insert_component_directive(text, block_id, component_type, attrs)
        except ValueError as error:
            self.send_error(404, str(error))
            return
        target.write_text(updated, encoding="utf-8")

        _, doc_workspace = document_workspace(self.server.project_root, rel_path)
        parsed = parse_org_document(updated, doc_workspace, self.server.project_root)
        added = next((block["components"][-1]["id"] for block in parsed["blocks"] if block["id"] == block_id and block["components"]), None)
        return self.write_json({"path": rel_path, "text": updated, "parsed": parsed, "componentId": added})

    def handle_component_delete(self):
        payload = self.read_json()
        rel_path = payload.get("path")
        block_id = payload.get("blockId")
        component_id = payload.get("componentId")
        if not rel_path or not block_id or not component_id:
            self.send_error(400, "Missing component delete fields.")
            return

        target = self.resolve_project_path(rel_path)
        text = target.read_text(encoding="utf-8")
        snapshot_path_state(self.server.project_root, rel_path, "component-delete")
        try:
            updated = delete_component_directive(text, block_id, component_id)
        except ValueError as error:
            self.send_error(404, str(error))
            return
        target.write_text(updated, encoding="utf-8")

        _, doc_workspace = document_workspace(self.server.project_root, rel_path)
        parsed = parse_org_document(updated, doc_workspace, self.server.project_root)
        return self.write_json({"path": rel_path, "text": updated, "parsed": parsed})

    def handle_source_save(self):
        payload = self.read_json()
        rel_path = payload.get("path")
        text = payload.get("text", "")
        if not rel_path:
            self.send_error(400, "Missing source save path.")
            return

        target = self.resolve_project_path(rel_path)
        snapshot_path_state(self.server.project_root, rel_path, "source-save")
        updated, changed = ensure_heading_ids(str(text))
        target.write_text(updated, encoding="utf-8")

        _, doc_workspace = document_workspace(self.server.project_root, rel_path)
        parsed = parse_org_document(updated, doc_workspace, self.server.project_root)
        return self.write_json({
            "path": rel_path,
            "text": updated,
            "parsed": parsed,
            "idsInserted": changed,
        })

    def handle_block_text_update(self):
        payload = self.read_json()
        rel_path = payload.get("path")
        block_id = payload.get("blockId")
        text_index = payload.get("textIndex")
        body = payload.get("body", "")
        if not rel_path or not block_id or not isinstance(text_index, int):
            self.send_error(400, "Missing block text update fields.")
            return

        target = self.resolve_project_path(rel_path)
        text = target.read_text(encoding="utf-8")
        snapshot_path_state(self.server.project_root, rel_path, "block-text")
        try:
            updated = update_block_text(text, block_id, text_index, body)
        except ValueError as error:
            self.send_error(404, str(error))
            return
        target.write_text(updated, encoding="utf-8")

        _, doc_workspace = document_workspace(self.server.project_root, rel_path)
        parsed = parse_org_document(updated, doc_workspace, self.server.project_root)
        return self.write_json({"path": rel_path, "text": updated, "parsed": parsed})

    def handle_sql_query(self):
        payload = self.read_json()
        rel_path = payload.get("path")
        sql = payload.get("sql", "")
        if not rel_path:
            self.send_error(400, "Missing SQL query path.")
            return

        target = self.resolve_project_path(rel_path)
        if not target.exists() or not target.is_file():
            self.send_error(404, "Document not found.")
            return

        text = target.read_text(encoding="utf-8")
        doc_workspace = workspace_document(self.server.project_root, rel_path)
        try:
            result = execute_workspace_query(self.server.project_root, text, doc_workspace, sql)
        except ValueError as error:
            self.send_error(400, str(error))
            return
        return self.write_json(result)

    def handle_history_restore(self):
        payload = self.read_json()
        rel_path = payload.get("path")
        snapshot_id = payload.get("snapshotId")
        if not rel_path or snapshot_id is None:
            self.send_error(400, "Missing history restore fields.")
            return
        try:
            restored = restore_snapshot(self.server.project_root, snapshot_id, rel_path)
        except ValueError as error:
            self.send_error(404, str(error))
            return

        target = self.resolve_project_path(rel_path)
        if not target.exists() or not target.is_file():
            self.send_error(404, "Restored file is missing.")
            return
        text = target.read_text(encoding="utf-8")
        _, doc_workspace = document_workspace(self.server.project_root, rel_path)
        parsed = parse_org_document(text, doc_workspace, self.server.project_root)
        return self.write_json({
            "path": rel_path,
            "text": text,
            "parsed": parsed,
            "restored": restored,
        })

    def handle_recipe_apply(self):
        payload = self.read_json()
        recipe = payload.get("recipe", payload)
        if not isinstance(recipe, dict):
            self.send_error(400, "Recipe must be an object.")
            return
        if not isinstance(recipe.get("blocks", []), list):
            self.send_error(400, "Recipe blocks must be a list.")
            return
        return self.write_json(apply_recipe(self.server.project_root, recipe))

    def handle_snapshot_pending(self):
        return self.write_json({"pending": list_pending()})

    def handle_snapshot_freeze(self):
        payload = self.read_json()
        url = payload.get("url", "")
        title = payload.get("title", "")
        screenshot_b64 = payload.get("screenshot", "")
        try:
            png_bytes = base64.b64decode(screenshot_b64)
        except Exception:
            self.send_error(400, "Invalid screenshot base64.")
            return
        snapshot_id = payload.get("snapshotId")
        if snapshot_id:
            frozen_at = datetime.now(timezone.utc).isoformat()
            try:
                rel_path, parsed = overwrite_snapshot_component(
                    self.server.project_root, snapshot_id, url, title, frozen_at, png_bytes
                )
            except ValueError as error:
                self.send_error(404, str(error))
                return
            return self.write_json({"kind": "overwritten", "snapshotId": snapshot_id, "frozen_at": frozen_at, "path": rel_path, "parsed": parsed})
        else:
            pending_id = enqueue_pending(url, title, png_bytes)
            return self.write_json({"kind": "pending", "pendingId": pending_id})

    def handle_snapshot_promote(self):
        payload = self.read_json()
        rel_path = payload.get("path")
        pending_id = payload.get("pendingId")
        heading_title = payload.get("headingTitle")
        if not rel_path or not pending_id:
            self.send_error(400, "Missing path or pendingId.")
            return
        self.resolve_project_path(rel_path)
        try:
            rel_path, text, parsed = promote_pending_snapshot(
                self.server.project_root, rel_path, pending_id, heading_title
            )
        except ValueError as error:
            self.send_error(404, str(error))
            return
        return self.write_json({"path": rel_path, "text": text, "parsed": parsed})

    def handle_snapshot_discard(self):
        payload = self.read_json()
        pending_id = payload.get("pendingId")
        if not pending_id:
            self.send_error(400, "Missing pendingId.")
            return
        discard_pending(pending_id)
        return self.write_json({"ok": True})

    def handle_register_extension(self):
        payload = self.read_json()
        extension_id = payload.get("extensionId", "").strip()
        if not extension_id:
            self.send_error(400, "Missing extensionId.")
            return
        register_extension(extension_id)
        return self.write_json({"ok": True})

    def serve_static(self, request_path):
        rel_path = "index.html" if request_path in ("", "/") else unquote(request_path).lstrip("/")
        root = self.server.app_root.resolve()
        target = (root / rel_path).resolve()
        if root not in target.parents and target != root:
            self.send_error(403)
            return
        if not target.exists() or not target.is_file():
            self.send_error(404)
            return
        content_type = mimetypes.guess_type(str(target))[0] or "application/octet-stream"
        body = target.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def resolve_project_path(self, rel_path):
        root = self.server.project_root.resolve()
        target = (root / rel_path).resolve()
        if root not in target.parents and target != root:
            raise PermissionError("Path is outside project root.")
        return target

    def read_json(self):
        length = int(self.headers.get("Content-Length", "0"))
        raw = self.rfile.read(length).decode("utf-8")
        return json.loads(raw) if raw else {}

    def write_json(self, value):
        body = json.dumps(value).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt, *args):
        print(fmt % args, file=sys.stderr)


class OrgHtmlServer(ThreadingHTTPServer):
    def __init__(self, server_address, handler_cls, project_root, app_root):
        super().__init__(server_address, handler_cls)
        self.project_root = project_root
        self.app_root = app_root


def main():
    parser = argparse.ArgumentParser(description="Run the local OrgHTML malleable UI prototype.")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--root", default=".", help="Project root containing plaintext files.")
    args = parser.parse_args()

    root = Path(args.root).resolve()
    app_root = Path(__file__).resolve().parent
    server = OrgHtmlServer((args.host, args.port), OrgHtmlHandler, root, app_root)
    print(f"OrgHTML serving project {root} with app assets {app_root} at http://{args.host}:{args.port}/")
    server.serve_forever()


if __name__ == "__main__":
    main()
