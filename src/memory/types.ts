/**
 * Memory system types — file-based agent memory with 3D scoping
 * (entity x integration x group) and YAML frontmatter tags.
 */

// ---------------------------------------------------------------------------
// Memory entries and queries
// ---------------------------------------------------------------------------

export interface MemoryEntry {
  /** Entity scope: "person:<canonical-id>", "group:<folder>", "global" */
  entity: string;
  /** Integration scope: "calendar", "slack", "_core", etc. */
  integration: string;
  /** Tags for cross-cutting queries. */
  tags: string[];
  /** The memory content. */
  content: string;
  /** Confidence level. */
  confidence: 'high' | 'medium' | 'low';
  /** Who created this memory. */
  source: 'agent' | 'admin' | 'system';
  /** Optional specific filename (default: auto-generated from content). */
  file?: string;
}

export interface MemoryQuery {
  /** Grep-style content search. */
  text?: string;
  /** AND-filter on tags. */
  tags?: string[];
  /** Filter by entity: "person:justin", "group:project-team", "global". */
  entity?: string;
  /** Filter by integration: "calendar", "_core", etc. */
  integration?: string;
}

export interface MemoryResult {
  /** Relative path within the memory directory. */
  file: string;
  entity: string;
  integration: string;
  tags: string[];
  content: string;
  confidence: string;
  source: string;
  created: string;
  updated: string;
}

// ---------------------------------------------------------------------------
// Memory index (tag -> file path lookup)
// ---------------------------------------------------------------------------

export interface MemoryIndex {
  entries: Array<{
    file: string;
    entity: string;
    integration: string;
    tags: string[];
  }>;
}

// ---------------------------------------------------------------------------
// Memory provider interface (pluggable backend)
// ---------------------------------------------------------------------------

export interface MemoryProvider {
  search(query: MemoryQuery): Promise<MemoryResult[]>;
  store(entry: MemoryEntry): Promise<string>;
  forget(id: string): Promise<void>;
  /**
   * Build the in-context memory block for a group.
   * @param groupFolder — the group being served
   * @param budgets — integration name → max chars
   */
  getContext(
    groupFolder: string,
    budgets: Map<string, number>,
  ): Promise<string>;
}
