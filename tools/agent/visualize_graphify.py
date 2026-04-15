#!/usr/bin/env python3
"""Serve a local Cytoscape viewer for the repo Graphify graph."""

from __future__ import annotations

import argparse
import json
import math
import sys
import webbrowser
from collections import deque
from functools import partial
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

REPO_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_GRAPH = REPO_ROOT / ".graphify" / "graph.json"
DEFAULT_QUERY = "integrations channels admin ui scheduler memory"
DEFAULT_NODE_LIMIT = 140
PRESETS = {
    "overview": {"label": "Overview", "query": DEFAULT_QUERY, "limit": 140},
    "integrations": {"label": "Integrations", "query": "integrations registry service manager settings store channel", "limit": 160},
    "admin": {"label": "Admin UI", "query": "admin ui dashboard api react coreui", "limit": 140},
    "runtime": {"label": "Runtime Loop", "query": "index orchestrator router scheduler container runner db", "limit": 150},
    "memory": {"label": "Memory", "query": "memory groups agents structured memory store", "limit": 130},
}

INDEX_HTML = """<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>selfhosted-claw Graphify Viewer</title>
  <script src="https://unpkg.com/cytoscape@3.30.2/dist/cytoscape.min.js"></script>
  <style>
    :root { --bg: #f4f1e8; --panel: rgba(255, 251, 242, 0.94); --ink: #1f2a1f; --muted: #5d6b60; --accent: #bf5b2c; --accent-2: #2f6c63; --border: rgba(31, 42, 31, 0.14); --shadow: 0 20px 45px rgba(45, 39, 24, 0.14); }
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; font-family: Georgia, "Iowan Old Style", "Palatino Linotype", serif; color: var(--ink); background: radial-gradient(circle at top left, rgba(191, 91, 44, 0.15), transparent 32%), radial-gradient(circle at bottom right, rgba(47, 108, 99, 0.16), transparent 28%), linear-gradient(135deg, #f5f0e5 0%, #efe7d7 48%, #e9e1d2 100%); }
    .shell { display: grid; grid-template-columns: 360px 1fr; gap: 20px; min-height: 100vh; padding: 20px; }
    .panel, .stage { background: var(--panel); border: 1px solid var(--border); border-radius: 20px; box-shadow: var(--shadow); backdrop-filter: blur(8px); }
    .panel { display: flex; flex-direction: column; padding: 20px; gap: 16px; }
    .eyebrow { margin: 0; color: var(--accent); font-size: 0.8rem; letter-spacing: 0.18em; text-transform: uppercase; }
    h1 { margin: 0; font-size: clamp(1.8rem, 2.8vw, 2.4rem); line-height: 1.05; }
    .lede, .meta, .empty { margin: 0; color: var(--muted); line-height: 1.45; }
    .controls { display: grid; gap: 12px; }
    label { font-size: 0.9rem; font-weight: 600; }
    input, select, button { width: 100%; border-radius: 12px; border: 1px solid var(--border); padding: 10px 12px; font: inherit; color: var(--ink); background: rgba(255, 255, 255, 0.84); }
    button { cursor: pointer; background: linear-gradient(135deg, var(--accent), #d88d54); color: #fff9f0; font-weight: 700; border: none; }
    button.alt { background: linear-gradient(135deg, var(--accent-2), #4b9186); }
    .stats { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
    .stat { border: 1px solid var(--border); border-radius: 14px; padding: 12px; background: rgba(255, 255, 255, 0.66); }
    .stat strong { display: block; font-size: 1.5rem; }
    .meta-block { display: grid; gap: 8px; max-height: 40vh; overflow: auto; padding-right: 6px; }
    .meta-card { border: 1px solid var(--border); border-radius: 14px; padding: 12px; background: rgba(255, 255, 255, 0.66); }
    .meta-card h2 { margin: 0 0 6px 0; font-size: 1rem; }
    .meta-card code { font-family: Consolas, "SFMono-Regular", monospace; word-break: break-word; color: var(--accent-2); }
    .stage { position: relative; overflow: hidden; min-height: 72vh; }
    #cy { position: absolute; inset: 0; }
    .banner { position: absolute; top: 16px; right: 16px; z-index: 2; background: rgba(255, 251, 242, 0.92); border: 1px solid var(--border); border-radius: 999px; padding: 8px 12px; color: var(--muted); font-size: 0.85rem; max-width: min(48ch, calc(100% - 32px)); }
    @media (max-width: 960px) { .shell { grid-template-columns: 1fr; } .panel { order: 2; } .stage { min-height: 60vh; } }
  </style>
</head>
<body>
  <div class="shell">
    <aside class="panel">
      <div>
        <p class="eyebrow">Graphify Viewer</p>
        <h1>selfhosted-claw knowledge graph</h1>
        <p class="lede">Use this page to explore a focused Graphify subgraph without asking your browser to bench-press the whole repo.</p>
      </div>
      <div class="stats">
        <div class="stat"><span>Visible nodes</span><strong id="nodeCount">0</strong></div>
        <div class="stat"><span>Visible edges</span><strong id="edgeCount">0</strong></div>
      </div>
      <div class="controls">
        <div>
          <label for="preset">Preset</label>
          <select id="preset">
            <option value="overview">Overview</option>
            <option value="integrations">Integrations</option>
            <option value="admin">Admin UI</option>
            <option value="runtime">Runtime Loop</option>
            <option value="memory">Memory</option>
            <option value="custom">Custom</option>
          </select>
        </div>
        <div>
          <label for="query">Graph focus query</label>
          <input id="query" type="text" placeholder="integrations, admin, scheduler">
        </div>
        <div>
          <label for="nodeLimit">Node cap</label>
          <input id="nodeLimit" type="number" min="20" max="600" step="10" value="140">
        </div>
        <div>
          <label for="search">Filter visible nodes</label>
          <input id="search" type="text" placeholder="registry, signal, admin">
        </div>
        <div>
          <label for="community">Community</label>
          <select id="community">
            <option value="">All communities</option>
          </select>
        </div>
        <button id="focusBtn" type="button">Load focused subgraph</button>
        <button id="fullBtn" type="button" class="alt">Load full graph</button>
        <button id="fitBtn" type="button">Fit visible graph</button>
        <button id="resetBtn" type="button" class="alt">Reset filters</button>
      </div>
      <div class="meta-block">
        <div class="meta-card">
          <h2>Loaded view</h2>
          <p class="meta" id="graphSummary">Loading graph view...</p>
        </div>
        <div class="meta-card">
          <h2>Selected node</h2>
          <p class="empty" id="emptyState">Click a node to inspect its source, type, community, and neighbors.</p>
          <div id="nodeMeta" hidden>
            <p class="meta"><strong id="nodeLabel"></strong></p>
            <p class="meta">ID: <code id="nodeId"></code></p>
            <p class="meta">Type: <span id="nodeType"></span></p>
            <p class="meta">Community: <span id="nodeCommunity"></span></p>
            <p class="meta">Degree: <span id="nodeDegree"></span></p>
            <p class="meta">Source: <code id="nodeSource"></code></p>
          </div>
        </div>
      </div>
    </aside>
    <main class="stage">
      <div class="banner">Focused subgraph mode is the default. Full graph mode is available when your browser is feeling heroic.</div>
      <div id="cy"></div>
    </main>
  </div>
  <script>
    const defaultQuery = "integrations channels admin ui scheduler memory";
    const defaultLimit = "140";
    const presets = {
      overview: { query: "integrations channels admin ui scheduler memory", limit: "140" },
      integrations: { query: "integrations registry service manager settings store channel", limit: "160" },
      admin: { query: "admin ui dashboard api react coreui", limit: "140" },
      runtime: { query: "index orchestrator router scheduler container runner db", limit: "150" },
      memory: { query: "memory groups agents structured memory store", limit: "130" },
    };
    const presetSelect = document.getElementById("preset");
    const queryInput = document.getElementById("query");
    const nodeLimitInput = document.getElementById("nodeLimit");
    const searchInput = document.getElementById("search");
    const communitySelect = document.getElementById("community");
    const focusBtn = document.getElementById("focusBtn");
    const fullBtn = document.getElementById("fullBtn");
    const fitBtn = document.getElementById("fitBtn");
    const resetBtn = document.getElementById("resetBtn");
    const nodeCount = document.getElementById("nodeCount");
    const edgeCount = document.getElementById("edgeCount");
    const graphSummary = document.getElementById("graphSummary");
    const emptyState = document.getElementById("emptyState");
    const nodeMeta = document.getElementById("nodeMeta");
    const nodeLabel = document.getElementById("nodeLabel");
    const nodeId = document.getElementById("nodeId");
    const nodeType = document.getElementById("nodeType");
    const nodeCommunity = document.getElementById("nodeCommunity");
    const nodeDegree = document.getElementById("nodeDegree");
    const nodeSource = document.getElementById("nodeSource");
    presetSelect.value = "overview";
    queryInput.value = defaultQuery;
    nodeLimitInput.value = defaultLimit;
    const toCyElements = (graph) => {
      const nodes = (graph.nodes || []).map((node) => ({ data: { id: String(node.id), label: node.label || node.id, source_file: node.source_file || "", source_location: node.source_location || "", file_type: node.file_type || "", community: node.community == null ? "" : String(node.community), norm_label: node.norm_label || "" } }));
      const edges = (graph.links || []).map((edge, index) => ({ data: { id: edge.id || `edge-${index}`, source: String(edge.source), target: String(edge.target), relation: edge.relation || "", confidence: edge.confidence || "" } }));
      return { nodes, edges };
    };
    let cy = null;
    const applyFilters = (graph) => {
      const term = searchInput.value.trim().toLowerCase();
      const community = communitySelect.value;
      graph.nodes().forEach((node) => {
        const text = `${node.data("label")} ${node.data("norm_label")} ${node.data("source_file")}`.toLowerCase();
        const matchesTerm = !term || text.includes(term);
        const matchesCommunity = !community || node.data("community") === community;
        node.style("display", matchesTerm && matchesCommunity ? "element" : "none");
      });
      graph.edges().forEach((edge) => {
        const visible = edge.source().visible() && edge.target().visible();
        edge.style("display", visible ? "element" : "none");
      });
    };
    const ensureCy = () => {
      if (cy) return cy;
      cy = cytoscape({
        container: document.getElementById("cy"),
        elements: [],
        style: [
          { selector: "node", style: { "background-color": "#bf5b2c", "label": "data(label)", "font-size": 10, "color": "#1f2a1f", "text-wrap": "wrap", "text-max-width": 120, "text-background-color": "rgba(255,251,242,0.82)", "text-background-opacity": 1, "text-background-padding": 3, "border-width": 1, "border-color": "#fff8ef", "width": 16, "height": 16 } },
          { selector: "node[file_type = 'code']", style: { "background-color": "#2f6c63" } },
          { selector: "node:selected", style: { "background-color": "#d99e2b", "border-width": 3, "border-color": "#4b2d17" } },
          { selector: "edge", style: { "width": 1.2, "line-color": "rgba(31,42,31,0.25)", "curve-style": "bezier", "opacity": 0.8 } }
        ],
        layout: { name: "grid" }
      });
      const updateSelection = (node) => {
        emptyState.hidden = true;
        nodeMeta.hidden = false;
        nodeLabel.textContent = node.data("label");
        nodeId.textContent = node.id();
        nodeType.textContent = node.data("file_type") || "unknown";
        nodeCommunity.textContent = node.data("community") || "n/a";
        nodeDegree.textContent = String(node.connectedEdges(":visible").length);
        const sourceBits = [node.data("source_file"), node.data("source_location")].filter(Boolean);
        nodeSource.textContent = sourceBits.length ? sourceBits.join(" ") : "n/a";
      };
      cy.on("tap", "node", (event) => updateSelection(event.target));
      cy.on("tap", (event) => {
        if (event.target === cy) {
          emptyState.hidden = false;
          nodeMeta.hidden = true;
        }
      });
      return cy;
    };
    const rerender = () => {
      const graph = ensureCy();
      applyFilters(graph);
      graph.layout({ name: "cose", animate: false, fit: true, padding: 36, nodeRepulsion: 9000, idealEdgeLength: 90 }).run();
    };
    const fillCommunities = (elements) => {
      communitySelect.innerHTML = '<option value="">All communities</option>';
      const communities = [...new Set(elements.nodes.map((node) => node.data.community).filter(Boolean))].sort((a, b) => Number(a) - Number(b));
      communities.forEach((community) => {
        const option = document.createElement("option");
        option.value = community;
        option.textContent = `Community ${community}`;
        communitySelect.appendChild(option);
      });
    };
    const buildGraphUrl = (fullGraph = false) => {
      const params = new URLSearchParams();
      params.set("full", fullGraph ? "1" : "0");
      params.set("preset", presetSelect.value || "custom");
      params.set("query", queryInput.value.trim() || defaultQuery);
      params.set("limit", nodeLimitInput.value || defaultLimit);
      return `/api/graph?${params.toString()}`;
    };
    const loadGraph = (fullGraph = false) => {
      graphSummary.textContent = "Loading graph view...";
      fetch(buildGraphUrl(fullGraph))
        .then((response) => response.json())
        .then((payload) => {
          const graph = ensureCy();
          const elements = toCyElements(payload.graph);
          fillCommunities(elements);
          graph.elements().remove();
          graph.add([...elements.nodes, ...elements.edges]);
          nodeCount.textContent = String(elements.nodes.length);
          edgeCount.textContent = String(elements.edges.length);
          graphSummary.textContent = payload.meta.summary;
          emptyState.hidden = false;
          nodeMeta.hidden = true;
          rerender();
        })
        .catch((error) => {
          emptyState.hidden = false;
          emptyState.textContent = `Failed to load graph: ${error}`;
        });
    };
    searchInput.addEventListener("input", () => { if (cy) applyFilters(cy); });
    presetSelect.addEventListener("change", () => {
      const preset = presetSelect.value;
      if (preset !== "custom" && presets[preset]) {
        queryInput.value = presets[preset].query;
        nodeLimitInput.value = presets[preset].limit;
      }
    });
    communitySelect.addEventListener("change", rerender);
    fitBtn.addEventListener("click", () => { if (cy) cy.fit(cy.elements(":visible"), 30); });
    focusBtn.addEventListener("click", () => loadGraph(false));
    fullBtn.addEventListener("click", () => loadGraph(true));
    resetBtn.addEventListener("click", () => {
      presetSelect.value = "overview";
      searchInput.value = "";
      communitySelect.value = "";
      queryInput.value = defaultQuery;
      nodeLimitInput.value = defaultLimit;
      emptyState.hidden = false;
      nodeMeta.hidden = true;
      loadGraph(false);
    });
    loadGraph(false);
  </script>
</body>
</html>
"""


