import { parse } from "orga";

export function parseOrgSource(text) {
  const ast = parse(text);
  return { ast };
}

export function summarizeAst(ast) {
  const topLevelNodeCount = Array.isArray(ast?.children)
    ? ast.children.length
    : Array.isArray(ast?.nodes)
      ? ast.nodes.length
      : 0;

  return {
    topLevelNodeCount
  };
}

export function extractHeadingPreview(ast) {
  const headings = [];

  walkAst(ast, (node) => {
    if (!node || typeof node !== "object") {
      return;
    }

    if (typeof node.level === "number") {
      const title = getNodeTitle(node);
      headings.push({
        level: node.level,
        title: title || "Untitled heading"
      });
    }
  });

  return headings;
}

function walkAst(value, visitor) {
  if (!value || typeof value !== "object") {
    return;
  }

  visitor(value);

  if (Array.isArray(value)) {
    value.forEach((item) => walkAst(item, visitor));
    return;
  }

  Object.values(value).forEach((child) => {
    if (typeof child === "object" && child !== null) {
      walkAst(child, visitor);
    }
  });
}

function getNodeTitle(node) {
  if (typeof node.title === "string") {
    return node.title.trim();
  }

  if (Array.isArray(node.title)) {
    return flattenText(node.title).trim();
  }

  if (node.title && typeof node.title === "object") {
    return flattenText(node.title).trim();
  }

  if (Array.isArray(node.children)) {
    return flattenText(node.children).trim();
  }

  return "";
}

function flattenText(value) {
  if (typeof value === "string") {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => flattenText(item)).join(" ");
  }

  if (!value || typeof value !== "object") {
    return "";
  }

  if (typeof value.value === "string") {
    return value.value;
  }

  return Object.values(value)
    .map((child) => flattenText(child))
    .join(" ");
}