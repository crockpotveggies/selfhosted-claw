import fs from 'fs';
import path from 'path';
import { logger } from './logger.js';

/**
 * Parse the .env file and return values for the requested keys.
 * Does NOT load anything into process.env — callers decide what to
 * do with the values. This keeps secrets out of the process environment
 * so they don't leak to child processes.
 */
export function readEnvFile(keys: string[]): Record<string, string> {
  const envFile = path.join(process.cwd(), '.env');
  let content: string;
  try {
    content = fs.readFileSync(envFile, 'utf-8');
  } catch (err) {
    logger.debug({ err }, '.env file not found, using defaults');
    return {};
  }

  const result: Record<string, string> = {};
  const wanted = new Set(keys);

  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    if (!wanted.has(key)) continue;
    let value = trimmed.slice(eqIdx + 1).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    if (value) result[key] = value;
  }

  return result;
}

function parseEnvLines(content: string): string[] {
  return content.split('\n');
}

function formatEnvValue(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

export function setEnvFileValues(
  updates: Record<string, string>,
  envPath: string = path.join(process.cwd(), '.env'),
): void {
  let content = '';
  try {
    content = fs.readFileSync(envPath, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }

  const lines = parseEnvLines(content);
  const pending = new Map(Object.entries(updates));
  const nextLines = lines.map((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return line;
    const eqIdx = line.indexOf('=');
    if (eqIdx === -1) return line;
    const key = line.slice(0, eqIdx).trim();
    if (!pending.has(key)) return line;
    const value = pending.get(key) || '';
    pending.delete(key);
    return `${key}=${formatEnvValue(value)}`;
  });

  for (const [key, value] of pending.entries()) {
    nextLines.push(`${key}=${formatEnvValue(value)}`);
  }

  const tempPath = `${envPath}.tmp`;
  fs.writeFileSync(tempPath, `${nextLines.join('\n').replace(/\n*$/, '\n')}`);
  fs.renameSync(tempPath, envPath);
}
