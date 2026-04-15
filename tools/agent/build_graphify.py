#!/usr/bin/env python3
"""Build a repo-scoped Graphify knowledge graph from graphify.toml."""

from __future__ import annotations

import argparse
import fnmatch
import json
import sys
import tomllib
from pathlib import Path, PurePosixPath

from graphify.build import build
from graphify.cluster import cluster
from graphify.export import to_json
from graphify.extract import extract


def _posix_relative(path: Path, root: Path) -> str:
    return path.relative_to(root).as_posix()


def _matches_any(path_text: str, patterns: list[str]) -> bool:
    return any(fnmatch.fnmatch(path_text, pattern) for pattern in patterns)


def _collect_source_files(repo_root: Path, source: dict) -> list[Path]:
    source_root = (repo_root / source["path"]).resolve()
    if not source_root.exists():
        return []

    include_patterns = source.get("include", [])
    exclude_patterns = source.get("exclude", [])
    max_depth = source.get("depth")
    files: dict[Path, None] = {}

    for pattern in include_patterns:
        for candidate in source_root.glob(pattern):
            if not candidate.is_file():
                continue
            rel = _posix_relative(candidate, source_root)
            if max_depth is not None and len(PurePosixPath(rel).parts) - 1 > max_depth:
                continue
            if _matches_any(rel, exclude_patterns):
                continue
            files[candidate.resolve()] = None

    return sorted(files.keys())


def _load_config(config_path: Path) -> dict:
    with config_path.open("rb") as handle:
        return tomllib.load(handle)


def _snapshot(config_path: Path, files: list[Path]) -> dict:
    entries = []
    for path in files:
        stat = path.stat()
        entries.append(
            {
                "path": path.as_posix(),
                "size": stat.st_size,
                "mtime_ns": stat.st_mtime_ns,
            }
        )
    return {
        "config_path": config_path.as_posix(),
        "config_mtime_ns": config_path.stat().st_mtime_ns,
        "files": entries,
    }


def _build_needed(manifest_path: Path, snapshot: dict, force: bool) -> bool:
    if force or not manifest_path.exists():
        return True
    try:
        existing = json.loads(manifest_path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return True
    return existing != snapshot


def main() -> int:
    parser = argparse.ArgumentParser(description="Build the Graphify graph described by graphify.toml")
    parser.add_argument("--config", required=True, help="Path to graphify.toml")
    parser.add_argument("--force", action="store_true", help="Force a rebuild even if inputs are unchanged")
    args = parser.parse_args()

    config_path = Path(args.config).resolve()
    repo_root = config_path.parent
    config = _load_config(config_path)

    graph_cfg = config.get("graph", {})
    output_path = (repo_root / graph_cfg.get("output", ".graphify/graph.json")).resolve()
    manifest_path = output_path.with_suffix(".manifest.json")
    output_path.parent.mkdir(parents=True, exist_ok=True)

    all_files: dict[Path, None] = {}
    for source in config.get("sources", []):
        for path in _collect_source_files(repo_root, source):
            all_files[path] = None

    selected_files = sorted(all_files.keys())
    if not selected_files:
        print("error: graphify build found no matching files", file=sys.stderr)
        return 1

    snapshot = _snapshot(config_path, selected_files)
    if not _build_needed(manifest_path, snapshot, args.force) and output_path.exists():
        print(f"Graphify graph is current: {output_path}")
        return 0

    print(f"Building Graphify graph from {len(selected_files)} files...")
    extraction = extract(selected_files)
    graph = build([extraction])
    communities = cluster(graph)
    to_json(graph, communities, str(output_path))
    manifest_path.write_text(json.dumps(snapshot, indent=2), encoding="utf-8")
    print(f"Wrote {output_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
