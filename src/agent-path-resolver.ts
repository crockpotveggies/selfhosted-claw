import path from 'path';

import { DATA_DIR, GROUPS_DIR } from './config.js';
import { resolveGroupFolderPath } from './group-folder.js';

/**
 * Translate an agent-visible container path (e.g. "/workspace/group/foo.pdf")
 * into the corresponding host path. Agent tools that run host-side (slack,
 * whatsapp, etc.) receive paths as the agent sees them — inside the agent
 * container — but need to read the file from the host. Straight host paths
 * pass through unchanged so the caller's existsSync check can still catch
 * typos.
 */
export function resolveAgentFilePath(
  agentPath: string,
  sourceGroup: string,
): string {
  if (!agentPath) return agentPath;
  if (agentPath === '/workspace/group') {
    return resolveGroupFolderPath(sourceGroup);
  }
  if (agentPath.startsWith('/workspace/group/')) {
    const rel = agentPath.slice('/workspace/group/'.length);
    return path.join(resolveGroupFolderPath(sourceGroup), rel);
  }
  if (agentPath === '/workspace/global') {
    return path.join(GROUPS_DIR, 'global');
  }
  if (agentPath.startsWith('/workspace/global/')) {
    const rel = agentPath.slice('/workspace/global/'.length);
    return path.join(GROUPS_DIR, 'global', rel);
  }
  if (agentPath.startsWith('/workspace/state/')) {
    const rel = agentPath.slice('/workspace/state/'.length);
    return path.join(DATA_DIR, 'sessions', sourceGroup, rel);
  }
  return agentPath;
}

/**
 * Infer a conservative MIME type from a file extension. Used by
 * send_file-style tools that accept an arbitrary agent-supplied path and
 * need to pass an explicit content type to the channel. Falls back to
 * application/octet-stream for unknown extensions.
 */
export function inferMimeTypeFromPath(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case '.pdf':
      return 'application/pdf';
    case '.png':
      return 'image/png';
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.gif':
      return 'image/gif';
    case '.txt':
      return 'text/plain';
    case '.md':
      return 'text/markdown';
    case '.json':
      return 'application/json';
    case '.csv':
      return 'text/csv';
    case '.html':
      return 'text/html';
    default:
      return 'application/octet-stream';
  }
}
