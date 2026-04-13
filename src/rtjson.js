function normalizeWhitespace(text) {
  return text.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

function renderInlineNode(node, options) {
  if (!node || typeof node !== "object") {
    return "";
  }

  switch (node.e) {
    case "text":
    case "raw":
      return node.t ?? "";
    case "link":
      return node.u ? `${node.t ?? node.u} (${node.u})` : node.t ?? "";
    case "ra:thinking_step":
      return options.includeReasoning ? `${node.state === "complete" ? "[done]" : "[thinking]"} ${node.title ?? ""}`.trim() : "";
    default:
      if (Array.isArray(node.c)) {
        return renderInline(node.c, options);
      }
      return "";
  }
}

function renderInline(nodes, options) {
  if (!Array.isArray(nodes)) {
    return "";
  }

  return nodes.map((node) => renderInlineNode(node, options)).join("");
}

function renderListItem(node, options, ordered, index) {
  const marker = ordered ? `${index + 1}.` : "-";
  const lines = [];

  for (const child of node.c ?? []) {
    const rendered =
      child?.e === "par"
        ? renderInline(child.c ?? [], options).trim()
        : renderBlock(child, options);

    if (!rendered) {
      continue;
    }

    const childLines = rendered.split("\n");
    if (!childLines.length) {
      continue;
    }

    lines.push(`${marker} ${childLines[0]}`);
    for (const continuation of childLines.slice(1)) {
      lines.push(`  ${continuation}`);
    }
  }

  return lines.join("\n");
}

function renderProduct(node, options) {
  const sections = [];
  const title = [node.name, node.estimated_price ? `(${node.estimated_price})` : ""].join(" ").trim();

  if (title) {
    sections.push(title);
  }

  if (node.description) {
    sections.push(node.description);
  }

  const retailers = (node.c ?? [])
    .map((child) => renderBlock(child, options))
    .filter(Boolean)
    .join("\n");

  if (retailers) {
    sections.push(retailers);
  }

  return sections.join("\n");
}

function renderBlock(node, options) {
  if (!node || typeof node !== "object") {
    return "";
  }

  switch (node.e) {
    case "par":
      return renderInline(node.c ?? [], options).trim();
    case "h": {
      const text = renderInline(node.c ?? [], options).trim();
      return text ? `${"#".repeat(Math.max(1, Math.min(node.l ?? 1, 6)))} ${text}` : "";
    }
    case "list":
      return (node.c ?? [])
        .map((item, index) => renderListItem(item, options, Boolean(node.o), index))
        .filter(Boolean)
        .join("\n");
    case "li":
      return renderListItem(node, options, false, 0);
    case "hr":
      return "---";
    case "ra:reasoning":
      return options.includeReasoning
        ? (node.c ?? []).map((child) => renderBlock(child, options)).filter(Boolean).join("\n")
        : "";
    case "ra:thinking_step":
      return options.includeReasoning ? `${node.state === "complete" ? "[done]" : "[thinking]"} ${node.title ?? ""}`.trim() : "";
    case "ra:carousel":
      return (node.c ?? []).map((child) => renderBlock(child, options)).filter(Boolean).join("\n\n");
    case "ra:product":
      return renderProduct(node, options);
    case "ra:retailers":
      return (node.c ?? []).map((child) => renderBlock(child, options)).filter(Boolean).join("\n");
    case "ra:retailer": {
      const retailer = [node.name, node.price ? `(${node.price})` : "", node.url ? `- ${node.url}` : ""]
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();
      return retailer;
    }
    case "ra:grid":
      return (node.c ?? []).map((child) => renderBlock(child, options)).filter(Boolean).join("\n");
    case "ra:subreddit":
      return node.name ?? node.id ?? "";
    case "ra:subreddit_source_bar":
    case "ra:post_sources":
    case "ra:post_source":
    case "ra:subreddit_sources":
    case "ra:subreddit_source":
      return "";
    default: {
      const blockChildren = (node.c ?? []).map((child) => renderBlock(child, options)).filter(Boolean).join("\n");
      if (blockChildren) {
        return blockChildren;
      }

      return renderInline(node.c ?? [], options).trim();
    }
  }
}

export function renderRichtextDocument(document, { includeReasoning = false } = {}) {
  if (!Array.isArray(document)) {
    return "";
  }

  const rendered = document
    .map((node) => renderBlock(node, { includeReasoning }))
    .filter(Boolean)
    .join("\n\n");

  return normalizeWhitespace(rendered);
}