def _load_graph(graph_path: Path) -> dict:
    with graph_path.open("r", encoding="utf-8") as handle:
        return json.load(handle)


def _score_node(node: dict, terms: list[str]) -> float:
    haystacks = [
        str(node.get("label", "")).lower(),
        str(node.get("norm_label", "")).lower(),
        str(node.get("source_file", "")).lower(),
        str(node.get("file_type", "")).lower(),
    ]
    score = 0.0
    for term in terms:
        for haystack in haystacks:
            if term in haystack:
                score += 3.0 if term == haystack else 1.0
    return score


def _build_subgraph(graph: dict, query: str, limit: int, preset: str = "custom") -> tuple[dict, dict]:
    nodes = graph.get("nodes", [])
    links = graph.get("links", [])
    node_by_id = {str(node["id"]): node for node in nodes}
    adjacency: dict[str, set[str]] = {node_id: set() for node_id in node_by_id}
    for link in links:
        source = str(link["source"])
        target = str(link["target"])
        adjacency.setdefault(source, set()).add(target)
        adjacency.setdefault(target, set()).add(source)
    terms = [term.lower() for term in query.split() if term.strip()]
    scored = []
    for node in nodes:
        score = _score_node(node, terms)
        if score > 0:
            degree_bonus = math.log2(len(adjacency.get(str(node["id"]), ())) + 1)
            scored.append((score + degree_bonus, str(node["id"])))
    if not scored:
        fallback = sorted(((len(adjacency.get(str(node["id"]), ())), str(node["id"])) for node in nodes), reverse=True)
        seeds = [node_id for _, node_id in fallback[: min(10, max(1, limit // 10))]]
    else:
        scored.sort(reverse=True)
        seeds = [node_id for _, node_id in scored[: min(12, len(scored))]]
    selected: list[str] = []
    seen: set[str] = set()
    queue = deque(seeds)
    while queue and len(selected) < limit:
        node_id = queue.popleft()
        if node_id in seen or node_id not in node_by_id:
            continue
        seen.add(node_id)
        selected.append(node_id)
        neighbors = sorted(adjacency.get(node_id, ()), key=lambda candidate: len(adjacency.get(candidate, ())), reverse=True)
        for neighbor in neighbors:
            if neighbor not in seen and len(selected) + len(queue) < limit * 2:
                queue.append(neighbor)
    selected_set = set(selected)
    sub_nodes = [node_by_id[node_id] for node_id in selected]
    sub_links = [link for link in links if str(link["source"]) in selected_set and str(link["target"]) in selected_set]
    meta = {
        "summary": f"Focused subgraph{'' if preset == 'custom' else f' [{preset}]'} for query '{query}' with {len(sub_nodes)} nodes and {len(sub_links)} edges (from {len(nodes)} total nodes).",
        "full_graph": False,
        "preset": preset,
        "query": query,
        "limit": limit,
        "total_nodes": len(nodes),
        "total_edges": len(links),
    }
    return {"nodes": sub_nodes, "links": sub_links}, meta


class GraphRequestHandler(BaseHTTPRequestHandler):
    def __init__(self, *args, graph_path: Path, default_query: str, default_limit: int, **kwargs) -> None:
        self.graph_path = graph_path
        self.default_query = default_query
        self.default_limit = default_limit
        super().__init__(*args, **kwargs)

    def do_GET(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        route = parsed.path
        if route in ("/", "/index.html"):
            self._send_html(INDEX_HTML)
            return
        if route == "/api/graph":
            self._send_graph(parsed.query)
            return
        self.send_error(HTTPStatus.NOT_FOUND, "Not found")

    def log_message(self, format: str, *args) -> None:  # noqa: A003
        return

    def _send_html(self, body: str) -> None:
        payload = body.encode("utf-8")
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def _send_graph(self, query_string: str) -> None:
        try:
            full_graph = _load_graph(self.graph_path)
        except FileNotFoundError:
            self.send_error(HTTPStatus.NOT_FOUND, "Graph file not found")
            return
        params = parse_qs(query_string)
        wants_full = params.get("full", ["0"])[0] == "1"
        preset = params.get("preset", ["custom"])[0]
        if preset in PRESETS:
            preset_config = PRESETS[preset]
            query = params.get("query", [preset_config["query"]])[0] or preset_config["query"]
            default_limit = preset_config["limit"]
        else:
            query = params.get("query", [self.default_query])[0] or self.default_query
            default_limit = self.default_limit
        try:
            limit = int(params.get("limit", [str(default_limit)])[0])
        except ValueError:
            limit = default_limit
        limit = max(20, min(limit, 600))
        if wants_full:
            payload_obj = {
                "graph": full_graph,
                "meta": {
                    "summary": f"Full graph view with {len(full_graph.get('nodes', []))} nodes and {len(full_graph.get('links', []))} edges. Heavy mode engaged.",
                    "full_graph": True,
                    "preset": preset,
                    "query": query,
                    "limit": limit,
                    "total_nodes": len(full_graph.get("nodes", [])),
                    "total_edges": len(full_graph.get("links", [])),
                },
            }
        else:
            subgraph, meta = _build_subgraph(full_graph, query, limit, preset=preset)
            payload_obj = {"graph": subgraph, "meta": meta}
        payload = json.dumps(payload_obj).encode("utf-8")
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)


def main() -> int:
    parser = argparse.ArgumentParser(description="Serve a Cytoscape viewer for .graphify/graph.json")
    parser.add_argument("--host", default="127.0.0.1", help="Host interface to bind")
    parser.add_argument("--port", type=int, default=8766, help="Port to listen on")
    parser.add_argument("--graph", default=str(DEFAULT_GRAPH), help="Path to graph.json")
    parser.add_argument("--query", default=DEFAULT_QUERY, help="Default focus query for the initial subgraph")
    parser.add_argument("--limit", type=int, default=DEFAULT_NODE_LIMIT, help="Default node cap for focused subgraphs")
    parser.add_argument("--open", action="store_true", help="Open the viewer in the default browser")
    args = parser.parse_args()
    graph_path = Path(args.graph).resolve()
    if not graph_path.exists():
        print("error: graph not found at " f"{graph_path}. Run `make graph` first.", file=sys.stderr)
        return 1
    handler = partial(GraphRequestHandler, graph_path=graph_path, default_query=args.query, default_limit=max(20, min(args.limit, 600)))
    server = ThreadingHTTPServer((args.host, args.port), handler)
    url = f"http://{args.host}:{args.port}/"
    print(f"Serving Graphify viewer at {url}")
    print(f"Graph source: {graph_path}")
    print(f"Default focus query: {args.query!r} (limit {max(20, min(args.limit, 600))})")
    if args.open:
        webbrowser.open(url)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\\nShutting down viewer.")
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
