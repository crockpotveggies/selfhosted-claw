import fs from 'fs';
import path from 'path';

export const AGENT_MEMORY_FILENAME = 'AGENT.md';
export const LEGACY_AGENT_MEMORY_FILENAME = 'CLAUDE.md';

function personalizeAssistantName(content: string, assistantName: string): string {
  if (assistantName === 'Andy') return content;
  let result = content.replace(/^# Andy$/m, `# ${assistantName}`);
  result = result.replace(/You are Andy/g, `You are ${assistantName}`);
  return result;
}

export function ensureAgentMemoryFile(
  groupDir: string,
  templateDir: string,
  assistantName: string,
): string | null {
  const agentPath = path.join(groupDir, AGENT_MEMORY_FILENAME);
  const legacyPath = path.join(groupDir, LEGACY_AGENT_MEMORY_FILENAME);

  if (fs.existsSync(agentPath)) return agentPath;

  let content: string | null = null;
  if (fs.existsSync(legacyPath)) {
    content = fs.readFileSync(legacyPath, 'utf-8');
  } else {
    const templateAgentPath = path.join(templateDir, AGENT_MEMORY_FILENAME);
    const templateLegacyPath = path.join(templateDir, LEGACY_AGENT_MEMORY_FILENAME);
    if (fs.existsSync(templateAgentPath)) {
      content = fs.readFileSync(templateAgentPath, 'utf-8');
    } else if (fs.existsSync(templateLegacyPath)) {
      content = fs.readFileSync(templateLegacyPath, 'utf-8');
    }
  }

  if (content === null) return null;

  fs.writeFileSync(agentPath, personalizeAssistantName(content, assistantName));
  return agentPath;
}

