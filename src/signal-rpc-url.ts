import fs from 'fs';

function isContainerRuntime(): boolean {
  return fs.existsSync('/.dockerenv') || fs.existsSync('/run/.containerenv');
}

export function resolveSignalRpcUrl(
  rawUrl: string,
  inContainer = isContainerRuntime(),
): string {
  if (!inContainer) return rawUrl;

  const parsed = new URL(rawUrl);
  if (
    parsed.hostname === '127.0.0.1' ||
    parsed.hostname === 'localhost' ||
    parsed.hostname === '::1'
  ) {
    parsed.hostname = 'host.docker.internal';
  }
  return parsed.toString();
}
