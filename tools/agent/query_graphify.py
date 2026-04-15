#!/usr/bin/env python3
"""Repo-local Graphify query helper with stable defaults for agents."""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path

from networkx.readwrite import json_graph

REPO_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_GRAPH = REPO_ROOT / ".graphify" / "graph.json"


def _ensure_graph(graph_path: Path) -> int:
    if graph_path.exists():
        return 0
    print(
        "error: graph not found at "
        f"{graph_path}. Run `make graph` (or `python tools/agent/build_graphify.py --config graphify.toml`) first.",
        file=sys.stderr,
    )
    return 1


def _run_graphify(args: list[str]) -> int:
    proc = subprocess.run(
        [sys.executable, "-m", "graphify", *args],
        cwd=str(REPO_ROOT),
    )
    return proc.returncode


def _load_graph_data(graph_path: Path) -> dict:
    return json.loads(graph_path.read_text(encoding="utf-8"))


def _load_graph_nx(graph_path: Path):
    raw = _load_graph_data(graph_path)
    try:
        return json_graph.node_link_graph(raw, edges="links")
    except TypeError:
        return json_graph.node_link_graph(raw)


def _find_exact_node(value: str, graph_path: Path) -> dict | None:
    raw = _load_graph_data(graph_path)
    normalized = value.replace("\\", "/").lstrip("./").lower()
    matches = []
    for node in raw.get("nodes", []):
        source_file = str(node.get("source_file", "")).replace("\\", "/").lower()
        if source_file.endswith(normalized):
            matches.append(node)
    if matches:
        matches.sort(
            key=lambda node: (
                0 if str(node.get("source_location", "")) == "L1" else 1,
                0 if "." in str(node.get("label", "")) else 1,
                len(str(node.get("label", ""))),
            )
        )
        return matches[0]
    return None


def _resolve_label(value: str, graph_path: Path) -> str:
    if "/" in value or "\\" in value:
        exact = _find_exact_node(value, graph_path)
        if exact is not None:
            return str(exact.get("label") or Path(value).name)
        return Path(value).name
    return value


def _print_exact_explain(node: dict, graph_path: Path) -> int:
    graph = _load_graph_nx(graph_path)
    node_id = node["id"]
    print(f"Node: {node.get('label', node_id)}")
    print(f"  ID:        {node_id}")
    source_bits = [str(node.get("source_file", "")).strip(), str(node.get("source_location", "")).strip()]
    print(f"  Source:    {' '.join(bit for bit in source_bits if bit).rstrip()}".rstrip())
    print(f"  Type:      {node.get('file_type', '')}")
    print(f"  Community: {node.get('community', '')}")
    print(f"  Degree:    {graph.degree(node_id)}")
    neighbors = list(graph.neighbors(node_id))
    if neighbors:
        print(f"\nConnections ({len(neighbors)}):")
        for neighbor in sorted(neighbors, key=lambda n: graph.degree(n), reverse=True)[:20]:
            edge = graph.edges[node_id, neighbor]
            relation = edge.get("relation", "")
            confidence = edge.get("confidence", "")
            print(f"  --> {graph.nodes[neighbor].get('label', neighbor)} [{relation}] [{confidence}]")
        if len(neighbors) > 20:
            print(f"  ... and {len(neighbors) - 20} more")
    return 0


def _print_exact_path(source_node: dict, target_node: dict, graph_path: Path) -> int:
    import networkx as nx

    graph = _load_graph_nx(graph_path)
    try:
        path_nodes = nx.shortest_path(graph, source_node["id"], target_node["id"])
    except (nx.NetworkXNoPath, nx.NodeNotFound):
        print(f"No path found between '{source_node.get('label')}' and '{target_node.get('label')}'.")
        return 0
    hops = len(path_nodes) - 1
    segments = []
    for i in range(len(path_nodes) - 1):
        u, v = path_nodes[i], path_nodes[i + 1]
        edge = graph.edges[u, v]
        relation = edge.get("relation", "")
        confidence = edge.get("confidence", "")
        confidence_str = f" [{confidence}]" if confidence else ""
        if i == 0:
            segments.append(graph.nodes[u].get("label", u))
        segments.append(f"--{relation}{confidence_str}--> {graph.nodes[v].get('label', v)}")
    print(f"Shortest path ({hops} hops):\n  " + " ".join(segments))
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="Query the repo Graphify knowledge graph")
    parser.add_argument(
        "--graph",
        default=str(DEFAULT_GRAPH),
        help="Path to graph.json (defaults to .graphify/graph.json)",
    )
    sub = parser.add_subparsers(dest="mode", required=True)

    p_query = sub.add_parser("query", help="Query the graph for architectural context")
    p_query.add_argument("question", help="Natural-language query")
    p_query.add_argument("--budget", type=int, default=2000, help="Token budget for graphify query output")
    p_query.add_argument("--dfs", action="store_true", help="Use depth-first traversal instead of breadth-first")

    p_explain = sub.add_parser("explain", help="Explain a graph node and its neighbors")
    p_explain.add_argument("node", help="Node label to explain")

    p_path = sub.add_parser("path", help="Find a shortest path between two graph nodes")
    p_path.add_argument("source", help="Source node label")
    p_path.add_argument("target", help="Target node label")

    args = parser.parse_args()
    graph_path = Path(args.graph).resolve()
    missing_graph_rc = _ensure_graph(graph_path)
    if missing_graph_rc != 0:
        return missing_graph_rc

    if args.mode == "query":
        cmd = ["query", args.question, "--budget", str(args.budget), "--graph", str(graph_path)]
        if args.dfs:
            cmd.insert(2, "--dfs")
        return _run_graphify(cmd)
    if args.mode == "explain":
        exact = _find_exact_node(args.node, graph_path) if ("/" in args.node or "\\" in args.node) else None
        if exact is not None:
            return _print_exact_explain(exact, graph_path)
        return _run_graphify(["explain", _resolve_label(args.node, graph_path), "--graph", str(graph_path)])
    if args.mode == "path":
        exact_source = _find_exact_node(args.source, graph_path) if ("/" in args.source or "\\" in args.source) else None
        exact_target = _find_exact_node(args.target, graph_path) if ("/" in args.target or "\\" in args.target) else None
        if exact_source is not None and exact_target is not None:
            return _print_exact_path(exact_source, exact_target, graph_path)
        return _run_graphify(
            [
                "path",
                _resolve_label(args.source, graph_path),
                _resolve_label(args.target, graph_path),
                "--graph",
                str(graph_path),
            ]
        )
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
