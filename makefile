.PHONY: help graph graph-force graph-query graph-explain graph-path graph-view

help:
	@echo "Targets:"
	@echo "  make graph             # build Graphify knowledge graph for local agents"
	@echo "  make graph-force       # force full rebuild of the knowledge graph"
	@echo "  make graph-query QUESTION=\"integrations\"   # query the Graphify graph"
	@echo "  make graph-explain NODE=\"src/index.ts\"     # explain a graph node"
	@echo "  make graph-path SRC=\"src/index.ts\" DST=\"src/integrations/registry.ts\"  # shortest path between nodes"
	@echo "  make graph-view        # serve the Cytoscape graph viewer"

graph:
	python tools/agent/build_graphify.py --config graphify.toml

graph-force:
	python tools/agent/build_graphify.py --config graphify.toml --force

graph-query:
	python tools/agent/query_graphify.py query "$(QUESTION)"

graph-explain:
	python tools/agent/query_graphify.py explain "$(NODE)"

graph-path:
	python tools/agent/query_graphify.py path "$(SRC)" "$(DST)"

graph-view:
	python tools/agent/visualize_graphify.py
